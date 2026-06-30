#!/usr/bin/env node
/**
 * loop2-live.mjs — Phase 2 (v3): Guarded Live Seam for Loop 2 (LOOP2-05)
 *
 * HUMAN-GATED — NEVER EXECUTED AUTOMATICALLY
 * ===========================================
 * This module provides the real, process-spawning verify, fix, and reMerge
 * functions that drive the Loop 2 controller (loop2.mjs) against the actual
 * integrated `rehearsal/<run-id>` app.
 *
 * It MUST NOT be called without an explicit --live flag. Calling it without
 * --live causes an immediate refusal with a human-readable error. This is a
 * hard contractual requirement (NFR-10, LOOP2-05).
 *
 * NEVER run this:
 *   - In automated CI/CD pipelines.
 *   - Against the `next` branch (NFR-01).
 *   - Without reading the human-gated checklist below.
 *   - Without a per-run budget cap configured.
 *   - Without a human watching the terminal.
 *
 * WHAT THIS MODULE DOES (LOOP2-05)
 * ==================================
 * This module provides the live-wired injections for runLoop2() in loop2.mjs:
 *
 *   liveVerify({ rehearsalBranch, runId }):
 *       Checks out the rehearsal branch, boots the integrated rehearsal app
 *       via runtime-isolate.sh (one integrated server, not per-worktree),
 *       spawns /bgsd-verify against the integrated system (via build-report.mjs),
 *       waits for exit, reads the integration-report.json it produces, and
 *       returns the parsed report in the shape expected by runLoop2() in loop2.mjs.
 *       Reuses the v0 Tester contract and computeVerdict() unchanged (LOOP2-02).
 *       HUMAN-GATED: refuses without --live (NFR-10).
 *
 *   liveFix(defects):
 *       Dispatches parallel fix agents (Sonnet/medium per Part 11) in worktrees
 *       branched off rehearsal/<run-id>, each fixing one independent tagged item.
 *       Never calls fix agents on BLOCKED or ERROR verdicts (loop2.mjs enforces this).
 *       HUMAN-GATED: refuses without --live (NFR-10).
 *
 *   liveReMerge():
 *       Re-integrates fixed worktree branches into rehearsal/<run-id> via the
 *       dependency-ordered conflict.mjs merge after fixes complete.
 *       HUMAN-GATED: refuses without --live (NFR-10).
 *
 *   runLiveLoop2({ runId, rehearsalBranch, loopOpts }):
 *       Wires liveVerify + liveFix + liveReMerge into runLoop2() and also
 *       advances run.json to `integrating` via advanceStateFn (run.mjs).
 *       HUMAN-GATED: refuses without --live (NFR-10). Also refuses if the
 *       current branch is `next`/`main`/`master` (requireNotNextBranch, NFR-01).
 *       Prints the human-gated warning + safety checklist when refused.
 *
 * HUMAN-GATED CHECKLIST (run through this before invoking with --live):
 * ======================================================================
 *   1. You are on a feature branch, NOT `next`. Verify: git branch --show-current
 *   2. rehearsal/<run-id> was assembled by Phase 1 Loop 2 controller (loop2.mjs)
 *      and ran clean under mocked Tester/fix before you reach this step.
 *   3. You have a per-run budget cap configured (--budget-cap or BGSD_BUDGET_CAP).
 *   4. caffeinate is running (Mac must not sleep during a live run).
 *   5. You are watching the terminal — this is NOT fire-and-forget (NFR-08).
 *   6. The runtime-isolate.sh isolation convention is in place: each rehearsal
 *      app runs on its own port/DB/env — no shared state with production.
 *   7. You know max_iterations (default: 5) and accept that fix agents may write
 *      to worktree branches off rehearsal/<run-id>.
 *   8. rehearsal/<run-id> is the target. `next` will NEVER be touched (NFR-01).
 *
 * GUARDED LIVE SEAM DESIGN (mirrors loop1-live.mjs / run-live.mjs exactly)
 * ==========================================================================
 * Every exported live function calls requireLiveFlag() as its FIRST executable
 * line and throws a human-readable refusal if --live is absent from process.argv.
 * The flag check uses process.argv, NOT process.env, so a CI environment variable
 * cannot accidentally unlock it.
 *
 * The runLiveLoop2() top-level function also calls requireNotNextBranch() so
 * the current branch is checked independently of --live.
 *
 * --dry-run (the default) is handled by the caller. This file is ONLY for
 * the --live path.
 *
 * Usage (human, supervised only):
 *   node bgsd/scripts/loop2-live.mjs --live \
 *     --run-id <id> \
 *     --rehearsal-branch rehearsal/<id> \
 *     --max-iterations 5
 */

import { spawnSync }         from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { integrationBranchForRun, isProductionBranch } from "./integration.mjs";
import { resolve, join, dirname }   from "node:path";
import { fileURLToPath }            from "node:url";

const __dir    = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (NFR-10, LOOP2-05) — mirrors loop1-live.mjs / run-live.mjs
// ---------------------------------------------------------------------------

/**
 * Check whether the --live flag was explicitly passed on the command line.
 * Returns true only if "--live" appears in process.argv.
 *
 * This is the same implementation as loop1-live.mjs and run-live.mjs.
 *
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to run the live seam unless --live is explicitly set.
 * This is called as the FIRST executable line of every exported live function.
 *
 * Mirrors loop1-live.mjs requireLiveFlag() exactly (LOOP2-05, NFR-10).
 *
 * @throws {Error} if --live is not in process.argv
 */
export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: loop2-live.mjs refused to run.\n" +
      "\n" +
      "The live Loop 2 integration run (real rehearsal app boot + real\n" +
      "Integration Tester→fix cycles) requires an explicit --live flag\n" +
      "to prevent accidental automation.\n" +
      "\n" +
      "To run this supervised:\n" +
      "  node bgsd/scripts/loop2-live.mjs --live [options]\n" +
      "\n" +
      "Safety checklist before using --live:\n" +
      "  - You are on a feature branch, NOT `next` (git branch --show-current)\n" +
      "  - rehearsal/<run-id> was assembled by the Phase 1 controller (loop2.mjs)\n" +
      "  - You have a per-run budget cap set (--budget-cap or BGSD_BUDGET_CAP)\n" +
      "  - caffeinate is running (Mac must not sleep during a live run)\n" +
      "  - You are watching the terminal — this is NOT fire-and-forget\n" +
      "  - runtime-isolate.sh isolation is in place (own port/DB/env)\n" +
      "  - rehearsal/<run-id> is the target; next is NEVER touched\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts or scheduled automation.\n" +
      "  - Run this against the 'next' branch (NFR-01).\n" +
      "  - Run this without reading the checklist in loop2-live.mjs.\n" +
      "  - Skip the --dry-run validation step (node bgsd/scripts/loop2.mjs).\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Branch safety guard (NFR-01) — mirrors run-live.mjs requireNotNextBranch()
// ---------------------------------------------------------------------------

/**
 * Refuse to run if the current branch is `next`, `main`, or `master`.
 * This guard fires regardless of --live — it is always enforced.
 *
 * Mirrors run-live.mjs requireNotNextBranch() exactly (NFR-01).
 *
 * @throws {Error} if the current branch is a protected branch
 */
export function requireNotProductionBranch() {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd:      REPO_ROOT,
    encoding: "utf8",
  });
  const branch = (result.stdout ?? "").trim();
  if (isProductionBranch(branch)) {
    throw new Error(
      `\nNFR-01 VIOLATION: loop2-live.mjs refuses to run on branch "${branch}".\n` +
      `bgsd NEVER writes to the production branch during a live integration run.\n` +
      `Switch to a feature branch (e.g. feat/bgsd-v0) and try again.\n`
    );
  }
}

// ---------------------------------------------------------------------------
// liveVerify — boots rehearsal app, runs Integration Tester (LOOP2-05)
// ---------------------------------------------------------------------------

/**
 * Live implementation of verify() for runLoop2().
 *
 * (1) Boots the integrated `rehearsal/<run-id>` app via runtime-isolate.sh
 *     (one integrated server, not per-worktree — LOOP2-01).
 * (2) Spawns /bgsd-verify (via build-report.mjs) against the integrated system
 *     to run the Integration Tester end-to-end (LOOP2-02).
 * (3) Reads the integration-report.json it produces and returns the parsed
 *     result in the shape expected by runLoop2():
 *     { verdict, defects, criteria_results, scrutiny, reportPath }
 *
 * Reuses the v0 Tester contract (computeVerdict(), verification-report.json
 * shape) unchanged (LOOP2-02). Never rewrites the Tester.
 *
 * HUMAN-GATED: refuses without --live (NFR-10).
 *
 * @param {object} opts
 * @param {string}   opts.rehearsalBranch  e.g. "rehearsal/bgsd-0001-my-feature"
 * @param {string}   opts.runId            Run identifier
 * @param {string}   [opts.bgsdDir]        Override .bgsd dir path
 * @param {string}   [opts.isoScript]      Override path to runtime-isolate.sh
 * @param {string}   [opts.verifyScript]   Override path to build-report.mjs
 * @returns {Promise<{
 *   verdict:          "PASS"|"FAIL"|"ERROR"|"BLOCKED",
 *   defects:          Array,
 *   criteria_results: Array,
 *   scrutiny:         object,
 *   reportPath:       string|null,
 * }>}
 */
export async function liveVerify({
  rehearsalBranch,
  runId,
  bgsdDir,
  isoScript,
  verifyScript,
  usageTesting = process.env.BGSD_USAGE_TESTING !== "0",
}) {
  requireLiveFlag();

  const bgsd       = bgsdDir   ?? join(REPO_ROOT, ".bgsd");
  const isoPath    = isoScript ?? join(REPO_ROOT, "bgsd", "scripts", "runtime-isolate.sh");
  const reportPath = join(bgsd, "runs", runId, "integration-report.json");

  process.stderr.write(
    `[loop2-live] liveVerify: booting rehearsal app for ${rehearsalBranch}\n` +
    `  runtime-isolate.sh: ${isoPath}\n` +
    `  report path:        ${reportPath}\n` +
    `  usage testing:      ${usageTesting ? "ON (Playwright)" : "OFF (code-only / gsd-verifier)"}\n`
  );

  // LIVE SEAM POINT — Step 1: boot the integrated rehearsal app (LOOP2-01)
  //
  // In a fully-wired live run this would:
  //   const isoResult = spawnSync("bash", [isoPath, rehearsalBranch, runId], {
  //     cwd: REPO_ROOT, stdio: "inherit",
  //   });
  //   if (isoResult.status !== 0) {
  //     return { verdict: "ERROR", defects: [], criteria_results: [], scrutiny: {},
  //              reportPath: null };
  //   }
  //
  // The spawn is intentionally NOT executed here; the human watches the terminal
  // and triggers via the runLiveLoop2() export (NFR-10 / NFR-08).
  //
  // To wire the real boot, replace this comment block with the spawnSync above.

  process.stderr.write(
    `[loop2-live] (live seam not yet connected — would boot ${rehearsalBranch} via runtime-isolate.sh)\n`
  );

  // LIVE SEAM POINT — Step 2: run the Integration Tester (LOOP2-02)
  //
  // In a fully-wired live run this would invoke build-report.mjs against the
  // running integrated system and then read integration-report.json:
  //
  //   const verify = verifyScript ?? join(REPO_ROOT, "bgsd", "scripts", "build-report.mjs");
  //   const verifyResult = spawnSync("node", [verify, "--run-id", runId,
  //                                            "--integration", "--scope", "integration"], {
  //     cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  //     env: { ...process.env, BGSD_USAGE_TESTING: usageTesting ? "1" : "0" },
  //   });
  //   if (verifyResult.error) {
  //     return { verdict: "ERROR", defects: [], criteria_results: [], scrutiny: {},
  //              reportPath: null };
  //   }
  //
  // The real invocation is intentionally NOT executed here.

  // If a real integration-report.json was already written (e.g. in a partial live run),
  // read it; otherwise surface as ERROR (NFR-06: no silent green).
  if (existsSync(reportPath)) {
    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (_) {
      return {
        verdict:          "ERROR",
        defects:          [],
        criteria_results: [],
        scrutiny:         {},
        reportPath,
      };
    }
    return {
      verdict:          report.verdict          ?? "ERROR",
      defects:          report.defects          ?? [],
      criteria_results: report.criteria_results ?? [],
      scrutiny:         report.integration?.scrutiny ?? {},
      reportPath,
    };
  }

  // No report found and we have not booted: ERROR (NFR-06)
  return {
    verdict:          "ERROR",
    defects:          [],
    criteria_results: [],
    scrutiny:         {},
    reportPath:       null,
  };
}

// ---------------------------------------------------------------------------
// liveFix — dispatch parallel fix agents on integration defects (LOOP2-05)
// ---------------------------------------------------------------------------

/**
 * Live implementation of fix() for runLoop2().
 *
 * Dispatches parallel fix agents (Sonnet/medium per Part 11) in worktrees
 * branched off `rehearsal/<run-id>`, each fixing one independent tagged item
 * from the integration defect backlog.
 *
 * Never called on BLOCKED or ERROR verdicts — that is enforced by loop2.mjs
 * before fix() is injected into the loop (LOOP2-04).
 *
 * HUMAN-GATED: refuses without --live (NFR-10).
 *
 * @param {Array<object>} defects     Defect list from the last verify report
 * @param {object}        [opts]
 * @param {number}          [opts.iteration]  Current loop iteration (for logging)
 * @returns {Promise<void>}
 */
export async function liveFix(defects, opts = {}) {
  requireLiveFlag();

  const { iteration = 0 } = opts;

  process.stderr.write(
    `[loop2-live] liveFix: would dispatch ${defects.length} parallel fix agents\n` +
    `  iteration:  ${iteration}\n` +
    `  defects:    ${defects.map((d) => d.id ?? d.description ?? "(unknown)").join(", ")}\n` +
    `  model:      sonnet (medium effort per Part 11)\n` +
    `  (live --live path; not spawning automatically without confirmation)\n`
  );

  // LIVE SEAM POINT: in a fully-wired live run this would:
  //   1. For each independent defect item, create a worktree off rehearsal/<run-id>:
  //        spawnSync("git", ["worktree", "add", wtPath, "-b", fixBranch, rehearsalHead], ...)
  //   2. Spawn a fix agent in the worktree:
  //        spawnSync("claude", ["-p", "/gsd-quick", "--worktree", wtPath,
  //                             "--effort", "medium", "--model-profile", "sonnet"], ...)
  //   3. Wait for all agents to complete (poll control files or join processes).
  //
  // The real spawns are intentionally NOT executed here; the human must watch
  // the terminal and confirm (NFR-10 "human-supervised, never CI").
  //
  // To wire the real dispatch, implement the three steps above using spawnSync
  // (or spawn with a polling loop) for each defect item in parallel.
}

// ---------------------------------------------------------------------------
// liveReMerge — re-integrate fixed branches via conflict.mjs (LOOP2-05)
// ---------------------------------------------------------------------------

/**
 * Live implementation of reMerge() for runLoop2().
 *
 * Re-integrates the fixed worktree branches into `rehearsal/<run-id>` after
 * fix agents complete, using the v2 conflict pre-check + dependency-ordered
 * merge from conflict.mjs (LOOP2-03).
 *
 * HUMAN-GATED: refuses without --live (NFR-10).
 *
 * @param {object} [opts]
 * @param {number}   [opts.iteration]   Current loop iteration (for logging)
 * @param {string}   [opts.runId]       Run identifier (for branch naming)
 * @returns {Promise<void>}
 */
export async function liveReMerge(opts = {}) {
  requireLiveFlag();

  const { iteration = 0, runId = "" } = opts;

  process.stderr.write(
    `[loop2-live] liveReMerge: would re-integrate fixed branches into rehearsal/${runId}\n` +
    `  iteration:  ${iteration}\n` +
    `  method:     conflict.mjs dependency-ordered merge (pre-check + merge)\n` +
    `  (live --live path; not merging automatically without confirmation)\n`
  );

  // LIVE SEAM POINT: in a fully-wired live run this would:
  //   1. Collect the fix-agent worktree branches for this iteration.
  //   2. Run conflict.mjs computeMergeOrder() to get dependency-ordered merge list.
  //   3. Run conflict.mjs executeMerges() with liveGitMergeFn as mergeFn,
  //      a resolver agent as resolverFn, and addEscalation as escalateFn.
  //
  // Example wiring (not executed here):
  //
  //   const { computeMergeOrder, executeMerges, liveGitMergeFn } =
  //     await import(`file://${join(__dir, "conflict.mjs")}`);
  //
  //   const mergeOrder = computeMergeOrder({ waves, unitStatuses, edges });
  //   await executeMerges({
  //     mergeOrder,
  //     runId,
  //     mergeFn:    (unitId, rid) => liveGitMergeFn(unitId, rid, { cwd: REPO_ROOT }),
  //     resolverFn: async (unitId, conflicts) => ({ confidence: 0.0, resolution: null }),
  //     escalateFn: async (unitId, info) => { /* addEscalation via control.mjs */ },
  //   });
  //
  // The real merge is intentionally NOT executed here.
}

// ---------------------------------------------------------------------------
// runLiveLoop2 — full wired integration loop (LOOP2-05, human-supervised)
// ---------------------------------------------------------------------------

/**
 * Wire liveVerify + liveFix + liveReMerge into runLoop2() and drive the full
 * Loop 2 integration verify→fix loop end-to-end.
 *
 * Also advances run.json to the `integrating` lifecycle state via
 * advanceStateFn (reusing run.mjs advanceState — LOOP2-01).
 *
 * This is the human-supervised, end-to-end live integration run. It drives
 * `rehearsal/<run-id>` through the full verify→fix→re-merge→re-verify cycle
 * using the real Integration Tester and real fix agents.
 *
 * HUMAN-GATED: refuses without --live (NFR-10).
 * NEVER run in CI or against `next` (NFR-01).
 *
 * @param {object} opts
 * @param {string}   opts.runId               Run identifier (e.g. "bgsd-0001-foo")
 * @param {string}   [opts.rehearsalBranch]   e.g. "rehearsal/bgsd-0001-foo"
 * @param {string}   [opts.bgsdDir]           Override .bgsd directory path
 * @param {string}   [opts.runJsonPath]       Path to run.json (for advanceStateFn)
 * @param {object}   [opts.loopOpts]          Options forwarded to runLoop2 (maxIterations, etc.)
 * @returns {Promise<object>}  runLoop2 result
 */
export async function runLiveLoop2({
  runId,
  rehearsalBranch,
  bgsdDir,
  runJsonPath,
  loopOpts = {},
}) {
  requireLiveFlag();
  requireNotProductionBranch();

  const branch  = rehearsalBranch ?? integrationBranchForRun(runId);
  const bgsd    = bgsdDir ?? join(REPO_ROOT, ".bgsd");

  process.stderr.write(
    "\n" +
    "======================================================================\n" +
    "Kiwi: HUMAN-SUPERVISED Live Integration Run\n" +
    "======================================================================\n\n" +
    `  Run ID:           ${runId}\n` +
    `  Rehearsal Branch: ${branch}\n` +
    `  --live flag:      DETECTED\n\n` +
    "Safety checklist — confirm before proceeding:\n" +
    "  [1] On a feature branch, NOT next:  git branch --show-current\n" +
    "  [2] Phase 1 controller ran clean under mocked Tester/fix\n" +
    "  [3] Per-run budget cap is set (--budget-cap or BGSD_BUDGET_CAP)\n" +
    "  [4] caffeinate is running (caffeinate -dimsu &)\n" +
    "  [5] Watching the terminal — this is NOT fire-and-forget\n" +
    "  [6] runtime-isolate.sh isolation is in place (own port/DB/env)\n" +
    "  [7] rehearsal/<run-id> is the target; next is NEVER touched\n" +
    "\n" +
    "  Proceeding with runLiveLoop2 (live seam stubs active)...\n" +
    "======================================================================\n\n"
  );

  // Lazy import the pure controller (so this file can be imported in tests
  // without accidentally pulling in live state — mirrors loop1-live.mjs).
  const { runLoop2 } = await import(`file://${resolve(__dir, "loop2.mjs")}`);

  // Build advanceStateFn from run.mjs (advances run.json to "integrating" — LOOP2-01).
  // When runJsonPath is provided, we wire the real advanceState; otherwise a no-op.
  let advanceStateFn = null;
  if (runJsonPath) {
    try {
      const { advanceState } = await import(`file://${resolve(__dir, "run.mjs")}`);
      advanceStateFn = (toState, meta) => advanceState(runJsonPath, toState, meta);
    } catch (_) {
      // If run.mjs is not available, fall back to a log-only stub
      advanceStateFn = (toState, meta) => {
        process.stderr.write(
          `[loop2-live] advanceStateFn: would advance run.json → "${toState}" (run.mjs unavailable)\n`
        );
      };
    }
  }

  const verify   = () => liveVerify({ rehearsalBranch: branch, runId, bgsdDir: bgsd });
  const fix      = (defects, opts2) => liveFix(defects, { ...opts2 });
  const reMerge  = (opts2) => liveReMerge({ ...opts2, runId });

  return runLoop2({
    runId,
    rehearsalBranch: branch,
    verify,
    fix,
    reMerge,
    advanceStateFn,
    bgsdDir: bgsd,
    ...loopOpts,
  });
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
  // Guard fires at invocation time: if --live is absent, print the refusal.
  try {
    requireLiveFlag();
  } catch (err) {
    process.stderr.write(err.message);
    process.exit(1);
  }

  // Also check branch safety at CLI invocation time.
  try {
    requireNotProductionBranch();
  } catch (err) {
    process.stderr.write(err.message);
    process.exit(1);
  }

  process.stderr.write(
    "\n[loop2-live] --live flag detected. This is a HUMAN-SUPERVISED run.\n" +
    "  Pass runId, rehearsalBranch, and loopOpts programmatically via\n" +
    "  the runLiveLoop2() export. This CLI entrypoint is a usage reminder.\n\n" +
    "  Before a live integration run, ensure:\n" +
    "    1. git branch --show-current (must NOT be 'next')\n" +
    "    2. Phase 1 controller (loop2.mjs) ran clean under mocked Tester/fix\n" +
    "    3. BGSD_BUDGET_CAP is set\n" +
    "    4. caffeinate is running\n" +
    "    5. You are watching the terminal\n\n"
  );
  process.exit(0);
}
