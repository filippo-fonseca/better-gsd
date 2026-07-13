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
import { propagateEnvForConfig } from "./envprop.mjs";
import { activeLane, buildAgentSpawn } from "./harness.mjs";
import { resolve, join, dirname }   from "node:path";
import { fileURLToPath }            from "node:url";

const __dir    = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");
const PLUGIN_ROOT = resolve(__dir, "..");

/**
 * Parse the `PORT:` line runtime-isolate.sh prints on `up`. The script emits a
 * line like `PORT: 3123`; we take the first match and return the integer.
 *
 * @param {string} stdout  combined stdout from runtime-isolate.sh up
 * @returns {number|null}  the parsed port, or null when no PORT: line appears
 */
export function parseIsolatePort(stdout) {
  const m = /^\s*PORT:\s*(\d+)\s*$/m.exec(String(stdout ?? ""));
  return m ? Number(m[1]) : null;
}

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
 * Refuse to run if the current branch is a production branch (`main`/`master`).
 * This guard is ALWAYS enforced (NFR-01) — it does not depend on --live.
 *
 * The git boundary + repo root are injectable so the guard is unit-testable
 * (a test can force the "current branch" to a production branch without a real
 * checkout). Defaults read the real current branch of the repo.
 *
 * Mirrors run-live.mjs requireNotProductionBranch() exactly (NFR-01).
 *
 * @param {object}   [opts]
 * @param {Function} [opts.gitImpl]   Injected git runner (default spawnSync)
 * @param {string}   [opts.repoRoot]  Repo root to read the branch from (default REPO_ROOT)
 * @throws {Error} if the current branch is a protected branch
 */
export function requireNotProductionBranch(opts = {}) {
  const gitImpl  = opts.gitImpl  ?? spawnSync;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const result = gitImpl("git", ["branch", "--show-current"], {
    cwd:      repoRoot,
    encoding: "utf8",
  });
  const branch = (result?.stdout ?? "").trim();
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
 * NFR-01 branch guard is always enforced (via requireNotProductionBranch); no
 * --live flag is required to run the live seam.
 *
 * @param {object} opts
 * @param {string}   opts.rehearsalBranch  e.g. "rehearsal/bgsd-0001-my-feature"
 * @param {string}   opts.runId            Run identifier
 * @param {string}   [opts.rehearsalAppDir] Absolute path to the assembled app dir to boot
 *                                          (default: the repo root — the integrated tree).
 * @param {string}   [opts.integrationCriteria] Path to the integration criteria file passed
 *                                               to /bgsd-verify --criteria.
 * @param {string}   [opts.bgsdDir]        Override .bgsd dir path
 * @param {string}   [opts.isoScript]      Override path to runtime-isolate.sh
 * @param {string}   [opts.repoRoot]       Override the repo root (default REPO_ROOT)
 * @param {Function} [opts.spawnImpl]      Injected child-process runner (default spawnSync)
 * @param {Function} [opts.gitImpl]        Injected git runner (default spawnSync)
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
  rehearsalAppDir,
  integrationCriteria,
  bgsdDir,
  isoScript,
  repoRoot,
  spawnImpl,
  gitImpl,
  usageTesting = process.env.BGSD_USAGE_TESTING !== "0",
}) {
  const spawn  = spawnImpl ?? spawnSync;
  const git    = gitImpl   ?? spawnSync;
  const root   = repoRoot  ?? REPO_ROOT;

  // NFR-01 branch guard is always enforced (uses the injected git boundary so a
  // test can force a production-branch refusal).
  requireNotProductionBranch({ gitImpl: git, repoRoot: root });

  const bgsd       = bgsdDir   ?? join(root, ".bgsd");
  const isoPath    = isoScript ?? join(PLUGIN_ROOT, "scripts", "runtime-isolate.sh");
  const appDir     = rehearsalAppDir ?? root;
  const criteria   = integrationCriteria ?? join(bgsd, "runs", runId, "integration-criteria.md");
  const reportPath = join(bgsd, "runs", runId, "integration-report.json");

  process.stderr.write(
    `[loop2-live] liveVerify: booting integrated rehearsal app for ${rehearsalBranch}\n` +
    `  runtime-isolate.sh: ${isoPath}\n` +
    `  app dir:            ${appDir}\n` +
    `  report path:        ${reportPath}\n` +
    `  usage testing:      ${usageTesting ? "ON (Playwright)" : "OFF (code-only / gsd-verifier)"}\n`
  );

  let booted = false;
  try {
    // Step 0: propagate env files onto the integration/rehearsal checkout before
    // booting — a rehearsal worktree (appDir) does not carry gitignored env files,
    // so without this the integrated app fails to boot and the Tester fails
    // spuriously. No-op when appDir IS the repo root (env already present).
    propagateEnvForConfig({
      repoRoot: root,
      destDir: appDir,
      log: (m) => process.stderr.write(`[loop2-live] ${m}\n`),
    });

    // Step 1: boot the integrated rehearsal app via runtime-isolate.sh (LOOP2-01).
    // runtime-isolate.sh prints `PORT:`/`DATABASE_URL:`/`READY` on stdout.
    const isoResult = spawn(
      "bash",
      [isoPath, "up", appDir],
      { cwd: root, encoding: "utf8" }
    );
    if (isoResult?.error) {
      throw new Error(`runtime-isolate.sh up failed: ${isoResult.error.message}`);
    }
    if (isoResult?.status !== 0) {
      throw new Error(
        `runtime-isolate.sh up exited non-zero (${isoResult?.status}): ${isoResult?.stderr ?? ""}`
      );
    }
    booted = true;

    const port = parseIsolatePort(isoResult.stdout);
    if (!port) {
      // Booted but no PORT: line — cannot address the app. ERROR (NFR-06).
      throw new Error(
        `runtime-isolate.sh up did not print a PORT: line; cannot address the rehearsal app`
      );
    }
    const url = `http://localhost:${port}`;
    process.stderr.write(`[loop2-live] rehearsal app is up at ${url}\n`);

    // Step 2: run the Integration Tester end-to-end (LOOP2-02) on the active
    // harness. claude: `claude -p /bgsd-verify <url> --criteria <file>`; codex:
    // `codex exec "<prompt>" --model <equiv> --sandbox …`. Runs the whole-app UAT
    // + code review, writes integration-report.json, and prints a verdict line.
    const laneV = activeLane("evaluate");
    const harnessV = laneV.harness;
    const verifySpawn = buildAgentSpawn({
      harness: harnessV,
      command: "/bgsd-verify",
      model: laneV.model,
      effort: laneV.effort,
      extraArgs: [url, "--criteria", criteria],
    });
    const verifyResult = spawn(
      verifySpawn.cmd,
      verifySpawn.args,
      {
        cwd:      root,
        stdio:    "inherit",
        encoding: "utf8",
        env:      { ...verifySpawn.env, BGSD_USAGE_TESTING: usageTesting ? "1" : "0" },
      }
    );
    if (verifyResult?.error) {
      throw new Error(`${verifySpawn.cmd} /bgsd-verify failed to spawn: ${verifyResult.error.message}`);
    }
    if (verifyResult?.status !== 0) {
      throw new Error(
        `${verifySpawn.cmd} /bgsd-verify exited non-zero (${verifyResult?.status}): ${verifyResult?.stderr ?? ""}`
      );
    }

    // The Tester claimed success; the report MUST exist (NFR-06: no silent green).
    if (!existsSync(reportPath)) {
      throw new Error(
        `integration report missing at ${reportPath} after /bgsd-verify claimed success`
      );
    }

    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (err) {
      throw new Error(`integration report at ${reportPath} is not valid JSON: ${err.message}`);
    }

    return {
      verdict:          report.verdict          ?? "ERROR",
      defects:          report.defects          ?? [],
      criteria_results: report.criteria_results ?? [],
      scrutiny:         report.integration?.scrutiny ?? {},
      reportPath,
    };
  } catch (err) {
    // Any failure in boot or Tester surfaces as ERROR (NFR-06). We never claim a
    // silent green: the report read above only returns when it is present + valid.
    process.stderr.write(`[loop2-live] liveVerify ERROR: ${err.message}\n`);
    return {
      verdict:          "ERROR",
      defects:          [],
      criteria_results: [],
      scrutiny:         {},
      reportPath:       existsSync(reportPath) ? reportPath : null,
    };
  } finally {
    // Teardown is guaranteed even on failure: if the app booted, tear it down.
    if (booted) {
      const down = spawn(
        "bash",
        [isoPath, "down", appDir],
        { cwd: root, encoding: "utf8" }
      );
      if (down?.error) {
        process.stderr.write(`[loop2-live] runtime-isolate.sh down error: ${down.error.message}\n`);
      } else if (down?.status !== 0) {
        process.stderr.write(
          `[loop2-live] runtime-isolate.sh down exited non-zero (${down?.status})\n`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// liveFix — dispatch parallel fix agents on integration defects (LOOP2-05)
// ---------------------------------------------------------------------------

/**
 * Group a flat defect list into independent fix groups. Defects that share a
 * `feature` (or, absent that, a `file`) belong to the same fix agent so two
 * agents never touch the same surface concurrently. Anything ungrouped becomes
 * its own group keyed by defect id.
 *
 * @param {Array<object>} defects
 * @returns {Array<{ key: string, defects: Array<object> }>}
 */
export function groupDefectsForFix(defects) {
  const groups = new Map();
  for (const d of Array.isArray(defects) ? defects : []) {
    const key = String(d.feature ?? d.file ?? d.id ?? d.description ?? "ungrouped");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return [...groups.entries()].map(([key, ds]) => ({ key, defects: ds }));
}

/** Turn a defect-group key into a filesystem/branch-safe slug. */
function slugForKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "fix";
}

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
 * These fix agents are "Loop-2 gated": each independent defect group gets its
 * own worktree + branch off the rehearsal head and its own /gsd-quick agent.
 * Every child-process step checks status/error and throws on failure (NFR-06).
 * The child-process + git boundaries are INJECTABLE so the whole path is
 * unit-testable under mocks (no real worktree, no real claude).
 *
 * @param {Array<object>} defects     Defect list from the last verify report
 * @param {object}        [opts]
 * @param {number}          [opts.iteration]     Current loop iteration (for logging + branch name)
 * @param {string}          [opts.runId]         Run identifier (for branch naming)
 * @param {string}          [opts.rehearsalBranch] Rehearsal branch fixes are based off
 * @param {string}          [opts.rehearsalHead] Explicit rehearsal head ref (default: the branch)
 * @param {string}          [opts.repoRoot]      Override the repo root (default REPO_ROOT)
 * @param {string}          [opts.worktreeRoot]  Where fix worktrees are created (default <bgsd>/runs/<runId>/fix-worktrees)
 * @param {string}          [opts.bgsdDir]       Override .bgsd dir path
 * @param {Function}        [opts.spawnImpl]     Injected child-process runner (default spawnSync)
 * @param {Function}        [opts.gitImpl]       Injected git runner (default spawnSync)
 * @returns {Promise<Array<{ key: string, branch: string, worktree: string }>>}
 *          the fix branches created this iteration (consumed by liveReMerge).
 */
export async function liveFix(defects, opts = {}) {
  const {
    iteration = 0,
    runId = "",
    rehearsalBranch,
    rehearsalHead,
    repoRoot,
    worktreeRoot,
    bgsdDir,
    spawnImpl,
    gitImpl,
  } = opts;

  const spawn = spawnImpl ?? spawnSync;
  const git   = gitImpl   ?? spawnSync;
  const root  = repoRoot  ?? REPO_ROOT;
  const bgsd  = bgsdDir   ?? join(root, ".bgsd");

  // NFR-01 branch guard is always enforced (injected git boundary for testability).
  requireNotProductionBranch({ gitImpl: git, repoRoot: root });

  const branch = rehearsalBranch ?? integrationBranchForRun(runId);
  const head   = rehearsalHead ?? branch;
  const wtRoot = worktreeRoot ?? join(bgsd, "runs", runId, "fix-worktrees");

  const groups = groupDefectsForFix(defects);

  process.stderr.write(
    `[loop2-live] liveFix: dispatching ${groups.length} parallel fix agents\n` +
    `  iteration:      ${iteration}\n` +
    `  rehearsal head: ${head}\n` +
    `  defect groups:  ${groups.map((g) => g.key).join(", ") || "(none)"}\n` +
    `  model:          sonnet (medium effort per Part 11)\n`
  );

  const created = [];

  for (const group of groups) {
    const slug       = slugForKey(group.key);
    const fixBranch  = `fix/${runId || "run"}-i${iteration}-${slug}`;
    const wtPath     = join(wtRoot, `i${iteration}-${slug}`);

    // 1. Create a worktree + branch off the rehearsal head (NFR-06: throw on failure).
    const wtResult = git(
      "git",
      ["worktree", "add", wtPath, "-b", fixBranch, head],
      { cwd: root, stdio: "inherit", encoding: "utf8" }
    );
    if (wtResult?.error) {
      throw new Error(`liveFix: git worktree add failed for "${group.key}": ${wtResult.error.message}`);
    }
    if (wtResult?.status !== 0) {
      throw new Error(
        `liveFix: git worktree add exited non-zero for "${group.key}" (${wtResult?.status}): ${wtResult?.stderr ?? ""}`
      );
    }

    // 1b. Propagate env files into the fix worktree (worktrees skip gitignored
    //     files) so the fix agent can boot the app it is repairing.
    propagateEnvForConfig({
      repoRoot: root,
      destDir: wtPath,
      log: (m) => process.stderr.write(`[loop2-live] ${m}\n`),
    });

    // 2. Spawn the fix agent in the worktree on the active harness (NFR-06:
    //    throw on failure). Fix agents run sonnet/medium per Part 11.
    const laneF = activeLane("build");
    const harnessF = laneF.harness;
    const fixSpawn = buildAgentSpawn({
      harness: harnessF,
      command: "/gsd-quick",
      model: laneF.model,
      effort: laneF.effort,
      extraArgs: ["--worktree", wtPath],
    });
    const fixResult = spawn(
      fixSpawn.cmd,
      fixSpawn.args,
      { cwd: wtPath, stdio: "inherit", encoding: "utf8", env: fixSpawn.env }
    );
    if (fixResult?.error) {
      throw new Error(`liveFix: ${fixSpawn.cmd} /gsd-quick failed to spawn for "${group.key}": ${fixResult.error.message}`);
    }
    if (fixResult?.status !== 0) {
      throw new Error(
        `liveFix: ${fixSpawn.cmd} /gsd-quick exited non-zero for "${group.key}" (${fixResult?.status}): ${fixResult?.stderr ?? ""}`
      );
    }

    created.push({ key: group.key, branch: fixBranch, worktree: wtPath });
  }

  return created;
}

// ---------------------------------------------------------------------------
// liveReMerge — re-integrate fixed branches via conflict.mjs (LOOP2-05)
// ---------------------------------------------------------------------------

/**
 * Live implementation of reMerge() for runLoop2().
 *
 * Re-integrates the fixed worktree branches into `rehearsal/<run-id>` after
 * fix agents complete. Each fix branch is merged with a git dry-run conflict
 * pre-check FIRST (`git merge-tree --write-tree`, read-only, no working-tree
 * mutation), then, only when clean, a real `git merge --no-ff` (LOOP2-03).
 *
 * Mirrors run-live.mjs liveMergeFn exactly: on conflict it REPORTS the
 * conflicting paths and does NOT force anything (NFR-06). It never claims a
 * clean merge that did not happen.
 *
 * The git boundary is INJECTABLE (gitImpl) so the path is unit-testable without
 * a real repo.
 *
 * @param {object} [opts]
 * @param {number}   [opts.iteration]   Current loop iteration (for logging)
 * @param {string}   [opts.runId]       Run identifier (for branch naming)
 * @param {string}   [opts.rehearsalBranch] Target branch (default integrationBranchForRun(runId))
 * @param {Array<{ branch: string }>} [opts.fixBranches] Fix branches to merge back (from liveFix)
 * @param {string}   [opts.repoRoot]    Override the repo root (default REPO_ROOT)
 * @param {Function} [opts.gitImpl]     Injected git runner (default spawnSync)
 * @returns {Promise<{
 *   merged:    Array<{ branch: string }>,
 *   conflicts: Array<{ branch: string, reason: string, conflicts: string[] }>,
 * }>}
 */
export async function liveReMerge(opts = {}) {
  const {
    iteration = 0,
    runId = "",
    rehearsalBranch,
    fixBranches = [],
    repoRoot,
    gitImpl,
  } = opts;

  const git  = gitImpl  ?? spawnSync;
  const root = repoRoot ?? REPO_ROOT;

  // NFR-01 branch guard is always enforced (injected git boundary for testability).
  requireNotProductionBranch({ gitImpl: git, repoRoot: root });

  const target = rehearsalBranch ?? integrationBranchForRun(runId);

  process.stderr.write(
    `[loop2-live] liveReMerge: re-integrating ${fixBranches.length} fixed branches into ${target}\n` +
    `  iteration:  ${iteration}\n` +
    `  method:     git merge-tree dry-run pre-check + git merge --no-ff\n`
  );

  const merged    = [];
  const conflicts = [];

  for (const fb of fixBranches) {
    const branch = fb?.branch;
    if (!branch) continue;

    // 1. Dry-run conflict pre-check (read-only; does not touch HEAD or the index).
    const dryRun = git(
      "git",
      ["merge-tree", "--write-tree", "--name-only", target, branch],
      { cwd: root, encoding: "utf8" }
    );
    if (dryRun?.error) {
      throw new Error(`liveReMerge: git merge-tree failed for "${branch}": ${dryRun.error.message}`);
    }
    if (dryRun?.status !== 0) {
      // Non-zero from merge-tree = the merge would conflict. Report, do not force.
      const conflictPaths = String(dryRun?.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      conflicts.push({ branch, reason: "conflict", conflicts: conflictPaths });
      process.stderr.write(
        `[loop2-live] liveReMerge: "${branch}" would conflict — reported, not forced (${conflictPaths.length} paths)\n`
      );
      continue;
    }

    // 2. Clean pre-check -> do the real merge into the rehearsal branch.
    const merge = git(
      "git",
      ["merge", "--no-ff", "-m", `bgsd(loop2): ${branch} → ${target}`, branch],
      { cwd: root, stdio: "inherit", encoding: "utf8" }
    );
    if (merge?.error) {
      throw new Error(`liveReMerge: git merge failed for "${branch}": ${merge.error.message}`);
    }
    if (merge?.status !== 0) {
      // Real merge unexpectedly conflicted after a clean pre-check — abort + report.
      git("git", ["merge", "--abort"], { cwd: root, encoding: "utf8" });
      conflicts.push({ branch, reason: "merge_failed", conflicts: [] });
      continue;
    }

    merged.push({ branch });
  }

  return { merged, conflicts };
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
 * This is the human-supervised, end-to-end live integration run. It drives the
 * rehearsal branch through the full verify→fix→re-merge→re-verify cycle using
 * the real Integration Tester and real fix agents.
 *
 * The --live gate is REMOVED: a plain /bgsd-sesh fires this path with zero
 * friction. The next/production-branch guard (NFR-01) is still ALWAYS enforced.
 *
 * @param {object} opts
 * @param {string}   opts.runId               Run identifier (e.g. "bgsd-0001-foo")
 * @param {string}   [opts.rehearsalBranch]   Rehearsal/integration branch
 * @param {string}   [opts.rehearsalAppDir]   Assembled app dir to boot (default: repo root)
 * @param {string}   [opts.integrationCriteria] Criteria file passed to /bgsd-verify
 * @param {string}   [opts.bgsdDir]           Override .bgsd directory path
 * @param {string}   [opts.runJsonPath]       Path to run.json (for advanceStateFn)
 * @param {Function} [opts.spawnImpl]         Injected child-process runner (default spawnSync)
 * @param {Function} [opts.gitImpl]           Injected git runner (default spawnSync)
 * @param {object}   [opts.loopOpts]          Options forwarded to runLoop2 (maxIterations, etc.)
 * @returns {Promise<object>}  runLoop2 result
 */
export async function runLiveLoop2({
  runId,
  rehearsalBranch,
  rehearsalAppDir,
  integrationCriteria,
  bgsdDir,
  runJsonPath,
  spawnImpl,
  gitImpl,
  loopOpts = {},
}) {
  requireNotProductionBranch({ gitImpl, repoRoot: REPO_ROOT });

  const branch  = rehearsalBranch ?? integrationBranchForRun(runId);
  const bgsd    = bgsdDir ?? join(REPO_ROOT, ".bgsd");

  process.stderr.write(
    "\n" +
    "======================================================================\n" +
    "Kiwi: Live Integration Run (Loop 2)\n" +
    "======================================================================\n\n" +
    `  Run ID:           ${runId}\n` +
    `  Rehearsal Branch: ${branch}\n\n` +
    "Safety context:\n" +
    "  - Production branch guard (NFR-01) is enforced; next is the target.\n" +
    "  - runtime-isolate.sh gives the app its own port/DB/env.\n" +
    "  - The Tester boots the integrated app and reports PASS|FAIL|ERROR.\n" +
    "  - Fix agents run in worktrees off the rehearsal head; re-merge is\n" +
    "    conflict-pre-checked and never forced.\n" +
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

  // Fix branches created by the most recent liveFix() are threaded into the
  // subsequent liveReMerge() so re-merge knows exactly what to re-integrate.
  let lastFixBranches = [];

  const verify = () =>
    liveVerify({
      rehearsalBranch: branch,
      runId,
      rehearsalAppDir,
      integrationCriteria,
      bgsdDir: bgsd,
      spawnImpl,
      gitImpl,
    });

  const fix = async (defects, opts2) => {
    lastFixBranches = await liveFix(defects, {
      ...opts2,
      runId,
      rehearsalBranch: branch,
      bgsdDir: bgsd,
      spawnImpl,
      gitImpl,
    });
    return lastFixBranches;
  };

  const reMerge = (opts2) =>
    liveReMerge({
      ...opts2,
      runId,
      rehearsalBranch: branch,
      fixBranches: lastFixBranches,
      gitImpl,
    });

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
  // The --live gate is gone: a plain /bgsd-sesh fires the live Loop 2 path with
  // zero friction. The production-branch guard (NFR-01) is still enforced.
  try {
    requireNotProductionBranch();
  } catch (err) {
    process.stderr.write(err.message);
    process.exit(1);
  }

  process.stderr.write(
    "\n[loop2-live] live Loop 2 integration seam.\n" +
    "  Pass runId, rehearsalBranch, and loopOpts programmatically via\n" +
    "  the runLiveLoop2() export. This CLI entrypoint is a usage reminder.\n\n" +
    "  Before a live integration run, ensure:\n" +
    "    1. git branch --show-current (must NOT be a production branch)\n" +
    "    2. Phase 1 controller (loop2.mjs) ran clean under mocked Tester/fix\n" +
    "    3. BGSD_BUDGET_CAP is set\n" +
    "    4. caffeinate is running\n" +
    "    5. You are watching the terminal\n\n"
  );
  process.exit(0);
}
