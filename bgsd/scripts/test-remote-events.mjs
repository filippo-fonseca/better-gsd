#!/usr/bin/env node
/**
 * test-remote-events.mjs — unit + fixture tests for the structured-events slice
 * (remote-events.mjs) and the run.mjs / run-live.mjs seams that emit through it.
 *
 * No framework. Uses node:assert/strict. Exits 0 on all-pass, non-zero on any
 * failure (no silent green). Fully isolated: OS temp dirs, injected DI seams,
 * NEVER spawns a real claude / git / gh, NEVER hits the network.
 *
 * Run: node bgsd/scripts/test-remote-events.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Pin the harness so run-live's exact-argv/harness detection is deterministic.
process.env.BGSD_HARNESS = "claude";

import {
  emitStructured,
  buildStructuredEvent,
  lastSeqFromTail,
  nextSeq,
  outboxPath,
  seqSidecarPath,
  logsDir,
  agentLogPath,
  openAgentLog,
  emitRunState,
  emitPlanReady,
  STRUCTURED_EVENT_TYPES,
} from "./remote-events.mjs";

import { liveSpawnFn, liveMergeFn, liveReadStatusFn } from "./run-live.mjs";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push(name); failed++; }
}
async function atest(name, fn) {
  try { await fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push(name); failed++; }
}

function tmp() { return mkdtempSync(join(tmpdir(), "bgsd-events-")); }
/** Create the run dir so emitStructured does not no-op, and return repoRoot. */
function withRun(runId) {
  const repoRoot = tmp();
  mkdirSync(join(repoRoot, ".bgsd", "runs", runId), { recursive: true });
  return repoRoot;
}
function readEvents(repoRoot, runId) {
  const p = outboxPath(repoRoot, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// E01–E05: pure core
// ---------------------------------------------------------------------------

test("E01 — buildStructuredEvent shape mirrors the outbox envelope", () => {
  const ev = buildStructuredEvent({ seq: 7, type: "run-state", text: "x", meta: { to: "y" }, at: "T" });
  assert.deepEqual(ev, { seq: 7, at: "T", type: "run-state", text: "x", meta: { to: "y" } });
  // No meta key when meta is null.
  const bare = buildStructuredEvent({ seq: 1, type: "note", text: "z", meta: null, at: "T" });
  assert.ok(!("meta" in bare), "null meta is omitted");
  assert.equal(bare.text, "z");
});

test("E02 — lastSeqFromTail recovers the last good seq, skips a torn final line", () => {
  assert.equal(lastSeqFromTail(""), 0, "empty → 0");
  assert.equal(lastSeqFromTail('{"seq":1}\n{"seq":2}\n'), 2);
  // A torn/partial final line is skipped; the last good line wins.
  assert.equal(lastSeqFromTail('{"seq":4}\n{"seq":5}\n{"seq":6'), 5, "torn tail line ignored");
  assert.equal(lastSeqFromTail("garbage\nmore garbage"), 0, "no valid line → 0");
});

test("E03 — catalog lists exactly the additive v2 types", () => {
  for (const t of ["run-state", "plan-ready", "agent-spawned", "verification", "pr-opened"]) {
    assert.ok(STRUCTURED_EVENT_TYPES.includes(t), `${t} present`);
  }
  assert.ok(!STRUCTURED_EVENT_TYPES.includes("narration"), "v1 types are not re-declared");
});

test("E04 — emitStructured no-ops (returns null) when the run dir is absent", () => {
  const repoRoot = tmp(); // note: NO run dir created
  const ev = emitStructured(repoRoot, "ghost", { type: "run-state", text: "x" });
  assert.equal(ev, null, "no run dir → null");
  assert.ok(!existsSync(outboxPath(repoRoot, "ghost")), "no file written");
  rmSync(repoRoot, { recursive: true, force: true });
});

test("E05 — emitStructured NEVER throws on bad input", () => {
  assert.doesNotThrow(() => emitStructured(null, null, {}));
  assert.doesNotThrow(() => emitStructured(undefined, "r", null));
  assert.doesNotThrow(() => emitStructured("/nonexistent/path/xyz", "r", { type: "x" }));
  assert.equal(emitStructured(null, "r", { type: "x" }), null);
});

// ---------------------------------------------------------------------------
// E06–E09: file protocol + seq monotonicity (incl. the perf sidecar path)
// ---------------------------------------------------------------------------

test("E06 — emitStructured writes the envelope + assigns monotonic seq", () => {
  const runId = "r-mono";
  const repoRoot = withRun(runId);
  const a = emitStructured(repoRoot, runId, { type: "run-state", text: "a", meta: { to: "decomposed" } }, { now: () => "T0" });
  const b = emitStructured(repoRoot, runId, { type: "plan-ready", text: "b" }, { now: () => "T1" });
  const c = emitStructured(repoRoot, runId, { type: "wave-started", text: "c" }, { now: () => "T2" });
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3], "seq increments 1,2,3");
  assert.equal(a.at, "T0", "injected clock used");
  assert.deepEqual(a.meta, { to: "decomposed" });
  const evs = readEvents(repoRoot, runId);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3], "on-disk seqs monotonic");
  assert.deepEqual(evs.map((e) => e.type), ["run-state", "plan-ready", "wave-started"]);
  rmSync(repoRoot, { recursive: true, force: true });
});

test("E07 — perf path: sidecar carries the high-water mark", () => {
  const runId = "r-sidecar";
  const repoRoot = withRun(runId);
  emitStructured(repoRoot, runId, { type: "note", text: "1" });
  emitStructured(repoRoot, runId, { type: "note", text: "2" });
  const sidecar = seqSidecarPath(repoRoot, runId);
  assert.ok(existsSync(sidecar), "sidecar written");
  assert.equal(readFileSync(sidecar, "utf8").trim(), "2", "sidecar = high-water seq");
  assert.equal(nextSeq(repoRoot, runId), 3, "nextSeq reads the sidecar cheaply");
  rmSync(repoRoot, { recursive: true, force: true });
});

test("E08 — perf path: cold start with no sidecar recovers seq from the jsonl tail", () => {
  const runId = "r-cold";
  const repoRoot = withRun(runId);
  // Pre-seed an outbox with existing events but NO sidecar (simulates a v1 file
  // or a deleted sidecar). The next emit must not collide or rewind.
  const p = outboxPath(repoRoot, runId);
  appendFileSync(p, JSON.stringify({ seq: 1, at: "T", type: "narration", text: "old" }) + "\n");
  appendFileSync(p, JSON.stringify({ seq: 2, at: "T", type: "stage", text: "old2" }) + "\n");
  assert.ok(!existsSync(seqSidecarPath(repoRoot, runId)), "no sidecar to start");
  const ev = emitStructured(repoRoot, runId, { type: "run-state", text: "new" });
  assert.equal(ev.seq, 3, "recovered from tail → next seq is 3, no collision");
  rmSync(repoRoot, { recursive: true, force: true });
});

test("E09 — typed emitters shape text + meta correctly", () => {
  const runId = "r-typed";
  const repoRoot = withRun(runId);
  const rs = emitRunState(repoRoot, runId, { from: "spawning", to: "executing" });
  assert.equal(rs.type, "run-state");
  assert.deepEqual(rs.meta, { from: "spawning", to: "executing", run_id: runId });
  const pr = emitPlanReady(repoRoot, runId, {
    waveCount: 2,
    units: [{ id: "u1", title: "One", wave: 0 }, { id: "u2", title: "Two", wave: 1 }],
  });
  assert.equal(pr.type, "plan-ready");
  assert.equal(pr.meta.unit_count, 2);
  assert.equal(pr.meta.wave_count, 2);
  assert.deepEqual(pr.meta.units, [{ id: "u1", title: "One", wave: 0 }, { id: "u2", title: "Two", wave: 1 }]);
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E10: openAgentLog — append fd + discoverable path, never throws
// ---------------------------------------------------------------------------

test("E10 — openAgentLog creates the logs dir + an append fd", () => {
  const runId = "r-log";
  const repoRoot = withRun(runId);
  const res = openAgentLog(repoRoot, runId, "unit-x");
  assert.ok(res, "returns { fd, path }");
  assert.equal(res.path, agentLogPath(repoRoot, runId, "unit-x"));
  assert.ok(existsSync(logsDir(repoRoot, runId)), "logs dir created");
  // fd is usable for append.
  writeSync(res.fd, "hello\n");
  closeSync(res.fd);
  assert.equal(readFileSync(res.path, "utf8"), "hello\n");
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture tests: run-live.mjs seams emit through remote-events (DI seams).
// Mirrors test-run-live.mjs — mock git/spawn, no real subprocesses.
// ---------------------------------------------------------------------------

const UNIT = {
  id: "unit-evt-ab12",
  title: "Emit events unit",
  scope: "Wire it up.",
  touched: ["src/x.ts"],
  deps: [],
  difficulty: 0.5,
  criteria: ["it emits"],
  model_posture: {
    planner: { model: "opus", effort: "high" },
    executor: { model: "opus", effort: "xhigh" },
    researcher: { model: "opus", effort: "high" },
    verifier: { model: "opus", effort: "medium" },
    fablePlan: false,
    spawnModel: "opus",
  },
};

function makeGitMock({ branch = "feat/bgsd-v0", status = 0, mergeTreeOut = "", mergeTreeStatus = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "branch" && args[1] === "--show-current") return { status: 0, stdout: branch, stderr: "" };
    if (args[0] === "merge-tree") return { status: mergeTreeStatus, stdout: mergeTreeOut, stderr: "" };
    return { status, stdout: "", stderr: "" };
  };
  impl.calls = calls;
  return impl;
}
function makeSpawnMock() {
  const calls = [];
  const impl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: "", stderr: "" }; };
  impl.calls = calls;
  return impl;
}

await atest("E11 — liveSpawnFn emits branch-created + agent-spawned and records log_path", async () => {
  const runId = "bgsd-evt-0001";
  const repoRoot = withRun(runId);            // repoRoot with .bgsd/runs/<runId>
  const bgsdDir = join(repoRoot, ".bgsd");
  const wtPath = join(tmp(), "wt");
  const plan = { path: wtPath, branch: "run/unit-evt", port: 3160 };

  try {
    await liveSpawnFn(UNIT.id, plan, {
      runId, scale: "feature", unit: UNIT,
      bgsdDir, repoRoot, gitImpl: makeGitMock(), spawnImpl: makeSpawnMock(),
    });

    const evs = readEvents(repoRoot, runId);
    const branchEv = evs.find((e) => e.type === "branch-created");
    const spawnEv = evs.find((e) => e.type === "agent-spawned");
    assert.ok(branchEv, "branch-created emitted");
    assert.equal(branchEv.meta.branch, "run/unit-evt");
    assert.equal(branchEv.meta.unit_id, UNIT.id);
    assert.ok(spawnEv, "agent-spawned emitted");
    assert.equal(spawnEv.meta.agent_id, UNIT.id);
    assert.equal(spawnEv.meta.worktree, wtPath);
    assert.equal(spawnEv.meta.branch, "run/unit-evt");

    // log_path recorded on the control file, and the log file was opened.
    const cf = JSON.parse(readFileSync(join(bgsdDir, "runs", runId, "control", `${UNIT.id}.json`), "utf8"));
    assert.equal(cf.log_path, agentLogPath(repoRoot, runId, UNIT.id), "control file carries log_path");
    assert.ok(existsSync(agentLogPath(repoRoot, runId, UNIT.id)), "log file created (append fd)");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(wtPath, { recursive: true, force: true });
  }
});

await atest("E12 — liveMergeFn emits unit-merged on a clean merge, not on a conflict", async () => {
  const runId = "bgsd-evt-0002";
  const repoRoot = withRun(runId);

  // Clean merge → unit-merged emitted.
  const cleanRes = await liveMergeFn(UNIT.id, runId, { branch: "run/unit-evt" }, {
    repoRoot, gitImpl: makeGitMock({ mergeTreeStatus: 0 }),
  });
  assert.deepEqual(cleanRes, { merged: true });
  let evs = readEvents(repoRoot, runId);
  const merged = evs.find((e) => e.type === "unit-merged");
  assert.ok(merged, "unit-merged emitted on clean merge");
  assert.equal(merged.meta.unit_id, UNIT.id);
  assert.equal(merged.meta.into, `rehearsal/${runId}`);

  // Conflict → NO new unit-merged.
  const before = readEvents(repoRoot, runId).filter((e) => e.type === "unit-merged").length;
  const conflictRes = await liveMergeFn(UNIT.id, runId, { branch: "run/unit-evt" }, {
    repoRoot, gitImpl: makeGitMock({ mergeTreeStatus: 1, mergeTreeOut: "src/x.ts" }),
  });
  assert.equal(conflictRes.merged, false);
  const after = readEvents(repoRoot, runId).filter((e) => e.type === "unit-merged").length;
  assert.equal(after, before, "no unit-merged on conflict");

  rmSync(repoRoot, { recursive: true, force: true });
});

await atest("E13 — liveReadStatusFn emits agent-phase on change only, and agent-done once at terminal", async () => {
  const runId = "bgsd-evt-0003";
  const repoRoot = withRun(runId);
  const bgsdDir = join(repoRoot, ".bgsd");
  const unitId = "unit-status-cd34";
  const controlDir = join(bgsdDir, "runs", runId, "control");
  mkdirSync(controlDir, { recursive: true });
  const controlPath = join(controlDir, `${unitId}.json`);
  const writeCf = (phase, status) => writeFileSync(controlPath, JSON.stringify({
    agent_id: unitId, run_id: runId, worktree: "/wt", branch: "b", unit_id: unitId,
    phase, status, heartbeat_at: "T", started_at: "T", updated_at: "T",
    progress: { iteration: 1, max_iterations: 5, note: "" },
  }));

  // First poll (plan/running) → one agent-phase.
  writeCf("plan", "running");
  await liveReadStatusFn(unitId, runId, bgsdDir);
  // Same phase/status again → NO new event (change-detection).
  await liveReadStatusFn(unitId, runId, bgsdDir);
  let phaseEvents = readEvents(repoRoot, runId).filter((e) => e.type === "agent-phase");
  assert.equal(phaseEvents.length, 1, "identical poll does not re-emit (no heartbeat spam)");

  // Phase change → a second agent-phase.
  writeCf("execute", "running");
  await liveReadStatusFn(unitId, runId, bgsdDir);
  phaseEvents = readEvents(repoRoot, runId).filter((e) => e.type === "agent-phase");
  assert.equal(phaseEvents.length, 2, "a phase change re-emits");

  // Terminal → agent-phase + exactly one agent-done.
  writeCf("done", "done");
  await liveReadStatusFn(unitId, runId, bgsdDir);
  await liveReadStatusFn(unitId, runId, bgsdDir); // repeat terminal poll
  const doneEvents = readEvents(repoRoot, runId).filter((e) => e.type === "agent-done");
  assert.equal(doneEvents.length, 1, "agent-done fires exactly once at terminal");
  assert.equal(doneEvents[0].meta.status, "done");
  assert.equal(doneEvents[0].meta.verified, true);

  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\nremote-events.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f}\n`); process.exit(1); }
process.stdout.write("\nAll tests PASSED.\n");
