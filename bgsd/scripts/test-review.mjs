#!/usr/bin/env node
/**
 * test-review.mjs — Unit tests for review.mjs (REVIEW-01..04)
 *
 * Tests (all deterministic, no real I/O, no real boots, mocked promptFn):
 *
 *   (a) buildReviewChecklist — items derived from integration-report criteria
 *   (b) buildReviewChecklist — items derived from integration-report defects
 *   (c) buildReviewChecklist — baseline items when no criteria/defects
 *   (d) buildVerdictQuestion — valid selector option-set (>=2 options + freeText)
 *   (e) buildVerdictQuestion — free-text/"other" affordance is present
 *   (f) resolveVerdict — "approve" -> "approved"
 *   (g) resolveVerdict — "request-changes" -> "request_changes"
 *   (h) resolveVerdict — "abort" -> "aborted"
 *   (i) resolveVerdict — null -> "needs_input"  (NEVER "approved") [NFR-06/11]
 *   (j) resolveVerdict — ""   -> "needs_input"  (NEVER "approved") [NFR-06/11]
 *   (k) resolveVerdict — undefined -> "needs_input" [NFR-06/11]
 *   (l) resolveVerdict — free text -> "request_changes"
 *   (m) writeReviewJson — schema round-trips correctly
 *   (n) writeReviewJson — verdict "needs_input" round-trips (never "approved" from null)
 *   (o) openReviewGate — no answer (null promptFn) -> needs_input, NOT approved [NFR-11]
 *   (p) openReviewGate — "approve" -> approved, advanceStateFn called with "done"
 *   (q) openReviewGate — "request-changes" -> request_changes, change_items populated
 *   (r) openReviewGate — "abort" -> aborted, advanceStateFn called with "aborted"
 *   (s) openReviewGate — free text -> request_changes
 *   (t) parseChangeItems — multi-line free text produces discrete items
 *   (u) parseChangeItems — structured items passthrough
 *   (v) liveBootRehearsalApp — refuses without --live flag [NFR-10]
 *   (w) liveBootRehearsalApp — dry-run (default) returns dryRun:true
 *   (x) buildKiwiReviewPrompt — contains URL, checklist labels, option ids
 *
 * Uses node:assert — no external deps (NFR-05).
 * Exits non-zero on any failure (no silent green — NFR-06).
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

import {
  buildReviewChecklist,
  buildVerdictQuestion,
  resolveVerdict,
  parseChangeItems,
  writeReviewJson,
  openReviewGate,
  liveBootRehearsalApp,
  buildKiwiReviewPrompt,
  isLiveFlagSet,
} from "./review.mjs";

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

const FIXTURE_INTEGRATION_REPORT = {
  run_id:       "bgsd-0001-test-feature",
  scope:        "integration",
  verdict:      "PASS",
  criteria_results: [
    { id: "AC-01", description: "User can log in with email and password", status: "pass" },
    { id: "AC-02", description: "Dashboard loads with correct data",        status: "pass" },
  ],
  defects: [
    { id: "D-01", description: "API returns 401 on /profile",
      severity: "high", file: "src/api/profile.ts", feature: "auth" },
  ],
};

const FIXTURE_RUN_ID = "bgsd-0001-test-feature";

// ---------------------------------------------------------------------------
// (a) buildReviewChecklist — items derived from criteria
// ---------------------------------------------------------------------------
await test("(a) buildReviewChecklist: items derived from integration-report criteria", () => {
  const items = buildReviewChecklist({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
  });

  // Should have 2 criteria items + 1 defect item = 3 total
  assert.ok(Array.isArray(items), "items should be an array");
  const criteriaItems = items.filter((i) => i.source === "criteria");
  assert.ok(criteriaItems.length >= 2, `expected >= 2 criteria items, got ${criteriaItems.length}`);

  // Each item has id, label, source, status
  for (const item of criteriaItems) {
    assert.ok(item.id, "item.id should be set");
    assert.ok(item.label, "item.label should be set");
    assert.strictEqual(item.source, "criteria");
    assert.strictEqual(item.status, "pending");
  }

  // Labels should reflect the criteria descriptions
  const labels = criteriaItems.map((i) => i.label);
  assert.ok(
    labels.some((l) => l.includes("log in") || l.includes("AC-01")),
    "expected a label containing AC-01 content"
  );
});

// ---------------------------------------------------------------------------
// (b) buildReviewChecklist — items derived from defects
// ---------------------------------------------------------------------------
await test("(b) buildReviewChecklist: items derived from integration-report defects", () => {
  const items = buildReviewChecklist({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
  });

  const defectItems = items.filter((i) => i.source === "defect");
  assert.ok(defectItems.length >= 1, `expected >= 1 defect item, got ${defectItems.length}`);

  const d = defectItems[0];
  assert.ok(d.label.includes("API returns 401") || d.label.includes("D-01"),
    `defect label should reference the defect: "${d.label}"`);
  assert.ok(d.label.includes("profile") || d.label.includes("auth"),
    `defect label should reference file or feature: "${d.label}"`);
});

// ---------------------------------------------------------------------------
// (c) buildReviewChecklist — baseline items when no criteria/defects
// ---------------------------------------------------------------------------
await test("(c) buildReviewChecklist: baseline items when report has no criteria/defects", () => {
  const items = buildReviewChecklist({
    runId:             FIXTURE_RUN_ID,
    integrationReport: { verdict: "PASS", criteria_results: [], defects: [] },
  });

  assert.ok(Array.isArray(items), "items should be an array");
  assert.ok(items.length >= 1, "should generate at least 1 baseline item");
  const baseline = items.filter((i) => i.source === "baseline");
  assert.ok(baseline.length >= 1, "should have at least 1 baseline item");
});

// ---------------------------------------------------------------------------
// (d) buildVerdictQuestion — valid selector option-set (>=2 options + freeText)
// ---------------------------------------------------------------------------
await test("(d) buildVerdictQuestion: valid GSD selector option-set with >=2 options", () => {
  const q = buildVerdictQuestion();

  assert.ok(typeof q.prompt === "string" && q.prompt.length > 0, "prompt should be a non-empty string");
  assert.ok(Array.isArray(q.options), "options should be an array");
  assert.ok(q.options.length >= 2, `expected >= 2 options, got ${q.options.length}`);

  // Each option has id, label, description
  for (const opt of q.options) {
    assert.ok(opt.id, `option.id should be set: ${JSON.stringify(opt)}`);
    assert.ok(opt.label, `option.label should be set: ${JSON.stringify(opt)}`);
    assert.ok(opt.description, `option.description should be set: ${JSON.stringify(opt)}`);
  }

  // Must include approve, request-changes, abort
  const ids = q.options.map((o) => o.id);
  assert.ok(ids.includes("approve"),          "options should include 'approve'");
  assert.ok(ids.includes("request-changes"),  "options should include 'request-changes'");
  assert.ok(ids.includes("abort"),            "options should include 'abort'");
});

// ---------------------------------------------------------------------------
// (e) buildVerdictQuestion — free-text/"other" affordance is present
// ---------------------------------------------------------------------------
await test("(e) buildVerdictQuestion: free-text/other affordance always present", () => {
  const q = buildVerdictQuestion();

  assert.ok(q.freeText, "freeText field should be present");
  assert.ok(q.freeText.id, "freeText.id should be set");
  assert.ok(q.freeText.label, "freeText.label should be set");
  // The "other" / free-text option must have a non-empty placeholder
  assert.ok(q.freeText.placeholder && q.freeText.placeholder.length > 0,
    "freeText.placeholder should be non-empty");
});

// ---------------------------------------------------------------------------
// (f) resolveVerdict — "approve" -> "approved"
// ---------------------------------------------------------------------------
await test("(f) resolveVerdict: 'approve' -> 'approved'", () => {
  assert.strictEqual(resolveVerdict("approve"), "approved");
});

// ---------------------------------------------------------------------------
// (g) resolveVerdict — "request-changes" -> "request_changes"
// ---------------------------------------------------------------------------
await test("(g) resolveVerdict: 'request-changes' -> 'request_changes'", () => {
  assert.strictEqual(resolveVerdict("request-changes"), "request_changes");
});

// ---------------------------------------------------------------------------
// (h) resolveVerdict — "abort" -> "aborted"
// ---------------------------------------------------------------------------
await test("(h) resolveVerdict: 'abort' -> 'aborted'", () => {
  assert.strictEqual(resolveVerdict("abort"), "aborted");
});

// ---------------------------------------------------------------------------
// (i) resolveVerdict — null -> "needs_input" (NEVER "approved") [NFR-06/11]
// ---------------------------------------------------------------------------
await test("(i) resolveVerdict: null -> 'needs_input' — NEVER 'approved' (NFR-11)", () => {
  const verdict = resolveVerdict(null);
  assert.strictEqual(verdict, "needs_input",
    `expected 'needs_input' for null answer, got '${verdict}'`);
  assert.notStrictEqual(verdict, "approved",
    "null answer MUST NOT resolve to 'approved' (NFR-11: gate never auto-passed)");
});

// ---------------------------------------------------------------------------
// (j) resolveVerdict — "" -> "needs_input" (NEVER "approved") [NFR-06/11]
// ---------------------------------------------------------------------------
await test("(j) resolveVerdict: '' -> 'needs_input' — NEVER 'approved' (NFR-11)", () => {
  const verdict = resolveVerdict("");
  assert.strictEqual(verdict, "needs_input",
    `expected 'needs_input' for empty string, got '${verdict}'`);
  assert.notStrictEqual(verdict, "approved");
});

// ---------------------------------------------------------------------------
// (k) resolveVerdict — undefined -> "needs_input" [NFR-06/11]
// ---------------------------------------------------------------------------
await test("(k) resolveVerdict: undefined -> 'needs_input' (NFR-11)", () => {
  const verdict = resolveVerdict(undefined);
  assert.strictEqual(verdict, "needs_input");
  assert.notStrictEqual(verdict, "approved");
});

// ---------------------------------------------------------------------------
// (l) resolveVerdict — free text -> "request_changes"
// ---------------------------------------------------------------------------
await test("(l) resolveVerdict: arbitrary free text -> 'request_changes'", () => {
  const verdict = resolveVerdict("The login button is broken on mobile");
  assert.strictEqual(verdict, "request_changes");
});

// ---------------------------------------------------------------------------
// (m) writeReviewJson — schema round-trips correctly
// ---------------------------------------------------------------------------
await test("(m) writeReviewJson: schema round-trips correctly", () => {
  const captured = {};
  const mockWriteFn = (tmpPath, content) => {
    captured.content = content;
  };

  const checklistItems = buildReviewChecklist({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
  });

  const result = writeReviewJson({
    runId:          FIXTURE_RUN_ID,
    bgsdDir:        "/tmp/bgsd-test-review-roundtrip",
    verdict:        "approved",
    checklistItems,
    freeText:       null,
    changeItems:    [],
    reviewedAt:     "2026-06-29T10:00:00.000Z",
    writeFn:        mockWriteFn,
  });

  assert.ok(captured.content, "writeFn should have been called");
  const parsed = JSON.parse(captured.content);

  assert.strictEqual(parsed.run_id,        FIXTURE_RUN_ID);
  assert.strictEqual(parsed.reviewed_at,   "2026-06-29T10:00:00.000Z");
  assert.strictEqual(parsed.verdict,       "approved");
  assert.ok(Array.isArray(parsed.checklist_items), "checklist_items should be array");
  assert.ok(parsed.checklist_items.length >= 1, "checklist_items should be non-empty");
  assert.strictEqual(parsed.free_text,     null);
  assert.ok(Array.isArray(parsed.change_items), "change_items should be array");
  assert.strictEqual(parsed.change_items.length, 0);

  // result.reviewJson should match the parsed object
  assert.deepStrictEqual(result.reviewJson, parsed);
});

// ---------------------------------------------------------------------------
// (n) writeReviewJson — verdict "needs_input" round-trips (never "approved" from null)
// ---------------------------------------------------------------------------
await test("(n) writeReviewJson: verdict 'needs_input' round-trips", () => {
  const captured = {};
  const mockWriteFn = (tmpPath, content) => { captured.content = content; };

  writeReviewJson({
    runId:          FIXTURE_RUN_ID,
    bgsdDir:        "/tmp/bgsd-test-needs-input",
    verdict:        "needs_input",
    checklistItems: [],
    freeText:       null,
    changeItems:    [],
    writeFn:        mockWriteFn,
  });

  const parsed = JSON.parse(captured.content);
  assert.strictEqual(parsed.verdict, "needs_input");
  assert.notStrictEqual(parsed.verdict, "approved",
    "a 'needs_input' verdict written to review.json must not be 'approved'");
});

// ---------------------------------------------------------------------------
// (o) openReviewGate — no answer (null promptFn) -> needs_input, NOT approved [NFR-11]
// ---------------------------------------------------------------------------
await test("(o) openReviewGate: unanswered gate -> needs_input, NEVER approved (NFR-11)", async () => {
  const states = [];
  const captured = {};

  const result = await openReviewGate({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
    bgsdDir:           "/tmp/bgsd-test-gate-no-answer",
    promptFn:          async () => null,   // ← no answer
    bootFn:            async ()  => ({ url: "http://localhost:3099", port: 3099, dryRun: true }),
    writeFn:           (opts) => { captured.review = opts; return { reviewJson: opts, reviewPath: "/tmp/review.json" }; },
    advanceStateFn:    (state, meta) => states.push({ state, meta }),
  });

  // Must be needs_input, NEVER approved (NFR-11)
  assert.strictEqual(result.verdict, "needs_input",
    `unanswered gate must resolve to 'needs_input', got '${result.verdict}'`);
  assert.notStrictEqual(result.verdict, "approved",
    "unanswered gate MUST NOT resolve to 'approved' (NFR-11)");

  // advanceStateFn should have been called with "review" first, then "needs_input"
  const stateNames = states.map((s) => s.state);
  assert.ok(stateNames.includes("review"),      "advanceStateFn should be called with 'review'");
  assert.ok(stateNames.includes("needs_input"), "advanceStateFn should be called with 'needs_input'");
  assert.ok(!stateNames.includes("done"),       "gate must NOT advance to 'done' when unanswered");
});

// ---------------------------------------------------------------------------
// (p) openReviewGate — "approve" -> approved, advanceStateFn called with "done"
// ---------------------------------------------------------------------------
await test("(p) openReviewGate: 'approve' -> approved, state advanced to 'done'", async () => {
  const states = [];

  const result = await openReviewGate({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
    bgsdDir:           "/tmp/bgsd-test-gate-approve",
    promptFn:          async () => "approve",
    bootFn:            async ()  => ({ url: "http://localhost:3099", port: 3099, dryRun: true }),
    writeFn:           ()     => ({ reviewJson: {}, reviewPath: "/tmp/review.json" }),
    advanceStateFn:    (state, meta) => states.push({ state, meta }),
  });

  assert.strictEqual(result.verdict, "approved");
  const stateNames = states.map((s) => s.state);
  assert.ok(stateNames.includes("done"), "approve should advance state to 'done'");
  assert.ok(!stateNames.includes("needs_input"), "approve must not park in needs_input");
});

// ---------------------------------------------------------------------------
// (q) openReviewGate — "request-changes" -> request_changes, change_items populated
// ---------------------------------------------------------------------------
await test("(q) openReviewGate: 'request-changes' -> request_changes with change_items", async () => {
  const states = [];
  let capturedWriteArgs;

  const result = await openReviewGate({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
    bgsdDir:           "/tmp/bgsd-test-gate-rc",
    promptFn:          async () => "The sidebar is broken\nLogin redirects incorrectly",
    bootFn:            async () => ({ url: "http://localhost:3099", port: 3099, dryRun: true }),
    writeFn:           (args) => { capturedWriteArgs = args; return { reviewJson: args, reviewPath: "/tmp/review.json" }; },
    advanceStateFn:    (state, meta) => states.push({ state, meta }),
  });

  assert.strictEqual(result.verdict, "request_changes");
  assert.ok(Array.isArray(result.changeItems), "changeItems should be an array");
  assert.ok(result.changeItems.length >= 1,    "changeItems should be non-empty for request_changes");

  const stateNames = states.map((s) => s.state);
  assert.ok(stateNames.includes("needs_input"), "request_changes should park in needs_input");
  assert.ok(!stateNames.includes("done"),       "request_changes must not advance to done");
});

// ---------------------------------------------------------------------------
// (r) openReviewGate — "abort" -> aborted, advanceStateFn called with "aborted"
// ---------------------------------------------------------------------------
await test("(r) openReviewGate: 'abort' -> aborted, state advanced to 'aborted'", async () => {
  const states = [];

  const result = await openReviewGate({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
    bgsdDir:           "/tmp/bgsd-test-gate-abort",
    promptFn:          async () => "abort",
    bootFn:            async () => ({ url: "http://localhost:3099", port: 3099, dryRun: true }),
    writeFn:           ()     => ({ reviewJson: {}, reviewPath: "/tmp/review.json" }),
    advanceStateFn:    (state, meta) => states.push({ state, meta }),
  });

  assert.strictEqual(result.verdict, "aborted");
  const stateNames = states.map((s) => s.state);
  assert.ok(stateNames.includes("aborted"), "abort should advance state to 'aborted'");
  assert.ok(!stateNames.includes("done"),   "abort must not advance to 'done'");
});

// ---------------------------------------------------------------------------
// (s) openReviewGate — free text -> request_changes
// ---------------------------------------------------------------------------
await test("(s) openReviewGate: free text -> request_changes", async () => {
  const result = await openReviewGate({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
    bgsdDir:           "/tmp/bgsd-test-gate-freetext",
    promptFn:          async () => "Something is off with the navigation",
    bootFn:            async () => ({ url: "http://localhost:3099", port: 3099, dryRun: true }),
    writeFn:           ()     => ({ reviewJson: {}, reviewPath: "/tmp/review.json" }),
    advanceStateFn:    () => {},
  });

  assert.strictEqual(result.verdict, "request_changes");
  assert.strictEqual(result.freeText, "Something is off with the navigation");
});

// ---------------------------------------------------------------------------
// (t) parseChangeItems — multi-line free text produces discrete items
// ---------------------------------------------------------------------------
await test("(t) parseChangeItems: multi-line free text produces discrete items", () => {
  const items = parseChangeItems(
    "The sidebar is broken\nLogin redirects incorrectly\nFont sizes are wrong"
  );

  assert.ok(Array.isArray(items), "should return an array");
  assert.ok(items.length >= 2, `expected >= 2 items, got ${items.length}`);
  for (const item of items) {
    assert.ok(item.id, "item.id should be set");
    assert.ok(item.description, "item.description should be set");
    assert.strictEqual(item.source, "human");
  }
});

// ---------------------------------------------------------------------------
// (u) parseChangeItems — structured items passthrough
// ---------------------------------------------------------------------------
await test("(u) parseChangeItems: structured items pass through unchanged", () => {
  const structured = [
    { id: "C-01", description: "Fix the sidebar", source: "review" },
    { id: "C-02", description: "Fix login redirect", source: "review" },
  ];
  const items = parseChangeItems(null, structured);

  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].id, "C-01");
  assert.strictEqual(items[1].description, "Fix login redirect");
});

// ---------------------------------------------------------------------------
// (v) liveBootRehearsalApp — refuses without --live flag [NFR-10]
// ---------------------------------------------------------------------------
await test("(v) liveBootRehearsalApp: dry-run without --live (boot is NOT executed)", () => {
  // Verify --live is NOT set in the test process (it should not be)
  assert.strictEqual(isLiveFlagSet(), false,
    "test must not be run with --live to test the guard");

  // In dry-run mode (default), liveBootRehearsalApp should return without throwing
  // and return dryRun: true
  const result = liveBootRehearsalApp({
    runId:            FIXTURE_RUN_ID,
    rehearsalBranch:  `rehearsal/${FIXTURE_RUN_ID}`,
    bgsdDir:          null,
    port:             3099,
  });

  assert.strictEqual(result.dryRun, true,
    "without --live, liveBootRehearsalApp must return dryRun: true (no live boot)");
  assert.ok(result.url.includes("localhost"), "url should contain localhost");
});

// ---------------------------------------------------------------------------
// (w) liveBootRehearsalApp — dry-run returns correct url shape
// ---------------------------------------------------------------------------
await test("(w) liveBootRehearsalApp: dry-run default returns url + port (NFR-10)", () => {
  const result = liveBootRehearsalApp({
    runId:           FIXTURE_RUN_ID,
    rehearsalBranch: `rehearsal/${FIXTURE_RUN_ID}`,
    bgsdDir:         null,
    port:            4200,
  });

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.port, 4200);
  assert.ok(result.url.includes("4200"), `url should include port 4200: ${result.url}`);
});

// ---------------------------------------------------------------------------
// (x) buildKiwiReviewPrompt — contains URL, checklist labels, option ids
// ---------------------------------------------------------------------------
await test("(x) buildKiwiReviewPrompt: output contains URL, checklist, and selector options", () => {
  const checklistItems = buildReviewChecklist({
    runId:             FIXTURE_RUN_ID,
    integrationReport: FIXTURE_INTEGRATION_REPORT,
  });
  const verdictQuestion = buildVerdictQuestion();

  const prompt = buildKiwiReviewPrompt({
    runId:             FIXTURE_RUN_ID,
    localhostUrl:      "http://localhost:3099",
    changelogSummary:  "Agent 1: added auth feature\nAgent 2: added dashboard",
    checklistItems,
    verdictQuestion,
  });

  assert.ok(typeof prompt === "string" && prompt.length > 0, "prompt should be a non-empty string");
  assert.ok(prompt.includes("http://localhost:3099"), "prompt should contain the localhost URL");
  assert.ok(prompt.includes("User can log in"), "prompt should contain a checklist label");
  assert.ok(prompt.includes("[approve]"), "prompt should contain the approve option id");
  assert.ok(prompt.includes("[request-changes]"), "prompt should contain the request-changes option id");
  assert.ok(prompt.includes("[abort]"), "prompt should contain the abort option id");
  assert.ok(prompt.includes("[other]") || prompt.includes("Type your own"),
    "prompt should contain the free-text affordance");
  assert.ok(prompt.includes("bgsd-0001-test-feature"), "prompt should contain the run ID");
  assert.ok(prompt.includes("needs_input") || prompt.includes("never auto-approved"),
    "prompt should mention the never-auto-pass rule");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write("\n");
process.stdout.write(`test-review.mjs: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
