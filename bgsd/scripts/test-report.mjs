#!/usr/bin/env node
/**
 * test-report.mjs — Unit tests for parse-criteria.mjs + build-report.mjs
 *
 * No external framework. Uses node:assert, node:fs, node:child_process.
 * Run with: node bgsd/scripts/test-report.mjs
 * Exits 0 on all-pass, non-zero on any failure.
 *
 * Test groups:
 *   T01 — parse-criteria: markdown file fixture → expected list
 *   T02 — parse-criteria: inline string → expected list
 *   T03 — parse-criteria: inline with embedded IDs preserved
 *   T04 — parse-criteria: inline split on newlines
 *   T05 — build-report FAIL case: fail criterion + console defect → verdict FAIL
 *   T06 — build-report PASS case: all pass, no defects → verdict PASS
 *   T07 — build-report ERROR case: input.error=true → verdict ERROR
 *   T08 — build-report: critical defect with all-pass criteria → verdict FAIL
 *   T09 — build-report stdout discipline: exactly one verdict line, no full JSON
 *   T10 — schema conformance: all required keys present with correct types/enums
 *   T11 — validateReport rejects missing required field
 *   T12 — validateReport rejects bad enum value
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { parseFile, parseInline } from "./parse-criteria.mjs";
import {
  computeVerdict,
  assembleReport,
  validateReport,
} from "./build-report.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dir, "__tests__");
const TMP_DIR = resolve(__dir, "../../.bgsd-tmp/test-report");

mkdirSync(TMP_DIR, { recursive: true });

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

/**
 * Build a minimal valid run-results object for testing.
 */
function makeRunResults(overrides = {}) {
  const defaults = {
    run_id: `test-${Date.now()}`,
    environment: {
      port: 3000,
      db: null,
      node_env: "development",
      framework: "nextjs",
      build_mode: "development",
      url: "http://localhost:3000",
    },
    criteria_results: [
      {
        id: "CRIT-01",
        description: "The page loads without errors.",
        source: "inline",
        status: "pass",
        driver: "console",
        evidence: null,
      },
    ],
    defects: [],
    screenshots: [],
    driver_ladder: {
      console: { ran: true, findings: 0 },
      network: { ran: true, findings: 0 },
      dom: { ran: true, findings: 0 },
      vision: { ran: false, findings: 0 },
    },
  };
  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
console.log("\nbgsd Phase-4 unit tests\n");

// --- T01: parseFile with markdown fixture ---
test("T01: parseFile(fixture-uispec.md) returns 5 criteria with correct IDs", () => {
  const criteria = parseFile(resolve(fixturesDir, "fixture-uispec.md"));

  // 4 checklist items from Success Criteria + 1 plain bullet without an ID
  assert.equal(
    criteria.length,
    5,
    `Expected 5 criteria, got ${criteria.length}: ${JSON.stringify(criteria.map((c) => c.id))}`
  );

  // First four preserve embedded IDs
  assert.equal(criteria[0].id, "CRIT-01");
  assert.equal(criteria[1].id, "CRIT-02");
  assert.equal(criteria[2].id, "CRIT-03");
  assert.equal(criteria[3].id, "CRIT-04");

  // Descriptions are stripped of markdown markers and ID prefixes
  assert.ok(
    criteria[0].description.includes("page loads"),
    `criteria[0].description should mention 'page loads': "${criteria[0].description}"`
  );
  assert.ok(
    criteria[2].description.includes("Submit"),
    `criteria[2].description should mention 'Submit': "${criteria[2].description}"`
  );

  // 5th item (plain bullet, no ID) gets auto-assigned ID
  assert.ok(
    criteria[4].id.startsWith("CRIT-"),
    `criteria[4] should get auto-assigned ID, got "${criteria[4].id}"`
  );

  // All source fields = absolute path to the fixture
  for (const c of criteria) {
    assert.ok(
      c.source.endsWith("fixture-uispec.md"),
      `source should end with fixture-uispec.md: "${c.source}"`
    );
  }
});

// --- T02: parseInline with semicolons ---
test("T02: parseInline('a; b; c') returns 3 criteria", () => {
  const criteria = parseInline("page loads without errors; nav has 5 items; submit fires POST");

  assert.equal(criteria.length, 3, `Expected 3, got ${criteria.length}`);
  assert.equal(criteria[0].id, "CRIT-01");
  assert.equal(criteria[1].id, "CRIT-02");
  assert.equal(criteria[2].id, "CRIT-03");

  assert.ok(criteria[0].description.includes("page loads"));
  assert.ok(criteria[1].description.includes("nav"));
  assert.ok(criteria[2].description.includes("submit"));

  for (const c of criteria) {
    assert.equal(c.source, "inline");
  }
});

// --- T03: parseInline preserves embedded IDs ---
test("T03: parseInline preserves embedded IDs like 'CRIT-05: ...'", () => {
  const criteria = parseInline("CRIT-05: Footer shows copyright; No console errors");

  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].id, "CRIT-05");
  assert.equal(
    criteria[0].description,
    "Footer shows copyright",
    `description should be stripped of 'CRIT-05: ': "${criteria[0].description}"`
  );
  // Second item gets auto-assigned, skipping 5 which is taken
  assert.equal(criteria[1].id, "CRIT-01");
});

// --- T04: parseInline splits on newlines ---
test("T04: parseInline splits on newlines as well as semicolons", () => {
  const criteria = parseInline("First criterion\nSecond criterion\nThird criterion");
  assert.equal(criteria.length, 3, `Expected 3, got ${criteria.length}`);
  assert.equal(criteria[0].description, "First criterion");
  assert.equal(criteria[1].description, "Second criterion");
  assert.equal(criteria[2].description, "Third criterion");
});

// --- T05: FAIL case — criterion fail + console defect ---
test(
  "T05: build-report FAIL — criterion status=fail + console defect → verdict FAIL, defect present",
  () => {
    const input = makeRunResults({
      criteria_results: [
        {
          id: "CRIT-01",
          description: "No console errors on load.",
          source: "inline",
          status: "fail",
          driver: "console",
          evidence: {
            kind: "console_error",
            entry: { type: "error", text: "Uncaught TypeError: Cannot read property 'x' of undefined" },
          },
        },
        {
          id: "CRIT-02",
          description: "Nav renders all items.",
          source: "inline",
          status: "pass",
          driver: "dom",
          evidence: null,
        },
      ],
      defects: [
        {
          id: "DEF-01",
          severity: "high",
          source: "console",
          description: "Uncaught TypeError during initial load.",
          evidence: {
            kind: "console_error",
            entry: { type: "error", text: "Uncaught TypeError: Cannot read property 'x' of undefined" },
          },
          criterion_id: "CRIT-01",
        },
      ],
    });

    const report = assembleReport(input);

    // Core assertion: verdict is FAIL
    assert.equal(report.verdict, "FAIL", `Expected FAIL, got ${report.verdict}`);

    // Defect is present and correctly mapped
    assert.equal(report.defects.length, 1, "Should have 1 defect");
    assert.equal(report.defects[0].id, "DEF-01");
    assert.equal(report.defects[0].source, "console");
    assert.equal(report.defects[0].criterion_id, "CRIT-01");
    assert.equal(report.defects[0].severity, "high");

    // Both criteria are in the report
    assert.equal(report.criteria.length, 2);
    assert.equal(
      report.criteria.find((c) => c.id === "CRIT-01").status,
      "fail"
    );
    assert.equal(
      report.criteria.find((c) => c.id === "CRIT-02").status,
      "pass"
    );

    // No false defects
    assert.equal(
      report.defects.filter((d) => d.criterion_id === "CRIT-02").length,
      0,
      "CRIT-02 should have no defects"
    );

    // Validate shape
    validateReport(report);
  }
);

// --- T06: PASS case ---
test("T06: build-report PASS — all criteria pass, zero defects → verdict PASS", () => {
  const input = makeRunResults();
  const report = assembleReport(input);

  assert.equal(report.verdict, "PASS", `Expected PASS, got ${report.verdict}`);
  assert.equal(report.defects.length, 0, "No defects expected");
  assert.equal(report.criteria.length, 1);
  assert.equal(report.criteria[0].status, "pass");

  validateReport(report);
});

// --- T07: ERROR case ---
test("T07: build-report ERROR — input.error=true → verdict ERROR", () => {
  const input = makeRunResults({ error: true });
  const report = assembleReport(input);

  assert.equal(report.verdict, "ERROR", `Expected ERROR, got ${report.verdict}`);
  validateReport(report);
});

// --- T08: critical defect + all-pass criteria → FAIL ---
test(
  "T08: build-report FAIL — critical defect even when all criteria pass",
  () => {
    const input = makeRunResults({
      defects: [
        {
          id: "DEF-01",
          severity: "critical",
          source: "network",
          description: "API endpoint returned 500.",
          evidence: { url: "/api/data", status: 500, ok: false },
          criterion_id: null,
        },
      ],
    });

    const report = assembleReport(input);
    assert.equal(report.verdict, "FAIL");
    validateReport(report);
  }
);

// --- T09: stdout discipline ---
test(
  "T09: build-report stdout discipline — exactly one verdict line, no JSON dump",
  () => {
    // Write a minimal run-results file to tmp
    const runId = `stdout-test-${Date.now()}`;
    const input = makeRunResults({ run_id: runId });
    const inputPath = resolve(TMP_DIR, `${runId}-input.json`);
    writeFileSync(inputPath, JSON.stringify(input), "utf8");

    // Run the script as a subprocess and capture stdout
    const scriptPath = resolve(__dir, "build-report.mjs");
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [scriptPath, inputPath], {
        encoding: "utf8",
      });
    } catch (err) {
      throw new Error(
        `build-report.mjs subprocess failed: ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`
      );
    }

    const lines = stdout.split("\n").filter((l) => l.trim() !== "");

    // Assert exactly one non-empty line
    assert.equal(
      lines.length,
      1,
      `Expected exactly 1 stdout line, got ${lines.length}:\n${stdout}`
    );

    const line = lines[0];

    // Assert the line is "PASS  <path>" or "FAIL  <path>"
    const verdictMatch = /^(PASS|FAIL|ERROR)\s+/.test(line);
    assert.ok(verdictMatch, `Line must start with PASS|FAIL|ERROR: "${line}"`);

    // Assert it contains the run directory path
    assert.ok(
      line.includes(runId),
      `Line must include run_id "${runId}": "${line}"`
    );

    // Assert the line does NOT contain a JSON dump (no '{' or '[')
    assert.ok(
      !line.includes("{") && !line.includes("["),
      `Stdout must not contain JSON: "${line}"`
    );
  }
);

// --- T10: schema conformance (all required keys with correct types/enums) ---
test("T10: assembled PASS report has every required key with correct types/enums", () => {
  const input = makeRunResults({
    criteria_results: [
      {
        id: "CRIT-01",
        description: "Page loads.",
        source: "inline",
        status: "pass",
        driver: "console",
        evidence: null,
      },
    ],
    screenshots: [{ label: "initial-load", path: "screenshot.png" }],
  });

  const report = assembleReport(input);

  // Top-level required fields
  assert.ok(typeof report.run_id === "string" && report.run_id.length > 0);
  assert.ok(
    typeof report.generated_at === "string" && report.generated_at.length > 0
  );
  assert.ok(["PASS", "FAIL", "ERROR"].includes(report.verdict));

  // environment
  assert.ok(typeof report.environment === "object" && report.environment !== null);
  assert.ok(typeof report.environment.url === "string");

  // criteria
  assert.ok(Array.isArray(report.criteria));
  const c = report.criteria[0];
  assert.ok(["pass", "fail", "skip"].includes(c.status));
  assert.ok(["console", "network", "dom", "vision", "none"].includes(c.driver));

  // defects
  assert.ok(Array.isArray(report.defects));

  // screenshots
  assert.ok(Array.isArray(report.screenshots));
  assert.equal(report.screenshots.length, 1);
  assert.ok(typeof report.screenshots[0].label === "string");
  assert.ok(typeof report.screenshots[0].path === "string");

  // driver_ladder
  for (const rung of ["console", "network", "dom", "vision"]) {
    const r = report.driver_ladder[rung];
    assert.ok(typeof r === "object" && r !== null);
    assert.ok(typeof r.ran === "boolean");
    assert.ok(typeof r.findings === "number" && Number.isInteger(r.findings));
  }

  validateReport(report);
});

// --- T11: validateReport rejects missing required field ---
test("T11: validateReport throws on missing required field (verdict)", () => {
  const input = makeRunResults();
  const report = assembleReport(input);
  delete report.verdict;

  assert.throws(
    () => validateReport(report),
    (err) =>
      err.name === "ValidationError" &&
      err.message.includes("verdict"),
    "Should throw ValidationError mentioning 'verdict'"
  );
});

// --- T12: validateReport rejects bad enum ---
test("T12: validateReport throws on bad enum value in criteria.status", () => {
  const input = makeRunResults();
  const report = assembleReport(input);
  report.criteria[0].status = "unknown";

  assert.throws(
    () => validateReport(report),
    (err) =>
      err.name === "ValidationError" &&
      err.message.includes("status"),
    "Should throw ValidationError mentioning 'status'"
  );
});

// ---------------------------------------------------------------------------
// Cleanup tmp
// ---------------------------------------------------------------------------
try {
  rmSync(TMP_DIR, { recursive: true, force: true });
} catch (_) {
  // best-effort
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed;
console.log(`\n${total} test(s): ${passed} passed, ${failed} failed`);

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
