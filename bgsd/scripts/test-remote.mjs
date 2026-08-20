#!/usr/bin/env node
/**
 * test-remote.mjs — unit tests for the remote-control bridge (remote.mjs).
 * Pure core (auth, inbound normalization, event framing, state payload) plus the
 * file-backed outbox/inbox protocol against an isolated tmp run dir.
 * Run: node bgsd/scripts/test-remote.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TMP = "/tmp/bgsd-test-remote";
try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }
mkdirSync(TMP, { recursive: true });

// queue.mjs resolves its store dir at import time from BGSD_QUEUE_DIR (else git
// top-level). Point it at an isolated fixture BEFORE importing remote.mjs (which
// imports queue.mjs) so /api/queue reads the fixture, not this repo's real queue.
const QUEUE_FIXTURE = join(TMP, "queue-fixture");
mkdirSync(QUEUE_FIXTURE, { recursive: true });
process.env.BGSD_QUEUE_DIR = QUEUE_FIXTURE;

const {
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
  // v2
  PROTOCOL_VERSION,
  CORS_HEADERS,
  pluginVersion,
  capabilitiesMap,
  resolveRunDir,
  archivedRunIds,
  projectAgent,
  buildPlanPayload,
  buildQueuePayload,
  sanitizeAgentId,
  readLogTail,
  LOG_CHUNK_BYTES,
  startServer,
  stopServer,
} = await import("./remote.mjs");

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

// ===========================================================================
// v2 — read endpoints (CORS, health caps, sessions, plan, agents, logs,
// tokens, queue). Pure projections + fixture-backed live HTTP tests.
// ===========================================================================

async function test_(name, fn) {
  try { await fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push(name); failed++; }
}

// --- v2 pure projections ----------------------------------------------------

test("V01 — protocol version + capabilities map (control/launch off in read slice)", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  const caps = capabilitiesMap({ control: false, launch: false });
  assert.deepEqual(caps, {
    sessions: true, plan: true, tokens: true, queue: true,
    agents: true, logs: true, control: false, launch: false,
  });
});

test("V02 — pluginVersion reads the plugin manifest beside remote.mjs", () => {
  // remote.mjs lives at bgsd/scripts; manifest at bgsd/.claude-plugin/plugin.json
  const v = pluginVersion();
  assert.equal(typeof v, "string", "version resolves to a string");
  assert.ok(/^\d+\.\d+\.\d+/.test(v), `looks like semver: ${v}`);
});

test("V03 — CORS headers: wildcard origin + methods + allowed headers", () => {
  assert.equal(CORS_HEADERS["access-control-allow-origin"], "*");
  assert.match(CORS_HEADERS["access-control-allow-methods"], /OPTIONS/);
  assert.match(CORS_HEADERS["access-control-allow-headers"], /authorization/);
  assert.match(CORS_HEADERS["access-control-allow-headers"], /x-bgsd-token/);
});

test("V04 — sanitizeAgentId allowlists safe ids and rejects traversal", () => {
  assert.equal(sanitizeAgentId("agent-abc_123.log"), "agent-abc_123.log");
  assert.equal(sanitizeAgentId("../etc/passwd"), null);
  assert.equal(sanitizeAgentId("a/b"), null);
  assert.equal(sanitizeAgentId(""), null);
  assert.equal(sanitizeAgentId(null), null);
});

test("V05 — projectAgent computes heartbeat + projects control fields", () => {
  const now = Date.UTC(2026, 0, 1, 0, 10, 0);
  const nowFn = () => now;
  const cf = {
    agent_id: "agent-1", unit_id: "auth", phase: "execute", status: "running",
    heartbeat_at: new Date(now - 30_000).toISOString(),   // 30s ago → alive
    model: "claude-opus-4-8", model_assignment: { tier: "opus" },
    worktree: "/wt/auth", branch: "feat/auth", progress: { iteration: 2 },
    context_bytes: 1000, context_pressure: "normal", restart_count: 1,
    escalations: [], blockers: [],
  };
  const p = projectAgent(cf, { nowFn });
  assert.equal(p.heartbeat, "alive");
  assert.equal(p.agent_id, "agent-1");
  assert.equal(p.model, "claude-opus-4-8");
  assert.equal(p.branch, "feat/auth");
  // stale + dead classification
  const stale = projectAgent({ ...cf, heartbeat_at: new Date(now - 3 * 60_000).toISOString() }, { nowFn });
  assert.equal(stale.heartbeat, "stale");
  const dead = projectAgent({ ...cf, heartbeat_at: new Date(now - 10 * 60_000).toISOString() }, { nowFn });
  assert.equal(dead.heartbeat, "dead");
});

test("V06 — buildPlanPayload joins units + _meta order + live control", () => {
  const payload = buildPlanPayload({
    runId: "run1",
    run: { state: "executing", scale: "feature", waves: [{ wave: 0, units: ["auth"] }], checkpoints: [] },
    units: [
      { id: "feed", title: "Feed", scope: "s2" },
      { id: "auth", title: "Auth", scope: "s1", criteria: ["c"] },
    ],
    meta: { scale: "feature", unit_ids: ["auth", "feed"] },
    controls: [{ unit_id: "auth", agent_id: "agent-a", status: "running", phase: "plan", worktree: "/wt/a", branch: "b" }],
  });
  assert.equal(payload.state, "executing");
  assert.equal(payload.scale, "feature");
  assert.deepEqual(payload.units.map((u) => u.id), ["auth", "feed"], "_meta.unit_ids drives order");
  assert.equal(payload.units[0].live.agent_id, "agent-a", "auth has a live control join");
  assert.equal(payload.units[1].live, null, "feed has no control yet → null");
});

test("V07 — buildQueuePayload projects counts + lean items", () => {
  const p = buildQueuePayload({
    counts: { queued: 2, done: 1 },
    current: { id: "item-x" },
    last_verdict: "done",
    items: [
      { id: "item-x", title: "Fix nav", state: "queued", source: "manual", created_at: "T", body: "hidden", content_key: "k" },
    ],
  });
  assert.equal(p.counts.queued, 2);
  assert.equal(p.current, "item-x");
  assert.deepEqual(Object.keys(p.items[0]).sort(), ["created_at", "id", "source", "state", "title"]);
  assert.equal(p.items[0].body, undefined, "body is not leaked");
});

test("V08 — readLogTail: absent, windowed, and past-EOF over-read", () => {
  const logDir = join(TMP, "logtail");
  mkdirSync(logDir, { recursive: true });
  const p = join(logDir, "a.log");
  assert.deepEqual(readLogTail(p, 0), { exists: false }, "absent file");
  writeFileSync(p, "abcdefghij", "utf8"); // 10 bytes
  const t0 = readLogTail(p, 0);
  assert.equal(t0.exists, true);
  assert.equal(t0.data, "abcdefghij");
  assert.equal(t0.offset, 0);
  assert.equal(t0.next_offset, 10);
  assert.equal(t0.eof, true);
  const t5 = readLogTail(p, 5);
  assert.equal(t5.data, "fghij");
  assert.equal(t5.offset, 5);
  const over = readLogTail(p, 999);
  assert.equal(over.data, "", "over-read past EOF returns empty at EOF");
  assert.equal(over.eof, true);
  assert.equal(LOG_CHUNK_BYTES, 256 * 1024);
});

// --- v2 disk-seam projections (resolveRunDir / archived) ---------------------

test("V09 — resolveRunDir prefers runs/ then falls back to seshs/; archivedRunIds", () => {
  const root = join(TMP, "resolve");
  mkdirSync(join(root, ".bgsd", "runs", "live-1"), { recursive: true });
  mkdirSync(join(root, ".bgsd", "seshs", "old-1"), { recursive: true });
  mkdirSync(join(root, ".bgsd", "seshs", "old-2"), { recursive: true });
  assert.ok(resolveRunDir(root, "live-1").endsWith(join("runs", "live-1")));
  assert.ok(resolveRunDir(root, "old-1").endsWith(join("seshs", "old-1")), "falls back to seshs");
  assert.equal(resolveRunDir(root, "nope"), null);
  assert.deepEqual(archivedRunIds(root), ["old-1", "old-2"]);
});

// --- v2 live HTTP endpoints against a fixture .bgsd tree --------------------

// Build a self-contained fixture repo with a decomposed run, one control file,
// a log, a tokens ledger, and an archived sesh.
function buildFixtureRepo() {
  const root = join(TMP, "fixture-repo");
  try { rmSync(root, { recursive: true, force: true }); } catch (_) { /**/ }
  const runId = "run-fixture";
  const runDir = join(root, ".bgsd", "runs", runId);
  mkdirSync(join(runDir, "units"), { recursive: true });
  mkdirSync(join(runDir, "control"), { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });

  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    run_id: runId, title: "Fixture", state: "executing", scale: "feature",
    waves: [{ wave: 0, units: ["auth"] }], checkpoints: [],
  }), "utf8");

  writeFileSync(join(runDir, "units", "auth.json"), JSON.stringify({
    id: "auth", title: "Auth", scope: "OAuth", criteria: ["login works"], difficulty: 0.4,
  }), "utf8");
  writeFileSync(join(runDir, "units", "_meta.json"), JSON.stringify({
    scale: "feature", unit_ids: ["auth"], written_at: new Date().toISOString(),
  }), "utf8");

  const nowIso = new Date().toISOString();
  writeFileSync(join(runDir, "control", "agent-auth.json"), JSON.stringify({
    agent_id: "agent-auth", run_id: runId, worktree: "/wt/auth", branch: "feat/auth",
    unit_id: "auth", phase: "execute", status: "running",
    heartbeat_at: nowIso, started_at: nowIso, updated_at: nowIso,
    progress: { iteration: 1, max_iterations: 5, note: "" },
    commits: [], model: "claude-opus-4-8", model_assignment: { tier: "opus" },
    assumptions: [], blockers: [], escalations: [], restart_count: 0,
    inbox_path: null, context_bytes: 2048, context_pressure: "normal",
  }), "utf8");

  writeFileSync(join(runDir, "logs", "agent-auth.log"), "hello log world", "utf8");

  writeFileSync(join(runDir, "tokens.json"), JSON.stringify({
    run_id: runId, created_at: nowIso, entries: [
      { ts: nowIso, agent_id: "agent-auth", unit_id: "auth", role: "executor",
        harness: "claude", model: "claude-opus-4-8", effort: "high",
        input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0,
        cache_creation_tokens: 0, cost_usd: 0.01, source: "measured" },
    ],
  }), "utf8");

  // an archived sesh (decomposed) for seshs/ fallback addressing
  const seshId = "sesh-old";
  const seshDir = join(root, ".bgsd", "seshs", seshId);
  mkdirSync(join(seshDir, "units"), { recursive: true });
  writeFileSync(join(seshDir, "run.json"), JSON.stringify({ run_id: seshId, state: "done", scale: "quick", waves: [], checkpoints: [] }), "utf8");
  writeFileSync(join(seshDir, "units", "_meta.json"), JSON.stringify({ scale: "quick", unit_ids: ["x"] }), "utf8");
  writeFileSync(join(seshDir, "units", "x.json"), JSON.stringify({ id: "x", title: "X" }), "utf8");

  // a run that exists but is NOT decomposed (no units/) → 409
  const bareId = "run-bare";
  mkdirSync(join(root, ".bgsd", "runs", bareId), { recursive: true });
  writeFileSync(join(root, ".bgsd", "runs", bareId, "run.json"), JSON.stringify({ run_id: bareId, state: "created" }), "utf8");

  return { root, runId, seshId, bareId };
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-json (e.g. SSE) */ }
  return { status: res.status, headers: res.headers, json, text };
}

const { root: FIXROOT, runId: FIXRUN, seshId: FIXSESH, bareId: FIXBARE } = buildFixtureRepo();

// Seed the isolated queue fixture with one item (BGSD_QUEUE_DIR points here).
{
  const { addItem } = await import("./queue.mjs");
  addItem({ title: "Fix the nav bug", body: "nav breaks on mobile", source: "manual" });
}

// Start ONE token-gated server bound to loopback for all live endpoint tests.
const TOKEN = "test-token-abcdef";
const srv = await startServer(FIXROOT, { runId: FIXRUN, port: 0, host: "127.0.0.1", token: TOKEN });
const BASE = srv.url;
const AUTH = { authorization: `Bearer ${TOKEN}` };

await test_("V10 — OPTIONS preflight answers 204 with CORS, BEFORE the auth gate", async () => {
  const res = await fetch(`${BASE}/api/plan`, { method: "OPTIONS" }); // no token
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods") || "", /OPTIONS/);
});

await test_("V11 — auth still gates GETs (401 without token); CORS on the 401 too", async () => {
  const r = await httpGet(`${BASE}/api/health`);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

await test_("V12 — GET /api/health carries protocol 2 + version + capabilities", async () => {
  const r = await httpGet(`${BASE}/api/health`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, "v1 field preserved");
  assert.ok(r.json.conductor, "v1 conductor preserved");
  assert.equal(r.json.protocol, 2);
  assert.equal(typeof r.json.bgsd_version, "string");
  assert.equal(r.json.capabilities.sessions, true);
  assert.equal(r.json.capabilities.control, true, "control is enabled by the control slice");
  assert.equal(r.json.capabilities.launch, false);
});

await test_("V13 — GET /api/sessions lists runs + latest + archived", async () => {
  const r = await httpGet(`${BASE}/api/sessions`, AUTH);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.sessions));
  assert.ok(r.json.sessions.some((s) => s.run_id === FIXRUN), "decomposed run is listed");
  assert.ok(r.json.sessions.some((s) => s.run_id === FIXBARE), "bare run is listed too");
  // latest_run_id is whichever run dir is newest by mtime (both live runs qualify)
  assert.ok([FIXRUN, FIXBARE].includes(r.json.latest_run_id), "latest is a live run id");
  assert.deepEqual(r.json.archived, [FIXSESH]);
});

await test_("V14 — GET /api/plan joins run + units + live control", async () => {
  const r = await httpGet(`${BASE}/api/plan?run=${FIXRUN}`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "executing");
  assert.equal(r.json.scale, "feature");
  assert.equal(r.json.waves.length, 1);
  assert.equal(r.json.units.length, 1);
  assert.equal(r.json.units[0].id, "auth");
  assert.equal(r.json.units[0].live.agent_id, "agent-auth");
});

await test_("V15 — GET /api/plan 409 when the run exists but is not decomposed", async () => {
  const r = await httpGet(`${BASE}/api/plan?run=${FIXBARE}`, AUTH);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "not yet decomposed");
});

await test_("V16 — GET /api/plan 404 for an unknown run", async () => {
  const r = await httpGet(`${BASE}/api/plan?run=does-not-exist`, AUTH);
  assert.equal(r.status, 404);
});

await test_("V17 — GET /api/plan resolves an archived sesh via seshs/ fallback", async () => {
  const r = await httpGet(`${BASE}/api/plan?run=${FIXSESH}`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.units[0].id, "x");
});

await test_("V18 — GET /api/agents projects control files + heartbeat", async () => {
  const r = await httpGet(`${BASE}/api/agents?run=${FIXRUN}`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.agents.length, 1);
  const a = r.json.agents[0];
  assert.equal(a.agent_id, "agent-auth");
  assert.equal(a.heartbeat, "alive", "fresh heartbeat classifies alive");
  assert.equal(a.model, "claude-opus-4-8");
  assert.equal(a.context_pressure, "normal");
});

await test_("V19 — GET /api/agents/<id>/log tails by byte offset", async () => {
  const r = await httpGet(`${BASE}/api/agents/agent-auth/log?run=${FIXRUN}&offset=0`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.agent_id, "agent-auth");
  assert.equal(r.json.data, "hello log world");
  assert.equal(r.json.eof, true);
  const r2 = await httpGet(`${BASE}/api/agents/agent-auth/log?run=${FIXRUN}&offset=6`, AUTH);
  assert.equal(r2.json.data, "log world");
  assert.equal(r2.json.offset, 6);
});

await test_("V20 — GET /api/agents/<id>/log 404 for a missing log, 400 for traversal", async () => {
  const miss = await httpGet(`${BASE}/api/agents/no-such-agent/log?run=${FIXRUN}`, AUTH);
  assert.equal(miss.status, 404);
  const trav = await httpGet(`${BASE}/api/agents/${encodeURIComponent("../secret")}/log?run=${FIXRUN}`, AUTH);
  assert.equal(trav.status, 400, "path traversal rejected");
});

await test_("V21 — GET /api/tokens totals + breakdowns; raw=1 adds entries", async () => {
  const r = await httpGet(`${BASE}/api/tokens?run=${FIXRUN}`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.totals.input, 1000);
  assert.equal(r.json.totals.output, 200);
  assert.ok(r.json.byModel["claude-opus-4-8"]);
  assert.ok(r.json.byRole.executor);
  assert.equal(r.json.entries, undefined, "no entries without raw=1");
  const raw = await httpGet(`${BASE}/api/tokens?run=${FIXRUN}&raw=1`, AUTH);
  assert.equal(raw.json.entries.length, 1);
});

await test_("V22 — GET /api/queue returns counts + lean items from the queue store", async () => {
  const r = await httpGet(`${BASE}/api/queue`, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.json.counts.queued, 1);
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.items[0].title, "Fix the nav bug");
  assert.equal(r.json.items[0].body, undefined, "body not leaked");
});

await test_("V23 — v1 routes are unchanged (state/events still shaped as before)", async () => {
  const st = await httpGet(`${BASE}/api/state?run=${FIXRUN}`, AUTH);
  assert.equal(st.status, 200);
  assert.equal(st.json.run_id, FIXRUN);
  assert.ok("pending_questions" in st.json, "v1 state shape preserved");
  const ev = await httpGet(`${BASE}/api/events?run=${FIXRUN}&since=0`, AUTH);
  assert.equal(ev.status, 200);
  assert.ok(Array.isArray(ev.json.events));
});

try { srv.server.close(); } catch (_) { /**/ }

// --- summary ----------------------------------------------------------------

try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }

process.stdout.write(`\nremote.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f}\n`); process.exit(1); }
