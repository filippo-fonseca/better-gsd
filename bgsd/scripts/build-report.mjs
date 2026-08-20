#!/usr/bin/env node
/**
 * build-report.mjs — REPORT-01..03 + verdict logic
 *
 * Reads a run-results JSON file, assembles a validated verification-report.json,
 * writes it to .bgsd/runs/<run_id>/verification-report.json, and prints exactly
 * ONE line to stdout:
 *
 *   PASS  .bgsd/runs/<run_id>/verification-report.json
 *   FAIL  .bgsd/runs/<run_id>/verification-report.json
 *   ERROR .bgsd/runs/<run_id>/verification-report.json
 *
 * NOTHING ELSE goes to stdout (VERIFY-03: no full JSON flooding stdout).
 * Errors go to stderr.
 *
 * Usage:
 *   node bgsd/scripts/build-report.mjs <run-results.json>
 *
 * Input shape (run-results.json):
 * {
 *   "run_id":          string,
 *   "environment":     { port, db, node_env, framework, build_mode, url },
 *   "criteria_results": [
 *     { id, description, source, status, driver, evidence }
 *   ],
 *   "defects":        [ { id, severity, source, description, evidence, criterion_id } ],
 *   "screenshots":    [ { label, path } ],
 *   "driver_ladder":  { console:{ran,findings}, network:{ran,findings},
 *                       dom:{ran,findings}, vision:{ran,findings} },
 *   "error":          boolean   (optional — if true, verdict is ERROR)
 * }
 *
 * No external deps (no ajv): structural validation is performed by hand.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { emitVerification } from "./remote-events.mjs";

// ---------------------------------------------------------------------------
// Verdict logic (REPORT-03)
// ---------------------------------------------------------------------------

/**
 * Compute the top-level verdict.
 *
 * Rules (in priority order):
 *   ERROR  — input signals an error/blocked state (input.error === true)
 *   FAIL   — any criterion has status "fail"
 *   FAIL   — any defect has severity "critical" or "high"
 *   PASS   — everything else
 *
 * @param {object} input  parsed run-results object
 * @returns {"PASS"|"FAIL"|"ERROR"}
 */
export function computeVerdict(input) {
  if (input.error === true) return "ERROR";

  const criteria = Array.isArray(input.criteria_results)
    ? input.criteria_results
    : [];
  const defects = Array.isArray(input.defects) ? input.defects : [];

  const anyFail = criteria.some((c) => c.status === "fail");
  if (anyFail) return "FAIL";

  const anyHighSeverity = defects.some(
    (d) => d.severity === "critical" || d.severity === "high"
  );
  if (anyHighSeverity) return "FAIL";

  return "PASS";
}

// ---------------------------------------------------------------------------
// Structural validation (hand-rolled, no ajv)
// ---------------------------------------------------------------------------

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function assertType(value, type, path) {
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${path}: expected array, got ${typeof value}`);
    }
    return;
  }
  if (typeof value !== type) {
    throw new ValidationError(
      `${path}: expected ${type}, got ${typeof value} (value: ${JSON.stringify(value)})`
    );
  }
}

function assertEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw new ValidationError(
      `${path}: expected one of [${allowed.join(", ")}], got "${value}"`
    );
  }
}

function assertString(value, path) {
  assertType(value, "string", path);
  if (value.length === 0) {
    throw new ValidationError(`${path}: must be a non-empty string`);
  }
}

function assertNullableString(value, path) {
  if (value !== null && value !== undefined) {
    assertType(value, "string", path);
  }
}

/**
 * Validate the assembled report object structurally.
 * Throws ValidationError on the first violation.
 *
 * @param {object} report  the assembled report object
 */
export function validateReport(report) {
  assertType(report, "object", "report");

  // Top-level required fields
  assertString(report.run_id, "report.run_id");
  assertString(report.generated_at, "report.generated_at");
  assertEnum(report.verdict, ["PASS", "FAIL", "ERROR"], "report.verdict");

  // environment
  const env = report.environment;
  assertType(env, "object", "report.environment");
  assertString(env.url, "report.environment.url");
  // port: integer or null
  if (env.port !== null && env.port !== undefined) {
    assertType(env.port, "number", "report.environment.port");
  }
  // build_mode: "development" | "production" | null
  if (env.build_mode !== null && env.build_mode !== undefined) {
    assertEnum(
      env.build_mode,
      ["development", "production"],
      "report.environment.build_mode"
    );
  }

  // criteria
  assertType(report.criteria, "array", "report.criteria");
  for (let i = 0; i < report.criteria.length; i++) {
    const c = report.criteria[i];
    const base = `report.criteria[${i}]`;
    assertType(c, "object", base);
    assertString(c.id, `${base}.id`);
    assertString(c.description, `${base}.description`);
    assertString(c.source, `${base}.source`);
    assertEnum(c.status, ["pass", "fail", "skip"], `${base}.status`);
    assertEnum(
      c.driver,
      ["console", "network", "dom", "vision", "none"],
      `${base}.driver`
    );
    // evidence: any (null, string, object) — just needs to be present
    if (!Object.prototype.hasOwnProperty.call(c, "evidence")) {
      throw new ValidationError(`${base}.evidence: field is required`);
    }
  }

  // defects
  assertType(report.defects, "array", "report.defects");
  for (let i = 0; i < report.defects.length; i++) {
    const d = report.defects[i];
    const base = `report.defects[${i}]`;
    assertType(d, "object", base);
    assertString(d.id, `${base}.id`);
    assertEnum(
      d.severity,
      ["critical", "high", "medium", "low"],
      `${base}.severity`
    );
    assertEnum(
      d.source,
      ["console", "network", "dom", "vision"],
      `${base}.source`
    );
    assertString(d.description, `${base}.description`);
    if (!Object.prototype.hasOwnProperty.call(d, "evidence")) {
      throw new ValidationError(`${base}.evidence: field is required`);
    }
    assertNullableString(d.criterion_id, `${base}.criterion_id`);
  }

  // screenshots
  assertType(report.screenshots, "array", "report.screenshots");
  for (let i = 0; i < report.screenshots.length; i++) {
    const s = report.screenshots[i];
    const base = `report.screenshots[${i}]`;
    assertType(s, "object", base);
    assertString(s.label, `${base}.label`);
    assertString(s.path, `${base}.path`);
  }

  // driver_ladder
  const dl = report.driver_ladder;
  assertType(dl, "object", "report.driver_ladder");
  for (const rung of ["console", "network", "dom", "vision"]) {
    const r = dl[rung];
    const base = `report.driver_ladder.${rung}`;
    assertType(r, "object", base);
    assertType(r.ran, "boolean", `${base}.ran`);
    assertType(r.findings, "number", `${base}.findings`);
    if (!Number.isInteger(r.findings) || r.findings < 0) {
      throw new ValidationError(
        `${base}.findings: must be a non-negative integer`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble the full verification-report object from run-results input.
 *
 * @param {object} input  parsed run-results JSON
 * @returns {object}  assembled report (before writing to disk)
 */
export function assembleReport(input) {
  const verdict = computeVerdict(input);

  const report = {
    run_id: input.run_id,
    generated_at: new Date().toISOString(),
    verdict,
    environment: {
      port: input.environment?.port ?? null,
      db: input.environment?.db ?? null,
      node_env: input.environment?.node_env ?? null,
      framework: input.environment?.framework ?? null,
      build_mode: input.environment?.build_mode ?? null,
      url: input.environment?.url ?? "",
    },
    criteria: (input.criteria_results ?? []).map((c) => ({
      id: c.id,
      description: c.description,
      source: c.source,
      status: c.status,
      driver: c.driver,
      evidence: c.evidence ?? null,
    })),
    defects: (input.defects ?? []).map((d) => ({
      id: d.id,
      severity: d.severity,
      source: d.source,
      description: d.description,
      evidence: d.evidence ?? null,
      criterion_id: d.criterion_id ?? null,
    })),
    screenshots: (input.screenshots ?? []).map((s) => ({
      label: s.label,
      path: s.path,
    })),
    driver_ladder: {
      console: {
        ran: input.driver_ladder?.console?.ran ?? false,
        findings: input.driver_ladder?.console?.findings ?? 0,
      },
      network: {
        ran: input.driver_ladder?.network?.ran ?? false,
        findings: input.driver_ladder?.network?.findings ?? 0,
      },
      dom: {
        ran: input.driver_ladder?.dom?.ran ?? false,
        findings: input.driver_ladder?.dom?.findings ?? 0,
      },
      vision: {
        ran: input.driver_ladder?.vision?.ran ?? false,
        findings: input.driver_ladder?.vision?.findings ?? 0,
      },
    },
  };

  return report;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write a report object to disk.
 *
 * @param {object} report  validated report object
 * @param {string} outDir  directory to write to (created if absent)
 * @returns {string}  absolute path to the written file
 */
export function writeReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "verification-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  return outPath;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (argv.length === 0) {
    process.stderr.write("Usage: build-report.mjs <run-results.json>\n");
    process.exit(1);
  }

  const inputPath = resolve(process.cwd(), argv[0]);
  let raw;
  try {
    raw = readFileSync(inputPath, "utf8");
  } catch (err) {
    process.stderr.write(`Error reading input: ${err.message}\n`);
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Error parsing JSON: ${err.message}\n`);
    process.exit(1);
  }

  if (!input.run_id) {
    process.stderr.write("Error: input JSON must have a run_id field.\n");
    process.exit(1);
  }

  let report;
  try {
    report = assembleReport(input);
    validateReport(report);
  } catch (err) {
    process.stderr.write(`Validation error: ${err.message}\n`);
    process.exit(1);
  }

  const outDir = resolve(process.cwd(), `.bgsd/runs/${input.run_id}`);
  let outPath;
  try {
    outPath = writeReport(report, outDir);
  } catch (err) {
    process.stderr.write(`Error writing report: ${err.message}\n`);
    process.exit(1);
  }

  // Structured outbox: mirror the verification verdict for remote observers.
  // Writes only to the jsonl outbox (NOT stdout), so VERIFY-03's exact-one-line
  // stdout contract is preserved. Guarded: emitStructured never throws.
  emitVerification(process.cwd(), input.run_id, {
    verdict: report.verdict,
    defectCount: Array.isArray(report.defects) ? report.defects.length : 0,
  });

  // Relative path for display (relative to cwd)
  const relPath = `.bgsd/runs/${input.run_id}/verification-report.json`;

  // VERIFY-03: EXACTLY ONE verdict line + path on stdout. Nothing else.
  process.stdout.write(`${report.verdict}  ${relPath}\n`);
}
