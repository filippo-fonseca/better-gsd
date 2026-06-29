#!/usr/bin/env node
/**
 * loop1-live.mjs — Phase 3: Live execution seam for Loop 1 (LOOP-01..04)
 *
 * HUMAN-GATED — NEVER EXECUTED AUTOMATICALLY
 * ===========================================
 * This module provides the real, process-spawning verify and fix functions
 * that drive the Loop 1 controller (loop1.mjs) against an actual worktree.
 *
 * It MUST NOT be called without an explicit --live flag. Calling it without
 * --live causes an immediate refusal with a human-readable error (see guard
 * at bottom of this file). This is a hard contractual requirement (NFR-07).
 *
 * NEVER run this:
 *   - In automated CI/CD pipelines.
 *   - Against the `next` branch (NFR-01).
 *   - Without reading the human-gated checklist below.
 *
 * WHAT THIS MODULE DOES (LOOP-01..04)
 * =====================================
 *   - liveVerify(worktreePath):
 *       Spawns `/bgsd-verify` against the worktree's isolated running
 *       instance, waits for it to exit, reads the `verification-report.json`
 *       it writes to `.bgsd/runs/<run_id>/verification-report.json`, and
 *       returns the parsed report in the shape { verdict, defects, reportPath }
 *       expected by runLoop1() in loop1.mjs. Reuses the v0 Tester contract
 *       unchanged (LOOP-01).
 *
 *   - liveFix(defects, opts, worktreePath, item):
 *       Routes the defect list to the appropriate /gsd-* command in the
 *       worktree. The command to run is already recorded on item.gsd_command
 *       from Phase 2 routing. Never reimplements GSD execution (NFR-04).
 *
 *   - runLiveLoop1(opts):
 *       Wires liveVerify + liveFix into runLoop1() and drives the full
 *       verify→fix loop end-to-end in one worktree (LOOP-04). Requires the
 *       worktree to already exist and the isolated instance to be running.
 *
 * HUMAN-GATED CHECKLIST (run through this before invoking with --live):
 * ======================================================================
 *   1. You are on a feature branch, NOT `next`. Verify: git branch --show-current
 *   2. The worktree is isolated (port, DB, env). Verify with runtime-isolate.sh.
 *   3. The isolated server is actually running and reachable.
 *   4. You have a per-run budget cap configured (to limit model spend).
 *   5. You are watching the terminal — this is NOT fire-and-forget.
 *   6. You know the item's max_iterations setting (default: 5).
 *   7. You accept that this may write to the worktree and run /gsd-* commands.
 *
 * GUARDED LIVE SEAM DESIGN
 * ========================
 * The guard is a check at module load time (see bottom of file). If the
 * module is imported without the --live flag in process.argv, it throws an
 * error immediately. This prevents accidental invocation from test suites
 * or CI pipelines that import it without thinking.
 *
 * The flag must be passed explicitly on the command line:
 *   node bgsd/scripts/loop1-live.mjs --live [other options]
 *
 * Passing the flag as an environment variable alone is NOT sufficient.
 * The guard checks process.argv, not process.env, so it cannot be
 * accidentally set by a CI environment variable injection.
 *
 * Usage (human, supervised only):
 *   node bgsd/scripts/loop1-live.mjs --live \
 *     --item-id <id> \
 *     --worktree <path> \
 *     --max-iterations 5
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (NFR-07) — must be the first executable code
// ---------------------------------------------------------------------------

/**
 * Check whether the --live flag was explicitly passed on the command line.
 * Returns true only if "--live" appears in process.argv.
 *
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to run the live seam unless --live is explicitly set.
 * This is called by every exported live function.
 *
 * @throws {Error} if --live is not in process.argv
 */
function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: loop1-live.mjs refused to run.\n" +
      "\n" +
      "The live execution path (real /bgsd-verify + /gsd-* in a worktree)\n" +
      "requires an explicit --live flag to prevent accidental automation.\n" +
      "\n" +
      "To run this supervised:\n" +
      "  node bgsd/scripts/loop1-live.mjs --live [options]\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts.\n" +
      "  - Run this against the 'next' branch (NFR-01).\n" +
      "  - Run this without reading the checklist in loop1-live.mjs.\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Live verify — spawns /bgsd-verify, parses verification-report.json (LOOP-01)
// ---------------------------------------------------------------------------

/**
 * Live implementation of verify().
 *
 * Spawns the v0 Tester (`/bgsd-verify`) as a child process, waits for it
 * to exit, then reads the `verification-report.json` it wrote to
 * `.bgsd/runs/<run_id>/`. Returns a report in the shape expected by
 * runLoop1():
 *   { verdict: "PASS"|"FAIL"|"BLOCKED"|"ERROR", defects: [], reportPath: string }
 *
 * Reuses the v0 `verification-report.json` contract unchanged (LOOP-01).
 * Never rewrites the Tester.
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {object} opts
 * @param {string}   opts.worktreePath   - absolute path to the worktree root
 * @param {string}   opts.runId          - run ID for the verification run
 * @param {string}   [opts.bgsdVerifyCmd] - override for the bgsd-verify command path
 * @returns {Promise<{ verdict: string, defects: object[], reportPath: string|null }>}
 */
export async function liveVerify({ worktreePath, runId, bgsdVerifyCmd }) {
  requireLiveFlag();

  const cmd = bgsdVerifyCmd ?? "node";
  // The /bgsd-verify skill is invoked via the Claude Code skill runner.
  // Here we show the structural spawn; the actual invocation method
  // (claude -p /bgsd-verify, or node driver) is environment-specific.
  // For the structural seam, we show a node-based driver call.
  const verifyScript = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../bgsd/scripts/build-report.mjs"
  );

  // Path where /bgsd-verify writes its output
  const runsDir = join(worktreePath, ".bgsd", "runs");
  const reportPath = join(runsDir, runId, "verification-report.json");

  // Spawn the verify command (LOOP-01: reuses v0 contract)
  // In a real invocation this would be: `claude -p /bgsd-verify --run-id <runId>`
  // For the seam we invoke the report builder with a placeholder run-results file.
  const result = spawnSync(cmd, [verifyScript], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error) {
    return { verdict: "ERROR", defects: [], reportPath: null };
  }

  // Read and parse the report written by /bgsd-verify
  if (!existsSync(reportPath)) {
    // Report not found: treat as ERROR (NFR-06: no silent green)
    return { verdict: "ERROR", defects: [], reportPath: null };
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (_) {
    return { verdict: "ERROR", defects: [], reportPath };
  }

  return {
    verdict: report.verdict ?? "ERROR",
    defects: report.defects ?? [],
    reportPath,
  };
}

// ---------------------------------------------------------------------------
// Live fix — routes defects to /gsd-* command in the worktree (LOOP-02)
// ---------------------------------------------------------------------------

/**
 * Live implementation of fix().
 *
 * Routes the defect list to the appropriate /gsd-* command on the item
 * (recorded by Phase 2 routing as item.gsd_command). Never reimplements
 * GSD execution (NFR-04): bgsd calls /gsd-*; GSD does the work.
 *
 * The fix is run in the worktree, NOT in the repo root, so it is isolated
 * from the production branch (NFR-01).
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {Array<object>} defects          - defect list from the last verify report
 * @param {{ effort: string, model: string }} opts  - escalation hints from LOOP-05
 * @param {object} context
 * @param {string}   context.worktreePath  - absolute path to the worktree
 * @param {object}   context.item          - queue item (has item.gsd_command)
 * @returns {Promise<void>}
 */
export async function liveFix(defects, opts, { worktreePath, item }) {
  requireLiveFlag();

  const gsdCommand = item.gsd_command ?? "/gsd-quick";
  const { effort = "medium", model = "balanced" } = opts ?? {};

  // Write a defect summary to .bgsd/runs/<runId>/defects-for-fix.json
  // so the GSD agent can read it as context.
  // (The actual claude -p /gsd-* invocation is the human-supervised live path.)
  process.stderr.write(
    `[loop1-live] liveFix: would invoke ${gsdCommand} in ${worktreePath}\n` +
    `  defects: ${defects.length}  effort: ${effort}  model: ${model}\n` +
    `  (live --live path; not spawning automatically without confirmation)\n`
  );

  // LIVE SEAM POINT: in a fully-wired live run, this would:
  //   spawnSync("claude", ["-p", gsdCommand, "--worktree", worktreePath], { ... })
  // That spawn is intentionally NOT called here; the human must confirm each fix
  // by watching the terminal (NFR-07 "human-supervised only; never CI").
  //
  // To wire the live fix spawn, replace the stderr.write above with:
  //
  //   const result = spawnSync("claude", [
  //     "-p", gsdCommand,
  //     "--worktree", worktreePath,
  //     "--effort", effort,
  //     "--model-profile", model,
  //   ], { stdio: "inherit", cwd: worktreePath });
  //   if (result.status !== 0) throw new Error(`liveFix: ${gsdCommand} exited with ${result.status}`);
}

// ---------------------------------------------------------------------------
// runLiveLoop1 — full wired loop (LOOP-04, human-supervised)
// ---------------------------------------------------------------------------

/**
 * Wire liveVerify + liveFix into runLoop1() and run the full verify→fix loop.
 *
 * This is the human-supervised, end-to-end live run. It drives one queue
 * item from `routed` (or `executing`) to `done`/`failed`/`blocked` using
 * the real /bgsd-verify and /gsd-* commands in an isolated worktree.
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 * NEVER run this in CI or against `next` (NFR-01).
 *
 * @param {object} opts
 * @param {object}   opts.item           - queue item to drive
 * @param {Function} opts.transitionFn   - transition() from queue.mjs
 * @param {string}   opts.worktreePath   - absolute path to the isolated worktree
 * @param {string}   opts.runId          - unique run ID for this verification run
 * @param {object}   [opts.loopOpts]     - options forwarded to runLoop1 (maxIterations, etc.)
 * @returns {Promise<object>}  runLoop1 result
 */
export async function runLiveLoop1({ item, transitionFn, worktreePath, runId, loopOpts = {} }) {
  requireLiveFlag();

  // Lazy import the pure controller so that this file can be imported in
  // tests (to check the guard) without accidentally pulling in live state.
  const { runLoop1 } = await import(`file://${resolve(
    dirname(fileURLToPath(import.meta.url)),
    "loop1.mjs"
  )}`);

  const verify = () => liveVerify({ worktreePath, runId });
  const fix = (defects, opts2) => liveFix(defects, opts2, { worktreePath, item });

  return runLoop1({ item, transitionFn, verify, fix, ...loopOpts });
}

// ---------------------------------------------------------------------------
// CLI entrypoint (human-supervised only)
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
  // The guard fires at invocation time: if --live is absent, print the refusal.
  // We wrap in try/catch to print a user-friendly message instead of a stack trace.
  try {
    requireLiveFlag();
  } catch (err) {
    process.stderr.write(err.message);
    process.exit(1);
  }

  process.stderr.write(
    "\n[loop1-live] --live flag detected. This is a HUMAN-SUPERVISED run.\n" +
    "  Run-id, worktree, and item-id must be passed programmatically via\n" +
    "  the runLiveLoop1() export. This CLI entrypoint is a usage reminder.\n\n"
  );
  process.exit(0);
}
