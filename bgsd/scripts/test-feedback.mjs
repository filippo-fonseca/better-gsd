#!/usr/bin/env node
/**
 * test-feedback.mjs — Unit tests for feedback.mjs (FEEDBACK-01..04)
 *
 * Tests (all deterministic, no real I/O, no spawning):
 *
 *   (a) parseFeedbackItems — review.json change_items -> fix items with stable ids
 *   (b) parseFeedbackItems — item shape: id, description, source, state, severity
 *   (c) parseFeedbackItems — free-text string -> discrete items (multi-line split)
 *   (d) parseFeedbackItems — single free-text line -> one item
 *   (e) parseFeedbackItems — empty source -> empty array
 *   (f) parseFeedbackItems — file/feature tags extracted from descriptions
 *
 *   (g) planReRun (full) — includes both loops ["loop1","loop2"] (FEEDBACK-02)
 *   (h) planReRun (full) — verified:true, result_status:"PENDING", NOT "UNVERIFIED"
 *   (i) planReRun (fast) — loops:["fast_fix"], verified:false (FEEDBACK-03)
 *   (j) planReRun (fast) — result_status is "UNVERIFIED", NOT "PASS" (NFR-06)
 *   (k) planReRun (fast) — verification_skipped:true (no silent green, NFR-06)
 *   (l) planReRun (fast, single trivial) — agent_strategy:"single", Haiku/low
 *   (m) planReRun (fast, multi) — agent_strategy:"parallel", Sonnet/medium
 *
 *   (n) ingestFeedback — review.json source: items parsed correctly (FEEDBACK-01)
 *   (o) ingestFeedback — full plan includes both loops (FEEDBACK-02)
 *   (p) ingestFeedback — fast plan is single-pass UNVERIFIED (FEEDBACK-03, NFR-06)
 *   (q) ingestFeedback — free-text source ingested as fix items (FEEDBACK-01)
 *   (r) ingestFeedback — plan has run_id, mode, items, re_run, planned_at
 *   (s) ingestFeedback — fast plan result_status NEVER equals "PASS" (NFR-06)
 *   (t) ingestFeedback — bounded: max_iterations respected in full plan (NFR-08)
 *
 *   (u) executeFeedbackPlan — refuses without --live flag (NFR-10)
 *   (v) executeFeedbackPlan — fast mode with injected fixFn: returns UNVERIFIED (NFR-06)
 *   (w) executeFeedbackPlan — full mode with injected loop1Fn+loop2Fn: returns result
 *   (x) executeFeedbackPlan — missing fixFn in fast mode throws (guard)
 *   (y) executeFeedbackPlan — missing loop1Fn in full mode throws (guard)
 *
 *   (z) inferSeverity — high/medium/low from keywords
 *   (aa) extractTags — file pattern detected
 *   (ab) extractTags — feature keyword detected
 *
 * Uses node:assert — no external deps (NFR-05).
 * Exits non-zero on any failure (no silent green — NFR-06).
 */

import assert from "node:assert/strict";

import {
  parseFeedbackItems,
  planReRun,
  ingestFeedback,
  executeFeedbackPlan,
  inferSeverity,
  extractTags,
  isLiveFlagSet,
  requireLiveFlag,
} from "./feedback.mjs";

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
// Fixture data
// ---------------------------------------------------------------------------

const SAMPLE_CHANGE_ITEMS = [
  { id: "change-1", description: "Login button crashes on mobile", source: "human" },
  { id: "change-2", description: "Dashboard loads slow — fix api/metrics.ts",  source: "human" },
  { id: "change-3", description: "Profile page 404 error",  source: "human" },
];

const FREE_TEXT_MULTI = [
  "The login page is broken",
  "Dashboard crashes with a 500 error",
  "Settings form doesn't save",
].join("\n");

// ---------------------------------------------------------------------------
// (a) parseFeedbackItems — review.json change_items -> fix items
// ---------------------------------------------------------------------------

await test("(a) parseFeedbackItems: change_items -> fix items with stable ids", () => {
  const items = parseFeedbackItems({ source: SAMPLE_CHANGE_ITEMS, runId: "run-001" });
  assert.equal(items.length, 3, "should produce 3 items from 3 change_items");
  for (const item of items) {
    assert.ok(item.id,          "each item must have an id");
    assert.ok(item.description, "each item must have a description");
    assert.equal(item.state, "pending", "each item must start as pending");
  }
});

// ---------------------------------------------------------------------------
// (b) parseFeedbackItems — item shape
// ---------------------------------------------------------------------------

await test("(b) parseFeedbackItems: item shape has id, description, source, state, severity", () => {
  const [item] = parseFeedbackItems({ source: SAMPLE_CHANGE_ITEMS, runId: "run-001" });
  assert.ok("id"          in item, "item must have id");
  assert.ok("description" in item, "item must have description");
  assert.ok("source"      in item, "item must have source");
  assert.ok("state"       in item, "item must have state");
  assert.ok("severity"    in item, "item must have severity");
  assert.ok("created_at"  in item, "item must have created_at");
  assert.equal(item.source, "review_json", "source must be review_json for structured input");
});

// ---------------------------------------------------------------------------
// (c) parseFeedbackItems — free-text multi-line split
// ---------------------------------------------------------------------------

await test("(c) parseFeedbackItems: free-text -> discrete items (multi-line split)", () => {
  const items = parseFeedbackItems({ source: FREE_TEXT_MULTI, runId: "run-001" });
  assert.ok(items.length >= 2, `should split multi-line text into >=2 items; got ${items.length}`);
  for (const item of items) {
    assert.equal(item.source, "free_text", "source must be free_text");
    assert.ok(item.description.length > 0, "description must not be empty");
  }
});

// ---------------------------------------------------------------------------
// (d) parseFeedbackItems — single free-text line -> one item
// ---------------------------------------------------------------------------

await test("(d) parseFeedbackItems: single free-text line -> one item", () => {
  const items = parseFeedbackItems({ source: "The login page is broken", runId: "run-001" });
  assert.equal(items.length, 1, "single line should produce exactly 1 item");
  assert.equal(items[0].source, "free_text");
});

// ---------------------------------------------------------------------------
// (e) parseFeedbackItems — empty source -> empty array
// ---------------------------------------------------------------------------

await test("(e) parseFeedbackItems: empty source -> empty array", () => {
  assert.deepEqual(parseFeedbackItems({ source: null,  runId: "r" }), []);
  assert.deepEqual(parseFeedbackItems({ source: "",    runId: "r" }), []);
  assert.deepEqual(parseFeedbackItems({ source: [],    runId: "r" }), []);
  assert.deepEqual(parseFeedbackItems({ source: "   ", runId: "r" }), []);
});

// ---------------------------------------------------------------------------
// (f) parseFeedbackItems — file/feature tag extraction
// ---------------------------------------------------------------------------

await test("(f) parseFeedbackItems: file/feature tags extracted from descriptions", () => {
  const items = parseFeedbackItems({
    source: "Fix api/metrics.ts — dashboard not loading",
    runId:  "run-001",
  });
  assert.equal(items.length, 1);
  // file should be detected (api/metrics.ts)
  assert.ok(items[0].file !== null || items[0].feature !== null, "should extract at least one tag");
});

// ---------------------------------------------------------------------------
// (g) planReRun (full) — includes both loops
// ---------------------------------------------------------------------------

await test("(g) planReRun (full): loops includes 'loop1' and 'loop2' (FEEDBACK-02)", () => {
  const plan = planReRun({ items: SAMPLE_CHANGE_ITEMS, mode: "full" });
  assert.ok(plan.loops.includes("loop1"), "full plan must include loop1");
  assert.ok(plan.loops.includes("loop2"), "full plan must include loop2");
});

// ---------------------------------------------------------------------------
// (h) planReRun (full) — verified:true, result_status:"PENDING"
// ---------------------------------------------------------------------------

await test("(h) planReRun (full): verified:true, result_status:'PENDING'", () => {
  const plan = planReRun({ items: SAMPLE_CHANGE_ITEMS, mode: "full" });
  assert.equal(plan.verified,             true,      "full plan must be verified");
  assert.equal(plan.result_status,        "PENDING", "full plan result_status must be PENDING, not UNVERIFIED");
  assert.equal(plan.verification_skipped, false,     "full plan must NOT skip verification");
});

// ---------------------------------------------------------------------------
// (i) planReRun (fast) — loops:["fast_fix"], verified:false
// ---------------------------------------------------------------------------

await test("(i) planReRun (fast): loops is ['fast_fix'], verified:false (FEEDBACK-03)", () => {
  const plan = planReRun({ items: SAMPLE_CHANGE_ITEMS, mode: "fast" });
  assert.deepEqual(plan.loops,   ["fast_fix"], "fast plan loops must be ['fast_fix']");
  assert.equal(plan.verified,    false,        "fast plan must NOT be verified (NFR-06)");
});

// ---------------------------------------------------------------------------
// (j) planReRun (fast) — result_status is "UNVERIFIED", NOT "PASS" (NFR-06)
// ---------------------------------------------------------------------------

await test("(j) planReRun (fast): result_status is 'UNVERIFIED', NOT 'PASS' (NFR-06)", () => {
  const plan = planReRun({ items: SAMPLE_CHANGE_ITEMS, mode: "fast" });
  assert.equal(plan.result_status, "UNVERIFIED", "fast plan must be UNVERIFIED");
  assert.notEqual(plan.result_status, "PASS", "fast plan must NEVER be PASS (no silent green)");
});

// ---------------------------------------------------------------------------
// (k) planReRun (fast) — verification_skipped:true (no silent green)
// ---------------------------------------------------------------------------

await test("(k) planReRun (fast): verification_skipped:true (no silent green, NFR-06)", () => {
  const plan = planReRun({ items: SAMPLE_CHANGE_ITEMS, mode: "fast" });
  assert.equal(plan.verification_skipped, true, "fast plan must mark verification_skipped:true");
});

// ---------------------------------------------------------------------------
// (l) planReRun (fast, single trivial) — agent_strategy:"single", Haiku/low
// ---------------------------------------------------------------------------

await test("(l) planReRun (fast, single trivial item): single agent, Haiku/low", () => {
  const trivialItem = [{ id: "x", description: "Minor text typo", severity: "low" }];
  const plan = planReRun({ items: trivialItem, mode: "fast" });
  assert.equal(plan.agent_strategy, "single",    "single trivial item -> single agent strategy");
  assert.equal(plan.model_hint,     "Haiku/low", "single trivial item -> Haiku/low model");
});

// ---------------------------------------------------------------------------
// (m) planReRun (fast, multi) — agent_strategy:"parallel", Sonnet/medium
// ---------------------------------------------------------------------------

await test("(m) planReRun (fast, multi items): parallel agents, Sonnet/medium", () => {
  const plan = planReRun({ items: SAMPLE_CHANGE_ITEMS, mode: "fast" });
  assert.equal(plan.agent_strategy, "parallel",      "multiple items -> parallel agents");
  assert.equal(plan.model_hint,     "Sonnet/medium", "multiple items -> Sonnet/medium");
});

// ---------------------------------------------------------------------------
// (n) ingestFeedback — review.json source: items parsed correctly
// ---------------------------------------------------------------------------

await test("(n) ingestFeedback: review.json change_items parsed into fix items (FEEDBACK-01)", () => {
  const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "full", runId: "run-001" });
  assert.equal(plan.items.length, 3, "should produce 3 fix items from 3 change_items");
  for (const item of plan.items) {
    assert.ok(item.id,          "each item must have an id");
    assert.ok(item.description, "each item must have a description");
    assert.equal(item.state, "pending");
  }
});

// ---------------------------------------------------------------------------
// (o) ingestFeedback — full plan includes both loops
// ---------------------------------------------------------------------------

await test("(o) ingestFeedback (full): plan includes both loop1 + loop2 (FEEDBACK-02)", () => {
  const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "full", runId: "run-001" });
  assert.ok(plan.re_run.loops.includes("loop1"), "re_run.loops must include loop1");
  assert.ok(plan.re_run.loops.includes("loop2"), "re_run.loops must include loop2");
});

// ---------------------------------------------------------------------------
// (p) ingestFeedback — fast plan is single-pass UNVERIFIED (FEEDBACK-03, NFR-06)
// ---------------------------------------------------------------------------

await test("(p) ingestFeedback (fast): single-pass plan marked UNVERIFIED (FEEDBACK-03, NFR-06)", () => {
  const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "fast", runId: "run-001" });
  assert.equal(plan.re_run.verified,             false,        "fast plan must NOT be verified");
  assert.equal(plan.re_run.verification_skipped, true,         "fast plan must skip verification");
  assert.equal(plan.re_run.result_status,        "UNVERIFIED", "fast plan must be UNVERIFIED");
  assert.deepEqual(plan.re_run.loops,            ["fast_fix"], "fast plan loops must be ['fast_fix']");
});

// ---------------------------------------------------------------------------
// (q) ingestFeedback — free-text source ingested as fix items
// ---------------------------------------------------------------------------

await test("(q) ingestFeedback: free-text source ingested as fix items (FEEDBACK-01)", () => {
  const plan = ingestFeedback({
    source: FREE_TEXT_MULTI,
    mode:   "full",
    runId:  "run-002",
  });
  assert.ok(plan.items.length >= 2, `free-text must produce >=2 items; got ${plan.items.length}`);
  for (const item of plan.items) {
    assert.equal(item.source, "free_text");
  }
});

// ---------------------------------------------------------------------------
// (r) ingestFeedback — plan shape
// ---------------------------------------------------------------------------

await test("(r) ingestFeedback: plan has run_id, mode, items, re_run, planned_at", () => {
  const plan = ingestFeedback({ source: "Something is broken", mode: "full", runId: "run-003" });
  assert.ok("run_id"     in plan, "plan must have run_id");
  assert.ok("mode"       in plan, "plan must have mode");
  assert.ok("items"      in plan, "plan must have items");
  assert.ok("re_run"     in plan, "plan must have re_run");
  assert.ok("planned_at" in plan, "plan must have planned_at");
  assert.equal(plan.run_id, "run-003");
  assert.equal(plan.mode,   "full");
});

// ---------------------------------------------------------------------------
// (s) ingestFeedback — fast plan result_status NEVER equals "PASS" (NFR-06)
// ---------------------------------------------------------------------------

await test("(s) ingestFeedback (fast): result_status NEVER equals 'PASS' (NFR-06)", () => {
  const plan = ingestFeedback({
    source: SAMPLE_CHANGE_ITEMS,
    mode:   "fast",
    runId:  "run-004",
  });
  assert.notEqual(
    plan.re_run.result_status,
    "PASS",
    "--fast result_status MUST NOT be 'PASS' — no silent green (NFR-06)"
  );
  assert.equal(plan.re_run.result_status, "UNVERIFIED");
});

// ---------------------------------------------------------------------------
// (t) ingestFeedback — bounded: max_iterations respected in full plan (NFR-08)
// ---------------------------------------------------------------------------

await test("(t) ingestFeedback (full): max_iterations bounded (NFR-08)", () => {
  const plan = ingestFeedback({
    source:        SAMPLE_CHANGE_ITEMS,
    mode:          "full",
    runId:         "run-005",
    maxIterations: 3,
  });
  assert.equal(plan.re_run.max_iterations, 3, "max_iterations must be respected");
});

// ---------------------------------------------------------------------------
// (u) executeFeedbackPlan — refuses without --live flag (NFR-10)
// ---------------------------------------------------------------------------

await test("(u) executeFeedbackPlan: refuses without --live flag (NFR-10)", async () => {
  // Guard: process.argv will NOT contain --live in this test run
  assert.equal(isLiveFlagSet(), false, "test must run without --live");

  const plan = ingestFeedback({ source: "A bug", mode: "full", runId: "run-006" });

  let threw = false;
  try {
    await executeFeedbackPlan({ plan, runId: "run-006" });
  } catch (err) {
    threw = true;
    assert.ok(
      err.message.includes("HUMAN-GATED"),
      `error must mention HUMAN-GATED; got: ${err.message.slice(0, 100)}`
    );
  }
  assert.ok(threw, "executeFeedbackPlan must throw without --live");
});

// ---------------------------------------------------------------------------
// (v) executeFeedbackPlan (fast mode, with injected --live + fixFn) — UNVERIFIED
// ---------------------------------------------------------------------------

await test("(v) executeFeedbackPlan (fast): injected fixFn returns UNVERIFIED result (NFR-06)", async () => {
  // We must temporarily inject --live into argv for this test.
  // Use a patched requireLiveFlag by bypassing it via the loop: inject loop via
  // module-level functions. The cleanest way without rewriting the module is to
  // pass a mock that exercises the fast-mode branch directly (without calling
  // requireLiveFlag), which we achieve by stubbing the argv.

  const originalArgv = process.argv.slice();
  process.argv.push("--live");

  try {
    const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "fast", runId: "run-007" });

    const mockFixFn = async ({ items }) => items.map((item) => ({ id: item.id, status: "fixed" }));

    const result = await executeFeedbackPlan({
      plan,
      runId:  "run-007",
      fixFn:  mockFixFn,
    });

    assert.equal(result.verified,             false,        "fast result must NOT be verified (NFR-06)");
    assert.equal(result.verification_skipped, true,         "fast result must mark verification_skipped");
    assert.equal(result.result_status,        "UNVERIFIED", "fast result must be UNVERIFIED");
    assert.notEqual(result.result_status,     "PASS",       "fast result must NEVER be PASS (NFR-06)");
    assert.equal(result.mode,                 "fast");
  } finally {
    process.argv.length = 0;
    for (const a of originalArgv) process.argv.push(a);
  }
});

// ---------------------------------------------------------------------------
// (w) executeFeedbackPlan (full mode, injected loop1Fn+loop2Fn)
// ---------------------------------------------------------------------------

await test("(w) executeFeedbackPlan (full): injected loop1Fn+loop2Fn called, returns result", async () => {
  const originalArgv = process.argv.slice();
  process.argv.push("--live");

  try {
    const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "full", runId: "run-008" });

    let loop1Called = false;
    let loop2Called = false;

    const mockLoop1Fn = async () => { loop1Called = true; return { status: "ok" }; };
    const mockLoop2Fn = async () => { loop2Called = true; return { verdict: "PASS" }; };

    const result = await executeFeedbackPlan({
      plan,
      runId:    "run-008",
      loop1Fn:  mockLoop1Fn,
      loop2Fn:  mockLoop2Fn,
    });

    assert.ok(loop1Called, "loop1Fn must be called in full mode");
    assert.ok(loop2Called, "loop2Fn must be called in full mode");
    assert.equal(result.mode,                 "full");
    assert.equal(result.verified,             true);
    assert.equal(result.verification_skipped, false);
    assert.equal(result.result_status,        "PASS");
  } finally {
    process.argv.length = 0;
    for (const a of originalArgv) process.argv.push(a);
  }
});

// ---------------------------------------------------------------------------
// (x) executeFeedbackPlan — missing fixFn in fast mode throws
// ---------------------------------------------------------------------------

await test("(x) executeFeedbackPlan (fast): missing fixFn throws guard error", async () => {
  const originalArgv = process.argv.slice();
  process.argv.push("--live");

  try {
    const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "fast", runId: "run-009" });

    let threw = false;
    try {
      await executeFeedbackPlan({ plan, runId: "run-009" }); // no fixFn
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("fixFn"), `error must mention fixFn; got: ${err.message}`);
    }
    assert.ok(threw, "must throw when fixFn is missing in fast mode");
  } finally {
    process.argv.length = 0;
    for (const a of originalArgv) process.argv.push(a);
  }
});

// ---------------------------------------------------------------------------
// (y) executeFeedbackPlan — missing loop1Fn in full mode throws
// ---------------------------------------------------------------------------

await test("(y) executeFeedbackPlan (full): missing loop1Fn throws guard error", async () => {
  const originalArgv = process.argv.slice();
  process.argv.push("--live");

  try {
    const plan = ingestFeedback({ source: SAMPLE_CHANGE_ITEMS, mode: "full", runId: "run-010" });

    let threw = false;
    try {
      await executeFeedbackPlan({ plan, runId: "run-010" }); // no loop1Fn
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("loop1Fn"), `error must mention loop1Fn; got: ${err.message}`);
    }
    assert.ok(threw, "must throw when loop1Fn is missing in full mode");
  } finally {
    process.argv.length = 0;
    for (const a of originalArgv) process.argv.push(a);
  }
});

// ---------------------------------------------------------------------------
// (z) inferSeverity — high/medium/low from keywords
// ---------------------------------------------------------------------------

await test("(z) inferSeverity: high/medium/low inferred from keywords", () => {
  assert.equal(inferSeverity("App crashes on login"),               "high",   "crash -> high");
  assert.equal(inferSeverity("Cannot load the page"),               "high",   "cannot -> high");
  assert.equal(inferSeverity("404 error on profile"),               "high",   "404 -> high");
  assert.equal(inferSeverity("Page loads slow"),                    "medium", "slow -> medium");
  assert.equal(inferSeverity("Dashboard looks a bit off"),          "medium", "off -> medium");
  assert.equal(inferSeverity("Minor cosmetic improvement needed"),  "low",    "no keywords -> low");
  assert.equal(inferSeverity(""),                                   "low",    "empty -> low");
});

// ---------------------------------------------------------------------------
// (aa) extractTags — file pattern detected
// ---------------------------------------------------------------------------

await test("(aa) extractTags: detects .ts / .mjs / .tsx file references", () => {
  const { file } = extractTags("Fix the bug in api/metrics.ts line 42");
  assert.ok(file !== null, "should detect .ts file reference");
  assert.ok(file?.includes("metrics.ts"), `file should include metrics.ts; got ${file}`);
});

// ---------------------------------------------------------------------------
// (ab) extractTags — feature keyword detected
// ---------------------------------------------------------------------------

await test("(ab) extractTags: detects feature keywords (login, dashboard, etc.)", () => {
  const { feature } = extractTags("The login form does not submit");
  assert.ok(feature !== null, "should detect 'login' feature keyword");
  assert.equal(feature, "login");
});

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

process.stdout.write("\n");
if (failed > 0) {
  process.stderr.write(`test-feedback: ${passed} passed, ${failed} FAILED\n`);
  process.exit(1);
} else {
  process.stdout.write(`test-feedback: ${passed} passed, 0 failed\n`);
  process.exit(0);
}
