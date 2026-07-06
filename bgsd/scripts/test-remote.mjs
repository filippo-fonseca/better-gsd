#!/usr/bin/env node
/**
 * test-remote.mjs — unit tests for the remote-control bridge (remote.mjs).
 * Pure core (auth, inbound normalization, event framing, state payload) plus the
 * file-backed outbox/inbox protocol against an isolated tmp run dir.
 * Run: node bgsd/scripts/test-remote.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  generateToken,
  isLoopbackHost,
  tokenRequiredForHost,
  extractToken,
  checkAuth,
  normalizeInbound,
  buildOutboxEvent,
  eventsSince,
  parseOutbox,
  remoteStatePayload,
  appendOutboxEvent,
  readOutbox,
  mirrorNarration,
  writeInboxMessage,
  outboxPath,
  inboxDir,
} from "./remote.mjs";

const TMP = "/tmp/bgsd-test-remote";
try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }
mkdirSync(TMP, { recursive: true });

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push(name); failed++; }
}

// --- auth / token -----------------------------------------------------------

test("R01 — generateToken uses the injected rng and hex-encodes it", () => {
  const tok = generateToken((n) => Buffer.alloc(n, 0xab));
  assert.equal(tok, "ab".repeat(24));
});

test("R02 — loopback detection + token requirement", () => {
  for (const h of ["127.0.0.1", "localhost", "::1"]) assert.equal(isLoopbackHost(h), true, h);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(tokenRequiredForHost("0.0.0.0"), true, "non-loopback requires a token");
  assert.equal(tokenRequiredForHost("127.0.0.1"), false, "loopback may run tokenless");
});

test("R03 — extractToken reads bearer header, x-bgsd-token, and ?token", () => {
  assert.equal(extractToken({ headers: { authorization: "Bearer abc" } }, new URL("http://x/")), "abc");
  assert.equal(extractToken({ headers: { "x-bgsd-token": "hdr" } }, new URL("http://x/")), "hdr");
  assert.equal(extractToken({ headers: {} }, new URL("http://x/?token=q")), "q");
  assert.equal(extractToken({ headers: {} }, new URL("http://x/")), null);
});

test("R04 — checkAuth: open when no token set; constant-time match/mismatch", () => {
  assert.equal(checkAuth({ provided: null, expected: null }), true, "no expected → open");
  assert.equal(checkAuth({ provided: "s3cret", expected: "s3cret" }), true);
  assert.equal(checkAuth({ provided: "wrong", expected: "s3cret" }), false);
  assert.equal(checkAuth({ provided: "short", expected: "longervalue" }), false, "length mismatch → false, no throw");
  assert.equal(checkAuth({ provided: null, expected: "s3cret" }), false);
});

// --- inbound normalization --------------------------------------------------

test("R05 — normalizeInbound: a plain message", () => {
  const now = () => "2026-01-01T00:00:00.000Z";
  const rng = (n) => Buffer.alloc(n, 1);
  const m = normalizeInbound({ text: "  hi there  " }, { now, rng });
  assert.equal(m.kind, "message");
  assert.equal(m.text, "hi there");
  assert.equal(m.source, "remote");
  assert.equal(m.at, "2026-01-01T00:00:00.000Z");
  assert.ok(m.id.startsWith("remote-"));
});

test("R06 — normalizeInbound: an answer to a parked unit", () => {
  const m = normalizeInbound({ answersUnit: "auth", answer: "Google OAuth" });
  assert.equal(m.kind, "answer");
  assert.equal(m.answersUnit, "auth");
  assert.equal(m.answer, "Google OAuth");
});

test("R07 — normalizeInbound: answer falls back to text; empty payloads throw", () => {
  const m = normalizeInbound({ answersUnit: "u1", text: "yes" });
  assert.equal(m.answer, "yes");
  assert.throws(() => normalizeInbound({}), /text is required/);
  assert.throws(() => normalizeInbound({ answersUnit: "u1" }), /answer is required/);
});

// --- event framing ----------------------------------------------------------

test("R08 — buildOutboxEvent shape + eventsSince + parseOutbox", () => {
  const ev = buildOutboxEvent({ seq: 3, type: "note", text: "x", meta: { a: 1 }, at: "T" });
  assert.deepEqual(ev, { seq: 3, at: "T", type: "note", text: "x", meta: { a: 1 } });
  const evs = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  assert.deepEqual(eventsSince(evs, 1).map((e) => e.seq), [2, 3]);
  assert.deepEqual(eventsSince(evs, 0).map((e) => e.seq), [1, 2, 3]);
  const parsed = parseOutbox('{"seq":1}\n\n{bad}\n{"seq":2}\n');
  assert.deepEqual(parsed.map((e) => e.seq), [1, 2], "malformed lines are skipped");
});

// --- state payload ----------------------------------------------------------

test("R09 — remoteStatePayload surfaces needs_input units as answerable questions", () => {
  const model = {
    run: { run_id: "r1", state: "executing" },
    conductor: { name: "Kiwi", emoji: "🥝" },
    agents: [
      { id: "a1", unit: "auth", status: "needs_input", note: "escalated: which provider?" },
      { id: "a2", unit: "feed", status: "running", note: "" },
    ],
  };
  const narration = { stage: "loop1", stageLabel: "Loop 1", counts: { total: 2 }, lines: ["l"], gateCommand: null };
  const p = remoteStatePayload({ runId: "r1", model, narration });
  assert.equal(p.run_id, "r1");
  assert.equal(p.stage, "loop1");
  assert.equal(p.pending_questions.length, 1, "only the needs_input unit is pending");
  assert.equal(p.pending_questions[0].answersUnit, "auth");
  assert.equal(p.pending_questions[0].question, "escalated: which provider?");
  assert.equal(p.agents.length, 2);
});

// --- outbox file protocol ---------------------------------------------------

test("R10 — appendOutboxEvent assigns monotonic seq; readOutbox filters by since", () => {
  const root = join(TMP, "r10");
  const runId = "run1";
  const e1 = appendOutboxEvent(root, runId, { type: "narration", text: "one" });
  const e2 = appendOutboxEvent(root, runId, { type: "narration", text: "two" });
  const e3 = appendOutboxEvent(root, runId, { type: "note", text: "three" });
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3], "seq increments");
  assert.ok(existsSync(outboxPath(root, runId)));
  assert.deepEqual(readOutbox(root, runId, 0).map((e) => e.text), ["one", "two", "three"]);
  assert.deepEqual(readOutbox(root, runId, 2).map((e) => e.text), ["three"], "since filters");
  assert.deepEqual(readOutbox(root, "missing", 0), [], "absent outbox → empty");
});

// --- inbox file protocol (reuses session-inbox) -----------------------------

test("R11 — writeInboxMessage drops a drainable *.json into session-inbox", () => {
  const root = join(TMP, "r11");
  const runId = "run1";
  const msg = normalizeInbound({ answersUnit: "auth", answer: "Google" });
  const p = writeInboxMessage(root, runId, msg);
  assert.ok(existsSync(p), "message file exists");
  const files = readdirSync(inboxDir(root, runId)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "exactly one drainable json (no stray .tmp)");
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(parsed.answersUnit, "auth", "the session loop will match answersUnit");
  assert.equal(parsed.answer, "Google");
});

// --- summary ----------------------------------------------------------------

try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }

process.stdout.write(`\nremote.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f}\n`); process.exit(1); }
