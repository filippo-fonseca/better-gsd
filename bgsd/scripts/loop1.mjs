#!/usr/bin/env node
/**
 * loop1.mjs — Phase 3: Loop 1, Verify→Fix Ralph Loop (LOOP-01..05)
 *
 * Implements a bounded, per-worktree verify→fix loop. All live execution
 * (spawning /bgsd-verify, calling /gsd-* commands, creating/destroying
 * worktrees) is injected via dependency injection — this controller is
 * pure, deterministic logic with no process spawning.
 *
 * ALGORITHM
 * =========
 *
 *   1. Call verify() — returns a VerificationReport { verdict, defects[] }.
 *   2. If verdict === PASS: record done, return.
 *   3. If verdict === BLOCKED or ERROR: record blocked, return (never retry blindly).
 *   4. Compute a stable defect signature from the defect list.
 *   5. If this signature has been seen before (same defects recurred): stop as
 *      failed (no-progress guard — don't burn iterations).
 *   6. Call fix(defects) — injects a fix attempt.
 *   7. Increment iteration counter. If iteration >= maxIterations: stop as failed.
 *   8. Goto 1.
 *
 * STOP CONDITIONS (LOOP-03, NFR-06/07)
 * ======================================
 *   - PASS            : clean Tester pass -> item "done".
 *   - maxIterations   : iteration cap hit -> item "failed" (reason: max_iterations).
 *   - no-progress     : same defect signature recurs -> item "failed" (reason: no_progress).
 *   - BLOCKED/ERROR   : non-retryable Tester verdict -> item "blocked" (never fabricates PASS).
 *
 * DEFECT SIGNATURES (LOOP-03 "same defect signature recurring")
 * ==============================================================
 * A signature is a stable, order-independent fingerprint of the defect list.
 * It is computed as a sorted SHA-256 of each defect's id (or description when
 * id is absent). Sorting makes the signature independent of defect order.
 * The signature is compared across iterations; if it matches the previous
 * iteration's signature, no-progress is declared and the loop stops.
 *
 * ESCALATION LADDER (LOOP-05)
 * ===========================
 * Passed as `escalateAfterIters` (default: 2). After that many fix attempts
 * without a PASS, the effort band is bumped one level (low->medium->high).
 * After `escalateModelAfterIters` (default: 4), the model tier is bumped
 * (fast->balanced->quality). Both are recorded in the audit trail so spend
 * is adaptive to demonstrated difficulty. The escalation hints are passed to
 * fix() via the opts argument; fix() may or may not honor them.
 *
 * QUEUE INTEGRATION
 * =================
 * runLoop1() calls the provided transition() function to advance the item
 * through: routed -> executing -> verifying -> looping -> done|failed|blocked.
 * Every transition is timestamped and recorded in the audit trail (QUEUE-03).
 *
 * HUMAN-GATED LIVE SEAM
 * =====================
 * The real verify = spawn /bgsd-verify and parse its verification-report.json;
 * the real fix = route to /gsd-* execution in a worktree. Those live functions
 * are in loop1-live.mjs and are GUARDED: they refuse to run without --live.
 * This file (loop1.mjs) never spawns processes.
 *
 * Usage (library):
 *   import { runLoop1, defectSignature } from './loop1.mjs';
 *   const result = await runLoop1({ item, transition, verify, fix });
 *
 * @module loop1
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Defect signature — stable, order-independent fingerprint (LOOP-03)
// ---------------------------------------------------------------------------

/**
 * Compute a stable, order-independent SHA-256 signature of a defects array.
 *
 * The signature is derived from each defect's `id` field (falling back to
 * `description` when id is absent), sorted lexicographically and then
 * hashed. This makes the signature:
 *   - Order-independent: same defects in different order -> same signature.
 *   - Stable: the same set of defects always produces the same signature.
 *   - Sensitive to content: different defects -> different signature.
 *
 * An empty defect list returns the fixed string "empty".
 *
 * @param {Array<{id?: string, description?: string}>} defects
 * @returns {string}  hex SHA-256 of sorted defect keys
 */
export function defectSignature(defects) {
  if (!Array.isArray(defects) || defects.length === 0) {
    return "empty";
  }
  // Build one stable key per defect: prefer id, fall back to description
  const keys = defects
    .map((d) => (d.id ? String(d.id) : String(d.description ?? "unknown")))
    .sort(); // sort for order-independence

  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Effort + model escalation helpers (LOOP-05)
// ---------------------------------------------------------------------------

const EFFORT_LADDER = ["low", "medium", "high"];
const MODEL_LADDER  = ["fast", "balanced", "quality"];

/**
 * Bump an effort band one step up the ladder.
 * Returns the next band, or the current band if already at the top.
 *
 * @param {string} current
 * @returns {string}
 */
function escalateEffort(current) {
  const idx = EFFORT_LADDER.indexOf(current);
  if (idx === -1 || idx >= EFFORT_LADDER.length - 1) return current;
  return EFFORT_LADDER[idx + 1];
}

/**
 * Bump a model tier one step up the ladder.
 * Returns the next tier, or the current tier if already at the top.
 *
 * @param {string} current
 * @returns {string}
 */
function escalateModel(current) {
  const idx = MODEL_LADDER.indexOf(current);
  if (idx === -1 || idx >= MODEL_LADDER.length - 1) return current;
  return MODEL_LADDER[idx + 1];
}

// ---------------------------------------------------------------------------
// runLoop1 — main loop controller (LOOP-01..05)
// ---------------------------------------------------------------------------

/**
 * Run the verify→fix Ralph loop for a single queue item.
 *
 * @param {object} opts
 * @param {object}   opts.item             - queue item to drive (mutated in place via transition)
 * @param {Function} opts.transitionFn     - transition(item, toState, meta) from queue.mjs
 * @param {Function} opts.verify           - async () => { verdict: "PASS"|"FAIL"|"BLOCKED"|"ERROR", defects: [] }
 *                                           Injectable; in tests this is a mock.
 *                                           In live runs (loop1-live.mjs) this spawns /bgsd-verify.
 * @param {Function} opts.fix              - async (defects, { effort, model }) => void
 *                                           Injectable; in tests this is a mock.
 *                                           In live runs this routes to /gsd-* execution.
 * @param {number}   [opts.maxIterations=5]          - hard cap on fix→re-verify cycles (LOOP-03)
 * @param {number}   [opts.escalateAfterIters=2]     - bump effort band after N fix failures (LOOP-05)
 * @param {number}   [opts.escalateModelAfterIters=4] - bump model tier after N fix failures (LOOP-05)
 * @param {string}   [opts.initialEffort="medium"]   - starting effort band for fix() calls
 * @param {string}   [opts.initialModel="balanced"]  - starting model tier for fix() calls
 *
 * @returns {Promise<{
 *   outcome: "done" | "failed" | "blocked",
 *   reason:  "pass" | "max_iterations" | "no_progress" | "blocked_verdict" | "error_verdict",
 *   iterations: number,
 *   reportPath: string | null
 * }>}
 */
export async function runLoop1(opts) {
  const {
    item,
    transitionFn,
    verify,
    fix,
    maxIterations        = 5,
    escalateAfterIters   = 2,
    escalateModelAfterIters = 4,
    initialEffort        = "medium",
    initialModel         = "balanced",
  } = opts;

  // Current escalation state (LOOP-05)
  let effort = initialEffort;
  let model  = initialModel;

  // No-progress guard: track the last seen defect signature (LOOP-03)
  let lastSignature = null;

  // Iteration counter (one iteration = one verify + optional fix)
  let iterations = 0;

  // -------------------------------------------------------------------------
  // Step 1: advance from routed -> executing (GSD execution is the caller's
  // responsibility before runLoop1; but we guard against already-executing items)
  // -------------------------------------------------------------------------
  if (item.state === "routed") {
    transitionFn(item, "executing", {
      phase: "3-loop1",
      note: "loop1 starting; execution assumed by caller or stub",
    });
  }

  // -------------------------------------------------------------------------
  // Step 2: executing -> verifying (first verify pass)
  // -------------------------------------------------------------------------
  if (item.state === "executing") {
    transitionFn(item, "verifying", {
      phase: "3-loop1",
      note: "entering verify phase",
    });
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  while (true) {
    // --- VERIFY ---
    let report;
    try {
      report = await verify();
    } catch (err) {
      // verify() threw unexpectedly: treat as ERROR, park as blocked (NFR-06)
      transitionFn(item, "blocked", {
        phase: "3-loop1",
        reason: "verify_threw",
        error: err.message,
        iterations,
      });
      return {
        outcome: "blocked",
        reason: "error_verdict",
        iterations,
        reportPath: null,
      };
    }

    const verdict = report.verdict;
    const defects = Array.isArray(report.defects) ? report.defects : [];
    const reportPath = report.reportPath ?? null;

    // Record the verify result on the item's audit trail
    item.last_verdict   = verdict;
    item.last_defects   = defects;
    item.last_report    = reportPath;

    // --- PASS: clean run -> done (LOOP-03 criterion 1, LOOP-04) ---
    if (verdict === "PASS") {
      // From verifying or looping -> done
      if (item.state === "looping") {
        transitionFn(item, "done", {
          phase: "3-loop1",
          reason: "pass",
          iterations,
          reportPath,
        });
      } else {
        // Still in "verifying" (first-pass clean)
        transitionFn(item, "done", {
          phase: "3-loop1",
          reason: "pass",
          iterations,
          reportPath,
        });
      }
      return {
        outcome: "done",
        reason: "pass",
        iterations,
        reportPath,
      };
    }

    // --- BLOCKED / ERROR: non-retryable -> blocked (NFR-06, LOOP-03) ---
    if (verdict === "BLOCKED" || verdict === "ERROR") {
      const termState = "blocked";
      const reason = verdict === "BLOCKED" ? "blocked_verdict" : "error_verdict";
      const fromState = item.state;
      // Advance to blocked from current state (verifying or looping)
      if (fromState === "verifying" || fromState === "looping") {
        transitionFn(item, termState, {
          phase: "3-loop1",
          reason,
          verdict,
          iterations,
          reportPath,
        });
      }
      return {
        outcome: "blocked",
        reason,
        iterations,
        reportPath,
      };
    }

    // --- FAIL: enter the fix-backlog cycle (LOOP-02) ---
    // Compute defect signature for no-progress detection (LOOP-03)
    const sig = defectSignature(defects);

    // No-progress guard: if the same signature recurs, stop early (LOOP-03)
    if (sig === lastSignature) {
      const fromState = item.state;
      if (fromState === "verifying" || fromState === "looping") {
        transitionFn(item, "failed", {
          phase: "3-loop1",
          reason: "no_progress",
          defect_signature: sig,
          iterations,
          reportPath,
        });
      }
      return {
        outcome: "failed",
        reason: "no_progress",
        iterations,
        reportPath,
      };
    }
    lastSignature = sig;

    // Transition to looping (if not already there)
    if (item.state === "verifying") {
      transitionFn(item, "looping", {
        phase: "3-loop1",
        reason: "fail_entering_fix_cycle",
        defect_signature: sig,
        defect_count: defects.length,
        iterations,
        reportPath,
      });
    }

    // --- maxIterations cap (LOOP-03) ---
    if (iterations >= maxIterations) {
      transitionFn(item, "failed", {
        phase: "3-loop1",
        reason: "max_iterations",
        maxIterations,
        iterations,
        reportPath,
      });
      return {
        outcome: "failed",
        reason: "max_iterations",
        iterations,
        reportPath,
      };
    }

    // --- ESCALATION LADDER (LOOP-05) ---
    // Bump effort band after escalateAfterIters failed fix attempts
    if (iterations > 0 && iterations % escalateAfterIters === 0) {
      const prevEffort = effort;
      effort = escalateEffort(effort);
      if (effort !== prevEffort) {
        item.trail = item.trail ?? [];
        item.trail.push({
          from: item.state,
          to: item.state,
          at: new Date().toISOString(),
          meta: {
            phase: "3-loop1",
            note: "effort_escalation",
            from_effort: prevEffort,
            to_effort: effort,
            iterations,
          },
        });
      }
    }
    // Bump model tier after escalateModelAfterIters failed fix attempts
    if (iterations > 0 && iterations % escalateModelAfterIters === 0) {
      const prevModel = model;
      model = escalateModel(model);
      if (model !== prevModel) {
        item.trail = item.trail ?? [];
        item.trail.push({
          from: item.state,
          to: item.state,
          at: new Date().toISOString(),
          meta: {
            phase: "3-loop1",
            note: "model_escalation",
            from_model: prevModel,
            to_model: model,
            iterations,
          },
        });
      }
    }

    // --- FIX (LOOP-02) ---
    try {
      await fix(defects, { effort, model });
    } catch (err) {
      // fix() threw: park as failed (unexpected; don't retry a broken fix path)
      transitionFn(item, "failed", {
        phase: "3-loop1",
        reason: "fix_threw",
        error: err.message,
        iterations,
        reportPath,
      });
      return {
        outcome: "failed",
        reason: "fix_threw",
        iterations,
        reportPath,
      };
    }

    // Record fix attempt on the item's audit trail
    item.trail = item.trail ?? [];
    item.trail.push({
      from: "looping",
      to: "verifying",
      at: new Date().toISOString(),
      meta: {
        phase: "3-loop1",
        note: "fix_attempt",
        iteration: iterations,
        effort,
        model,
        defect_signature: sig,
        defect_count: defects.length,
      },
    });

    // Advance back to verifying for the next verify pass (looping -> verifying)
    if (item.state === "looping") {
      transitionFn(item, "verifying", {
        phase: "3-loop1",
        note: "re-verify after fix",
        iteration: iterations,
        effort,
        model,
      });
    }

    iterations++;
  }
}

// ---------------------------------------------------------------------------
// Queue drainer integration helper
// ---------------------------------------------------------------------------

/**
 * Wire runLoop1 into the queue drainer for a single item.
 *
 * This is the drainer seam (QUEUE-04): called once per item after Phase 2
 * (classify + route) has completed. The item must be in `routed` state.
 *
 * The verify and fix functions are INJECTED by the caller:
 *   - In tests: mocks.
 *   - In live runs (loop1-live.mjs): the real spawn-based implementations,
 *     guarded behind --live.
 *
 * @param {object} opts
 * @param {object}   opts.item         - queue item in `routed` state
 * @param {Function} opts.transitionFn - transition() from queue.mjs
 * @param {Function} opts.verify       - injectable verify function
 * @param {Function} opts.fix          - injectable fix function
 * @param {object}   [opts.loopOpts]   - additional options forwarded to runLoop1
 * @returns {Promise<object>}  the runLoop1 result
 */
export async function drainItem({ item, transitionFn, verify, fix, loopOpts = {} }) {
  return runLoop1({ item, transitionFn, verify, fix, ...loopOpts });
}
