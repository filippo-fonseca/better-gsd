#!/usr/bin/env node
/**
 * test-loop1.mjs — Unit tests for loop1.mjs (Phase 3: LOOP-01..05)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-loop1.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests use mocked verify() and fix() — zero process spawning.
 *
 * Test groups:
 *
 *   L01 — clean first pass: 1 verify call, done, iterations=0
 *   L02 — fail then pass: verify=FAIL once, fix once, verify=PASS -> done
 *   L03 — never converges: always FAIL, hits maxIterations -> failed
 *   L04 — no-progress: same defect signature twice -> stops early as failed
 *   L05 — BLOCKED verdict -> blocked, no further calls, never fabricates PASS
 *   L06 — ERROR verdict  -> blocked, no further calls, never fabricates PASS
 *   L07 — defectSignature: same defects (any order) -> same sig
 *   L08 — defectSignature: different defects -> different sig
 *   L09 — defectSignature: empty defects -> "empty"
 *   L10 — audit trail: every transition is timestamped and recorded
 *   L11 — iteration counter is accurately recorded in the terminal trail entry
 *   L12 — escalation: effort band is bumped after escalateAfterIters (LOOP-05)
 *   L13 — escalation: model tier is bumped after escalateModelAfterIters (LOOP-05)
 *   L14 — fix() throwing -> item lands in failed (not blocked), no re-try
 *   L15 — verify() throwing -> item lands in blocked, no re-try
 *   L16 — live seam: loop1-live.mjs refuses without --live flag
 *   L17 — isLiveFlagSet() returns false when --live is absent
 *   L18 — drainItem: wires runLoop1 and returns result for a PASS scenario
 */

import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import { runLoop1, defectSignature, drainItem } from "./loop1.mjs";
import { isLiveFlagSet } from "./loop1-live.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal queue item in `routed` state (the state runLoop1 expects).
 * @param {object} [overrides]
 * @returns {object}
 */
function makeItem(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "item-test-" + Math.random().toString(36).slice(2),
    title: "Test item",
    body: "",
    source: "manual",
    state: "routed",
    attempts: 1,
    gsd_command: "/gsd-quick",
    gsd_chain: [],
    route_class: "scoped-fix",
    route_model_profile: "balanced",
    route_effort: "medium",
    created_at: now,
    updated_at: now,
    trail: [],
    ...overrides,
  };
}

/**
 * Build a minimal transition function that validates transitions and records
 * them on the item, mirroring the real queue.mjs transition() logic.
 *
 * Allowed transitions (from queue.mjs TRANSITIONS table):
 *   routed      -> executing, needs_input, blocked
 *   executing   -> verifying, failed, blocked
 *   verifying   -> looping, done, failed, blocked
 *   looping     -> verifying, done, failed, blocked
 */
const ALLOWED = {
  routed:    new Set(["executing", "needs_input", "blocked"]),
  executing: new Set(["verifying", "failed", "blocked"]),
  verifying: new Set(["looping", "done", "failed", "blocked"]),
  looping:   new Set(["verifying", "done", "failed", "blocked"]),
  done:      new Set(),
  failed:    new Set(),
  blocked:   new Set(),
  needs_input: new Set(),
};

function makeTransition() {
  return function transition(item, toState, meta = {}) {
    const allowed = ALLOWED[item.state];
    if (!allowed || !allowed.has(toState)) {
      throw new Error(
        `test transition: illegal ${item.state} -> ${toState}`
      );
    }
    const prev = item.state;
    item.state = toState;
    item.updated_at = new Date().toISOString();
    item.trail = item.trail ?? [];
    item.trail.push({
      from: prev,
      to: toState,
      at: item.updated_at,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  };
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a verify mock that returns the given sequence of reports.
 * After the sequence is exhausted, returns the last report indefinitely.
 *
 * @param {Array<{verdict: string, defects?: object[]}>} sequence
 * @returns {{ mock: Function, calls: number[] }}
 */
function makeVerifyMock(sequence) {
  let calls = 0;
  const callLog = [];
  const mock = async () => {
    const idx = Math.min(calls, sequence.length - 1);
    const report = sequence[idx];
    calls++;
    callLog.push(calls);
    return {
      verdict: report.verdict,
      defects: report.defects ?? [],
      reportPath: `/fake/run/${calls}/verification-report.json`,
    };
  };
  return { mock, get calls() { return calls; }, callLog };
}

/**
 * Create a fix mock that records calls but does nothing.
 * @returns {{ mock: Function, calls: number, defectsReceived: Array }}
 */
function makeFixMock() {
  let calls = 0;
  const defectsReceived = [];
  const optsReceived = [];
  const mock = async (defects, opts) => {
    calls++;
    defectsReceived.push(defects);
    optsReceived.push(opts);
  };
  return {
    mock,
    get calls() { return calls; },
    defectsReceived,
    optsReceived,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${err.message}\n`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) process.stderr.write(`        ${l.trim()}\n`);
    }
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

process.stdout.write("\nbgsd loop1 unit tests (Phase 3)\n\n");

// ---------------------------------------------------------------------------
// L01 — clean first pass: 1 verify call, done, iterations=0
// ---------------------------------------------------------------------------
await test("L01: clean first pass -> 1 verify call, item=done, iterations=0", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();
  const verifyMock = makeVerifyMock([{ verdict: "PASS" }]);
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "done", "outcome must be 'done'");
  assert.equal(result.reason, "pass", "reason must be 'pass'");
  assert.equal(result.iterations, 0, "iterations must be 0 (no fix cycles)");
  assert.equal(verifyMock.calls, 1, "verify must be called exactly once");
  assert.equal(fixMock.calls, 0, "fix must never be called on a clean first pass");
  assert.equal(item.state, "done", "item.state must be 'done'");
});

// ---------------------------------------------------------------------------
// L02 — fail then pass: verify=FAIL once, fix once, verify=PASS -> done
// ---------------------------------------------------------------------------
await test("L02: FAIL -> fix -> PASS -> done (2 verify calls, 1 fix call)", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  const defects = [{ id: "D1", description: "nav broken" }];
  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects },
    { verdict: "PASS" },
  ]);
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "done", "outcome must be 'done'");
  assert.equal(result.reason, "pass", "reason must be 'pass'");
  assert.equal(verifyMock.calls, 2, "verify must be called twice (FAIL + PASS)");
  assert.equal(fixMock.calls, 1, "fix must be called exactly once");
  assert.equal(item.state, "done", "item.state must be 'done'");

  // Fix received the defect list from the first FAIL
  assert.deepEqual(fixMock.defectsReceived[0], defects, "fix must receive the defect list");
});

// ---------------------------------------------------------------------------
// L03 — never converges: always FAIL, hits maxIterations -> failed
// ---------------------------------------------------------------------------
await test("L03: always FAIL -> maxIterations -> item=failed, reason=max_iterations", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();
  const MAX = 3;

  // Alternating defect signatures so no-progress guard doesn't fire first
  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects: [{ id: "D1" }] },
    { verdict: "FAIL", defects: [{ id: "D2" }] },
    { verdict: "FAIL", defects: [{ id: "D3" }] },
    { verdict: "FAIL", defects: [{ id: "D4" }] },
    { verdict: "FAIL", defects: [{ id: "D5" }] },
  ]);
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: MAX,
  });

  assert.equal(result.outcome, "failed", "outcome must be 'failed'");
  assert.equal(result.reason, "max_iterations", "reason must be 'max_iterations'");
  assert.ok(result.iterations >= MAX, `iterations must be >= maxIterations (${MAX}), got ${result.iterations}`);
  assert.equal(item.state, "failed", "item.state must be 'failed'");
});

// ---------------------------------------------------------------------------
// L04 — no-progress: same defect signature twice -> stops early as failed
// ---------------------------------------------------------------------------
await test("L04: same defect signature recurs -> no_progress stop, item=failed", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  // The same defect appears twice consecutively — no-progress fires on second occurrence
  const sameDefects = [{ id: "D1", description: "nav broken" }];
  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects: sameDefects },
    { verdict: "FAIL", defects: sameDefects }, // same signature -> no_progress
  ]);
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 10, // high cap so max_iterations doesn't fire first
  });

  assert.equal(result.outcome, "failed", "outcome must be 'failed'");
  assert.equal(result.reason, "no_progress", "reason must be 'no_progress'");
  assert.equal(item.state, "failed", "item.state must be 'failed'");

  // Should stop before burning through max iterations
  assert.ok(verifyMock.calls <= 3, `verify should be called at most 3 times, got ${verifyMock.calls}`);
});

// ---------------------------------------------------------------------------
// L05 — BLOCKED verdict -> blocked, no further calls, never fabricates PASS
// ---------------------------------------------------------------------------
await test("L05: BLOCKED verdict -> item=blocked, no fix calls, no fabricated PASS", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  const verifyMock = makeVerifyMock([{ verdict: "BLOCKED", defects: [] }]);
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "blocked", "outcome must be 'blocked'");
  assert.equal(result.reason, "blocked_verdict", "reason must be 'blocked_verdict'");
  assert.equal(verifyMock.calls, 1, "verify must be called exactly once");
  assert.equal(fixMock.calls, 0, "fix must never be called after a BLOCKED verdict");
  assert.equal(item.state, "blocked", "item.state must be 'blocked'");
  // Confirm no silent done/pass
  assert.notEqual(item.state, "done", "item must NOT be in 'done' state");
});

// ---------------------------------------------------------------------------
// L06 — ERROR verdict -> blocked, no further calls, never fabricates PASS
// ---------------------------------------------------------------------------
await test("L06: ERROR verdict -> item=blocked, no fix calls, no fabricated PASS", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  const verifyMock = makeVerifyMock([{ verdict: "ERROR", defects: [] }]);
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "blocked", "outcome must be 'blocked' (ERROR maps to blocked)");
  assert.equal(result.reason, "error_verdict", "reason must be 'error_verdict'");
  assert.equal(fixMock.calls, 0, "fix must never be called after an ERROR verdict");
  assert.equal(item.state, "blocked", "item.state must be 'blocked'");
  assert.notEqual(item.state, "done", "item must NOT be in 'done' state");
});

// ---------------------------------------------------------------------------
// L07 — defectSignature: same defects in different order -> same sig
// ---------------------------------------------------------------------------
await test("L07: defectSignature is order-independent (same defects, different order)", () => {
  const defects1 = [{ id: "D1" }, { id: "D2" }, { id: "D3" }];
  const defects2 = [{ id: "D3" }, { id: "D1" }, { id: "D2" }];

  const sig1 = defectSignature(defects1);
  const sig2 = defectSignature(defects2);

  assert.equal(sig1, sig2, "same defects in different order must produce the same signature");
  assert.ok(sig1.length > 0, "signature must be non-empty");
});

// ---------------------------------------------------------------------------
// L08 — defectSignature: different defects -> different sig
// ---------------------------------------------------------------------------
await test("L08: defectSignature differentiates distinct defect sets", () => {
  const sigA = defectSignature([{ id: "D1" }]);
  const sigB = defectSignature([{ id: "D2" }]);
  const sigC = defectSignature([{ id: "D1" }, { id: "D2" }]);

  assert.notEqual(sigA, sigB, "different single defects must produce different signatures");
  assert.notEqual(sigA, sigC, "single defect vs pair must produce different signatures");
  assert.notEqual(sigB, sigC, "single defect vs pair must produce different signatures");
});

// ---------------------------------------------------------------------------
// L09 — defectSignature: empty defects -> "empty"
// ---------------------------------------------------------------------------
await test('L09: defectSignature([]) returns "empty"', () => {
  assert.equal(defectSignature([]), "empty", 'empty array must return "empty"');
  assert.equal(defectSignature(null), "empty", 'null must return "empty"');
  assert.equal(defectSignature(undefined), "empty", 'undefined must return "empty"');
});

// ---------------------------------------------------------------------------
// L10 — audit trail: every state transition is timestamped and recorded
// ---------------------------------------------------------------------------
await test("L10: audit trail — every transition is timestamped and recorded on item.trail", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();
  const verifyMock = makeVerifyMock([{ verdict: "PASS" }]);
  const fixMock = makeFixMock();

  await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
  });

  assert.ok(Array.isArray(item.trail), "item.trail must be an array");
  assert.ok(item.trail.length >= 3, `trail must have at least 3 entries (routed->executing->verifying->done), got ${item.trail.length}`);

  for (const entry of item.trail) {
    assert.ok(typeof entry.at === "string" && entry.at.length > 0, "every trail entry must have an 'at' timestamp");
    assert.ok(typeof entry.from === "string", "every trail entry must have a 'from' state");
    assert.ok(typeof entry.to === "string", "every trail entry must have a 'to' state");
  }

  // Final state in trail must be "done"
  const lastEntry = item.trail[item.trail.length - 1];
  assert.equal(lastEntry.to, "done", "final trail entry must transition to 'done'");
});

// ---------------------------------------------------------------------------
// L11 — iteration count recorded in the terminal trail entry
// ---------------------------------------------------------------------------
await test("L11: iteration count is recorded in the terminal trail entry's meta", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  const defects = [{ id: "D1" }];
  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects },
    { verdict: "PASS" },
  ]);
  const fixMock = makeFixMock();

  await runLoop1({ item, transitionFn, verify: verifyMock.mock, fix: fixMock.mock });

  // The done transition should carry iterations in its meta
  const doneEntry = item.trail.find((e) => e.to === "done");
  assert.ok(doneEntry, "trail must contain a done entry");
  assert.ok(doneEntry.meta, "done trail entry must have meta");
  assert.ok("iterations" in doneEntry.meta, "done trail entry meta must include iterations");
});

// ---------------------------------------------------------------------------
// L12 — escalation: effort band is bumped after escalateAfterIters (LOOP-05)
// ---------------------------------------------------------------------------
await test("L12: effort band escalates after escalateAfterIters fix failures (LOOP-05)", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  // Use unique defects each time to avoid no-progress guard
  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects: [{ id: "D1" }] },
    { verdict: "FAIL", defects: [{ id: "D2" }] },
    { verdict: "FAIL", defects: [{ id: "D3" }] },
    { verdict: "PASS" },
  ]);
  const fixMock = makeFixMock();

  await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 10,
    escalateAfterIters: 2,    // bump effort after 2 fix attempts
    initialEffort: "low",
  });

  // After 2 fix attempts effort should have been bumped from low -> medium
  // The bump is recorded in the audit trail and in optsReceived by fixMock
  const escalatedOpts = fixMock.optsReceived.find((o) => o.effort !== "low");
  assert.ok(
    escalatedOpts !== undefined,
    `fix should have been called with escalated effort after ${2} attempts; opts were: ${JSON.stringify(fixMock.optsReceived)}`
  );
});

// ---------------------------------------------------------------------------
// L13 — escalation: model tier is bumped after escalateModelAfterIters (LOOP-05)
// ---------------------------------------------------------------------------
await test("L13: model tier escalates after escalateModelAfterIters fix failures (LOOP-05)", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  // Use unique defects each time to avoid no-progress guard; need 5 FAIL + PASS
  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects: [{ id: "A1" }] },
    { verdict: "FAIL", defects: [{ id: "A2" }] },
    { verdict: "FAIL", defects: [{ id: "A3" }] },
    { verdict: "FAIL", defects: [{ id: "A4" }] },
    { verdict: "FAIL", defects: [{ id: "A5" }] },
    { verdict: "PASS" },
  ]);
  const fixMock = makeFixMock();

  await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
    maxIterations: 10,
    escalateAfterIters: 100,       // disable effort escalation for this test
    escalateModelAfterIters: 4,    // bump model after 4 fix attempts
    initialModel: "fast",
    initialEffort: "low",
  });

  // After 4 fix attempts model should have been bumped from fast -> balanced
  const escalatedOpts = fixMock.optsReceived.find((o) => o.model !== "fast");
  assert.ok(
    escalatedOpts !== undefined,
    `fix should have been called with escalated model after 4 attempts; opts were: ${JSON.stringify(fixMock.optsReceived)}`
  );
});

// ---------------------------------------------------------------------------
// L14 — fix() throwing -> item lands in failed, no re-try
// ---------------------------------------------------------------------------
await test("L14: fix() throwing -> item=failed (reason=fix_threw), no retry", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  const verifyMock = makeVerifyMock([
    { verdict: "FAIL", defects: [{ id: "D1" }] },
  ]);
  let fixCalls = 0;
  const brokenFix = async () => {
    fixCalls++;
    throw new Error("fix agent crashed");
  };

  const result = await runLoop1({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: brokenFix,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "failed", "outcome must be 'failed'");
  assert.equal(result.reason, "fix_threw", "reason must be 'fix_threw'");
  assert.equal(item.state, "failed", "item.state must be 'failed'");
  assert.equal(fixCalls, 1, "fix must only be called once (no retry after throw)");
});

// ---------------------------------------------------------------------------
// L15 — verify() throwing -> item lands in blocked, no re-try
// ---------------------------------------------------------------------------
await test("L15: verify() throwing -> item=blocked (reason=error_verdict), no retry", async () => {
  const item = makeItem();
  const transitionFn = makeTransition();

  let verifyCalls = 0;
  const brokenVerify = async () => {
    verifyCalls++;
    throw new Error("verify process could not spawn");
  };
  const fixMock = makeFixMock();

  const result = await runLoop1({
    item,
    transitionFn,
    verify: brokenVerify,
    fix: fixMock.mock,
    maxIterations: 5,
  });

  assert.equal(result.outcome, "blocked", "outcome must be 'blocked'");
  assert.equal(result.reason, "error_verdict", "reason must be 'error_verdict'");
  assert.equal(item.state, "blocked", "item.state must be 'blocked'");
  assert.equal(verifyCalls, 1, "verify must only be called once (no retry after throw)");
  assert.equal(fixMock.calls, 0, "fix must never be called after verify throws");
});

// ---------------------------------------------------------------------------
// L16 — live seam: loop1-live.mjs refuses without --live flag
// ---------------------------------------------------------------------------
await test("L16: live seam (loop1-live.mjs) refuses without --live flag", async () => {
  // Import the live functions; since --live is not in process.argv during
  // test execution, calling them must throw the human-gated refusal.
  const { liveVerify, liveFix, runLiveLoop1 } = await import("./loop1-live.mjs");

  await assert.rejects(
    () => liveVerify({ worktreePath: "/fake", runId: "r1" }),
    /HUMAN-GATED/,
    "liveVerify must refuse without --live"
  );

  await assert.rejects(
    () => liveFix([], {}, { worktreePath: "/fake", item: makeItem() }),
    /HUMAN-GATED/,
    "liveFix must refuse without --live"
  );

  await assert.rejects(
    () => runLiveLoop1({ item: makeItem(), transitionFn: makeTransition(), worktreePath: "/fake", runId: "r2" }),
    /HUMAN-GATED/,
    "runLiveLoop1 must refuse without --live"
  );
});

// ---------------------------------------------------------------------------
// L17 — isLiveFlagSet() returns false when --live is absent
// ---------------------------------------------------------------------------
await test("L17: isLiveFlagSet() returns false when --live is absent from process.argv", () => {
  // During test execution, --live is NOT in process.argv (we never pass it)
  assert.equal(isLiveFlagSet(), false, "isLiveFlagSet() must return false during test runs");
});

// ---------------------------------------------------------------------------
// L18 — drainItem: wires runLoop1 and returns PASS result
// ---------------------------------------------------------------------------
await test("L18: drainItem() wires runLoop1 and returns correct result for a PASS scenario", async () => {
  const item = makeItem(); // starts in "routed"
  const transitionFn = makeTransition();
  const verifyMock = makeVerifyMock([{ verdict: "PASS" }]);
  const fixMock = makeFixMock();

  const result = await drainItem({
    item,
    transitionFn,
    verify: verifyMock.mock,
    fix: fixMock.mock,
  });

  assert.equal(result.outcome, "done", "drainItem must return done for a clean PASS");
  assert.equal(result.reason, "pass", "drainItem reason must be pass");
  assert.equal(item.state, "done", "item.state must be done after drainItem");
});

// ---------------------------------------------------------------------------
// Summary (no silent green — NFR-06)
// ---------------------------------------------------------------------------
process.stdout.write(`\n18 test(s) defined: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) {
    process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  }
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
