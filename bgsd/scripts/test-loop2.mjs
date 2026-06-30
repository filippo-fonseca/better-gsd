#!/usr/bin/env node
/**
 * test-loop2.mjs — Unit tests for loop2.mjs (LOOP2-01..04)
 *
 * All tests use fully mocked verify/fix/reMerge functions.
 * No real processes, no real app boot, no real git — pure DI-controlled logic.
 *
 * Tests:
 *   (a) Clean first integration pass -> integration_done (LOOP2-01/02/04)
 *   (b) FAIL -> fix -> reMerge -> PASS -> integration_done (LOOP2-03)
 *   (c) Never-converges -> max_iterations -> integration_failed (LOOP2-04)
 *   (d) No-progress (same defect signature twice) -> integration_failed (LOOP2-04)
 *   (e) BLOCKED verdict -> integration_blocked, fix NEVER called (LOOP2-04, NFR-06)
 *   (f) ERROR verdict   -> integration_blocked, fix NEVER called (LOOP2-04, NFR-06)
 *   (g) verify() throws -> integration_blocked (NFR-06)
 *   (h) fix() throws    -> integration_failed (NFR-06)
 *   (i) reMerge() throws -> integration_failed (NFR-06)
 *   (j) defectSignature — order-independent, deterministic
 *   (k) advanceStateFn called with "integrating" on loop start (LOOP2-01)
 *   (l) assembleIntegrationReport — reuses v0 shape + integration block (LOOP2-02)
 *   (m) Multi-step: FAIL->fix->reMerge->FAIL->fix->reMerge->PASS (2 iterations)
 *   (v) Argument validation
 *   (r) lastReport shape
 *
 * Uses node:assert — no external deps (NFR-05).
 * Exits non-zero on any failure (no silent green — NFR-06).
 */

import assert from "node:assert/strict";
import {
  runLoop2,
  defectSignature,
  assembleIntegrationReport,
} from "./loop2.mjs";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${label}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${label}\n         ${err.message}\n`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) process.stderr.write(`         ${l.trim()}\n`);
    }
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock verify() that returns successive values from `results`.
 * Each call pops the first item. If it runs out, throws to surface over-calling.
 */
function makeVerify(results) {
  const queue = [...results];
  return async function verify() {
    if (queue.length === 0) throw new Error("verify() called more times than expected");
    return queue.shift();
  };
}

/** Mock fix that records calls. */
function makeFix() {
  const calls = [];
  const fn = async (defects, opts) => { calls.push({ defects, opts }); };
  fn.calls = calls;
  return fn;
}

/** Mock reMerge that records calls. */
function makeReMerge() {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); };
  fn.calls = calls;
  return fn;
}

/** Null-op writeFn for tests that don't want disk writes. */
const noopWrite = () => null;

/** Mock advanceStateFn that records calls. */
function makeAdvanceState() {
  const calls = [];
  const fn = (toState, meta) => { calls.push({ toState, meta }); };
  fn.calls = calls;
  return fn;
}

// Standard PASS report shape
const PASS_REPORT = {
  verdict: "PASS",
  defects: [],
  criteria_results: [{ id: "c1", status: "pass", description: "ok", source: "uat", driver: "none", evidence: null }],
};

// Standard FAIL report shape with one defect
const FAIL_REPORT_A = {
  verdict: "FAIL",
  defects: [{ id: "d1", description: "login broken", severity: "high", source: "console" }],
  criteria_results: [{ id: "c1", status: "fail", description: "login", source: "uat", driver: "dom", evidence: "screenshot" }],
};

const BASE_OPTS = {
  runId: "bgsd-0001-test",
  rehearsalBranch: "rehearsal/bgsd-0001-test",
  writeFn: noopWrite,
};

// ---------------------------------------------------------------------------
// (j) defectSignature — order-independent, deterministic
// ---------------------------------------------------------------------------
process.stdout.write("\nbgsd loop2 unit tests (v3 Phase 1)\n");
process.stdout.write("\n--- defectSignature tests ---\n");

await test("(j1) empty defects -> 'empty'", async () => {
  assert.equal(defectSignature([]),     "empty");
  assert.equal(defectSignature(null),   "empty");
  assert.equal(defectSignature("nope"), "empty");
});

await test("(j2) same defects in different order -> same signature", async () => {
  const a = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];
  const b = [{ id: "d3" }, { id: "d1" }, { id: "d2" }];
  assert.equal(defectSignature(a), defectSignature(b));
});

await test("(j3) different defects -> different signature", async () => {
  const a = [{ id: "d1" }];
  const b = [{ id: "d2" }];
  assert.notEqual(defectSignature(a), defectSignature(b));
});

await test("(j4) falls back to description when id is absent", async () => {
  const a = [{ description: "foo broken" }];
  const b = [{ description: "foo broken" }];
  assert.equal(defectSignature(a), defectSignature(b));
});

// ---------------------------------------------------------------------------
// (l) assembleIntegrationReport — reuses v0 shape + integration block (LOOP2-02)
// ---------------------------------------------------------------------------
process.stdout.write("\n--- assembleIntegrationReport tests ---\n");

await test("(l1) scope is 'integration'", async () => {
  const r = assembleIntegrationReport({
    runId: "r1", rehearsalBranch: "rehearsal/r1", verdict: "PASS", iteration: 0,
  });
  assert.equal(r.scope,   "integration");
  assert.equal(r.verdict, "PASS");
  assert.equal(r.run_id,  "r1");
});

await test("(l2) integration block has rehearsal_branch + iteration + scrutiny fields", async () => {
  const r = assembleIntegrationReport({
    runId: "r1",
    rehearsalBranch: "rehearsal/r1",
    verdict: "FAIL",
    iteration: 2,
    scrutiny: { cross_boundary_uat: true, alignment_check: true },
  });
  assert.equal(r.integration.rehearsal_branch, "rehearsal/r1");
  assert.equal(r.integration.iteration,        2);
  assert.equal(r.integration.scrutiny.cross_boundary_uat,     true);
  assert.equal(r.integration.scrutiny.alignment_check,         true);
  assert.equal(r.integration.scrutiny.integrated_diff_review,  false);
  assert.equal(r.integration.scrutiny.improvement_scrutiny,    false);
});

await test("(l3) criteria_results and defects are passed through", async () => {
  const cr = [{ id: "c1", status: "fail" }];
  const de = [{ id: "d1", severity: "high" }];
  const r = assembleIntegrationReport({
    runId: "r1", rehearsalBranch: "rehearsal/r1", verdict: "FAIL",
    iteration: 0, criteriaResults: cr, defects: de,
  });
  assert.deepEqual(r.criteria_results, cr);
  assert.deepEqual(r.defects, de);
});

await test("(l4) generated_at is a valid ISO 8601 timestamp", async () => {
  const r = assembleIntegrationReport({
    runId: "r1", rehearsalBranch: "rehearsal/r1", verdict: "PASS", iteration: 0,
  });
  assert.ok(new Date(r.generated_at).getTime() > 0, "generated_at must be valid ISO 8601");
});

// ---------------------------------------------------------------------------
// (a) Clean first integration pass -> integration_done (LOOP2-01, LOOP2-04 SC1)
// ---------------------------------------------------------------------------
process.stdout.write("\n--- runLoop2 core tests ---\n");

await test("(a) clean first pass -> integration_done, reason pass, 0 iterations", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify:    makeVerify([PASS_REPORT]),
    fix,
    reMerge,
  });

  assert.equal(result.outcome,    "integration_done");
  assert.equal(result.reason,     "pass");
  assert.equal(result.iterations, 0);
  assert.equal(fix.calls.length,     0, "fix must not be called on a PASS");
  assert.equal(reMerge.calls.length, 0, "reMerge must not be called on a PASS");
});

// ---------------------------------------------------------------------------
// (b) FAIL -> fix -> reMerge -> PASS -> integration_done (LOOP2-03)
// ---------------------------------------------------------------------------
await test("(b) FAIL->fix->reMerge->PASS -> integration_done, reason pass, 1 iteration", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([FAIL_REPORT_A, PASS_REPORT]),
    fix,
    reMerge,
  });

  assert.equal(result.outcome,    "integration_done");
  assert.equal(result.reason,     "pass");
  assert.equal(result.iterations, 1);
  assert.equal(fix.calls.length,     1, "fix must be called exactly once");
  assert.equal(reMerge.calls.length, 1, "reMerge must be called exactly once");
  assert.deepEqual(fix.calls[0].defects, FAIL_REPORT_A.defects, "fix called with defects from FAIL report");
});

// ---------------------------------------------------------------------------
// (c) Never-converges -> max_iterations -> integration_failed (LOOP2-04)
// ---------------------------------------------------------------------------
await test("(c) never-converges -> max_iterations(3) -> integration_failed", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  // Each verify returns a DIFFERENT defect to avoid the no-progress short-circuit.
  // With maxIterations=3 the loop fires 3 fix+reMerge cycles then terminates.
  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([
      { verdict: "FAIL", defects: [{ id: "dA" }], criteria_results: [] },
      { verdict: "FAIL", defects: [{ id: "dB" }], criteria_results: [] },
      { verdict: "FAIL", defects: [{ id: "dC" }], criteria_results: [] },
      { verdict: "FAIL", defects: [{ id: "dD" }], criteria_results: [] }, // never reached
    ]),
    fix,
    reMerge,
    maxIterations: 3,
  });

  assert.equal(result.outcome,    "integration_failed");
  assert.equal(result.reason,     "max_iterations");
  assert.equal(result.iterations, 3);
  assert.equal(fix.calls.length,     3);
  assert.equal(reMerge.calls.length, 3);
});

// ---------------------------------------------------------------------------
// (d) No-progress (same defect signature twice) -> integration_failed early (LOOP2-04)
// ---------------------------------------------------------------------------
await test("(d) no-progress (same sig twice) -> integration_failed, reason no_progress", async () => {
  const fix      = makeFix();
  const reMerge  = makeReMerge();
  const SAME = [{ id: "d-stable" }];

  // 1st verify: FAIL with SAME (sets lastSignature)
  // fix + reMerge happens
  // 2nd verify: FAIL with SAME again -> no_progress
  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([
      { verdict: "FAIL", defects: SAME, criteria_results: [] },
      { verdict: "FAIL", defects: SAME, criteria_results: [] },
    ]),
    fix,
    reMerge,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "integration_failed");
  assert.equal(result.reason,  "no_progress");
  assert.equal(fix.calls.length,     1, "fix called once before no-progress detected");
  assert.equal(reMerge.calls.length, 1, "reMerge called once before no-progress detected");
  assert.equal(result.iterations,    1, "one complete fix+reMerge cycle before stop");
});

// ---------------------------------------------------------------------------
// (e) BLOCKED verdict -> integration_blocked, fix NEVER called (LOOP2-04, NFR-06)
// ---------------------------------------------------------------------------
await test("(e) BLOCKED verdict -> integration_blocked, fix not called", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([{ verdict: "BLOCKED", defects: [], criteria_results: [] }]),
    fix,
    reMerge,
  });

  assert.equal(result.outcome,            "integration_blocked");
  assert.equal(result.reason,             "blocked_verdict");
  assert.equal(fix.calls.length,          0, "fix must NOT be called on BLOCKED");
  assert.equal(reMerge.calls.length,      0, "reMerge must NOT be called on BLOCKED");
  assert.equal(result.iterations,         0);
});

// ---------------------------------------------------------------------------
// (f) ERROR verdict -> integration_blocked, fix NEVER called (LOOP2-04, NFR-06)
// ---------------------------------------------------------------------------
await test("(f) ERROR verdict -> integration_blocked, fix not called", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([{ verdict: "ERROR", defects: [], criteria_results: [] }]),
    fix,
    reMerge,
  });

  assert.equal(result.outcome,       "integration_blocked");
  assert.equal(result.reason,        "error_verdict");
  assert.equal(fix.calls.length,     0, "fix must NOT be called on ERROR");
  assert.equal(reMerge.calls.length, 0, "reMerge must NOT be called on ERROR");
});

// ---------------------------------------------------------------------------
// (g) verify() throws -> integration_blocked (NFR-06)
// ---------------------------------------------------------------------------
await test("(g) verify() throws -> integration_blocked, reason error_verdict", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify: async () => { throw new Error("tester crashed"); },
    fix,
    reMerge,
  });

  assert.equal(result.outcome,   "integration_blocked");
  assert.equal(result.reason,    "error_verdict");
  assert.equal(fix.calls.length, 0, "fix must NOT be called when verify() throws");
});

// ---------------------------------------------------------------------------
// (h) fix() throws -> integration_failed (NFR-06)
// ---------------------------------------------------------------------------
await test("(h) fix() throws -> integration_failed, reason fix_threw", async () => {
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([FAIL_REPORT_A]),
    fix:    async () => { throw new Error("fix agent exploded"); },
    reMerge,
  });

  assert.equal(result.outcome,       "integration_failed");
  assert.equal(result.reason,        "fix_threw");
  assert.equal(reMerge.calls.length, 0, "reMerge must not be called if fix throws");
});

// ---------------------------------------------------------------------------
// (i) reMerge() throws -> integration_failed (NFR-06)
// ---------------------------------------------------------------------------
await test("(i) reMerge() throws -> integration_failed, reason remerge_threw", async () => {
  const fix = makeFix();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify:  makeVerify([FAIL_REPORT_A]),
    fix,
    reMerge: async () => { throw new Error("merge conflict unresolvable"); },
  });

  assert.equal(result.outcome,    "integration_failed");
  assert.equal(result.reason,     "remerge_threw");
  assert.equal(fix.calls.length,  1, "fix IS called before reMerge");
});

// ---------------------------------------------------------------------------
// (k) advanceStateFn called with "integrating" at loop start (LOOP2-01)
// ---------------------------------------------------------------------------
await test("(k) advanceStateFn called with 'integrating' at loop start", async () => {
  const advance = makeAdvanceState();
  const fix     = makeFix();
  const reMerge = makeReMerge();

  await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([PASS_REPORT]),
    fix,
    reMerge,
    advanceStateFn: advance,
  });

  assert.ok(advance.calls.length >= 1, "advanceStateFn should be called at least once");
  assert.equal(advance.calls[0].toState, "integrating", "first call must target 'integrating'");
  assert.equal(
    advance.calls[0].meta.rehearsal_branch,
    BASE_OPTS.rehearsalBranch,
    "rehearsal_branch passed in meta"
  );
});

// ---------------------------------------------------------------------------
// (m) Multi-step: FAIL->FAIL->PASS over 2 iterations (LOOP2-03)
// ---------------------------------------------------------------------------
await test("(m) 2 FAIL cycles then PASS -> integration_done, 2 iterations", async () => {
  const fix     = makeFix();
  const reMerge = makeReMerge();

  const result = await runLoop2({
    ...BASE_OPTS,
    verify: makeVerify([
      { verdict: "FAIL", defects: [{ id: "d1" }], criteria_results: [] },
      { verdict: "FAIL", defects: [{ id: "d2" }], criteria_results: [] },
      PASS_REPORT,
    ]),
    fix,
    reMerge,
    maxIterations: 5,
  });

  assert.equal(result.outcome,    "integration_done");
  assert.equal(result.reason,     "pass");
  assert.equal(result.iterations, 2);
  assert.equal(fix.calls.length,     2, "fix called for each FAIL cycle");
  assert.equal(reMerge.calls.length, 2, "reMerge called for each FAIL cycle");
});

// ---------------------------------------------------------------------------
// Argument validation tests (v)
// ---------------------------------------------------------------------------
process.stdout.write("\n--- Argument validation tests ---\n");

await test("(v1) missing runId -> throws", async () => {
  await assert.rejects(
    () => runLoop2({ verify: async () => {}, fix: async () => {}, reMerge: async () => {} }),
    /runId is required/
  );
});

await test("(v2) missing verify -> throws", async () => {
  await assert.rejects(
    () => runLoop2({ runId: "r1", fix: async () => {}, reMerge: async () => {} }),
    /verify must be a function/
  );
});

await test("(v3) missing fix -> throws", async () => {
  await assert.rejects(
    () => runLoop2({ runId: "r1", verify: async () => {}, reMerge: async () => {} }),
    /fix must be a function/
  );
});

await test("(v4) missing reMerge -> throws", async () => {
  await assert.rejects(
    () => runLoop2({ runId: "r1", verify: async () => {}, fix: async () => {} }),
    /reMerge must be a function/
  );
});

// ---------------------------------------------------------------------------
// lastReport shape test (r)
// ---------------------------------------------------------------------------
process.stdout.write("\n--- lastReport shape tests ---\n");

await test("(r1) lastReport has scope:'integration' and correct verdict + run_id", async () => {
  const result = await runLoop2({
    ...BASE_OPTS,
    verify:   makeVerify([PASS_REPORT]),
    fix:      makeFix(),
    reMerge:  makeReMerge(),
  });

  assert.ok(result.lastReport,                         "lastReport should be present");
  assert.equal(result.lastReport.scope,   "integration");
  assert.equal(result.lastReport.verdict, "PASS");
  assert.equal(result.lastReport.run_id,  BASE_OPTS.runId);
});

await test("(r2) lastReport on FAIL has correct verdict and defects", async () => {
  const result = await runLoop2({
    ...BASE_OPTS,
    verify:  makeVerify([FAIL_REPORT_A]),
    fix:     async () => { throw new Error("intentional"); },
    reMerge: makeReMerge(),
  });

  assert.equal(result.lastReport.verdict, "FAIL");
  assert.ok(Array.isArray(result.lastReport.defects));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
process.stdout.write("\n");

if (failed > 0) {
  process.stderr.write(`${passed} passed, ${failed} FAILED\n`);
  process.exit(1);
} else {
  process.stdout.write(`${passed} passed, 0 failed\n`);
  process.stdout.write("All tests PASSED.\n");
  process.exit(0);
}
