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
 */

import assert from "node:assert/strict";

import {
  LANES,
  GSD_FLOW,
  PIPELINE_STAGES,
  classifyAgentRole,
  laneForAgent,
  gsdSubstage,
  phaseProgress,
  normalizeAgent,
  buildPipeline,
  buildDashboardModel,
} from "./gui.mjs";

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
    run: { run_id: "run-x", scale: "feature", state: "executing" },
    agents: [
      agent("unit-a", "execute", "running"),
      agent("unit-b", "done", "done"),
      agent("verifier-1", "verify", "running"),
      agent("integrator", "plan", "blocked"),
    ],
    now: Date.parse("2026-06-30T12:34:56.000Z"),
  });
  assert.equal(model.run.run_id, "run-x");
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

process.stdout.write(`\ngui.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("\nAll tests PASSED.\n");
