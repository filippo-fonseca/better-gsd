#!/usr/bin/env node
/**
 * test-gui.mjs — Unit tests for gui.mjs (dashboard view model).
 *
 * node:assert + a local runner. Exits non-zero on any failure (no silent green).
 *
 * G01 — classifyAgentRole: verifier / integrator / reviewer / pipeline
 * G02 — laneForAgent: role maps to the right lane
 * G03 — gsdSubstage: known phases labelled, unknown falls through
 * G04 — phaseProgress: linear index; fixing maps to execute; unknown clamps to 0
 * G05 — normalizeAgent: flattens a control object to the UI shape
 * G06 — buildDashboardModel: lanes populated, counts correct, generated_at set
 * G07 — buildDashboardModel: empty run yields empty lanes + zero counts
 * G11 — agentFlow: an execute agent has discuss/ui/plan done, execute active, rest pending
 * G12 — agentFlow: a fixing agent re-lights execute as active
 * G13 — agentFlow: a done-status agent has the whole flow done
 * G14 — agentFlow: a blocked / failed agent marks its current step blocked
 * G15 — buildDashboardModel: every agent (model + lanes) carries a flow array
 * G16 — overallStatus: blocked > needs_input > running > done, empty is idle
 * G17 — summarizeSessions: newest-first ordering by mtime
 * G18 — summarizeSessions: status derivation (in-progress / completed / aborted)
 * G19 — summarizeSessions: counts present + entry shape
 * G20 — sessionStatus: run.state overrides agent-derived status
 *
 * gui-live daemonize path (the "localhost dies after ~20 min" fix):
 * D01 — startDaemon spawns process.execPath with the __serve argv, detached, unref'd
 * D02 — startDaemon reads the real port/url/pid back from the pointer the daemon writes
 * D03 — startDaemon passes an explicit --port through unchanged
 * D04 — startDaemon returns nulls (times out) when no pointer ever appears
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LANES,
  GSD_FLOW,
  PIPELINE_STAGES,
  classifyAgentRole,
  laneForAgent,
  gsdSubstage,
  phaseProgress,
  normalizeAgent,
  agentFlow,
  overallStatus,
  buildPipeline,
  buildDashboardModel,
  summarizeSessions,
  sessionStatus,
} from "./gui.mjs";

import { startDaemon, setStage } from "./gui-live.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

/**
 * A fake spawn: records the exact call and returns a child stub with pid + unref.
 * Never launches a real process, so the daemonize tests stay fast and hermetic.
 */
function fakeSpawn(record, { writesPointerTo } = {}) {
  return (cmd, argv, opts) => {
    record.cmd = cmd;
    record.argv = argv;
    record.opts = opts;
    record.unrefCalled = false;
    // Simulate the real daemon writing its pointer once it is listening, so the
    // poll in startDaemon has something to read back — without any real process.
    if (writesPointerTo) {
      writeFileSync(writesPointerTo, JSON.stringify({
        pid: 999999, port: 61234, url: "http://localhost:61234", run_id: "run-demo",
        started_at: new Date().toISOString(),
      }), "utf8");
    }
    return { pid: 424242, unref() { record.unrefCalled = true; } };
  };
}

// Temp .bgsd repo. Returns { dir, cleanup }.
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-gui-"));
  mkdirSync(join(dir, ".bgsd"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const agent = (agent_id, phase, status, extra = {}) => ({
  agent_id,
  phase,
  status,
  progress: { iteration: 1, max_iterations: 5, note: "" },
  heartbeat_at: "2026-06-30T12:00:00.000Z",
  ...extra,
});

process.stdout.write("\nbgsd gui dashboard-model tests\n\n");

test("G01 — classifyAgentRole infers role from id/unit", () => {
  assert.equal(classifyAgentRole({ agent_id: "verifier-1" }), "verifier");
  assert.equal(classifyAgentRole({ agent_id: "tester-a" }), "verifier");
  assert.equal(classifyAgentRole({ agent_id: "loop2-integrator" }), "integrator");
  assert.equal(classifyAgentRole({ unit_id: "rehearsal" }), "integrator");
  assert.equal(classifyAgentRole({ agent_id: "review-gate" }), "reviewer");
  assert.equal(classifyAgentRole({ agent_id: "unit-search-bar" }), "pipeline");
});

test("G02 — laneForAgent maps role to lane", () => {
  assert.equal(laneForAgent({ agent_id: "unit-1" }), "loop1");
  assert.equal(laneForAgent({ agent_id: "verifier-1" }), "verify");
  assert.equal(laneForAgent({ agent_id: "integrator" }), "loop2");
  assert.equal(laneForAgent({ agent_id: "review" }), "review");
  // every lane id is a real LANES entry
  const laneIds = new Set(LANES.map((l) => l.id));
  for (const a of ["unit-1", "verifier-1", "integrator", "review"]) {
    assert.ok(laneIds.has(laneForAgent({ agent_id: a })));
  }
});

test("G03 — gsdSubstage labels known phases, passes through unknown", () => {
  assert.equal(gsdSubstage("execute"), "Execute");
  assert.equal(gsdSubstage("ui"), "UI design");
  assert.equal(gsdSubstage("fixing"), "Fix → re-verify");
  assert.equal(gsdSubstage("mystery"), "mystery");
  assert.equal(gsdSubstage(undefined), "—");
});

test("G04 — phaseProgress linear; fixing->execute; unknown clamps", () => {
  assert.deepEqual(phaseProgress("discuss"), { index: 0, total: GSD_FLOW.length });
  assert.equal(phaseProgress("verify").index, GSD_FLOW.indexOf("verify"));
  assert.equal(phaseProgress("fixing").index, GSD_FLOW.indexOf("execute"));
  assert.equal(phaseProgress("bogus").index, 0);
});

test("G05 — normalizeAgent flattens a control object", () => {
  const n = normalizeAgent(agent("unit-search", "execute", "running", { unit_id: "search" }));
  assert.equal(n.id, "unit-search");
  assert.equal(n.unit, "search");
  assert.equal(n.role, "pipeline");
  assert.equal(n.lane, "loop1");
  assert.equal(n.substage, "Execute");
  assert.equal(n.status, "running");
  assert.equal(n.iteration, 1);
  assert.equal(n.max_iterations, 5);
});

test("G06 — buildDashboardModel populates lanes + counts", () => {
  const model = buildDashboardModel({
    run: { run_id: "run-x", title: "Ship The Thing", scale: "feature", state: "executing" },
    agents: [
      agent("unit-a", "execute", "running"),
      agent("unit-b", "done", "done"),
      agent("verifier-1", "verify", "running"),
      agent("integrator", "plan", "blocked"),
    ],
    now: Date.parse("2026-06-30T12:34:56.000Z"),
  });
  assert.equal(model.run.run_id, "run-x");
  assert.equal(model.run.title, "Ship The Thing", "buildDashboardModel returns the run title");
  assert.equal(model.run.generated_at, "2026-06-30T12:34:56.000Z");
  assert.equal(model.counts.total, 4);
  assert.equal(model.counts.running, 2);
  assert.equal(model.counts.done, 1);
  assert.equal(model.counts.blocked, 1);

  const lane = (id) => model.lanes.find((l) => l.id === id);
  assert.equal(lane("loop1").agents.length, 2, "two pipeline agents in loop1");
  assert.equal(lane("verify").agents.length, 1);
  assert.equal(lane("loop2").agents.length, 1);
  assert.equal(lane("review").agents.length, 0);
});

test("G07 — buildDashboardModel: empty run -> empty lanes + zero counts", () => {
  const model = buildDashboardModel({});
  assert.equal(model.counts.total, 0);
  assert.equal(model.agents.length, 0);
  assert.equal(model.lanes.length, LANES.length);
  for (const l of model.lanes) assert.equal(l.agents.length, 0);
  // title is null on an empty run (header falls back to run id / "live view").
  assert.equal(model.run.title, null, "empty run has a null title");
});

test("G08 — buildPipeline marks done/active/pending around the current stage", () => {
  const p = buildPipeline("decompose");
  const byId = Object.fromEntries(p.map((s) => [s.id, s.status]));
  assert.equal(byId.discuss, "done", "stages before current are done");
  assert.equal(byId.decompose, "active", "current stage is active");
  assert.equal(byId.loop1, "pending", "stages after current are pending");
  assert.equal(p.length, PIPELINE_STAGES.length);
});

test("G09 — buildPipeline: unknown/null stage leaves all pending", () => {
  for (const s of buildPipeline(null)) assert.equal(s.status, "pending");
  for (const s of buildPipeline("nope")) assert.equal(s.status, "pending");
});

test("G10 — buildDashboardModel surfaces pipeline + stage + note (pre-fan-out)", () => {
  const model = buildDashboardModel({
    run: { run_id: "r", scale: "project", stage: "discuss", note: "mapping the codebase" },
    agents: [],
  });
  assert.equal(model.run.stage, "discuss");
  assert.equal(model.run.note, "mapping the codebase");
  assert.ok(Array.isArray(model.pipeline), "model carries a pipeline timeline");
  assert.equal(model.pipeline.find((s) => s.id === "discuss").status, "active");
  assert.equal(model.counts.total, 0, "no agents yet, but stage is still visible");
});

test("G11 — agentFlow: execute agent has prior steps done, execute active, rest pending", () => {
  const flow = agentFlow(agent("unit-a", "execute", "running"));
  assert.equal(flow.length, GSD_FLOW.length, "flow spans the whole GSD flow");
  const byPhase = Object.fromEntries(flow.map((s) => [s.phase, s.status]));
  assert.equal(byPhase.discuss, "done");
  assert.equal(byPhase.ui, "done");
  assert.equal(byPhase.plan, "done");
  assert.equal(byPhase.execute, "active");
  assert.equal(byPhase.verify, "pending");
  assert.equal(byPhase.done, "pending");
  // steps carry their friendly labels too
  assert.equal(flow.find((s) => s.phase === "ui").label, "UI design");
});

test("G12 — agentFlow: fixing agent re-lights execute as active", () => {
  const flow = agentFlow(agent("unit-a", "fixing", "running"));
  const byPhase = Object.fromEntries(flow.map((s) => [s.phase, s.status]));
  assert.equal(byPhase.plan, "done", "steps before execute are done");
  assert.equal(byPhase.execute, "active", "fixing maps onto execute active");
  assert.equal(byPhase.verify, "pending");
});

test("G13 — agentFlow: done-status agent has the whole flow done", () => {
  const flow = agentFlow(agent("unit-a", "done", "done"));
  for (const s of flow) assert.equal(s.status, "done", `${s.phase} should be done`);
  // a phase of "done" with a still-running status also completes the flow
  const flow2 = agentFlow(agent("unit-b", "done", "running"));
  for (const s of flow2) assert.equal(s.status, "done");
});

test("G14 — agentFlow: blocked / failed agent marks its current step blocked", () => {
  const blocked = agentFlow(agent("unit-a", "plan", "blocked"));
  const bp = Object.fromEntries(blocked.map((s) => [s.phase, s.status]));
  assert.equal(bp.discuss, "done", "steps before current stay done");
  assert.equal(bp.ui, "done");
  assert.equal(bp.plan, "blocked", "the current step is blocked, not active");
  assert.equal(bp.execute, "pending");

  const failed = agentFlow(agent("unit-b", "execute", "failed"));
  const fp = Object.fromEntries(failed.map((s) => [s.phase, s.status]));
  assert.equal(fp.execute, "blocked", "a failed status blocks the current step");
});

test("G15 — buildDashboardModel puts a flow array on every agent", () => {
  const model = buildDashboardModel({
    run: { run_id: "run-x" },
    agents: [
      agent("unit-a", "execute", "running"),
      agent("verifier-1", "verify", "running"),
    ],
  });
  for (const a of model.agents) {
    assert.ok(Array.isArray(a.flow), "each model.agents entry carries a flow array");
    assert.equal(a.flow.length, GSD_FLOW.length);
    for (const s of a.flow) {
      assert.ok("phase" in s && "label" in s && "status" in s, "flow step has phase/label/status");
    }
  }
  // the same flow rides along inside each lane's agents
  const laneAgents = model.lanes.flatMap((l) => l.agents);
  assert.ok(laneAgents.length > 0);
  for (const a of laneAgents) assert.ok(Array.isArray(a.flow), "lane agents carry flow too");
});

test("G16 — overallStatus: blocked > needs_input > running > done, empty is idle", () => {
  assert.equal(overallStatus({ total: 0, running: 0, done: 0, blocked: 0, needs_input: 0 }), "idle");
  assert.equal(overallStatus({ total: 3, running: 2, done: 0, blocked: 1, needs_input: 1 }), "blocked");
  assert.equal(overallStatus({ total: 2, running: 1, done: 0, blocked: 0, needs_input: 1 }), "needs_input");
  assert.equal(overallStatus({ total: 2, running: 1, done: 1, blocked: 0, needs_input: 0 }), "running");
  assert.equal(overallStatus({ total: 2, running: 0, done: 2, blocked: 0, needs_input: 0 }), "done");
  // it also lands on the model
  const model = buildDashboardModel({ agents: [agent("unit-a", "execute", "running")] });
  assert.equal(model.overall, "running");
});

test("G16b — a live run.state stays in-progress even when all spawned agents are done (between waves)", () => {
  // The reported bug: mid-run, every agent spawned SO FAR is done (e.g. between
  // waves), which must NOT mark the session complete while run.state is live.
  const doneControls = [agent("u1", "execute", "done"), agent("u2", "execute", "done")];
  assert.equal(sessionStatus({ state: "executing" }, doneControls), "in-progress");
  assert.equal(sessionStatus({ state: "spawning" }, doneControls), "in-progress");
  // overallStatus: no running agents + a live state -> running, not done.
  assert.equal(overallStatus({ total: 2, running: 0, done: 2, blocked: 0, needs_input: 0 }, "executing"), "running");
  // Only a real done state (or no state at all) reports completed/done.
  assert.equal(sessionStatus({ state: "done" }, doneControls), "completed");
  assert.equal(sessionStatus({ state: "" }, doneControls), "completed");
  assert.equal(overallStatus({ total: 2, running: 0, done: 2, blocked: 0, needs_input: 0 }, "done"), "done");
});

test("G17 — summarizeSessions orders newest-first by mtime", () => {
  const sessions = summarizeSessions([
    { runId: "old", run: { scale: "quick", state: "done" }, controls: [], mtime: 100 },
    { runId: "new", run: { scale: "feature", state: "done" }, controls: [], mtime: 300 },
    { runId: "mid", run: { scale: "project", state: "done" }, controls: [], mtime: 200 },
  ]);
  assert.deepEqual(sessions.map((s) => s.run_id), ["new", "mid", "old"]);
  // updated_at is an ISO string derived from mtime.
  assert.equal(sessions[0].updated_at, new Date(300).toISOString());
});

test("G18 — summarizeSessions derives in-progress / completed / aborted", () => {
  const sessions = summarizeSessions([
    // in-progress: an agent is still running, no terminal run.state.
    {
      runId: "running-run",
      run: { scale: "feature", state: "executing", stage: "loop1" },
      controls: [agent("unit-a", "execute", "running"), agent("unit-b", "done", "done")],
      mtime: 30,
    },
    // completed: all agents terminal-done, no run.state hint.
    {
      runId: "done-run",
      run: { scale: "feature", stage: "review" },
      controls: [agent("unit-a", "done", "done"), agent("unit-b", "done", "done")],
      mtime: 20,
    },
    // aborted: an agent failed and nothing is still running.
    {
      runId: "bad-run",
      run: { scale: "feature", stage: "loop1" },
      controls: [agent("unit-a", "execute", "failed"), agent("unit-b", "done", "done")],
      mtime: 10,
    },
  ]);
  const byId = Object.fromEntries(sessions.map((s) => [s.run_id, s.status]));
  assert.equal(byId["running-run"], "in-progress");
  assert.equal(byId["done-run"], "completed");
  assert.equal(byId["bad-run"], "aborted");
});

test("G19 — summarizeSessions: counts present + entry shape", () => {
  const [s] = summarizeSessions([
    {
      runId: "run-x",
      run: { title: "Search Bar", scale: "feature", state: "executing", stage: "loop1" },
      controls: [agent("unit-a", "execute", "running"), agent("verifier-1", "verify", "blocked")],
      mtime: 500,
    },
  ]);
  assert.deepEqual(Object.keys(s).sort(), [
    "counts", "run_id", "scale", "stage", "state", "status", "title", "updated_at",
  ]);
  assert.equal(s.run_id, "run-x");
  assert.equal(s.title, "Search Bar", "summarizeSessions surfaces the title");
  assert.equal(s.scale, "feature");
  assert.equal(s.state, "executing");
  assert.equal(s.stage, "loop1");
  assert.equal(s.counts.total, 2);
  assert.equal(s.counts.running, 1);
  assert.equal(s.counts.blocked, 1);
  // internal sort key must not leak into the serialized entry.
  assert.equal(s._mtime, undefined);
});

test("G20 — sessionStatus: run.state overrides agent-derived status", () => {
  // Explicitly aborted run, even though an agent is still running.
  assert.equal(sessionStatus({ state: "aborted" }, [agent("a", "execute", "running")]), "aborted");
  // Explicitly completed run, even with no agents.
  assert.equal(sessionStatus({ state: "completed" }, []), "completed");
  // No run.state and no agents: nothing has happened yet.
  assert.equal(sessionStatus(null, []), "in-progress");
  // needs_input with nothing running is treated as aborted (needs the user).
  assert.equal(sessionStatus(null, [agent("a", "discuss", "needs_input")]), "aborted");
});

test("G23 — paused: overallStatus + sessionStatus surface a distinct paused badge (PAUSE-01)", () => {
  // A paused run wins the overall badge even when an agent still reads running,
  // and even when there are no agents at all (pause taken between waves).
  assert.equal(
    overallStatus({ total: 1, running: 1, done: 0, blocked: 0, needs_input: 0 }, "paused"),
    "paused"
  );
  assert.equal(overallStatus({ total: 0, running: 0, done: 0, blocked: 0, needs_input: 0 }, "paused"), "paused");
  // Without the paused state it behaves exactly as before.
  assert.equal(overallStatus({ total: 1, running: 1, done: 0, blocked: 0, needs_input: 0 }), "running");

  // sessionStatus reports "paused" regardless of agent dispositions.
  assert.equal(sessionStatus({ state: "paused" }, [agent("a", "execute", "running")]), "paused");
  assert.equal(sessionStatus({ state: "paused" }, []), "paused");

  // It flows through buildDashboardModel's overall field.
  const model = buildDashboardModel({
    run: { run_id: "r", state: "paused" },
    agents: [agent("unit-a", "execute", "running")],
  });
  assert.equal(model.overall, "paused");
});

test("G21 — summarizeSessions: title present, null when the run has none", () => {
  const sessions = summarizeSessions([
    { runId: "titled",   run: { title: "Add User Auth", state: "done" }, controls: [], mtime: 200 },
    { runId: "untitled", run: { state: "done" },                          controls: [], mtime: 100 },
  ]);
  const byId = Object.fromEntries(sessions.map((s) => [s.run_id, s.title]));
  assert.equal(byId["titled"], "Add User Auth", "title flows through to the summary");
  assert.equal(byId["untitled"], null, "a run with no title reports null (UI falls back to run id)");
});

test("G22 — setStage / title verb writes the title onto run.json", () => {
  const { dir, cleanup } = tempRepo();
  try {
    const runDir = join(dir, ".bgsd", "runs", "bgsd-0001-demo");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"),
      JSON.stringify({ run_id: "bgsd-0001-demo", state: "created" }), "utf8");

    // setStage with a title merges it onto run.json (like the `title` verb does).
    const written = setStage(dir, { runId: "bgsd-0001-demo", title: "Ship The Search Bar" });
    assert.equal(written.title, "Ship The Search Bar", "setStage returns the merged title");

    const onDisk = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    assert.equal(onDisk.title, "Ship The Search Bar", "title landed on run.json");
    assert.equal(onDisk.run_id, "bgsd-0001-demo", "existing fields preserved");
    assert.equal(onDisk.state, "created", "unrelated fields untouched");
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// gui-live daemonize path — the fix for the dashboard dying after ~20 minutes.
// These assert `start`'s detached-spawn contract WITHOUT booting a real daemon,
// by injecting a fake spawn (spawnImpl) and reading the port back from a pointer
// the fake writes (standing in for what the real listening daemon writes).
// ---------------------------------------------------------------------------

await (async () => {
  process.stdout.write("\nbgsd gui-live daemonize tests\n\n");

  await atest("D01 — startDaemon spawns node with __serve argv, detached + unref'd", async () => {
    const { dir, cleanup } = tempRepo();
    try {
      const rec = {};
      const spawnImpl = fakeSpawn(rec, { writesPointerTo: join(dir, ".bgsd", "gui.json") });
      await startDaemon(dir, { runId: "run-demo", port: 0, spawnImpl });

      assert.equal(rec.cmd, process.execPath, "spawns the same node binary running this test");
      // argv: [thisScript, "__serve", "--run-id", "run-demo", "--port", "0"]
      assert.ok(/gui-live\.mjs$/.test(rec.argv[0]), "argv[0] is the absolute gui-live.mjs path");
      assert.equal(rec.argv[1], "__serve", "invokes the internal daemon subcommand");
      const runIdx = rec.argv.indexOf("--run-id");
      assert.ok(runIdx >= 0 && rec.argv[runIdx + 1] === "run-demo", "passes --run-id through");
      const portIdx = rec.argv.indexOf("--port");
      assert.ok(portIdx >= 0 && rec.argv[portIdx + 1] === "0", "passes --port through (0 = auto)");
      assert.equal(rec.opts.detached, true, "detached so it survives the parent");
      assert.equal(rec.opts.cwd, dir, "runs in the repo root");
      assert.ok(Array.isArray(rec.opts.stdio) && rec.opts.stdio.length === 3, "stdio wires a log fd");
      assert.equal(rec.opts.stdio[0], "ignore", "stdin ignored");
      assert.equal(rec.unrefCalled, true, "child.unref() cuts it loose from this process");
    } finally { cleanup(); }
  });

  await atest("D02 — startDaemon reads real port/url/pid back from the daemon's pointer", async () => {
    const { dir, cleanup } = tempRepo();
    try {
      const rec = {};
      const spawnImpl = fakeSpawn(rec, { writesPointerTo: join(dir, ".bgsd", "gui.json") });
      const res = await startDaemon(dir, { runId: "run-demo", port: 0, spawnImpl });
      // The pointer the (fake) daemon wrote reports port 61234 — start must echo THAT,
      // not the requested 0, so the URL it prints is the one the daemon actually bound.
      assert.equal(res.port, 61234, "port comes from the pointer, not the request");
      assert.equal(res.url, "http://localhost:61234");
      assert.equal(res.pid, 999999, "pid is the daemon's (from pointer), not start's launcher pid");
      assert.equal(res.runId, "run-demo");
    } finally { cleanup(); }
  });

  await atest("D03 — startDaemon passes an explicit --port through unchanged", async () => {
    const { dir, cleanup } = tempRepo();
    try {
      const rec = {};
      const spawnImpl = fakeSpawn(rec, { writesPointerTo: join(dir, ".bgsd", "gui.json") });
      await startDaemon(dir, { runId: "run-demo", port: 52444, spawnImpl });
      const portIdx = rec.argv.indexOf("--port");
      assert.equal(rec.argv[portIdx + 1], "52444", "explicit port reaches the daemon argv");
    } finally { cleanup(); }
  });

  await atest("D04 — startDaemon times out to nulls when no pointer ever appears", async () => {
    const { dir, cleanup } = tempRepo();
    try {
      const rec = {};
      // A fake that never writes a pointer: the daemon never came up.
      const spawnImpl = fakeSpawn(rec);
      const res = await startDaemon(dir, { runId: "run-demo", port: 0, spawnImpl, timeoutMs: 120, intervalMs: 20 });
      assert.equal(res.url, null, "no url when the daemon never wrote its pointer");
      assert.equal(res.port, null, "no port either");
      assert.equal(res.pid, 424242, "falls back to the launcher child pid so callers can report something");
      assert.equal(rec.unrefCalled, true, "still detaches even on timeout");
    } finally { cleanup(); }
  });
})();

process.stdout.write(`\ngui.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("\nAll tests PASSED.\n");
