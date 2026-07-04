#!/usr/bin/env node
/**
 * loop1-live.mjs — Phase 3: Live execution seam for Loop 1 (LOOP-01..04)
 *
 * LIVE — the real, process-spawning verify and fix functions that drive the
 * Loop 1 controller (loop1.mjs) against an actual worktree. The old `--live`
 * gate has been REMOVED: a plain /bgsd-sesh fires this path with zero friction
 * (mirrors run-live.mjs). The next-branch guard (NFR-01) still protects
 * main/master and is ALWAYS enforced.
 *
 * NEVER run this:
 *   - Against the `next` / any production branch (NFR-01, enforced in code).
 *
 * WHAT THIS MODULE DOES (LOOP-01..04)
 * =====================================
 *   - liveVerify(worktreePath):
 *       Spawns the real Tester (`claude -p /bgsd-verify`) against the
 *       worktree's isolated running instance, waits for it to exit, reads the
 *       `verification-report.json` it writes to
 *       `.bgsd/runs/<run_id>/verification-report.json`, and returns the parsed
 *       report in the shape { verdict, defects, reportPath } expected by
 *       runLoop1() in loop1.mjs. Reuses the v0 Tester contract unchanged
 *       (LOOP-01). Throws on spawn error (NFR-06); a missing report after a
 *       claimed success is an ERROR, never a silent PASS.
 *
 *   - liveFix(defects, opts, worktreePath, item):
 *       Routes the defect list to the appropriate /gsd-* command in the
 *       worktree via a real `claude -p <gsd-command>` spawn. The command to
 *       run is already recorded on item.gsd_command from Phase 2 routing.
 *       Never reimplements GSD execution (NFR-04). Throws on non-zero/error.
 *
 *   - runLiveLoop1(opts):
 *       Wires liveVerify + liveFix into runLoop1() and drives the full
 *       verify→fix loop end-to-end in one worktree (LOOP-04). Requires the
 *       worktree to already exist and the isolated instance to be running.
 *
 * INJECTABLE BOUNDARIES (unit-testable, mirrors run-live.mjs)
 * ===========================================================
 * The child-process boundary is injectable via `spawnImpl` (default
 * spawnSync) and the report read via `readFileImpl` (default readFileSync),
 * so the whole path is unit-testable under mocks — no real claude, no network.
 *
 * Usage (human-supervised):
 *   node bgsd/scripts/loop1-live.mjs \
 *     --item-id <id> \
 *     --worktree <path> \
 *     --max-iterations 5
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireNotProductionBranch } from "./run-live.mjs";
import { activeHarness, resolveHarnessConfig, resolveModel, buildAgentSpawn } from "./harness.mjs";

// ---------------------------------------------------------------------------
// Live flag helper (retained for compatibility; no longer gates execution)
// ---------------------------------------------------------------------------

/**
 * Check whether the --live flag was explicitly passed on the command line.
 * Retained for backward compatibility (callers/tests may still probe it), but
 * the live seam no longer requires it: the `--live` gate has been removed.
 *
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

// ---------------------------------------------------------------------------
// Live verify — spawns /bgsd-verify, parses verification-report.json (LOOP-01)
// ---------------------------------------------------------------------------

/**
 * Live implementation of verify().
 *
 * Spawns the REAL v0 Tester (`claude -p /bgsd-verify`) as a child process,
 * waits for it to exit, then reads the `verification-report.json` it wrote to
 * `.bgsd/runs/<run_id>/`. Returns a report in the shape expected by
 * runLoop1():
 *   { verdict: "PASS"|"FAIL"|"BLOCKED"|"ERROR", defects: [], reportPath: string }
 *
 * Reuses the v0 `verification-report.json` contract unchanged (LOOP-01).
 * Never rewrites the Tester.
 *
 * The `--live` gate is gone; the next-branch guard (NFR-01) still fires. The
 * child-process + report-read boundaries are INJECTABLE so the path is
 * unit-testable under mocks (no real claude, no browser, no network).
 *
 * NO SILENT GREEN (NFR-06): a spawn error throws; a missing report after a
 * claimed-success exit is an ERROR verdict, never a fabricated PASS.
 *
 * @param {object} opts
 * @param {string}   opts.worktreePath   - absolute path to the worktree root
 * @param {string}   opts.runId          - run ID for the verification run
 * @param {string}   [opts.criteriaFile] - acceptance-criteria file passed to /bgsd-verify (--criteria)
 * @param {string}   [opts.appDir]       - app dir to boot (--boot); defaults to the worktree root
 * @param {boolean}  [opts.usageTesting]  - run the Playwright usage-testing rung?
 *                   Defaults to the BGSD_USAGE_TESTING env (set by session.mjs).
 *                   When false, the Tester runs code-only (gsd-verifier) and the
 *                   Playwright ladder is skipped; code verification still runs.
 *                   Adds --no-usage-verification to the Tester argv when false.
 * @param {boolean}  [opts.headlessUi]    - run Playwright headless (adds --headless-ui).
 *                   Defaults to the BGSD_HEADLESS_UI env (set by session.mjs).
 * @param {Function} [opts.spawnImpl]     - injected child-process runner (default spawnSync)
 * @param {Function} [opts.readFileImpl]  - injected file reader (default readFileSync)
 * @returns {Promise<{ verdict: string, defects: object[], reportPath: string|null }>}
 */
export async function liveVerify({
  worktreePath,
  runId,
  criteriaFile,
  appDir,
  usageTesting = process.env.BGSD_USAGE_TESTING !== "0",
  headlessUi = process.env.BGSD_HEADLESS_UI === "1",
  spawnImpl = spawnSync,
  readFileImpl = readFileSync,
} = {}) {
  // NFR-01 branch guard (always enforced, no --live needed). Uses the injected
  // git boundary via run-live's guard default so main/master is protected.
  requireNotProductionBranch();

  // Path where /bgsd-verify writes its output (v0 contract, unchanged).
  const runsDir = join(worktreePath, ".bgsd", "runs");
  const reportPath = join(runsDir, runId, "verification-report.json");

  // Boot the app in the worktree (or an explicit appDir) and verify it.
  const bootTarget = appDir ?? worktreePath;
  const extraArgs = ["--boot", bootTarget];
  if (criteriaFile) {
    extraArgs.push("--criteria", criteriaFile);
  }
  // Code-only mode: skip the Playwright ladder (mirrors BGSD_USAGE_TESTING=0).
  if (!usageTesting) {
    extraArgs.push("--no-usage-verification");
  }
  // Headless UI: run Playwright with no visible browser/server window.
  if (headlessUi) {
    extraArgs.push("--headless-ui");
  }

  // Spawn the REAL Tester on the active harness (LOOP-01: reuses v0 contract).
  // claude keeps the exact v0 argv; codex runs `codex exec` with an opus-equiv
  // model. Thread the usage/headless posture through the env too.
  const hc = resolveHarnessConfig(worktreePath);
  const harness = activeHarness(worktreePath, { config: hc });
  const verifySpawn = buildAgentSpawn({
    harness,
    command: "/bgsd-verify",
    model: resolveModel("opus", harness, hc.models),
    modelForClaude: false, // the Tester manages its own model on claude
    extraArgs,
  });
  const result = spawnImpl(verifySpawn.cmd, verifySpawn.args, {
    cwd: worktreePath,
    stdio: "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      BGSD_USAGE_TESTING: usageTesting ? "1" : "0",
      BGSD_HEADLESS_UI:   headlessUi   ? "1" : "0",
    },
  });

  // NO SILENT GREEN (NFR-06): a spawn error is fatal — throw, never fabricate.
  if (result?.error) {
    throw new Error(
      `liveVerify: ${verifySpawn.cmd} /bgsd-verify failed to spawn for run "${runId}": ${result.error.message}`
    );
  }

  // Read and parse the report written by /bgsd-verify. A missing report after
  // any exit (including status 0) is an ERROR, not a silent pass (NFR-06).
  if (!existsSync(reportPath)) {
    return { verdict: "ERROR", defects: [], reportPath: null };
  }

  let report;
  try {
    report = JSON.parse(readFileImpl(reportPath, "utf8"));
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
 * (recorded by Phase 2 routing as item.gsd_command) via a REAL
 * `claude -p <gsd-command>` spawn. Never reimplements GSD execution
 * (NFR-04): bgsd calls /gsd-*; GSD does the work.
 *
 * The fix is run in the worktree, NOT in the repo root, so it is isolated
 * from the production branch (NFR-01, enforced in code).
 *
 * Before spawning, the defect list is written to
 * `.bgsd/runs/<runId>/defects-for-fix.json` in the worktree so the GSD agent
 * can read it as context.
 *
 * The `--live` gate is gone. The child-process boundary is INJECTABLE
 * (spawnImpl) so the path is unit-testable under mocks. NO SILENT GREEN
 * (NFR-06): a non-zero exit or spawn error throws.
 *
 * @param {Array<object>} defects          - defect list from the last verify report
 * @param {{ effort: string, model: string }} opts  - escalation hints from LOOP-05
 * @param {object} context
 * @param {string}   context.worktreePath  - absolute path to the worktree
 * @param {object}   context.item          - queue item (has item.gsd_command)
 * @param {string}   [context.runId]       - run ID (for the defects-for-fix.json path)
 * @param {Function} [context.spawnImpl]   - injected child-process runner (default spawnSync)
 * @returns {Promise<void>}
 */
export async function liveFix(defects, opts, { worktreePath, item, runId, spawnImpl = spawnSync }) {
  // NFR-01 branch guard (always enforced, no --live needed).
  requireNotProductionBranch();

  const gsdCommand = item.gsd_command ?? "/gsd-quick";
  const { effort = "medium", model = "balanced" } = opts ?? {};

  // Write the defect summary to .bgsd/runs/<runId>/defects-for-fix.json so the
  // GSD agent can read it as context. Fall back to a stable filename if runId
  // is absent so the context file is always produced.
  const runsDir = join(worktreePath, ".bgsd", "runs", runId ?? "current");
  const defectsPath = join(runsDir, "defects-for-fix.json");
  try {
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      defectsPath,
      JSON.stringify(
        {
          gsd_command: gsdCommand,
          effort,
          model,
          defect_count: Array.isArray(defects) ? defects.length : 0,
          defects: Array.isArray(defects) ? defects : [],
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (_) {
    // Context file is best-effort; the fix spawn still carries the routing.
  }

  process.stderr.write(
    `[loop1-live] liveFix: invoking ${gsdCommand} in ${worktreePath}\n` +
    `  defects: ${Array.isArray(defects) ? defects.length : 0}  effort: ${effort}  model: ${model}\n`
  );

  // Spawn the real /gsd-* fix in the worktree on the active harness (NFR-04: GSD
  // does the work). claude keeps the exact argv (--model-profile drives the GSD
  // model); codex runs `codex exec` with a sonnet-equiv model.
  const hc = resolveHarnessConfig(worktreePath);
  const harness = activeHarness(worktreePath, { config: hc });
  const fixSpawn = buildAgentSpawn({
    harness,
    command: gsdCommand,
    model: resolveModel("sonnet", harness, hc.models),
    modelForClaude: false, // GSD picks the model from --model-profile on claude
    extraArgs: ["--worktree", worktreePath, "--effort", effort, "--model-profile", model],
  });
  const result = spawnImpl(
    fixSpawn.cmd,
    fixSpawn.args,
    { cwd: worktreePath, stdio: "inherit", encoding: "utf8" }
  );

  // NO SILENT GREEN (NFR-06): throw on spawn error or non-zero exit.
  if (result?.error) {
    throw new Error(
      `liveFix: ${fixSpawn.cmd} ${gsdCommand} failed to spawn in "${worktreePath}": ${result.error.message}`
    );
  }
  if (result?.status !== 0) {
    throw new Error(
      `liveFix: ${gsdCommand} exited non-zero (exit ${result?.status}) in "${worktreePath}": ${result?.stderr ?? ""}`
    );
  }
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
 * The `--live` gate is gone; the next-branch guard (NFR-01) still protects
 * main/master via the verify/fix guards.
 *
 * @param {object} opts
 * @param {object}   opts.item           - queue item to drive
 * @param {Function} opts.transitionFn   - transition() from queue.mjs
 * @param {string}   opts.worktreePath   - absolute path to the isolated worktree
 * @param {string}   opts.runId          - unique run ID for this verification run
 * @param {string}   [opts.criteriaFile] - acceptance-criteria file for /bgsd-verify
 * @param {object}   [opts.loopOpts]     - options forwarded to runLoop1 (maxIterations, etc.)
 * @returns {Promise<object>}  runLoop1 result
 */
export async function runLiveLoop1({ item, transitionFn, worktreePath, runId, criteriaFile, loopOpts = {} }) {
  // Lazy import the pure controller so that this file can be imported in
  // tests without accidentally pulling in live state.
  const { runLoop1 } = await import(`file://${resolve(
    dirname(fileURLToPath(import.meta.url)),
    "loop1.mjs"
  )}`);

  const verify = () => liveVerify({ worktreePath, runId, criteriaFile });
  const fix = (defects, opts2) => liveFix(defects, opts2, { worktreePath, item, runId });

  return runLoop1({ item, transitionFn, verify, fix, ...loopOpts });
}

// ---------------------------------------------------------------------------
// CLI entrypoint (human-supervised)
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
  // The --live gate is gone: a plain /bgsd-sesh fires the live path with zero
  // friction. The next-branch guard (NFR-01) still protects main/master.
  process.stderr.write(
    "\n[loop1-live] live loop1 seam.\n" +
    "  Run-id, worktree, and item-id must be passed programmatically via\n" +
    "  the runLiveLoop1() export. This CLI entrypoint is a usage reminder.\n\n" +
    "  Before a live loop, ensure:\n" +
    "    1. git branch --show-current (must NOT be 'next')\n" +
    "    2. The worktree is isolated (port, DB, env) and the app is running\n" +
    "    3. You are watching the terminal\n\n"
  );
  process.exit(0);
}
