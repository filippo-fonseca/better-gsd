#!/usr/bin/env node
/**
 * test-remote-control.mjs — tests for the CONTROL slice of the remote API v2:
 *   - the pure core (CONTROL_ACTIONS, isControlAction, buildControlInboxItem),
 *   - POST /api/control against a fixture .bgsd tree (pause/abort/resume), the
 *     dual-write (run.json flip + session-inbox item + control-in event), the
 *     409 on a terminal run, abort idempotency, cooperative-vs-202 resume, the
 *     400 on an invalid action, and the auth gate.
 * Run: node bgsd/scripts/test-remote-control.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TMP = "/tmp/bgsd-test-remote-control";
try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }
mkdirSync(TMP, { recursive: true });

// Isolate the queue store (remote.mjs -> queue.mjs resolves it at import time).
const QUEUE_FIXTURE = join(TMP, "queue-fixture");
mkdirSync(QUEUE_FIXTURE, { recursive: true });
process.env.BGSD_QUEUE_DIR = QUEUE_FIXTURE;

const {
  CONTROL_ACTIONS,
  isControlAction,
  buildControlInboxItem,
  inboxDir,
  outboxPath,
  startServer,
} = await import("./remote.mjs");

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push(name); failed++; }
}
async function test_(name, fn) {
  try { await fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push(name); failed++; }
}

// --- pure core --------------------------------------------------------------

test("C01 — CONTROL_ACTIONS allowlist + isControlAction", () => {
  assert.deepEqual([...CONTROL_ACTIONS].sort(), ["abort", "pause", "resume"]);
  assert.equal(isControlAction("pause"), true);
  assert.equal(isControlAction("abort"), true);
  assert.equal(isControlAction("resume"), true);
  assert.equal(isControlAction("nuke"), false);
  assert.equal(isControlAction(""), false);
  assert.equal(isControlAction(null), false);
});

test("C02 — buildControlInboxItem shapes a kind:control item (reason/note carried)", () => {
  const now = () => "2026-01-01T00:00:00.000Z";
  const item = buildControlInboxItem("pause", { reason: "  meeting  ", note: "  back soon ", now });
  assert.equal(item.kind, "control");
  assert.equal(item.action, "pause");
  assert.equal(item.source, "remote");
  assert.equal(item.at, "2026-01-01T00:00:00.000Z");
  assert.equal(item.reason, "meeting", "reason trimmed");
  assert.equal(item.note, "back soon", "note trimmed");
  assert.ok(item.id.startsWith("remote-control-"));
  // absent reason/note keys are omitted, not null
  const bare = buildControlInboxItem("abort", { now });
  assert.equal("reason" in bare, false);
  assert.equal("note" in bare, false);
});

// --- fixture + live HTTP ----------------------------------------------------

/** A fixture repo with a runnable run + control files (fresh/stale heartbeats). */
function buildFixtureRepo({ heartbeatAgeMs = 30_000, state = "executing" } = {}) {
  const root = join(TMP, `fx-${Math.random().toString(36).slice(2, 8)}`);
  const runId = "run-ctl";
  const runDir = join(root, ".bgsd", "runs", runId);
  mkdirSync(join(runDir, "control"), { recursive: true });

  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    run_id: runId, title: "Control Fixture", state, scale: "feature",
    stage: "loop1", units: ["auth"], waves: [{ wave: 0, units: ["auth"] }],
    created_at: new Date().toISOString(),
  }), "utf8");

  const hb = new Date(Date.now() - heartbeatAgeMs).toISOString();
  const nowIso = new Date().toISOString();
  writeFileSync(join(runDir, "control", "agent-auth.json"), JSON.stringify({
    agent_id: "agent-auth", run_id: runId, worktree: "/wt/auth", branch: "feat/auth",
    unit_id: "auth", phase: "execute", status: "running",
    heartbeat_at: hb, started_at: nowIso, updated_at: nowIso,
    progress: { iteration: 1, max_iterations: 5, note: "" },
    commits: [], model: "claude-opus-4-8", model_assignment: { tier: "opus" },
    assumptions: [], blockers: [], escalations: [], restart_count: 0,
    inbox_path: null, context_bytes: 2048, context_pressure: "normal",
  }), "utf8");

  return { root, runId, runDir };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-json */ }
  return { status: res.status, headers: res.headers, json, text };
}

function readRunState(runDir) {
  return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).state;
}
function inboxControlItems(root, runId) {
  const dir = inboxDir(root, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((m) => m.kind === "control");
}
function outboxControlEvents(root, runId) {
  const p = outboxPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.type === "control-in");
}

const TOKEN = "ctl-token-123456";
const AUTH = { authorization: `Bearer ${TOKEN}` };

await test_("C03 — pause: 200, run.json -> paused, inbox item + control-in event", async () => {
  const { root, runId, runDir } = buildFixtureRepo();
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    const r = await post(`${srv.url}/api/control`, { action: "pause", reason: "meeting", note: "bbl" }, AUTH);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.action, "pause");
    assert.equal(readRunState(runDir), "paused", "run.json flipped to paused");
    const items = inboxControlItems(root, runId);
    assert.equal(items.length, 1, "one control inbox item dropped");
    assert.equal(items[0].action, "pause");
    assert.equal(items[0].reason, "meeting");
    const evs = outboxControlEvents(root, runId);
    assert.equal(evs.length, 1, "one control-in event appended");
    assert.equal(evs[0].meta.action, "pause");
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

await test_("C04 — pause on a terminal run -> 409 (nothing to pause)", async () => {
  const { root, runId, runDir } = buildFixtureRepo({ state: "done" });
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    const r = await post(`${srv.url}/api/control`, { action: "pause" }, AUTH);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /terminal|nothing to pause/i);
    assert.equal(readRunState(runDir), "done", "state untouched");
    assert.equal(inboxControlItems(root, runId).length, 0, "no inbox item on a rejected pause");
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

await test_("C05 — abort: 200, run.json -> aborted, and it is idempotent", async () => {
  const { root, runId, runDir } = buildFixtureRepo();
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    const r1 = await post(`${srv.url}/api/control`, { action: "abort", reason: "scrap it" }, AUTH);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.state, "aborted");
    assert.equal(readRunState(runDir), "aborted");
    // second abort is a no-op but still succeeds (idempotent)
    const r2 = await post(`${srv.url}/api/control`, { action: "abort" }, AUTH);
    assert.equal(r2.status, 200, "second abort still 200");
    assert.equal(r2.json.state, "aborted");
    assert.equal(readRunState(runDir), "aborted");
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

await test_("C06 — resume (fresh heartbeat) -> 200 cooperative + inbox item", async () => {
  // Pause first so resume has something to restore.
  const { root, runId, runDir } = buildFixtureRepo({ heartbeatAgeMs: 30_000 });
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    await post(`${srv.url}/api/control`, { action: "pause" }, AUTH);
    const r = await post(`${srv.url}/api/control`, { action: "resume" }, AUTH);
    assert.equal(r.status, 200, "live heartbeat -> cooperative resume");
    assert.equal(r.json.resumed, true);
    assert.equal(r.json.mode, "cooperative");
    assert.ok(r.json.inbox, "a resume inbox item was dropped");
    // run restored out of paused
    assert.notEqual(readRunState(runDir), "paused", "run restored from paused");
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

await test_("C07 — resume (stale heartbeat) -> 202 needs-conductor + hint", async () => {
  // 10 min old heartbeat classifies dead -> no live Conductor to receive it.
  const { root, runId } = buildFixtureRepo({ heartbeatAgeMs: 10 * 60_000 });
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    await post(`${srv.url}/api/control`, { action: "pause" }, AUTH);
    const r = await post(`${srv.url}/api/control`, { action: "resume" }, AUTH);
    assert.equal(r.status, 202, "all-dead heartbeats -> needs-conductor");
    assert.equal(r.json.resumed, true);
    assert.equal(r.json.mode, "needs-conductor");
    assert.match(r.json.hint, /bgsd-resume/);
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

await test_("C08 — invalid action -> 400 (allowlist)", async () => {
  const { root, runId, runDir } = buildFixtureRepo();
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    const r = await post(`${srv.url}/api/control`, { action: "nuke" }, AUTH);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown control action/i);
    const missing = await post(`${srv.url}/api/control`, {}, AUTH);
    assert.equal(missing.status, 400, "missing action -> 400");
    assert.equal(readRunState(runDir), "executing", "state untouched on a 400");
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

await test_("C09 — auth gate: 401 without a token; invalid JSON -> 400", async () => {
  const { root, runId } = buildFixtureRepo();
  const srv = await startServer(root, { runId, port: 0, host: "127.0.0.1", token: TOKEN });
  try {
    const noauth = await post(`${srv.url}/api/control`, { action: "pause" }); // no token
    assert.equal(noauth.status, 401);
    // authed but malformed body
    const res = await fetch(`${srv.url}/api/control`, {
      method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: "{not json",
    });
    assert.equal(res.status, 400, "invalid JSON body -> 400");
  } finally { try { srv.server.close(); } catch (_) { /**/ } }
});

// --- summary ----------------------------------------------------------------

try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }

process.stdout.write(`\nremote-control: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f}\n`); process.exit(1); }
