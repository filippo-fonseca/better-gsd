#!/usr/bin/env node
/**
 * review.mjs — Phase 3 (v3): User Review Gate + /bgsd-user-eval
 *              (REVIEW-01..04)
 *
 * Implements the ONE mandatory human stop in v3: when Loop 2 returns clean the
 * Conductor advances the run into a `review` lifecycle state and opens the
 * User Review Gate. The gate is INTERACTIVE BY DESIGN and NEVER auto-passes
 * (NFR-11, REVIEW-03). An unanswered gate parks the run in `needs_input`.
 *
 * ARCHITECTURE
 * ============
 *
 *   openReviewGate({ runId, runPath, integrationReport, changelogSummary,
 *                    bgsdDir, promptFn, bootFn, writeFn?, advanceStateFn? })
 *     The main entry point. Advances run to `review`, generates the checklist,
 *     presents a GSD-style selector question, records the verdict into
 *     review.json, and advances the run state accordingly.
 *     All I/O boundaries (promptFn, bootFn, writeFn, advanceStateFn) are
 *     DEPENDENCY-INJECTED so the gate is unit-testable under mocked answers.
 *
 *   buildReviewChecklist({ runId, integrationReport, criteria? })
 *     Pure function. Derives a concrete, human-readable checklist from the
 *     run's acceptance criteria + integration-report.json defects.
 *     Deterministic. No model calls.
 *
 *   buildVerdictQuestion()
 *     Pure function. Returns a GSD-style selector question object:
 *       { prompt, options: [ { id, label, description }, ... ], freeText: true }
 *     Exactly 3 pre-filled options (approve / request-changes / abort) PLUS
 *     a type-your-own "other" affordance.
 *     NEVER fewer than 2 options + free-text (NFR-11).
 *
 *   resolveVerdict(answer)
 *     Pure function. Maps a raw answer (option id or free text) to a
 *     canonical verdict: "approved" | "request_changes" | "aborted" | "needs_input".
 *     An empty / null / undefined answer resolves to "needs_input" — NEVER "approved".
 *
 *   writeReviewJson({ path, verdict, checklistItems, freeText, changeItems,
 *                     runId, reviewedAt, writeFn? })
 *     Write (or update) review.json. I/O injectable for tests.
 *
 *   liveBootRehearsalApp({ runId, rehearsalBranch, bgsdDir })
 *     HUMAN-GATED live boot of the rehearsal app. Refuses without --live flag.
 *     Default dry-run prints the boot plan.
 *
 *   isLiveFlagSet()
 *     True iff --live is in process.argv.
 *
 * review.json schema:
 *   {
 *     run_id:          string,
 *     reviewed_at:     string (ISO 8601),
 *     verdict:         "approved" | "request_changes" | "aborted" | "needs_input",
 *     checklist_items: [ { id, label, status: "pending" | "passed" | "failed",
 *                          note?: string } ],
 *     free_text:       string | null,
 *     change_items:    [ { id, description, source } ]  (non-empty when request_changes)
 *   }
 *
 * Usage (library):
 *   import { openReviewGate, buildReviewChecklist, buildVerdictQuestion,
 *            resolveVerdict, writeReviewJson,
 *            liveBootRehearsalApp, isLiveFlagSet } from './review.mjs';
 *
 * @module review
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (mirrors loop1-live.mjs / loop2-live.mjs)
// ---------------------------------------------------------------------------

/**
 * Returns true iff --live is in process.argv.
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to execute a live-only operation unless --live is explicitly set.
 * @throws {Error} when --live is absent
 */
function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: review.mjs live boot refused.\n" +
      "\n" +
      "Booting the real rehearsal app for /bgsd-user-eval requires an\n" +
      "explicit --live flag to prevent accidental automation.\n" +
      "\n" +
      "To run supervised:\n" +
      "  node bgsd/scripts/review.mjs --live --run-id <id>\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts.\n" +
      "  - Run this against the 'next' branch (NFR-01).\n" +
      "  - Treat the dry-run output as a real review result.\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Checklist generation (REVIEW-02)
// ---------------------------------------------------------------------------

/**
 * Derive a concrete, human-readable test checklist from:
 *   - The run's acceptance criteria (from integration-report criteriaResults, or
 *     a passed-in criteria array).
 *   - The integration-report defects (as explicit "verify fixed" items).
 *
 * Each item has a stable id, a label the human can evaluate, and an initial
 * "pending" status.
 *
 * Pure function — no I/O, no model calls (NFR-05).
 *
 * @param {object} opts
 * @param {string}   opts.runId                Run identifier
 * @param {object}   [opts.integrationReport]  integration-report.json object
 * @param {Array}    [opts.criteria]           Optional override criteria array
 * @returns {Array<{ id: string, label: string, source: string, status: "pending" }>}
 */
export function buildReviewChecklist({ runId, integrationReport, criteria } = {}) {
  const items = [];

  // 1. Criteria from integration report (or passed-in override)
  const criteriaResults =
    criteria ??
    (Array.isArray(integrationReport?.criteria_results)
      ? integrationReport.criteria_results
      : []);

  for (const c of criteriaResults) {
    const id = c.id ?? `criterion-${items.length + 1}`;
    items.push({
      id:     `check-criteria-${id}`,
      label:  c.description
                ?? c.label
                ?? `Criterion ${id} passes end-to-end`,
      source: "criteria",
      status: "pending",
    });
  }

  // 2. Integration defects that were fixed — the human should verify they're gone
  const defects = Array.isArray(integrationReport?.defects)
    ? integrationReport.defects
    : [];

  for (const d of defects) {
    const defectId = d.id ?? `defect-${items.length + 1}`;
    const location = d.file ? ` (${d.file})` : d.feature ? ` (${d.feature})` : "";
    items.push({
      id:     `check-defect-${defectId}`,
      label:  `Verify defect fixed: ${d.description ?? defectId}${location}`,
      source: "defect",
      status: "pending",
    });
  }

  // 3. If there are no criteria or defects, add a baseline item so the
  //    checklist is never empty (always gives the human something to check).
  if (items.length === 0) {
    items.push({
      id:     "check-baseline-01",
      label:  `The integrated ${runId} app loads and responds on the localhost URL`,
      source: "baseline",
      status: "pending",
    });
    items.push({
      id:     "check-baseline-02",
      label:  "Core user flows work end-to-end with no visible regressions",
      source: "baseline",
      status: "pending",
    });
    items.push({
      id:     "check-baseline-03",
      label:  "No critical console errors appear during normal use",
      source: "baseline",
      status: "pending",
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Verdict question — GSD-style selector (REVIEW-03, NFR-11)
// ---------------------------------------------------------------------------

/**
 * Build the GSD-style selector question for the human verdict.
 *
 * Satisfies NFR-11 and the HARD REQUIREMENT:
 *   - At least 2 pre-filled concrete options.
 *   - An always-available "type your own" free-text option.
 *   - NEVER auto-passes — requires an explicit human selection.
 *
 * @returns {{
 *   prompt: string,
 *   options: Array<{ id: string, label: string, description: string }>,
 *   freeText: { id: string, label: string, placeholder: string }
 * }}
 */
export function buildVerdictQuestion() {
  return {
    prompt: "Your verdict on the rehearsal branch — pick one:",
    options: [
      {
        id:          "approve",
        label:       "Approve",
        description: "The integration looks good. Advance to PR creation.",
      },
      {
        id:          "request-changes",
        label:       "Request changes",
        description: "Something needs fixing. Describe what's wrong and route to /bgsd-feedback.",
      },
      {
        id:          "abort",
        label:       "Abort this run",
        description: "Stop here. Discard the rehearsal branch (branches are preserved for inspection).",
      },
    ],
    freeText: {
      id:          "other",
      label:       "Type your own",
      placeholder: "Describe your verdict or findings in free text...",
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict resolution (REVIEW-03, NFR-06/11)
// ---------------------------------------------------------------------------

/**
 * Map a raw human answer (option id string or free text) to a canonical verdict.
 *
 * Rules (NFR-06/11 — never auto-pass):
 *   "approve"          -> "approved"
 *   "request-changes"  -> "request_changes"
 *   "abort"            -> "aborted"
 *   null / undefined / "" / "needs_input" -> "needs_input"  (NEVER "approved")
 *   any other string   -> "request_changes" with the text captured as free_text
 *
 * An unanswered gate (no answer) ALWAYS resolves to "needs_input" — it can
 * NEVER resolve to "approved" without an explicit human selection.
 *
 * @param {string|null|undefined} answer  Raw answer from the selector or free-text field
 * @returns {"approved"|"request_changes"|"aborted"|"needs_input"}
 */
export function resolveVerdict(answer) {
  if (answer === null || answer === undefined || answer === "" || answer === "needs_input") {
    return "needs_input";
  }
  if (answer === "approve") return "approved";
  if (answer === "request-changes") return "request_changes";
  if (answer === "abort") return "aborted";
  // Any other free-text → treat as request_changes (the human wrote something)
  return "request_changes";
}

// ---------------------------------------------------------------------------
// Parse change items from free-text or structured request_changes answer
// (REVIEW-03: when request_changes, capture change items for /bgsd-feedback)
// ---------------------------------------------------------------------------

/**
 * Parse a "request changes" response into a list of discrete change items
 * that /bgsd-feedback can ingest.
 *
 * @param {string|null} freeText  The human's free-text findings
 * @param {Array}       [structured]  Optional pre-parsed items (from a structured source)
 * @returns {Array<{ id: string, description: string, source: "human" }>}
 */
export function parseChangeItems(freeText, structured) {
  if (Array.isArray(structured) && structured.length > 0) {
    return structured.map((item, i) => ({
      id:          item.id ?? `change-${i + 1}`,
      description: item.description ?? String(item),
      source:      item.source ?? "human",
    }));
  }

  if (!freeText || typeof freeText !== "string" || !freeText.trim()) {
    return [];
  }

  // Split on newlines, numbered lists, bullet points, or semicolons
  const lines = freeText
    .split(/\n|;|\.\s+(?=[A-Z])/)
    .map((l) => l.replace(/^[\s\-*\d.]+/, "").trim())
    .filter((l) => l.length > 3);

  if (lines.length === 0) {
    return [{ id: "change-1", description: freeText.trim(), source: "human" }];
  }

  return lines.map((l, i) => ({
    id:          `change-${i + 1}`,
    description: l,
    source:      "human",
  }));
}

// ---------------------------------------------------------------------------
// review.json writer (REVIEW-03)
// ---------------------------------------------------------------------------

/**
 * Write (or update) review.json for a run.
 *
 * review.json schema:
 * {
 *   run_id:          string,
 *   reviewed_at:     string (ISO 8601),
 *   verdict:         "approved" | "request_changes" | "aborted" | "needs_input",
 *   checklist_items: [ { id, label, source, status, note? } ],
 *   free_text:       string | null,
 *   change_items:    [ { id, description, source } ]
 * }
 *
 * Writes atomically (tmp + rename).
 *
 * @param {object} opts
 * @param {string}   opts.runId           Run identifier
 * @param {string}   opts.bgsdDir         Absolute path to .bgsd directory
 * @param {string}   opts.verdict         Canonical verdict string
 * @param {Array}    opts.checklistItems  Checklist items (from buildReviewChecklist)
 * @param {string|null} opts.freeText     Human's free-text findings (may be null)
 * @param {Array}    [opts.changeItems]   Parsed change items (when request_changes)
 * @param {string}   [opts.reviewedAt]    ISO 8601 timestamp (defaults to now)
 * @param {Function} [opts.writeFn]       Injectable writer (default: fs.writeFileSync)
 * @returns {{ reviewJson: object, reviewPath: string }}
 */
export function writeReviewJson({
  runId,
  bgsdDir,
  verdict,
  checklistItems,
  freeText = null,
  changeItems = [],
  reviewedAt,
  writeFn,
}) {
  const reviewDir  = join(bgsdDir, "runs", runId);
  mkdirSync(reviewDir, { recursive: true });
  const reviewPath = join(reviewDir, "review.json");

  const data = {
    run_id:          runId,
    reviewed_at:     reviewedAt ?? new Date().toISOString(),
    verdict,
    checklist_items: Array.isArray(checklistItems) ? checklistItems : [],
    free_text:       freeText ?? null,
    change_items:    Array.isArray(changeItems) ? changeItems : [],
  };

  const serialized = JSON.stringify(data, null, 2);
  const tmpPath    = reviewPath + ".tmp";

  const writer = typeof writeFn === "function"
    ? writeFn
    : (p, content) => {
        writeFileSync(p, content, "utf8");
        renameSync(p, reviewPath);
      };

  writer(tmpPath, serialized);

  return { reviewJson: data, reviewPath };
}

// ---------------------------------------------------------------------------
// Live boot of rehearsal app (REVIEW-02, NFR-10)
// ---------------------------------------------------------------------------

/**
 * Boot the rehearsal/<run-id> app for human review.
 *
 * In dry-run mode (default — no --live flag):
 *   Prints the boot plan and exits. No process is started.
 *
 * In live mode (--live flag):
 *   Invokes the v0/v2 runtime-isolate.sh convention against the integrated
 *   rehearsal instance and returns the localhost URL + port.
 *   HUMAN-GATED: requires --live in process.argv.
 *
 * @param {object} opts
 * @param {string}   opts.runId            Run identifier
 * @param {string}   opts.rehearsalBranch  e.g. "rehearsal/bgsd-0001-foo"
 * @param {string}   [opts.bgsdDir]        Absolute path to .bgsd directory
 * @param {number}   [opts.port]           Port override (default: 3099)
 * @returns {{ url: string, port: number, dryRun: boolean }}
 */
export function liveBootRehearsalApp({ runId, rehearsalBranch, bgsdDir, port = 3099 }) {
  if (!isLiveFlagSet()) {
    // Dry-run: report the plan, do NOT boot anything (NFR-10)
    process.stdout.write(
      "\n[bgsd-user-eval --dry-run] Boot plan for /bgsd-user-eval\n" +
      "=".repeat(60) + "\n\n" +
      `  Run ID:             ${runId}\n` +
      `  Rehearsal branch:   ${rehearsalBranch}\n` +
      `  Would boot on:      http://localhost:${port}\n` +
      `  Boot script:        bgsd/scripts/runtime-isolate.sh\n` +
      `  Readiness check:    HTTP GET http://localhost:${port}/health\n\n` +
      "  [dry-run] No app was started. Pass --live to boot for real (human-supervised).\n\n"
    );
    return { url: `http://localhost:${port}`, port, dryRun: true };
  }

  // LIVE SEAM POINT (HUMAN-GATED, NFR-10)
  requireLiveFlag();

  // In a fully-wired live run this would spawn runtime-isolate.sh with the
  // rehearsal branch checked out and wait for the readiness endpoint.
  // The actual spawn is not executed here — the human supervises the boot.
  process.stderr.write(
    `[review] liveBootRehearsalApp: LIVE — would spawn runtime-isolate.sh\n` +
    `  branch: ${rehearsalBranch}  port: ${port}\n` +
    `  (supervised live run; not spawning automatically)\n`
  );

  return { url: `http://localhost:${port}`, port, dryRun: false };
}

// ---------------------------------------------------------------------------
// Consolidated review prompt (REVIEW-01, REVIEW-07/Kiwi channel)
// ---------------------------------------------------------------------------

/**
 * Build the one consolidated review prompt surfaced through the Kiwi channel
 * (REVIEW-01): CHANGELOG summary + localhost URL + integration checklist.
 *
 * Pure function — no I/O.
 *
 * @param {object} opts
 * @param {string}   opts.runId              Run identifier
 * @param {string}   opts.localhostUrl       The URL printed to the human
 * @param {string}   [opts.changelogSummary] Per-agent CHANGELOG summary (plain text)
 * @param {Array}    opts.checklistItems     From buildReviewChecklist()
 * @param {object}   opts.verdictQuestion    From buildVerdictQuestion()
 * @returns {string}
 */
export function buildKiwiReviewPrompt({
  runId,
  localhostUrl,
  changelogSummary,
  checklistItems,
  verdictQuestion,
}) {
  const lines = [];
  lines.push("");
  lines.push("╔══════════════════════════════════════════════════╗");
  lines.push("║  Kiwi  ·  bgsd User Review Gate                  ║");
  lines.push("║  /bgsd-user-eval    🔒 main-protected             ║");
  lines.push("╚══════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Run: ${runId}  |  State: review`);
  lines.push("");

  if (changelogSummary) {
    lines.push("── What was built ──────────────────────────────────");
    lines.push(changelogSummary.trim());
    lines.push("");
  }

  lines.push("── Boot ─────────────────────────────────────────────");
  lines.push(`  Rehearsal app: ${localhostUrl}`);
  lines.push("  (open in your browser to verify by hand)");
  lines.push("");

  lines.push("── Checklist ────────────────────────────────────────");
  for (const item of checklistItems) {
    lines.push(`  [ ] ${item.label}`);
  }
  lines.push("");

  lines.push("── Verdict ──────────────────────────────────────────");
  lines.push(verdictQuestion.prompt);
  lines.push("");
  for (const opt of verdictQuestion.options) {
    lines.push(`  [${opt.id}]  ${opt.label} — ${opt.description}`);
  }
  lines.push(`  [${verdictQuestion.freeText.id}]  ${verdictQuestion.freeText.label}: ${verdictQuestion.freeText.placeholder}`);
  lines.push("");
  lines.push("────────────────────────────────────────────────────");
  lines.push("  Respond with: approve | request-changes | abort | <your text>");
  lines.push("  An unanswered gate parks the run in needs_input — never auto-approved.");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// openReviewGate — main entry point (REVIEW-01..04)
// ---------------------------------------------------------------------------

/**
 * Open the User Review Gate for a run that has passed Loop 2.
 *
 * Orchestrates:
 *   1. Advance run to `review` state (REVIEW-01, via injected advanceStateFn)
 *   2. Generate the checklist (REVIEW-02, via buildReviewChecklist)
 *   3. Boot the rehearsal app or report dry-run plan (REVIEW-02, via injected bootFn)
 *   4. Present the GSD-style selector question (REVIEW-03, via injected promptFn)
 *   5. Resolve the verdict (REVIEW-03, resolveVerdict)
 *   6. Parse change items if request_changes (REVIEW-03, parseChangeItems)
 *   7. Write review.json (REVIEW-03, via injected writeFn / writeReviewJson)
 *   8. Advance run to final state: done | needs_input | aborted (REVIEW-03)
 *
 * ALL I/O is DEPENDENCY-INJECTED (NFR-05/11):
 *   promptFn     — in tests: returns a mocked answer; in live: interactive selector
 *   bootFn       — in tests: no-op / returns dry plan; in live: liveBootRehearsalApp
 *   writeFn      — in tests: capture; in live: writeReviewJson
 *   advanceStateFn — in tests: recorder; in live: run.mjs advanceState wrapper
 *
 * NEVER auto-passes (NFR-06/11):
 *   An un-answered gate (promptFn returns null/undefined/"") resolves to
 *   `needs_input` and parks the run there — NEVER advances to "done".
 *
 * @param {object} opts
 * @param {string}   opts.runId                Run identifier
 * @param {string}   [opts.runPath]            Absolute path to run.json
 * @param {object}   [opts.integrationReport]  integration-report.json object
 * @param {string}   [opts.changelogSummary]   Per-agent CHANGELOG summary
 * @param {string}   [opts.bgsdDir]            Absolute path to .bgsd directory
 * @param {Function} opts.promptFn
 *   async (question: object) => string|null
 *   The interactive selector. In tests: mocked. In live: real interactive prompt.
 *   Returning null/undefined/"" means the human did NOT answer (-> needs_input).
 * @param {Function} [opts.bootFn]
 *   async ({ runId, rehearsalBranch, bgsdDir, port? }) => { url, port, dryRun }
 *   Defaults to liveBootRehearsalApp (dry-run unless --live).
 * @param {Function} [opts.writeFn]
 *   ({ runId, bgsdDir, verdict, checklistItems, freeText, changeItems }) =>
 *     { reviewJson, reviewPath }
 *   Defaults to writeReviewJson.
 * @param {Function} [opts.advanceStateFn]
 *   (toState: string, meta?: object) => void
 *   Called to advance the run state. No-op if not injected.
 * @param {number}   [opts.port]               Port for the rehearsal app (default 3099)
 *
 * @returns {Promise<{
 *   verdict:       "approved" | "request_changes" | "aborted" | "needs_input",
 *   checklistItems: Array,
 *   changeItems:   Array,
 *   freeText:      string|null,
 *   reviewPath:    string|null,
 *   reviewJson:    object|null,
 *   url:           string,
 * }>}
 */
export async function openReviewGate({
  runId,
  runPath,
  integrationReport,
  changelogSummary,
  bgsdDir,
  promptFn,
  bootFn,
  writeFn,
  advanceStateFn,
  port = 3099,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("openReviewGate: runId is required");
  }
  if (typeof promptFn !== "function") {
    throw new Error(
      "openReviewGate: promptFn must be injected — " +
      "use a mocked function in tests; use the interactive prompt in live runs"
    );
  }

  const boot   = typeof bootFn   === "function" ? bootFn   : liveBootRehearsalApp;
  const write  = typeof writeFn  === "function" ? writeFn  : writeReviewJson;
  const advance = typeof advanceStateFn === "function" ? advanceStateFn : () => {};

  const rehearsalBranch = `rehearsal/${runId}`;

  // 1. Advance to `review` state (REVIEW-01)
  advance("review", {
    phase:            "v3-review",
    note:             "User Review Gate opening — Loop 2 passed",
    rehearsal_branch: rehearsalBranch,
  });

  // 2. Generate checklist (REVIEW-02)
  const checklistItems = buildReviewChecklist({ runId, integrationReport });

  // 3. Boot the rehearsal app — dry-run unless --live (REVIEW-02, NFR-10)
  let bootResult;
  try {
    bootResult = await boot({ runId, rehearsalBranch, bgsdDir, port });
  } catch (_err) {
    bootResult = { url: `http://localhost:${port}`, port, dryRun: true };
  }
  const url = bootResult?.url ?? `http://localhost:${port}`;

  // 4. Build and present the verdict selector question (REVIEW-03)
  const verdictQuestion = buildVerdictQuestion();
  const kiwiPrompt = buildKiwiReviewPrompt({
    runId,
    localhostUrl: url,
    changelogSummary,
    checklistItems,
    verdictQuestion,
  });

  // Surface the consolidated Kiwi prompt (REVIEW-01)
  process.stdout.write(kiwiPrompt);

  // 5. Ask the human for their verdict (INTERACTIVE — never auto-passed, NFR-11)
  let rawAnswer;
  try {
    rawAnswer = await promptFn(verdictQuestion);
  } catch (_err) {
    // promptFn threw (e.g. stdin closed) — park as needs_input (NFR-06)
    rawAnswer = null;
  }

  // 6. Resolve verdict — null/empty ALWAYS -> needs_input (NFR-06/11)
  const verdict = resolveVerdict(rawAnswer);

  // Determine free_text: if the answer was not a known option id, it is free text
  const KNOWN_OPTION_IDS = new Set(["approve", "request-changes", "abort", "needs_input"]);
  const freeText =
    rawAnswer && !KNOWN_OPTION_IDS.has(rawAnswer) ? rawAnswer : null;

  // 7. Parse change items if request_changes (REVIEW-03)
  const changeItems = verdict === "request_changes"
    ? parseChangeItems(freeText)
    : [];

  // 8. Write review.json (REVIEW-03)
  let reviewPath = null;
  let reviewJson = null;
  if (bgsdDir) {
    try {
      const result = write({
        runId,
        bgsdDir,
        verdict,
        checklistItems,
        freeText,
        changeItems,
      });
      reviewPath = result?.reviewPath ?? null;
      reviewJson = result?.reviewJson ?? null;
    } catch (_err) {
      // Non-fatal: log but continue
      process.stderr.write(`[review] WARNING: could not write review.json: ${_err.message}\n`);
    }
  }

  // 9. Advance run to final state based on verdict (REVIEW-03)
  if (verdict === "approved") {
    advance("done", {
      review_verdict: verdict,
      note:           "User approved — advancing to CHANGELOG/PR step",
    });
  } else if (verdict === "aborted") {
    advance("aborted", {
      review_verdict: verdict,
      note:           "User aborted the run at the review gate",
    });
  } else {
    // needs_input or request_changes: park in needs_input
    advance("needs_input", {
      review_verdict: verdict,
      note:
        verdict === "request_changes"
          ? "User requested changes — route findings to /bgsd-feedback"
          : "Gate unanswered — parked in needs_input",
      change_items: changeItems,
    });
  }

  return { verdict, checklistItems, changeItems, freeText, reviewPath, reviewJson, url };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (dry-run / --live report only)
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
  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    }
    return flags;
  }

  const flags = parseFlags(process.argv.slice(2));
  const runId = flags.runId ?? flags.r ?? "bgsd-0001-demo";

  // Show the boot plan (dry-run default, or live if --live)
  liveBootRehearsalApp({
    runId,
    rehearsalBranch: `rehearsal/${runId}`,
    bgsdDir: null,
    port: flags.port ? Number(flags.port) : 3099,
  });

  // Show what the verdict question looks like
  const q = buildVerdictQuestion();
  process.stdout.write(
    "\n── Verdict question (GSD-style selector) ─────────────────\n" +
    `  Prompt: ${q.prompt}\n` +
    `  Options:\n`
  );
  for (const opt of q.options) {
    process.stdout.write(`    [${opt.id}] ${opt.label} — ${opt.description}\n`);
  }
  process.stdout.write(
    `  Free-text: [${q.freeText.id}] ${q.freeText.label}\n\n`
  );

  process.exit(0);
}
