#!/usr/bin/env node
/**
 * feedback.mjs — Phase 4 (v3): Feedback Mode — /bgsd-feedback [--fast]
 *                (FEEDBACK-01..04)
 *
 * Ingests human feedback (structured review.json change_items OR free-text)
 * into discrete, traceable fix items, then plans (and optionally executes) a
 * re-run of the fix pipeline.
 *
 * MODES
 * =====
 *   full (default)   — re-runs Loop 1 per affected worktree, re-merges, and
 *                      re-runs Loop 2 over the updated rehearsal branch, then
 *                      returns to the User Review Gate. Bounded by max_iterations
 *                      + the per-run budget cap (FEEDBACK-02, NFR-08).
 *
 *   fast (--fast)    — SKIPS loops. Spawns parallel (or single, for trivial
 *                      fixes) fix agents with NO computer-use verification.
 *                      Marked UNVERIFIED — never a clean PASS without a real
 *                      Tester pass (FEEDBACK-03, NFR-06). Still returns to the
 *                      human review gate.
 *
 * INGESTION (FEEDBACK-01)
 * =======================
 * ingestFeedback({ source, mode, runId, bgsdDir, writeFn? })
 *   source: Array of change_items (from review.json) OR a free-text string.
 *   Returns a FeedbackPlan — a pure, testable structure describing:
 *     - The parsed fix items (each tagged, id-stable, file/feature-tagged where possible)
 *     - The re-run plan (mode, loop spec, UNVERIFIED flag for --fast)
 *
 * LIVE RE-RUN GUARD (FEEDBACK-04 / NFR-10)
 * ==========================================
 * executeFeedbackPlan({ plan, runId, bgsdDir, loop1Fn?, loop2Fn?, fixFn? })
 *   Refuses without --live. Default dry-run reports the plan without spawning
 *   anything (mirrors requireLiveFlag() from loop1-live.mjs / loop2-live.mjs).
 *
 * NO SILENT GREEN (NFR-06)
 * ========================
 * --fast plans are ALWAYS marked:
 *   { verified: false, verification_skipped: true, result_status: "UNVERIFIED" }
 * They NEVER carry result_status "PASS". Only a full loop with a real Tester
 * pass can produce "PASS".
 *
 * ITEM SHAPE (reuses queue item fields, FEEDBACK-01)
 * ===================================================
 * {
 *   id:          string,           // stable, e.g. "fb-<runId>-<n>"
 *   description: string,           // what the human reported
 *   source:      "review_json" | "free_text",
 *   file:        string | null,    // tagged file/feature if extractable
 *   feature:     string | null,
 *   severity:    "low" | "medium" | "high",  // inferred heuristically
 *   state:       "pending"         // initial state
 * }
 *
 * PLAN SHAPE (FeedbackPlan)
 * =========================
 * {
 *   run_id:         string,
 *   mode:           "full" | "fast",
 *   items:          FeedbackItem[],
 *   re_run: {
 *     mode:            "full" | "fast",
 *     loops:           ["loop1","loop2"] | ["fast_fix"],  // full vs fast
 *     agent_strategy:  "parallel" | "single",             // fast only
 *     model_hint:      "Sonnet/low" | "Opus/medium",     // fast only
 *     verified:        boolean,    // false for --fast (NFR-06)
 *     verification_skipped: boolean,  // true for --fast
 *     result_status:   "PENDING" | "UNVERIFIED",  // UNVERIFIED for --fast
 *     max_iterations:  number,
 *     budget_cap:      string,
 *   },
 *   written_to:     string | null,   // .bgsd/runs/<runId>/feedback/ dir
 *   planned_at:     string,          // ISO 8601
 * }
 *
 * Usage (library):
 *   import { ingestFeedback, executeFeedbackPlan,
 *            parseFeedbackItems, planReRun,
 *            requireLiveFlag, isLiveFlagSet } from './feedback.mjs';
 *
 * @module feedback
 */

import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (mirrors loop1-live.mjs / loop2-live.mjs / review.mjs)
// ---------------------------------------------------------------------------

/**
 * Returns true iff --live is in process.argv.
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to execute a live-only re-run unless --live is explicitly set.
 * @throws {Error} when --live is absent
 */
export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: feedback.mjs live re-run refused.\n" +
      "\n" +
      "Executing a feedback re-run (spawning fix agents / loops) requires an\n" +
      "explicit --live flag to prevent accidental automation.\n" +
      "\n" +
      "To run supervised:\n" +
      "  node bgsd/scripts/feedback.mjs --live --run-id <id> [--fast]\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts.\n" +
      "  - Run this against the 'next' branch (NFR-01).\n" +
      "  - Treat the dry-run plan as a completed fix pass.\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Short ID generator for feedback items
// ---------------------------------------------------------------------------

function shortId() {
  return randomBytes(3).toString("hex");
}

// ---------------------------------------------------------------------------
// Heuristic severity inference
// ---------------------------------------------------------------------------

const HIGH_SEVERITY_WORDS = /\b(crash(es|ed|ing)?|broken|error|fail(s|ed|ing)?|critical|block(s|ed|ing)?|unable|can't|cannot|missing|404|500|regression)\b/i;
const MEDIUM_SEVERITY_WORDS = /\b(slow|wrong|incorrect|bad|unexpected|issue|problem|weird|off|doesn't)\b/i;

/**
 * Infer a severity from a feedback description string.
 * Pure function — no I/O (NFR-05).
 *
 * @param {string} description
 * @returns {"high"|"medium"|"low"}
 */
export function inferSeverity(description) {
  if (!description) return "low";
  if (HIGH_SEVERITY_WORDS.test(description)) return "high";
  if (MEDIUM_SEVERITY_WORDS.test(description)) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// File / feature tag extraction (heuristic, best-effort)
// ---------------------------------------------------------------------------

const FILE_PATTERN = /\b([\w\-./]+\.(mjs|js|ts|tsx|jsx|css|json|md|py|rb|go|rs|sh))\b/;
const FEATURE_PATTERN = /\b(login|auth|dashboard|profile|api|nav|header|footer|checkout|payment|search|upload|settings|feedback|review)\b/i;

/**
 * Attempt to extract a file or feature tag from a description.
 * Best-effort heuristic — returns nulls if nothing is found.
 * Pure function (NFR-05).
 *
 * @param {string} description
 * @returns {{ file: string|null, feature: string|null }}
 */
export function extractTags(description) {
  if (!description) return { file: null, feature: null };
  const fileMatch    = FILE_PATTERN.exec(description);
  const featureMatch = FEATURE_PATTERN.exec(description);
  return {
    file:    fileMatch    ? fileMatch[1]    : null,
    feature: featureMatch ? featureMatch[1].toLowerCase() : null,
  };
}

// ---------------------------------------------------------------------------
// parseFeedbackItems — FEEDBACK-01
// ---------------------------------------------------------------------------

/**
 * Parse a feedback source into an array of discrete, traceable fix items.
 *
 * source can be:
 *   (a) An array of change_item objects (from review.json change_items —
 *       the structured "request_changes" path).
 *   (b) A free-text string (direct /bgsd-feedback "<what's wrong>" input).
 *
 * Each item is tagged with a stable id, file/feature hint, and severity.
 * Deterministic — no model calls (NFR-05).
 *
 * @param {object} opts
 * @param {Array|string} opts.source    The feedback source
 * @param {string}       opts.runId     Run identifier (used in item ids)
 * @returns {Array<FeedbackItem>}
 */
export function parseFeedbackItems({ source, runId = "unknown" }) {
  if (!source) return [];

  const now = new Date().toISOString();

  // --- Path A: structured change_items array (from review.json) ---
  if (Array.isArray(source)) {
    return source
      .filter((item) => {
        const desc = item.description ?? item.label ?? String(item);
        return desc && String(desc).trim().length > 0;
      })
      .map((item, i) => {
        const description = String(item.description ?? item.label ?? item).trim();
        const { file, feature } = extractTags(description);
        return {
          id:          item.id ?? `fb-${runId}-${i + 1}-${shortId()}`,
          description,
          source:      "review_json",
          file:        item.file ?? file,
          feature:     item.feature ?? feature,
          severity:    item.severity ?? inferSeverity(description),
          state:       "pending",
          created_at:  now,
        };
      });
  }

  // --- Path B: free-text string ---
  if (typeof source === "string") {
    const text = source.trim();
    if (!text) return [];

    // Split on newlines, bullet points, numbered list prefixes, or semicolons
    const segments = text
      .split(/\n|;|\.\s+(?=[A-Z])/)
      .map((s) => s.replace(/^[\s\-*\d.]+/, "").trim())
      .filter((s) => s.length > 3);

    const lines = segments.length > 0 ? segments : [text];

    return lines.map((line, i) => {
      const { file, feature } = extractTags(line);
      return {
        id:          `fb-${runId}-${i + 1}-${shortId()}`,
        description: line,
        source:      "free_text",
        file,
        feature,
        severity:    inferSeverity(line),
        state:       "pending",
        created_at:  now,
      };
    });
  }

  return [];
}

// ---------------------------------------------------------------------------
// planReRun — FEEDBACK-02, FEEDBACK-03, FEEDBACK-04
// ---------------------------------------------------------------------------

/**
 * Decide the re-run strategy from items + mode.
 *
 * full (default):
 *   - Loops: ["loop1", "loop2"] — re-runs the entire two-loop machine.
 *   - verified: true (a real Tester pass is required for PASS).
 *   - result_status: "PENDING" (will become PASS/FAIL after the loops run).
 *
 * fast (--fast):
 *   - Loops: ["fast_fix"] — single pass, NO verification cycle.
 *   - agent_strategy: "parallel" if items > 1, "single" if exactly 1 trivial item.
 *   - verified: false — ALWAYS. No silent green (NFR-06).
 *   - result_status: "UNVERIFIED" — ALWAYS. Never "PASS".
 *   - model_hint: "Sonnet/low" for single trivial; "Opus/medium" for multi.
 *
 * Both modes respect max_iterations (NFR-08) and record the strategy as a
 * deterministic scored choice (NFR-05, FEEDBACK-04).
 *
 * Pure function — no I/O, no spawning (NFR-05).
 *
 * @param {object} opts
 * @param {Array}  opts.items            Parsed feedback items
 * @param {"full"|"fast"} opts.mode      "full" or "fast"
 * @param {number} [opts.maxIterations]  Loop iteration cap (default: 5)
 * @param {string} [opts.budgetCap]      Per-run budget cap label (default: "default")
 * @returns {ReRunPlan}
 */
export function planReRun({ items, mode, maxIterations = 5, budgetCap = "default" }) {
  const isFast = mode === "fast";

  if (!isFast) {
    // FULL MODE: re-run both loops (FEEDBACK-02)
    return {
      mode:                 "full",
      loops:                ["loop1", "loop2"],
      agent_strategy:       null,           // Loop 1 decides parallelism internally
      model_hint:           null,           // Loop 1/2 use their own model routing
      verified:             true,           // a real Tester pass is required for PASS
      verification_skipped: false,
      result_status:        "PENDING",      // will become PASS/FAIL after the loops
      max_iterations:       maxIterations,
      budget_cap:           budgetCap,
      item_count:           items.length,
    };
  }

  // FAST MODE: single/parallel fix pass, NO verification (FEEDBACK-03)
  // Decision: multi-agent vs single-agent is a deterministic scored choice.
  //   - 1 item with severity "low" -> single agent, Sonnet/low
  //   - otherwise -> parallel agents, Opus/medium
  const isTrivialSingle = items.length === 1 && items[0]?.severity === "low";
  const agentStrategy   = isTrivialSingle ? "single" : "parallel";
  const modelHint       = isTrivialSingle ? "Sonnet/low" : "Opus/medium";

  return {
    mode:                 "fast",
    loops:                ["fast_fix"],
    agent_strategy:       agentStrategy,
    model_hint:           modelHint,
    // NEVER verified — no Tester pass. ALWAYS UNVERIFIED (NFR-06, FEEDBACK-03).
    verified:             false,
    verification_skipped: true,
    result_status:        "UNVERIFIED",     // NEVER "PASS" without a Tester pass
    max_iterations:       1,               // fast: one pass, no loop
    budget_cap:           budgetCap,
    item_count:           items.length,
  };
}

// ---------------------------------------------------------------------------
// writeFeedbackItems — write items to .bgsd/runs/<runId>/feedback/ (FEEDBACK-01)
// ---------------------------------------------------------------------------

/**
 * Write parsed feedback items to the run ledger under
 * .bgsd/runs/<runId>/feedback/feedback-<timestamp>.json
 *
 * Writes atomically (tmp + rename).
 * I/O injectable for tests via writeFn.
 *
 * @param {object} opts
 * @param {string}   opts.runId     Run identifier
 * @param {string}   opts.bgsdDir   Absolute path to .bgsd directory
 * @param {Array}    opts.items     Parsed FeedbackItem[]
 * @param {object}   opts.plan      FeedbackPlan (for the file header)
 * @param {Function} [opts.writeFn] Injectable writer (default: fs.writeFileSync)
 * @returns {{ feedbackPath: string }}
 */
export function writeFeedbackItems({ runId, bgsdDir, items, plan, writeFn }) {
  const feedbackDir = join(bgsdDir, "runs", runId, "feedback");
  mkdirSync(feedbackDir, { recursive: true });

  const timestamp   = new Date().toISOString().replace(/[:.]/g, "-");
  const filename    = `feedback-${timestamp}.json`;
  const feedbackPath = join(feedbackDir, filename);
  const tmpPath     = feedbackPath + ".tmp";

  const data = {
    run_id:      runId,
    mode:        plan?.mode ?? "full",
    recorded_at: new Date().toISOString(),
    items,
  };

  const serialized = JSON.stringify(data, null, 2);

  if (typeof writeFn === "function") {
    writeFn(tmpPath, serialized);
  } else {
    writeFileSync(tmpPath, serialized, "utf8");
    renameSync(tmpPath, feedbackPath);
  }

  return { feedbackPath };
}

// ---------------------------------------------------------------------------
// ingestFeedback — main entry point (FEEDBACK-01..04)
// ---------------------------------------------------------------------------

/**
 * Ingest feedback from a review.json source or free-text string, parse it
 * into discrete fix items, plan the re-run, optionally write items to disk,
 * and return the complete FeedbackPlan.
 *
 * This is the DETERMINISTIC ingestion step (NFR-05). No model calls, no
 * process spawning. The plan is a pure, testable structure.
 *
 * The LIVE re-run (actually spawning fix agents / loops) is guarded in
 * executeFeedbackPlan() and requires --live (NFR-10).
 *
 * @param {object} opts
 * @param {Array|string}     opts.source         Feedback source (see parseFeedbackItems)
 * @param {"full"|"fast"}    [opts.mode]         "full" (default) or "fast" (--fast)
 * @param {string}           [opts.runId]        Run identifier
 * @param {string}           [opts.bgsdDir]      .bgsd directory path (optional; omit in tests)
 * @param {number}           [opts.maxIterations] Loop cap (default: 5)
 * @param {string}           [opts.budgetCap]    Budget cap label (default: "default")
 * @param {Function}         [opts.writeFn]      Injectable fs writer (for tests)
 * @returns {FeedbackPlan}
 */
export function ingestFeedback({
  source,
  mode = "full",
  runId = "unknown",
  bgsdDir = null,
  maxIterations = 5,
  budgetCap = "default",
  writeFn,
}) {
  const resolvedMode = mode === "fast" ? "fast" : "full";

  // 1. Parse feedback source into fix items (FEEDBACK-01)
  const items = parseFeedbackItems({ source, runId });

  // 2. Plan the re-run strategy (FEEDBACK-02/03/04)
  const reRun = planReRun({ items, mode: resolvedMode, maxIterations, budgetCap });

  // 3. Write items to disk if bgsdDir provided (FEEDBACK-01 ledger discipline)
  let writtenTo = null;
  if (bgsdDir) {
    try {
      const { feedbackPath } = writeFeedbackItems({
        runId,
        bgsdDir,
        items,
        plan: { mode: resolvedMode },
        writeFn,
      });
      writtenTo = feedbackPath;
    } catch (_err) {
      // Non-fatal: log but do not block the plan
      process.stderr.write(`[feedback] WARNING: could not write feedback items: ${_err.message}\n`);
    }
  }

  // 4. Assemble and return the FeedbackPlan (pure, testable)
  return {
    run_id:      runId,
    mode:        resolvedMode,
    items,
    re_run:      reRun,
    written_to:  writtenTo,
    planned_at:  new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// executeFeedbackPlan — GUARDED live re-run (FEEDBACK-04, NFR-10)
// ---------------------------------------------------------------------------

/**
 * Execute a FeedbackPlan — spawn fix agents and/or re-run Loop 1 + Loop 2.
 *
 * HUMAN-GATED: refuses without --live (mirrors requireLiveFlag() across the
 * codebase). Default dry-run prints the plan and exits without spawning
 * anything.
 *
 * In full mode: calls loop1Fn (per worktree) then loop2Fn (integration),
 *   reusing the existing controllers UNCHANGED (FEEDBACK-02, NFR-04).
 * In fast mode: calls fixFn with all items in parallel (or single for
 *   a trivial single-item case) with NO verification (FEEDBACK-03).
 *   Result is always UNVERIFIED (NFR-06).
 *
 * All live seam functions (loop1Fn, loop2Fn, fixFn) are DEPENDENCY-INJECTED
 * so this function is unit-testable with mocks; the guard prevents live
 * execution without --live (NFR-10).
 *
 * @param {object} opts
 * @param {FeedbackPlan} opts.plan          The plan from ingestFeedback()
 * @param {string}       opts.runId         Run identifier
 * @param {string}       [opts.bgsdDir]     .bgsd directory path
 * @param {Function}     [opts.loop1Fn]     Injected Loop 1 runner (async)
 * @param {Function}     [opts.loop2Fn]     Injected Loop 2 runner (async)
 * @param {Function}     [opts.fixFn]       Injected fast-fix runner (async)
 * @returns {Promise<FeedbackResult>}
 */
export async function executeFeedbackPlan({
  plan,
  runId,
  bgsdDir,
  loop1Fn,
  loop2Fn,
  fixFn,
}) {
  // HARD GUARD: refuse without --live (NFR-10)
  requireLiveFlag();

  const { mode, items, re_run: reRun } = plan;

  if (mode === "fast") {
    // FAST MODE: single/parallel fix pass, NO verification (FEEDBACK-03)
    if (typeof fixFn !== "function") {
      throw new Error("executeFeedbackPlan: fixFn must be injected for fast mode");
    }

    const fixResults = await fixFn({ items, agentStrategy: reRun.agent_strategy, modelHint: reRun.model_hint });

    // Fast results are ALWAYS UNVERIFIED — no silent green (NFR-06)
    return {
      run_id:               runId,
      mode:                 "fast",
      items_fixed:          Array.isArray(fixResults) ? fixResults.length : 0,
      verified:             false,
      verification_skipped: true,
      result_status:        "UNVERIFIED",   // NEVER "PASS" — explicit NFR-06
      fix_results:          fixResults ?? [],
      completed_at:         new Date().toISOString(),
    };
  }

  // FULL MODE: re-run Loop 1 per worktree, then Loop 2 (FEEDBACK-02)
  if (typeof loop1Fn !== "function") {
    throw new Error("executeFeedbackPlan: loop1Fn must be injected for full mode");
  }
  if (typeof loop2Fn !== "function") {
    throw new Error("executeFeedbackPlan: loop2Fn must be injected for full mode");
  }

  const loop1Results = await loop1Fn({ items, maxIterations: reRun.max_iterations });
  const loop2Results = await loop2Fn({ afterLoop1: loop1Results, maxIterations: reRun.max_iterations });

  return {
    run_id:               runId,
    mode:                 "full",
    items_fixed:          items.length,
    verified:             true,
    verification_skipped: false,
    result_status:        loop2Results?.verdict ?? "PENDING",
    loop1_results:        loop1Results,
    loop2_results:        loop2Results,
    completed_at:         new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (dry-run / plan report)
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
        const key  = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      } else if (!args[i].startsWith("-") && !flags._text) {
        flags._text = args[i];
      }
    }
    return flags;
  }

  const flags  = parseFlags(process.argv.slice(2));
  const runId  = flags.runId ?? flags.r ?? "bgsd-0001-demo";
  const mode   = flags.fast ? "fast" : "full";
  const source = flags._text ?? flags.feedback ?? "Example feedback item";

  const plan = ingestFeedback({ source, mode, runId });

  process.stdout.write("\n[bgsd-feedback");
  if (mode === "fast") process.stdout.write(" --fast");
  process.stdout.write("] Plan\n" + "=".repeat(60) + "\n\n");
  process.stdout.write(`  Run ID:       ${plan.run_id}\n`);
  process.stdout.write(`  Mode:         ${plan.mode}\n`);
  process.stdout.write(`  Items:        ${plan.items.length}\n`);
  for (const item of plan.items) {
    process.stdout.write(`    [${item.severity}] ${item.id}: ${item.description.slice(0, 70)}\n`);
  }
  process.stdout.write(`\n  Re-run plan:\n`);
  process.stdout.write(`    loops:                ${plan.re_run.loops.join(", ")}\n`);
  process.stdout.write(`    verified:             ${plan.re_run.verified}\n`);
  process.stdout.write(`    verification_skipped: ${plan.re_run.verification_skipped}\n`);
  process.stdout.write(`    result_status:        ${plan.re_run.result_status}\n`);
  if (plan.re_run.agent_strategy) {
    process.stdout.write(`    agent_strategy:       ${plan.re_run.agent_strategy}\n`);
    process.stdout.write(`    model_hint:           ${plan.re_run.model_hint}\n`);
  }
  process.stdout.write(`    max_iterations:       ${plan.re_run.max_iterations}\n`);

  if (mode === "fast") {
    process.stdout.write(
      "\n  [WARNING] --fast result will be UNVERIFIED. The human review gate\n" +
      "  is still required before any PR can be created. No silent green.\n"
    );
  }

  process.stdout.write("\n  [dry-run] Pass --live to execute this plan (human-supervised).\n\n");

  process.exit(0);
}
