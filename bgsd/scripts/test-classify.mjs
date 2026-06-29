#!/usr/bin/env node
/**
 * test-classify.mjs — Unit tests for classify-capture.mjs (DRIVER-02 + DRIVER-04)
 *
 * No external test framework: uses node:assert + node:fs only.
 * Run with: node bgsd/scripts/test-classify.mjs
 * Exits 0 on all-pass, non-zero on any failure.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Re-use classify() directly from the module (no subprocess overhead).
import { classify } from "./classify-capture.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dir, "__tests__");

function loadFixture(name) {
  const path = resolve(fixturesDir, name);
  return JSON.parse(readFileSync(path, "utf8"));
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
console.log("\nbgsd classify-capture tests\n");

// --- T01: validateDOMNesting → react_flag ---
test("T01: validateDOMNesting console error produces a react_flag", () => {
  const capture = loadFixture("fixture-react-validatedomnesting.json");
  const result = classify(capture);

  assert.equal(
    result.react_flags.length,
    1,
    `Expected 1 react_flag, got ${result.react_flags.length}`
  );
  assert.equal(
    result.react_flags[0].rule_id,
    "validateDOMNesting",
    "Flag should have rule_id=validateDOMNesting"
  );
  assert.ok(
    result.findings.some((f) => f.kind === "react_flag"),
    "findings should contain a react_flag entry"
  );
  assert.equal(
    result.console_reliable,
    true,
    "development mode => console_reliable=true"
  );
});

// --- T02: Hydration mismatch → react_flag ---
test("T02: Hydration mismatch error produces a react_flag", () => {
  const capture = loadFixture("fixture-hydration.json");
  const result = classify(capture);

  assert.equal(
    result.react_flags.length,
    1,
    `Expected 1 react_flag, got ${result.react_flags.length}`
  );
  assert.equal(
    result.react_flags[0].rule_id,
    "hydration_mismatch",
    "Flag should have rule_id=hydration_mismatch"
  );
});

// --- T03: Missing key prop → react_flag (from warning, not error) ---
test("T03: Missing key prop warning (type=warning) produces a react_flag", () => {
  const capture = loadFixture("fixture-missing-key.json");
  const result = classify(capture);

  assert.equal(
    result.react_flags.length,
    1,
    `Expected 1 react_flag, got ${result.react_flags.length}`
  );
  assert.equal(
    result.react_flags[0].rule_id,
    "missing_key_prop",
    "Flag should have rule_id=missing_key_prop"
  );
  // The source should be in the warnings bucket, not errors
  assert.equal(
    result.buckets.warnings.length,
    1,
    "Should be bucketed as a warning"
  );
  assert.equal(result.buckets.errors.length, 0, "errors bucket should be empty");
});

// --- T04: Clean fixture → ZERO findings, ZERO react_flags (no false positives) ---
test("T04: Clean fixture produces zero findings and zero react_flags", () => {
  const capture = loadFixture("fixture-clean.json");
  const result = classify(capture);

  assert.equal(
    result.findings.length,
    0,
    `Expected 0 findings, got ${result.findings.length}: ${JSON.stringify(result.findings)}`
  );
  assert.equal(
    result.react_flags.length,
    0,
    `Expected 0 react_flags, got ${result.react_flags.length}`
  );
  assert.equal(
    result.network_failures.length,
    0,
    "Expected 0 network_failures"
  );
  assert.equal(
    result.buckets.errors.length,
    0,
    "errors bucket should be empty"
  );
  assert.equal(
    result.buckets.warnings.length,
    0,
    "warnings bucket should be empty"
  );
  assert.equal(
    result.buckets.pageErrors.length,
    0,
    "pageErrors bucket should be empty"
  );
  assert.equal(result.console_reliable, true, "development => console_reliable");
});

// --- T05: Production mode → console_reliable=false (DRIVER-04) ---
test("T05: Production build_mode sets console_reliable=false", () => {
  const capture = loadFixture("fixture-prod-mode.json");
  const result = classify(capture);

  assert.equal(
    result.build_mode,
    "production",
    "build_mode should be 'production'"
  );
  assert.equal(
    result.console_reliable,
    false,
    "console_reliable must be false in production (DRIVER-04)"
  );
  // The error still gets bucketed even if unreliable — caller decides whether to act on it
  assert.equal(result.buckets.errors.length, 1, "error should still be bucketed");
});

// --- T06: Network 500 → network_failure ---
test("T06: HTTP 500 response produces a network_failure", () => {
  const capture = loadFixture("fixture-network-500.json");
  const result = classify(capture);

  assert.equal(
    result.network_failures.length,
    1,
    `Expected 1 network_failure, got ${result.network_failures.length}`
  );
  assert.equal(
    result.network_failures[0].status,
    500,
    "Failure entry should record status 500"
  );
  assert.ok(
    result.findings.some((f) => f.kind === "network_failure"),
    "findings should contain a network_failure"
  );
  // The 200 OK should NOT be a failure
  assert.equal(
    result.findings.filter((f) => f.kind === "network_failure").length,
    1,
    "Only the 500 should appear as a finding, not the 200"
  );
});

// --- T07: pageErrors are bucketed correctly ---
test("T07: pageErrors are placed in buckets.pageErrors and findings", () => {
  const capture = {
    console: [],
    pageErrors: [
      { message: "ReferenceError: foo is not defined", stack: "at app.js:10" },
    ],
    network: [],
    build_mode: "development",
  };
  const result = classify(capture);

  assert.equal(result.buckets.pageErrors.length, 1, "pageErrors bucket should have 1 entry");
  assert.ok(
    result.findings.some((f) => f.kind === "page_error"),
    "findings should contain a page_error"
  );
});

// --- T08: ok=false with status<400 is still a failure ---
test("T08: ok=false with status<400 is still classified as a network failure", () => {
  const capture = {
    console: [],
    pageErrors: [],
    network: [{ url: "http://localhost:3000/foo", status: 0, ok: false }],
    build_mode: "development",
  };
  const result = classify(capture);
  assert.equal(result.network_failures.length, 1, "ok=false should be a failure regardless of status");
});

// --- T09: ok=true with status 200 is NOT a failure ---
test("T09: ok=true with status 200 is not a network failure", () => {
  const capture = {
    console: [],
    pageErrors: [],
    network: [{ url: "http://localhost:3000/", status: 200, ok: true }],
    build_mode: "development",
  };
  const result = classify(capture);
  assert.equal(result.network_failures.length, 0, "clean 200 should not be a failure");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed;
console.log(`\n${total} assertion group(s): ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\nFailed tests:");
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("\nAll tests PASSED.");
  process.exit(0);
}
