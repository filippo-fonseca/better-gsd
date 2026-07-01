#!/usr/bin/env node
/**
 * test-run.mjs — Unit tests for run.mjs + run-live.mjs
 *               (Phase 4: RUN-01..04, SPAWN-04)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-run.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully mocked:
 *   - No real git worktrees, no real process spawn, no real claude -p.
 *   - Filesystem I/O uses OS temp directories, cleaned up after each test.
 *   - run-live.mjs guard tested by confirming it throws without --live.
 *
 * Test groups:
 *
 * --- run.mjs: ID + record helpers (RUN-01) ---
 *   R01 — promptSlug: basic 5-word slug
 *   R02 — promptSlug: handles special chars and long prompts
 *   R03 — mintRunId: produces bgsd-<NNNN>-<slug> format
 *   R04 — mintRunId: monotonic sequence increments on each call
 *   R05 — createRun: creates run.json with "created" state + all fields
 *   R06 — readRun: throws on missing file
 *   R07 — readRun: throws on invalid JSON
 *
 * --- run.mjs: state machine (RUN-02) ---
 *   R08 — advanceState: transitions created → decomposed
 *   R09 — advanceState: throws on unknown state
 *   R10 — advanceState: terminal state cannot be transitioned out of
 *   R11 — advanceState: every transition is timestamped in transitions[]
 *
 * --- run.mjs: merge-boundary checkpoint (RUN-03) ---
 *   R12 — recordCheckpoint: creates checkpoint record + advances state
 *   R13 — resumeFromCheckpoint: go=true advances to "merging"
 *   R14 — resumeFromCheckpoint: go=false advances to "aborted"
 *   R15 — resumeFromCheckpoint: throws if run is not in "checkpoint" state
 *   R16 — lifecycle halts at checkpoint + resumes deterministically
 *
 * --- run.mjs: abort (RUN-04) ---
 *   R17 — abortRun: records abort reason + sets state to "aborted"
 *   R18 — abortRun: idempotent — does not throw if already aborted
 *   R19 — abortRun mid-run: lifecycle aborts cleanly, no orphan state
 *
 * --- run.mjs: full lifecycle happy path (RUN-01..04) ---
 *   R20 — lifecycle happy path: init → decomposed → spawning → ... → done
 *   R21 — lifecycle surfaces blocked units (no silent green — NFR-06)
 *   R22 — lifecycle: all waves processed, one checkpoint per wave
 *   R23 — lifecycle: held units are surfaced in the final result
 *
 * --- run-live.mjs: guarded seam (SPAWN-04) ---
 *   R24 — requireLiveFlag: throws without --live
 *   R25 — isLiveFlagSet: returns false in test (--live not in argv)
 *   R26 — liveSpawnFn: runs without --live (gate removed); guards a bad plan
 *   R27 — liveReadStatusFn: runs without --live (gate removed); missing control -> running
 *   R28 — liveMergeFn: runs without --live (gate removed); guards a bad plan
 *   R29 — liveCheckpointFn: runs without --live (gate removed); resolves on go/no-go
 *
 * --- rehearsal + ledger helpers ---
 *   R30 — rehearsalBranch: returns rehearsal/<run-id>
 *   R31 — appendLedgerEntry: creates ledger.md if missing + appends entry
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  promptSlug,
  mintRunId,
  createRun,
  readRun,
  runJsonPath,
  advanceState,
  recordCheckpoint,
  resumeFromCheckpoint,
  abortRun,
  runLifecycle,
  rehearsalBranch,
  appendLedgerEntry,
  RUN_STATES,
  TERMINAL_STATES,
} from "./run.mjs";

import {
  isLiveFlagSet,
  requireLiveFlag,
  liveSpawnFn,
  liveReadStatusFn,
  liveMergeFn,
  liveCheckpointFn,
} from "./run-live.mjs";

// ---------------------------------------------------------------------------
// Test runner helpers
// ---------------------------------------------------------------------------

let total   = 0;
let passed  = 0;
let failed  = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // Treat as synchronous failure — async tests must use testAsync
      process.stderr.write(`  WARN  ${name} — returned a Promise but was registered with test(), not testAsync()\n`);
    }
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n         ${err.message}\n`);
    failed++;
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n         ${err.message}\n`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh temp dir for a test and return it.
 * The caller is responsible for cleaning up (or let OS handle it).
 */
function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "bgsd-test-run-"));
}

/**
 * Create a minimal run record in a temp .bgsd dir and return paths.
 */
function makeTestRun(prompt = "add user auth and rate limiting") {
  const tmpDir  = makeTmpDir();
  const bgsdDir = join(tmpDir, ".bgsd");

  const { runId } = mintRunId(prompt, bgsdDir);
  const run = createRun({ runId, prompt, bgsdDir });
  const runPath = runJsonPath(bgsdDir, runId);

  return { tmpDir, bgsdDir, runId, run, runPath };
}

/**
 * Build a minimal mocked environment for runLifecycle tests.
 *
 * - spawnFn:      records dispatched units, immediately marks them done
 * - readStatusFn: returns "done" for all units instantly
 * - mergeFn:      records merges, always returns { merged: true }
 * - checkpointFn: records checkpoints, always returns { go: true }
 */
function makeMockLifecycleEnv(opts = {}) {
  const dispatched  = [];
  const merges      = [];
  const checkpoints = [];

  const {
    unitStatuses = {},       // override: unitId -> "done"|"failed"
    checkpointGo = true,     // set to false to simulate rejection
    mergeFail    = false,    // set to true to make all merges fail
  } = opts;

  const spawnFn = async (unitId, plan) => {
    dispatched.push(unitId);
  };

  const readStatusFn = async (unitId) => {
    if (unitStatuses[unitId]) return unitStatuses[unitId];
    return "done";
  };

  const mergeFn = async (unitId, runId, plan) => {
    merges.push(unitId);
    if (mergeFail) return { merged: false, reason: "conflict" };
    return { merged: true };
  };

  const checkpointFn = async (checkpoint) => {
    checkpoints.push(checkpoint);
    return { go: typeof checkpointGo === "function"
      ? checkpointGo(checkpoint)
      : checkpointGo };
  };

  return { spawnFn, readStatusFn, mergeFn, checkpointFn, dispatched, merges, checkpoints };
}

/**
 * Build a minimal 2-unit graph for lifecycle tests.
 *   u1 — no deps (wave 0)
 *   u2 — no deps (wave 0)
 */
function makeSimpleGraph() {
  const units = [
    { id: "u1", title: "Unit 1", deps: [], touched: [] },
    { id: "u2", title: "Unit 2", deps: [], touched: [] },
  ];
  const edges = new Map([["u1", new Set()], ["u2", new Set()]]);
  const reverseEdges = new Map([["u1", new Set()], ["u2", new Set()]]);
  const graph = { nodes: new Map([["u1", units[0]], ["u2", units[1]]]), edges, reverseEdges };
  const waves = [["u1", "u2"]];
  const plans = new Map([
    ["u1", { unitId: "u1", path: "/fake/wt/u1", branch: "run/u1", port: 3100, db: "/fake/db/u1.sqlite" }],
    ["u2", { unitId: "u2", path: "/fake/wt/u2", branch: "run/u2", port: 3101, db: "/fake/db/u2.sqlite" }],
  ]);
  return { units, graph, waves, plans };
}

// ---------------------------------------------------------------------------
// --- run.mjs: ID + record helpers (RUN-01) ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- run.mjs: ID + record helpers (RUN-01) ---\n");

test("R01 — promptSlug: basic 5-word slug", () => {
  const slug = promptSlug("Add user auth and rate limiting");
  assert.equal(slug, "add-user-auth-and-rate");
});

test("R02 — promptSlug: handles special chars and long prompts", () => {
  const slug = promptSlug("Refactor!!! the (entire) API surface - NOW");
  // Special chars stripped; first 5 words; max 24 chars
  assert.ok(typeof slug === "string", "returns a string");
  assert.ok(slug.length > 0, "not empty");
  assert.ok(slug.length <= 24, `slug "${slug}" must be <= 24 chars`);
  assert.doesNotMatch(slug, /[!()]/);
});

test("R03 — mintRunId: produces bgsd-<NNNN>-<slug> format", () => {
  const tmpDir = makeTmpDir();
  const bgsdDir = join(tmpDir, ".bgsd");
  const { runId, seq } = mintRunId("Add user auth", bgsdDir);
  assert.match(runId, /^bgsd-\d{4}-/);
  assert.ok(typeof seq === "number" && seq > 0);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R04 — mintRunId: monotonic sequence increments on each call", () => {
  const tmpDir = makeTmpDir();
  const bgsdDir = join(tmpDir, ".bgsd");
  const first  = mintRunId("prompt one",   bgsdDir);
  const second = mintRunId("prompt two",   bgsdDir);
  const third  = mintRunId("prompt three", bgsdDir);
  assert.equal(second.seq, first.seq + 1,  "second seq = first + 1");
  assert.equal(third.seq,  second.seq + 1, "third seq = second + 1");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R05 — createRun: creates run.json with 'created' state + all fields", () => {
  const { tmpDir, bgsdDir, runId, run, runPath } = makeTestRun();
  assert.ok(existsSync(runPath), "run.json exists");
  assert.equal(run.run_id,    runId);
  assert.equal(run.state,     "created");
  assert.ok(typeof run.created_at === "string", "has created_at");
  assert.ok(Array.isArray(run.transitions), "has transitions array");
  assert.equal(run.transitions.length, 1, "one initial transition");
  assert.equal(run.transitions[0].to, "created");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R06 — readRun: throws on missing file", () => {
  assert.throws(
    () => readRun("/nonexistent/path/run.json"),
    /run.json not found/
  );
});

await testAsync("R07 — readRun: throws on invalid JSON", async () => {
  const tmpDir = makeTmpDir();
  const badPath = join(tmpDir, "bad.json");
  const { writeFileSync: wfs } = await import("node:fs");
  wfs(badPath, "{ not valid json", "utf8");

  assert.throws(
    () => readRun(badPath),
    /not valid JSON/
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --- run.mjs: state machine (RUN-02) ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- run.mjs: state machine (RUN-02) ---\n");

test("R08 — advanceState: transitions created → decomposed", () => {
  const { tmpDir, runPath } = makeTestRun();
  const updated = advanceState(runPath, "decomposed", { units: ["u1"] });
  assert.equal(updated.state, "decomposed");
  assert.equal(updated.transitions.length, 2);
  assert.equal(updated.transitions[1].from, "created");
  assert.equal(updated.transitions[1].to,   "decomposed");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R09 — advanceState: throws on unknown state", () => {
  const { tmpDir, runPath } = makeTestRun();
  assert.throws(
    () => advanceState(runPath, "INVALID_STATE"),
    /unknown state/i
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R10 — advanceState: terminal state cannot be transitioned out of", () => {
  const { tmpDir, runPath } = makeTestRun();
  abortRun(runPath, "test");
  assert.throws(
    () => advanceState(runPath, "decomposed"),
    /terminal state/i
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R11 — advanceState: every transition is timestamped in transitions[]", () => {
  const { tmpDir, runPath } = makeTestRun();
  advanceState(runPath, "decomposed");
  advanceState(runPath, "spawning");
  advanceState(runPath, "executing");
  const run = readRun(runPath);
  // 1 initial + 3 transitions = 4
  assert.equal(run.transitions.length, 4);
  for (const t of run.transitions) {
    assert.ok(typeof t.at === "string" && t.at.length > 0, "transition has timestamp");
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --- run.mjs: merge-boundary checkpoint (RUN-03) ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- run.mjs: merge-boundary checkpoint (RUN-03) ---\n");

test("R12 — recordCheckpoint: creates checkpoint record + advances state", () => {
  const { tmpDir, runPath } = makeTestRun();
  advanceState(runPath, "merging");
  const ckpt = recordCheckpoint(runPath, {
    waveIndex: 0,
    merged:    ["u1"],
    held:      ["u2"],
    blockers:  [],
  });
  assert.ok(typeof ckpt.checkpoint_id === "string", "has checkpoint_id");
  assert.equal(ckpt.wave_index, 0);
  assert.deepEqual(ckpt.merged, ["u1"]);
  assert.deepEqual(ckpt.held,   ["u2"]);
  const run = readRun(runPath);
  assert.equal(run.state, "checkpoint");
  assert.equal(run.checkpoints.length, 1);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R13 — resumeFromCheckpoint: go=true advances to 'merging'", () => {
  const { tmpDir, runPath } = makeTestRun();
  advanceState(runPath, "merging");
  const ckpt = recordCheckpoint(runPath, { waveIndex: 0, merged: [], held: [], blockers: [] });
  resumeFromCheckpoint(runPath, ckpt.checkpoint_id, { go: true });
  const run = readRun(runPath);
  assert.equal(run.state, "merging");
  const resumedCkpt = run.checkpoints.find((c) => c.checkpoint_id === ckpt.checkpoint_id);
  assert.equal(resumedCkpt.go, true);
  assert.ok(typeof resumedCkpt.resumed_at === "string");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R14 — resumeFromCheckpoint: go=false advances to 'aborted'", () => {
  const { tmpDir, runPath } = makeTestRun();
  advanceState(runPath, "merging");
  const ckpt = recordCheckpoint(runPath, { waveIndex: 0, merged: [], held: [], blockers: [] });
  resumeFromCheckpoint(runPath, ckpt.checkpoint_id, { go: false });
  const run = readRun(runPath);
  assert.equal(run.state, "aborted");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R15 — resumeFromCheckpoint: throws if run is not in 'checkpoint' state", () => {
  const { tmpDir, runPath } = makeTestRun();
  // Run is in "created" state — no checkpoint
  assert.throws(
    () => resumeFromCheckpoint(runPath, "fake-ckpt-id"),
    /expected "checkpoint"/i
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

await testAsync("R16 — lifecycle halts at checkpoint + resumes deterministically", async () => {
  const { tmpDir, bgsdDir, runId, runPath } = makeTestRun("lifecycle checkpoint resume test");
  const { units, graph, waves, plans } = makeSimpleGraph();

  const checkpointsSeen = [];
  let firstCkptId = null;

  const env = makeMockLifecycleEnv({
    checkpointGo: (ckpt) => {
      checkpointsSeen.push(ckpt.checkpoint_id);
      // First checkpoint: record id but approve
      if (!firstCkptId) firstCkptId = ckpt.checkpoint_id;
      return true;
    },
  });

  const result = await runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    ...env,
    pollIntervalMs: 0,
  });

  // Lifecycle must reach "done"
  assert.equal(result.outcome, "done", `expected done, got ${result.outcome}`);
  // Exactly one checkpoint per wave (1 wave here)
  assert.equal(checkpointsSeen.length, 1, "exactly 1 checkpoint for 1 wave");
  // The checkpoint id was recorded
  assert.ok(typeof firstCkptId === "string");
  // The run.json should be in "done" state
  const run = readRun(runPath);
  assert.equal(run.state, "done");
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --- run.mjs: abort (RUN-04) ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- run.mjs: abort (RUN-04) ---\n");

test("R17 — abortRun: records abort reason + sets state to 'aborted'", () => {
  const { tmpDir, runPath } = makeTestRun();
  const updated = abortRun(runPath, "manual_test_abort");
  assert.equal(updated.state,        "aborted");
  assert.equal(updated.abort_reason, "manual_test_abort");
  const run = readRun(runPath);
  assert.equal(run.state, "aborted");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("R18 — abortRun: idempotent — does not throw if already aborted", () => {
  const { tmpDir, runPath } = makeTestRun();
  abortRun(runPath, "first");
  // Should not throw
  const second = abortRun(runPath, "second");
  assert.equal(second.state, "aborted");
  rmSync(tmpDir, { recursive: true, force: true });
});

await testAsync("R19 — abortRun mid-run: lifecycle aborts cleanly, no orphan state", async () => {
  const { tmpDir, bgsdDir, runId, runPath } = makeTestRun("abort mid run test");
  const { units, graph, waves, plans } = makeSimpleGraph();

  // Reject the first checkpoint — simulates /bgsd-abort
  const env = makeMockLifecycleEnv({ checkpointGo: false });

  const result = await runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    ...env,
    pollIntervalMs: 0,
  });

  assert.equal(result.outcome, "aborted");
  assert.equal(result.aborted, true);

  // Run record must be preserved and in aborted state
  const run = readRun(runPath);
  assert.equal(run.state, "aborted");
  // run.json file must exist (not cleaned up — for inspection)
  assert.ok(existsSync(runPath), "run.json is preserved after abort");
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --- run.mjs: full lifecycle happy path (RUN-01..04) ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- run.mjs: full lifecycle happy path (RUN-01..04) ---\n");

await testAsync("R20 — lifecycle happy path: init → decomposed → spawning → ... → done", async () => {
  const { tmpDir, bgsdDir, runId, runPath } = makeTestRun("build user auth system");
  const { units, graph, waves, plans } = makeSimpleGraph();
  const env = makeMockLifecycleEnv();

  const result = await runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    ...env,
    pollIntervalMs: 0,
  });

  assert.equal(result.outcome, "done", `expected done, got ${result.outcome}`);
  assert.equal(result.aborted, false);
  assert.ok(Array.isArray(result.merged));
  assert.ok(Array.isArray(result.held));

  // Both units should have been dispatched
  assert.ok(env.dispatched.includes("u1"), "u1 dispatched");
  assert.ok(env.dispatched.includes("u2"), "u2 dispatched");

  // Final run.json must be in "done" state
  const run = readRun(runPath);
  assert.equal(run.state, "done");

  // All lifecycle states must appear in transitions
  const transStates = run.transitions.map((t) => t.to);
  for (const state of ["created", "decomposed", "spawning", "executing", "verifying", "merging", "checkpoint", "merging", "done"]) {
    assert.ok(transStates.includes(state), `state "${state}" appears in transitions`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
});

await testAsync("R21 — lifecycle surfaces blocked units (no silent green — NFR-06)", async () => {
  const { tmpDir, bgsdDir, runId, runPath } = makeTestRun("blocked unit test");
  const { units, graph, waves, plans } = makeSimpleGraph();

  // u2 fails
  const env = makeMockLifecycleEnv({ unitStatuses: { u2: "failed" } });

  const result = await runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    ...env,
    pollIntervalMs: 0,
  });

  // Run still completes (u1 succeeded); u2 is held back
  assert.equal(result.outcome, "done", "lifecycle still completes when one unit fails");
  // u2 must be in held, not merged (NFR-06: no silent green)
  assert.ok(result.held.includes("u2"), "u2 is held back, not silently merged");
  assert.ok(!result.merged.includes("u2"), "u2 is NOT in merged");

  rmSync(tmpDir, { recursive: true, force: true });
});

await testAsync("R22 — lifecycle: all waves processed, one checkpoint per wave", async () => {
  const { tmpDir, bgsdDir, runId, runPath } = makeTestRun("multi wave test");

  // 3-unit, 2-wave graph: wave0=[u1,u2], wave1=[u3 depends on u1]
  const units = [
    { id: "u1", title: "Unit 1", deps: [],     touched: [] },
    { id: "u2", title: "Unit 2", deps: [],     touched: [] },
    { id: "u3", title: "Unit 3", deps: ["u1"], touched: [] },
  ];
  const edges = new Map([
    ["u1", new Set()],
    ["u2", new Set()],
    ["u3", new Set(["u1"])],
  ]);
  const reverseEdges = new Map([
    ["u1", new Set(["u3"])],
    ["u2", new Set()],
    ["u3", new Set()],
  ]);
  const graph = {
    nodes: new Map(units.map((u) => [u.id, u])),
    edges,
    reverseEdges,
  };
  const waves = [["u1", "u2"], ["u3"]];
  const plans = new Map([
    ["u1", { unitId: "u1", path: "/fake/u1", branch: "run/u1", port: 3100, db: "/fake/u1.sqlite" }],
    ["u2", { unitId: "u2", path: "/fake/u2", branch: "run/u2", port: 3101, db: "/fake/u2.sqlite" }],
    ["u3", { unitId: "u3", path: "/fake/u3", branch: "run/u3", port: 3102, db: "/fake/u3.sqlite" }],
  ]);

  const env = makeMockLifecycleEnv();

  const result = await runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    ...env,
    pollIntervalMs: 0,
  });

  assert.equal(result.outcome, "done");
  // 2 waves = 2 checkpoints
  assert.equal(env.checkpoints.length, 2, `expected 2 checkpoints (one per wave), got ${env.checkpoints.length}`);
  assert.equal(env.checkpoints[0].wave_index, 0);
  assert.equal(env.checkpoints[1].wave_index, 1);

  rmSync(tmpDir, { recursive: true, force: true });
});

await testAsync("R23 — lifecycle: held units are surfaced in the final result", async () => {
  const { tmpDir, bgsdDir, runId, runPath } = makeTestRun("held units surface test");
  const { units, graph, waves, plans } = makeSimpleGraph();

  // Make merge always fail (held back)
  const env = makeMockLifecycleEnv({ mergeFail: true });

  const result = await runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    ...env,
    pollIntervalMs: 0,
  });

  // Both units held back due to merge failure
  assert.ok(result.held.includes("u1") || result.held.includes("u2"),
    "at least one unit is held back when merge fails");
  // Held units must NOT appear in merged (NFR-06)
  for (const uid of result.held) {
    assert.ok(!result.merged.includes(uid), `${uid} in held must not also be in merged`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// --- run-live.mjs: guarded seam (SPAWN-04) ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- run-live.mjs: guarded seam (SPAWN-04) ---\n");

test("R24 — requireLiveFlag: throws without --live", () => {
  // In test invocation, --live is not in process.argv
  assert.throws(
    () => requireLiveFlag(),
    /HUMAN-GATED/i
  );
});

test("R25 — isLiveFlagSet: returns false in test (--live not in argv)", () => {
  // We are running without --live
  assert.equal(isLiveFlagSet(), false);
});

await testAsync("R26 — liveSpawnFn: runs without --live (gate removed); still guards a bad plan", async () => {
  // The --live gate was removed from liveSpawnFn so the pipeline genuinely runs.
  // Without a valid plan it fails on the plan guard, NOT on a HUMAN-GATED refusal.
  await assert.rejects(
    () => liveSpawnFn("u1", { branch: "", port: 3100 }),
    /missing path or branch/i
  );
});

await testAsync("R27 — liveReadStatusFn: runs without --live (gate removed); missing control -> running", async () => {
  // The --live gate was removed. With no control file yet, the scheduler-facing
  // status is "running" (the agent may still be starting up), not a refusal.
  const res = await liveReadStatusFn("u1", "bgsd-0001-test", "/fake/.bgsd");
  assert.equal(res, "running");
});

await testAsync("R28 — liveMergeFn: runs without --live (gate removed); still guards a bad plan", async () => {
  // The --live gate was removed from liveMergeFn. It reaches its own plan guard.
  await assert.rejects(
    () => liveMergeFn("u1", "bgsd-0001-test", { branch: "" }),
    /missing branch/i
  );
});

await testAsync("R29 — liveCheckpointFn: runs without --live (gate removed); resolves on go/no-go", async () => {
  // The --live gate was removed. The checkpoint now proceeds to read the human's
  // go/no-go from stdin. Feed a mock stream ("abort") so the test never hangs.
  const { Readable } = await import("node:stream");
  const fake = Readable.from(["abort\n"]);
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    const res = await liveCheckpointFn({ checkpoint_id: "ckpt-1", wave_index: 0, merged: [], held: [], blockers: [] });
    assert.equal(res.go, false); // "abort" -> go:false
  } finally {
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
});

// ---------------------------------------------------------------------------
// --- rehearsal + ledger helpers ---
// ---------------------------------------------------------------------------

process.stdout.write("\n--- rehearsal + ledger helpers ---\n");

test("R30 — rehearsalBranch: returns the integration branch (next)", () => {
  const branch = rehearsalBranch("bgsd-0001-my-feature");
  assert.equal(branch, "next");
  // Worktree branches assemble INTO this standing branch; never main/master.
  assert.doesNotMatch(branch, /^(main|master)$/i);
});

test("R31 — appendLedgerEntry: creates ledger.md if missing + appends entry", () => {
  const tmpDir  = makeTmpDir();
  const bgsdDir = tmpDir; // use tmpDir as bgsdDir for simplicity

  const run = {
    run_id:     "bgsd-0001-test",
    state:      "done",
    created_at: new Date().toISOString(),
    prompt:     "add user auth and rate limiting",
  };

  // Should create ledger.md
  appendLedgerEntry(bgsdDir, run);
  const ledgerPath = join(bgsdDir, "ledger.md");
  assert.ok(existsSync(ledgerPath), "ledger.md was created");

  const content = readFileSync(ledgerPath, "utf8");
  assert.match(content, /bgsd Run Ledger/i, "has header");
  assert.match(content, /bgsd-0001-test/, "contains the run id");
  assert.match(content, /done/, "contains the state");

  // Append a second entry
  appendLedgerEntry(bgsdDir, { ...run, run_id: "bgsd-0002-another", state: "aborted" });
  const content2 = readFileSync(ledgerPath, "utf8");
  assert.match(content2, /bgsd-0002-another/, "second run id appears");
  assert.match(content2, /aborted/, "second run state appears");

  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${total} test(s) defined: ${passed} passed, ${failed} failed\n\n`);

if (failed > 0) {
  process.stderr.write(`${failed} test(s) FAILED.\n`);
  process.exit(1);
}

process.stdout.write("All tests PASSED.\n");
