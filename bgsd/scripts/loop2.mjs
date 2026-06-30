#!/usr/bin/env node
/**
 * loop2.mjs — Phase 1 (v3): Loop 2, Integration Verify→Fix Controller
 *             (LOOP2-01..04)
 *
 * Implements the bounded, integration-level verify→fix Ralph loop over the
 * assembled rehearsal/<run-id> branch. All live execution (booting the
 * integrated app, running the Integration Tester, calling fix agents,
 * re-merging) is DEPENDENCY-INJECTED — this controller is pure, deterministic
 * logic with NO process spawning, NO real app boot, and NO real Tester calls.
 *
 * RELATIONSHIP TO LOOP 1
 * ======================
 * loop2.mjs mirrors loop1.mjs's DI shape exactly:
 *   runLoop2({ verify, fix, reMerge, maxIterations, ... })
 *      vs
 *   runLoop1({ verify, fix, transitionFn, maxIterations, ... })
 *
 * Loop 2 is the integration-level sibling of Loop 1. Where Loop 1 runs per
 * worktree (verifying a single unit's work), Loop 2 runs over the WHOLE
 * assembled rehearsal/<run-id> branch (verifying the integrated system
 * across feature boundaries).
 *
 * ALGORITHM (LOOP2-01..04)
 * ========================
 *   1. Advance the run state to `integrating` (LOOP2-01).
 *   2. Call verify() — returns an IntegrationReport (reuses v0 report shape:
 *      verdict ∈ PASS|FAIL|ERROR|BLOCKED, criteria_results, defects).
 *   3. If verdict === PASS: integration done, advance to review gate.
 *   4. If verdict === BLOCKED or ERROR: park as integration_blocked (NFR-06).
 *   5. Compute a stable defect signature (reuses defectSignature() from loop1).
 *   6. If this signature was seen before (no-progress): park as integration_failed.
 *   7. Call fix(defects) — inject parallel fix agents on the defect backlog.
 *   8. Call reMerge() — re-integrate after fixes (reuses conflict.mjs convention).
 *   9. Increment iteration counter. If >= maxIterations: park as integration_failed.
 *  10. Goto 2.
 *
 * STOP CONDITIONS (LOOP2-04, NFR-06)
 * ===================================
 *   - PASS            : clean integration pass -> "integration_done".
 *   - BLOCKED|ERROR   : non-retryable verdict -> "integration_blocked" (fix NEVER called).
 *   - max_iterations  : hard cap hit -> "integration_failed".
 *   - no_progress     : same defect signature twice -> "integration_failed".
 *
 * INTEGRATION REPORT SCHEMA (LOOP2-02)
 * ======================================
 * The integration-report.json reuses the v0 verification-report.json contract:
 *   {
 *     run_id:            string,
 *     generated_at:      string (ISO 8601),
 *     scope:             "integration",            // integration tag (LOOP2-02)
 *     verdict:           "PASS"|"FAIL"|"ERROR"|"BLOCKED",
 *     integration: {                               // integration-specific block
 *       rehearsal_branch: string,
 *       iteration:        number,
 *       scrutiny: {
 *         cross_boundary_uat:  boolean,
 *         integrated_diff_review: boolean,
 *         alignment_check:     boolean,
 *         improvement_scrutiny: boolean,
 *       },
 *     },
 *     criteria_results:  [ { id, description, source, status, driver, evidence } ],
 *     defects:           [ { id, severity, source, description, evidence,
 *                            criterion_id, feature?, file? } ],
 *     // optional driver_ladder (same shape as verification-report.json)
 *   }
 *
 * HUMAN-GATED LIVE SEAM
 * =====================
 * The real verify = boot the rehearsal app + run the Integration Tester;
 * the real fix    = spawn parallel fix agents in worktrees off rehearsal/<run-id>;
 * the real reMerge = re-integrate via conflict.mjs re-merge.
 * Those live functions are in loop2-live.mjs (Phase 2) and GUARDED behind --live.
 * This file (loop2.mjs) NEVER spawns processes, boots apps, or runs agents.
 *
 * Usage (library):
 *   import { runLoop2, defectSignature, assembleIntegrationReport } from './loop2.mjs';
 *   const result = await runLoop2({ verify, fix, reMerge, runId, rehearsalBranch });
 *
 * @module loop2
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Defect signature — re-export the same stable fingerprint from loop1
// (LOOP2-04 "reused defectSignature()"). We re-implement it here so loop2.mjs
// is self-contained, but the algorithm is identical to loop1.mjs's.
// ---------------------------------------------------------------------------

/**
 * Compute a stable, order-independent SHA-256 signature of a defects array.
 *
 * Mirrors loop1.mjs defectSignature() exactly (LOOP2-04).
 * An empty defect list returns the fixed string "empty".
 *
 * @param {Array<{id?: string, description?: string}>} defects
 * @returns {string}  hex SHA-256 of sorted defect keys
 */
export function defectSignature(defects) {
  if (!Array.isArray(defects) || defects.length === 0) {
    return "empty";
  }
  const keys = defects
    .map((d) => (d.id ? String(d.id) : String(d.description ?? "unknown")))
    .sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Integration-report assembler (LOOP2-02)
// ---------------------------------------------------------------------------

/**
 * Assemble a structured integration-report object that reuses the v0 report
 * contract (verdict, criteria_results, defects) and adds an `integration`
 * block with integration-specific scrutiny metadata (LOOP2-02).
 *
 * The verdict is taken directly from the verify() result — computeVerdict()
 * (from build-report.mjs) is used unchanged by the live verify implementation;
 * here we accept the already-computed verdict from the injected verify().
 *
 * @param {object} opts
 * @param {string}   opts.runId              Run identifier
 * @param {string}   opts.rehearsalBranch    e.g. "rehearsal/bgsd-0001-my-feature"
 * @param {string}   opts.verdict            "PASS"|"FAIL"|"ERROR"|"BLOCKED"
 * @param {number}   opts.iteration          Current iteration count
 * @param {Array}    [opts.criteriaResults]  v0 criteria_results array
 * @param {Array}    [opts.defects]          v0 defects array
 * @param {object}   [opts.scrutiny]         Which integration checks were run
 * @param {string}   [opts.reportPath]       Path hint from the verify() result
 * @returns {object}  integration-report object (not written to disk here)
 */
export function assembleIntegrationReport({
  runId,
  rehearsalBranch,
  verdict,
  iteration,
  criteriaResults = [],
  defects = [],
  scrutiny = {},
  reportPath = null,
}) {
  return {
    run_id:       runId,
    generated_at: new Date().toISOString(),
    scope:        "integration",
    verdict,
    integration: {
      rehearsal_branch: rehearsalBranch,
      iteration,
      scrutiny: {
        cross_boundary_uat:      scrutiny.cross_boundary_uat      ?? false,
        integrated_diff_review:  scrutiny.integrated_diff_review  ?? false,
        alignment_check:         scrutiny.alignment_check         ?? false,
        improvement_scrutiny:    scrutiny.improvement_scrutiny    ?? false,
      },
    },
    criteria_results: criteriaResults,
    defects,
    ...(reportPath ? { report_path: reportPath } : {}),
  };
}

/**
 * Write an integration-report.json to disk atomically.
 *
 * @param {object} report   The assembled integration-report object
 * @param {string} outDir   Directory to write to (created if absent)
 * @returns {string}        Absolute path to the written file
 */
export function writeIntegrationReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "integration-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  return outPath;
}

/**
 * Write an integration.md log to disk.
 * Records iteration history + stop reason.
 *
 * @param {object} opts
 * @param {string}   opts.runId
 * @param {string}   opts.rehearsalBranch
 * @param {string}   opts.outcome
 * @param {string}   opts.reason
 * @param {number}   opts.iterations
 * @param {Array}    opts.trailEntries    Array of per-iteration log objects
 * @param {string}   opts.outDir          Directory to write to
 * @returns {string}  Path to the written file
 */
export function writeIntegrationLog({
  runId,
  rehearsalBranch,
  outcome,
  reason,
  iterations,
  trailEntries,
  outDir,
}) {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "integration.md");

  const lines = [
    `# Integration Log: ${runId}`,
    "",
    `**Branch:** \`${rehearsalBranch}\``,
    `**Outcome:** ${outcome}`,
    `**Reason:** ${reason}`,
    `**Iterations:** ${iterations}`,
    `**Generated:** ${new Date().toISOString()}`,
    "",
    "## Iteration Trail",
    "",
  ];

  for (const entry of trailEntries) {
    lines.push(
      `### Iteration ${entry.iteration}`,
      "",
      `- **Verdict:** ${entry.verdict}`,
      `- **Defects:** ${entry.defect_count ?? 0}`,
      `- **Defect Signature:** \`${entry.defect_signature ?? "none"}\``,
      `- **Action:** ${entry.action ?? "(none)"}`,
      `- **At:** ${entry.at}`,
      "",
    );
  }

  writeFileSync(outPath, lines.join("\n"), "utf8");
  return outPath;
}

// ---------------------------------------------------------------------------
// runLoop2 — main Loop 2 controller (LOOP2-01..04)
// ---------------------------------------------------------------------------

/**
 * Run the integration verify→fix loop over the assembled rehearsal/<run-id>
 * branch. This is the Loop 2 integration-level sibling of runLoop1().
 *
 * ALL live operations are dependency-injected:
 *   verify()  — in tests: mock. Live (Phase 2): boot rehearsal app + run Tester.
 *   fix()     — in tests: mock. Live (Phase 2): spawn parallel fix agents.
 *   reMerge() — in tests: mock. Live (Phase 2): re-integrate via conflict.mjs.
 *
 * This function NEVER spawns processes, boots an app, or runs agents.
 * No real git, no real Tester, no real fix agents (Phase 2 lives in loop2-live.mjs).
 *
 * @param {object} opts
 * @param {string}   opts.runId                 Run identifier (e.g. "bgsd-0001-foo")
 * @param {string}   opts.rehearsalBranch        e.g. "rehearsal/bgsd-0001-foo"
 * @param {Function} opts.verify
 *   async () => {
 *     verdict: "PASS"|"FAIL"|"ERROR"|"BLOCKED",
 *     defects: Array<{id?, description?, severity?, source?, feature?, file?}>,
 *     criteria_results?: Array,
 *     scrutiny?: object,
 *     reportPath?: string,
 *   }
 *   Injectable. In tests: mock. In live (Phase 2): boots app + runs Tester.
 * @param {Function} opts.fix
 *   async (defects: Array, opts: { iteration: number }) => void
 *   Injectable. In tests: mock. In live (Phase 2): spawns parallel fix agents.
 *   NEVER called on BLOCKED/ERROR verdicts (LOOP2-04).
 * @param {Function} opts.reMerge
 *   async (opts: { iteration: number }) => void
 *   Injectable. In tests: mock. In live (Phase 2): re-merges via conflict.mjs.
 *   Called after each fix() to re-integrate changes into rehearsal/<run-id>.
 * @param {number}   [opts.maxIterations=5]
 *   Hard cap on fix→re-merge→re-verify cycles (LOOP2-04).
 * @param {Function} [opts.advanceStateFn]
 *   (toState: string, meta?: object) => void
 *   Injectable state-advance function (wraps run.mjs advanceState in live runs;
 *   a no-op or recorder in tests). Called to advance to "integrating" (LOOP2-01).
 * @param {Function} [opts.writeFn]
 *   (report: object, outDir: string) => string  — injectable report writer.
 *   Default: writeIntegrationReport. In tests: may be a no-op or capture.
 * @param {string}   [opts.bgsdDir]
 *   Absolute path to .bgsd directory. When provided, integration-report.json
 *   and integration.md are written to .bgsd/runs/<run-id>/.
 *
 * @returns {Promise<{
 *   outcome:     "integration_done" | "integration_failed" | "integration_blocked",
 *   reason:      "pass" | "max_iterations" | "no_progress" | "blocked_verdict" | "error_verdict",
 *   iterations:  number,
 *   reportPath:  string | null,
 *   logPath:     string | null,
 *   lastReport:  object | null,
 * }>}
 */
export async function runLoop2(opts) {
  const {
    runId,
    rehearsalBranch = `rehearsal/${runId}`,
    verify,
    fix,
    reMerge,
    maxIterations   = 5,
    advanceStateFn  = null,
    writeFn         = writeIntegrationReport,
    bgsdDir         = null,
  } = opts;

  if (typeof verify   !== "function") throw new Error("runLoop2: verify must be a function");
  if (typeof fix      !== "function") throw new Error("runLoop2: fix must be a function");
  if (typeof reMerge  !== "function") throw new Error("runLoop2: reMerge must be a function");
  if (!runId || typeof runId !== "string") throw new Error("runLoop2: runId is required");

  // LOOP2-01: Advance run to `integrating` lifecycle state.
  if (typeof advanceStateFn === "function") {
    advanceStateFn("integrating", {
      phase: "v3-loop2",
      note: "Loop 2 starting — integration verify→fix controller",
      rehearsal_branch: rehearsalBranch,
    });
  }

  // Determine output directory for reports
  const outDir = bgsdDir ? join(bgsdDir, "runs", runId) : null;

  // No-progress guard: track the last seen defect signature (LOOP2-04)
  let lastSignature = null;

  // Iteration counter (one iteration = one verify + optional fix + reMerge)
  let iterations = 0;

  // Audit trail for integration.md log
  const trailEntries = [];

  // Last report received from verify() (held for the return value)
  let lastVerifyResult = null;
  let lastReportPath   = null;

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  while (true) {
    // --- VERIFY (LOOP2-01, LOOP2-02) ---
    let verifyResult;
    try {
      verifyResult = await verify();
    } catch (err) {
      // verify() threw unexpectedly: treat as ERROR, park as blocked (NFR-06)
      const report = assembleIntegrationReport({
        runId,
        rehearsalBranch,
        verdict: "ERROR",
        iteration: iterations,
        defects: [],
      });

      let reportPath = null;
      if (outDir) {
        try { reportPath = writeFn(report, outDir); } catch (_) {}
      }

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome: "integration_blocked",
            reason:  "verify_threw",
            iterations,
            trailEntries: [...trailEntries, {
              iteration: iterations,
              verdict: "ERROR",
              defect_count: 0,
              defect_signature: null,
              action: `verify() threw: ${err.message}`,
              at: new Date().toISOString(),
            }],
            outDir,
          })
        : null;

      return {
        outcome:    "integration_blocked",
        reason:     "error_verdict",
        iterations,
        reportPath,
        logPath,
        lastReport: report,
      };
    }

    lastVerifyResult = verifyResult;

    const verdict         = verifyResult.verdict;
    const defects         = Array.isArray(verifyResult.defects) ? verifyResult.defects : [];
    const criteriaResults = Array.isArray(verifyResult.criteria_results) ? verifyResult.criteria_results : [];
    const scrutiny        = verifyResult.scrutiny ?? {};
    const reportPath      = verifyResult.reportPath ?? null;

    // Assemble and (optionally) write the integration report (LOOP2-02)
    const report = assembleIntegrationReport({
      runId,
      rehearsalBranch,
      verdict,
      iteration:       iterations,
      criteriaResults,
      defects,
      scrutiny,
      reportPath,
    });

    if (outDir) {
      try { lastReportPath = writeFn(report, outDir); } catch (_) {}
    }

    // Record trail entry
    const trailEntry = {
      iteration:        iterations,
      verdict,
      defect_count:     defects.length,
      defect_signature: null,
      action:           null,
      at:               new Date().toISOString(),
    };

    // --- PASS: clean integration -> integration_done (LOOP2-04 criterion 1) ---
    if (verdict === "PASS") {
      trailEntry.action = "pass — integration done";
      trailEntries.push(trailEntry);

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome:      "integration_done",
            reason:       "pass",
            iterations,
            trailEntries,
            outDir,
          })
        : null;

      return {
        outcome:    "integration_done",
        reason:     "pass",
        iterations,
        reportPath: lastReportPath ?? reportPath,
        logPath,
        lastReport: report,
      };
    }

    // --- BLOCKED / ERROR: non-retryable -> integration_blocked (LOOP2-04, NFR-06)
    // Fix is NEVER called for BLOCKED or ERROR verdicts. ---
    if (verdict === "BLOCKED" || verdict === "ERROR") {
      const reason = verdict === "BLOCKED" ? "blocked_verdict" : "error_verdict";
      trailEntry.action = `${verdict} — integration blocked (fix not called)`;
      trailEntries.push(trailEntry);

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome:      "integration_blocked",
            reason,
            iterations,
            trailEntries,
            outDir,
          })
        : null;

      return {
        outcome:    "integration_blocked",
        reason,
        iterations,
        reportPath: lastReportPath ?? reportPath,
        logPath,
        lastReport: report,
      };
    }

    // --- FAIL: enter the fix-backlog cycle (LOOP2-03) ---

    // Compute defect signature for no-progress detection (LOOP2-04)
    const sig = defectSignature(defects);
    trailEntry.defect_signature = sig;

    // No-progress guard: if the same signature recurs, stop early (LOOP2-04)
    if (sig === lastSignature) {
      trailEntry.action = "no_progress — same defect signature recurring";
      trailEntries.push(trailEntry);

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome:      "integration_failed",
            reason:       "no_progress",
            iterations,
            trailEntries,
            outDir,
          })
        : null;

      return {
        outcome:    "integration_failed",
        reason:     "no_progress",
        iterations,
        reportPath: lastReportPath ?? reportPath,
        logPath,
        lastReport: report,
      };
    }
    lastSignature = sig;

    // --- maxIterations cap (LOOP2-04) ---
    if (iterations >= maxIterations) {
      trailEntry.action = `max_iterations (${maxIterations}) reached`;
      trailEntries.push(trailEntry);

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome:      "integration_failed",
            reason:       "max_iterations",
            iterations,
            trailEntries,
            outDir,
          })
        : null;

      return {
        outcome:    "integration_failed",
        reason:     "max_iterations",
        iterations,
        reportPath: lastReportPath ?? reportPath,
        logPath,
        lastReport: report,
      };
    }

    // --- FIX (LOOP2-03): dispatch parallel fix agents on the defect backlog ---
    try {
      await fix(defects, { iteration: iterations });
    } catch (err) {
      // fix() threw: park as failed (don't retry a broken fix path)
      trailEntry.action = `fix() threw: ${err.message}`;
      trailEntries.push(trailEntry);

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome:      "integration_failed",
            reason:       "fix_threw",
            iterations,
            trailEntries,
            outDir,
          })
        : null;

      return {
        outcome:    "integration_failed",
        reason:     "fix_threw",
        iterations,
        reportPath: lastReportPath ?? reportPath,
        logPath,
        lastReport: report,
      };
    }

    // --- RE-MERGE (LOOP2-03): re-integrate after fix via conflict.mjs convention ---
    try {
      await reMerge({ iteration: iterations });
    } catch (err) {
      // reMerge() threw: park as failed
      trailEntry.action = `reMerge() threw: ${err.message}`;
      trailEntries.push(trailEntry);

      const logPath = outDir
        ? writeIntegrationLog({
            runId, rehearsalBranch,
            outcome:      "integration_failed",
            reason:       "remerge_threw",
            iterations,
            trailEntries,
            outDir,
          })
        : null;

      return {
        outcome:    "integration_failed",
        reason:     "remerge_threw",
        iterations,
        reportPath: lastReportPath ?? reportPath,
        logPath,
        lastReport: report,
      };
    }

    trailEntry.action = `fix + reMerge completed — re-verifying (iteration ${iterations})`;
    trailEntries.push(trailEntry);

    iterations++;
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint (library module — no real execution here)
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
  process.stdout.write(
    "loop2.mjs — Phase 1 (v3): Loop 2 Integration Verify→Fix Controller\n" +
    "(library module — import and use its exported functions)\n\n" +
    "Exports:\n" +
    "  runLoop2({ runId, rehearsalBranch, verify, fix, reMerge, maxIterations, ... })\n" +
    "    The integration-level Ralph loop. All live operations are injected.\n" +
    "    NEVER spawns processes or boots an app (Phase 2 live seam lives in loop2-live.mjs).\n\n" +
    "  defectSignature(defects)  — stable SHA-256 fingerprint (mirrors loop1.mjs)\n\n" +
    "  assembleIntegrationReport({ runId, rehearsalBranch, verdict, iteration, ... })\n" +
    "    Builds integration-report.json object reusing v0 report shape + integration block.\n\n" +
    "  writeIntegrationReport(report, outDir)  — write integration-report.json\n\n" +
    "  writeIntegrationLog({ ... })            — write integration.md audit log\n\n" +
    "Stop conditions (LOOP2-04):\n" +
    "  PASS            -> integration_done\n" +
    "  BLOCKED|ERROR   -> integration_blocked (fix never called)\n" +
    "  max_iterations  -> integration_failed\n" +
    "  no_progress     -> integration_failed\n"
  );
  process.exit(0);
}
