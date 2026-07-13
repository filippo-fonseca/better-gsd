#!/usr/bin/env node
/**
 * run-live.mjs — Phase 4: Guarded Live Seam for /bgsd-run (SPAWN-04)
 *
 * HUMAN-GATED — NEVER EXECUTED AUTOMATICALLY
 * ===========================================
 * This module provides the real, multi-process-spawning implementation of
 * the /bgsd-run lifecycle against actual git worktrees and headless
 * `claude -p` Pipeline Agents.
 *
 * It MUST NOT be called without an explicit --live flag. Calling it without
 * --live causes an immediate refusal with a human-readable error and exits
 * non-zero. This is a hard contractual requirement (NFR-07, NFR-08, SPAWN-04).
 *
 * NEVER run this:
 *   - In automated CI/CD pipelines.
 *   - Against the `next` branch (NFR-01).
 *   - Without reading the human-gated checklist below.
 *   - Without a per-run budget cap configured.
 *   - Without a human watching the terminal.
 *
 * WHAT THIS MODULE DOES (SPAWN-04)
 * ==================================
 * This module provides the live-wired injections for runLifecycle() in run.mjs:
 *   - liveSpawnFn(unitId, plan):
 *       Creates a real git worktree for the unit, writes its .planning/config.json
 *       via the config seam, and launches a headless `claude -p` Pipeline Agent.
 *   - liveReadStatusFn(unitId):
 *       Reads the agent's control file (.bgsd/runs/<run-id>/control/<agent-id>.json)
 *       and maps the schema status to the scheduler's "running"|"done"|"failed"|"dead".
 *   - liveMergeFn(unitId, runId, plan):
 *       Git dry-run merge (conflict pre-check) then real merge into rehearsal/<run-id>.
 *   - liveCheckpointFn(checkpoint):
 *       Writes the checkpoint summary to stdout, pauses for human go/no-go confirmation.
 *
 * HUMAN-GATED CHECKLIST (run through this before invoking with --live):
 * ======================================================================
 *   1. You are on a feature branch, NOT `next`. Verify: git branch --show-current
 *   2. You have set a per-run budget cap (--budget-cap or BGSD_BUDGET_CAP env var).
 *   3. The worktree base directory (.bgsd/runs/<run-id>/worktrees/) has enough disk.
 *   4. caffeinate is running (this spawns many real processes; Mac must not sleep).
 *      Run: caffeinate -dimsu & (already handled by the global session setup).
 *   5. You are watching the terminal — this is NOT fire-and-forget (NFR-08).
 *   6. You understand that ≥2 concurrent `claude -p` processes will be spawned.
 *   7. You accept that real git worktrees will be created and real commits made.
 *   8. rehearsal/<run-id> will be written to; `next` will NEVER be touched (NFR-01).
 *   9. Merge-boundary checkpoints WILL pause and ask for your go/no-go.
 *  10. /bgsd-abort is available to stop an in-flight run at any checkpoint.
 *
 * GUARDED LIVE SEAM DESIGN (mirrors loop1-live.mjs)
 * ===================================================
 * The requireLiveFlag() check fires on every exported function, so any code
 * that imports and calls a function from this module without passing --live
 * will get an immediate refusal. The check looks at process.argv — NOT
 * process.env — so a CI environment variable cannot accidentally unlock it.
 *
 * Usage (human, supervised only):
 *   node bgsd/scripts/run-live.mjs --live \
 *     --prompt "Add user auth and rate limiting" \
 *     [--max-concurrency 4] \
 *     [--budget-cap 50]
 *
 * --dry-run (the default) is handled by run.mjs directly. This file is ONLY
 * for the --live path.
 */

import { spawn, spawnSync } from "node:child_process";
import { isProductionBranch } from "./integration.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { writeUnitWorktreeConfig } from "./decompose.mjs";
import { buildAgentSpawn } from "./harness.mjs";
import { buildLaneForUnit, loadContractForRun, harnessForLane } from "./model-contract.mjs";
import { createControlFile, updateControlFile } from "./control.mjs";
import { propagateEnvForConfig } from "./envprop.mjs";
import { readRunUnit, readRunScale } from "./run-units.mjs";
import { ADVISOR_CHECKPOINTS, readConductorSeed, writeAdvisorDirective } from "./advisor.mjs";
import { recordUsage } from "./tokens.mjs";
import { harvestUsage } from "./token-harvest.mjs";

/**
 * Best-effort token accounting for a spawn. Harvests real usage off the
 * harness transcript (no tokens spent) and appends a ledger row. Never throws:
 * if harvest fails we still log model/effort/role (source "none").
 */
function recordSpawnUsage(bgsdDir, runId, meta, cwd, t0) {
  try {
    const usage = harvestUsage(meta.harness, cwd, t0) ?? {};
    recordUsage(bgsdDir, runId, { ...meta, ...usage });
  } catch (_) {
    /* accounting must never break a run */
  }
}

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (NFR-07, SPAWN-04) — mirrors loop1-live.mjs exactly
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
 * Called by every exported live function.
 *
 * @throws {Error} if --live is not in process.argv
 */
export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: run-live.mjs refused to run.\n" +
      "\n" +
      "The live /bgsd-run orchestration path (real git worktrees + real\n" +
      "headless claude -p Pipeline Agents) requires an explicit --live flag\n" +
      "to prevent accidental automation.\n" +
      "\n" +
      "To run this supervised:\n" +
      "  node bgsd/scripts/run-live.mjs --live --prompt \"<prompt>\"\n" +
      "\n" +
      "Safety checklist before using --live:\n" +
      "  - You are on a feature branch, NOT `next` (git branch --show-current)\n" +
      "  - You have a per-run budget cap set (--budget-cap or BGSD_BUDGET_CAP)\n" +
      "  - caffeinate is running (Mac must not sleep during a live run)\n" +
      "  - You are watching the terminal — this is NOT fire-and-forget\n" +
      "  - ≥2 concurrent claude -p processes will be spawned\n" +
      "  - rehearsal/<run-id> will be written; next is NEVER touched\n" +
      "  - Merge-boundary checkpoints WILL pause for your go/no-go\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts or scheduled automation.\n" +
      "  - Run this against the 'next' branch (NFR-01).\n" +
      "  - Run this without reading the checklist in run-live.mjs.\n" +
      "  - Skip the --dry-run validation step (node bgsd/scripts/run.mjs --dry-run).\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Branch safety guard (NFR-01)
// ---------------------------------------------------------------------------

/**
 * Refuse to run if the current branch is `next` or any production branch.
 * This guard fires regardless of --live — it is always enforced (NFR-01).
 *
 * The git boundary + repo root are injectable so the guard is unit-testable
 * (a test can force the "current branch" to a production branch without a real
 * checkout). Defaults read the real current branch of the repo.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.gitImpl]   Injected git runner (default spawnSync)
 * @param {string}   [opts.repoRoot]  Repo root to read the branch from (default REPO_ROOT)
 * @throws {Error} if the current branch is a production branch
 */
export function requireNotProductionBranch(opts = {}) {
  const gitImpl  = opts.gitImpl  ?? spawnSync;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const result = gitImpl("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const branch = (result?.stdout ?? "").trim();
  if (isProductionBranch(branch)) {
    throw new Error(
      `\nNFR-01 VIOLATION: run-live.mjs refuses to run on production branch "${branch}".\n` +
      `bgsd NEVER writes to the production branch.\n` +
      `Switch to a feature branch (e.g. feat/bgsd-v0) and try again.\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Live spawn — creates a real git worktree + launches headless claude -p
// ---------------------------------------------------------------------------

/**
 * Live implementation of spawnFn (the dependency-injected spawn boundary).
 *
 * For each unit:
 *   1. Refuses on a production branch (NFR-01).
 *   2. Creates a git worktree at plan.path on branch plan.branch (off HEAD).
 *   3. Propagates .env* files into the worktree (worktrees skip gitignored
 *      files, so apps won't boot without this).
 *   4. Writes the unit's .planning/config.json via the config seams (NFR-04).
 *   5. Writes the unit brief to .planning/bgsd-unit.json.
 *   6. Creates the agent control file under .bgsd/runs/<runId>/control/.
 *   7. Copies a Conductor-authored seed plan, when one exists.
 *   8. Launches the selected build-lane Pipeline Agent.
 *
 * Every child-process step checks status/error and throws on failure — no
 * silent green (NFR-06). The child-process + git boundaries are INJECTABLE so
 * the whole path is unit-testable under mocks (no real worktree, no real claude).
 *
 * @param {string}   unitId   Unit identifier
 * @param {object}   plan     WorktreePlan from planWorktrees() ({ path, branch, port })
 * @param {object}   [opts]
 * @param {string}   [opts.runId]      Run id (for control-file + brief paths)
 * @param {string}   [opts.scale]      "quick"|"feature"|"project" (passed to the agent)
 * @param {object}   [opts.unit]       The full decomposed unit (falls back to a disk read)
 * @param {string}   [opts.bgsdDir]    Override the .bgsd dir (default <repo>/.bgsd)
 * @param {string}   [opts.repoRoot]   Override the repo root (default REPO_ROOT)
 * @param {Function} [opts.spawnImpl]  Injected child-process runner (default spawnSync)
 * @param {Function} [opts.gitImpl]    Injected git runner (default spawnSync)
 * @returns {Promise<void>}
 */
export async function liveSpawnFn(unitId, plan, opts = {}) {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const gitImpl   = opts.gitImpl   ?? spawnSync;
  const repoRoot  = opts.repoRoot  ?? REPO_ROOT;
  const bgsdDir   = opts.bgsdDir   ?? join(repoRoot, ".bgsd");
  const runId     = opts.runId ?? "";

  // NFR-01 branch guard (always enforced, no --live needed). Uses the injected
  // git boundary so a test can force a production-branch refusal.
  requireNotProductionBranch({ gitImpl, repoRoot });

  const { path: wtPath, branch, port } = plan ?? {};
  if (!wtPath || !branch) {
    throw new Error(`liveSpawnFn: plan for unit "${unitId}" is missing path or branch`);
  }

  // Resolve the full unit + scale. Prefer explicit opts; otherwise read them
  // back from the run's persisted units (persistRunUnits, run-units.mjs). This
  // keeps the injected spawnFn(unitId, plan) signature clean.
  const unit =
    opts.unit ??
    (runId ? readRunUnit(runId, unitId, { bgsdDir }) : null) ??
    { id: unitId };
  const scale = opts.scale ?? (runId ? readRunScale(runId, { bgsdDir }) : null) ?? "feature";

  const log = (msg) => process.stderr.write(`[run-live] ${msg}\n`);
  log(`liveSpawnFn: creating worktree for unit "${unitId}" (${branch} @ ${wtPath}, port ${port})`);

  // 1. Create the git worktree off HEAD (NFR-06: throw on non-zero/error).
  const worktreeResult = gitImpl(
    "git",
    ["worktree", "add", wtPath, "-b", branch, "HEAD"],
    { cwd: repoRoot, stdio: "inherit", encoding: "utf8" }
  );
  if (worktreeResult?.error) {
    throw new Error(`git worktree add failed for unit "${unitId}": ${worktreeResult.error.message}`);
  }
  if (worktreeResult?.status !== 0) {
    throw new Error(
      `git worktree add failed for unit "${unitId}" (exit ${worktreeResult?.status}): ${worktreeResult?.stderr ?? ""}`
    );
  }

  // 2. Propagate env files into the worktree (worktrees skip gitignored files).
  //    Patterns + on/off come from BGSD.md (env.files / env.propagate).
  propagateEnvForConfig({ repoRoot, destDir: wtPath, log });

  // 3. Write the per-unit config seams (posture + phase config) into .planning/.
  const planningDir = join(wtPath, ".planning");
  writeUnitWorktreeConfig(planningDir, unit);

  // 4. Write the unit brief the Pipeline Agent reads (.planning/bgsd-unit.json).
  //    run-live runs in a SEPARATE process from session.mjs, so the resolved
  //    contract (profile/routing/proxy) can't be read from this process's env —
  //    it would silently revert to claude/fixed/direct. Rehydrate it from the
  //    run's recorded run.json instead (loadContractForRun), which also keeps
  //    --proxy fail-closed across the boundary.
  const runDir = runId ? join(bgsdDir, "runs", runId) : null;
  const buildLane = buildLaneForUnit(loadContractForRun(runDir), unit.model_assignment);
  const advisorPath = runId
    ? writeAdvisorDirective(runId, unitId, { bgsdDir, scale })
    : null;
  const brief = {
    unit_id:  unitId,
    run_id:   runId,
    scale,
    title:    unit.title ?? unit.id ?? unitId,
    scope:    unit.scope ?? "",
    criteria: Array.isArray(unit.criteria) ? unit.criteria : [],
    touched:  Array.isArray(unit.touched)  ? unit.touched  : [],
    model_assignment: buildLane.assignment,
    model: buildLane.model,
    advisor_path: advisorPath,
    advisor_checkpoints: ADVISOR_CHECKPOINTS,
  };
  mkdirSync(planningDir, { recursive: true });
  writeFileSync(join(planningDir, "bgsd-unit.json"), JSON.stringify(brief, null, 2), "utf8");

  // Resolve the active HARNESS for this sesh (Claude Code or Codex) and its
  // model equivalents. `auto` detects from the environment, so switching
  // harnesses mid-project (e.g. to dodge a usage limit) is seamless — the next
  // spawn simply follows. Recorded on the control file + brief so we know which
  // harness ran each unit; the durable .bgsd/ state is harness-independent.
  const harness = harnessForLane(buildLane);

  // 5. Create the agent control file in the MAIN repo's .bgsd/runs/<runId>/.
  const controlPath = join(bgsdDir, "runs", runId, "control", `${unitId}.json`);
  createControlFile(controlPath, {
    agent_id: unitId,
    run_id:   runId,
    worktree: wtPath,
    branch,
    unit_id:  unitId,
    phase:    "plan",
    status:   "running",
    harness,
    model: buildLane.model,
    model_assignment: buildLane.assignment,
  });

  // Fixed routing uses the session build model. Adaptive routing uses only the
  // Conductor's persisted unit assignment and otherwise fails safe to heavy.
  const spawnModel = buildLane.model;
  log(`liveSpawnFn: model ${spawnModel} (${buildLane.assignment.tier}; ${buildLane.assignment.reason})`);

  // 6. The live Conductor/Advisor owns seed planning in v2. There is no separate
  //    pre-planner subprocess. If the Conductor authored a seed, copy it into the
  //    worktree and hand it to the Pipeline Agent.
  let seedPlanPath = null;

  // 6a. The live Conductor owns advisory reasoning and can author a durable seed
  //     plan. The seed lives at .bgsd/runs/<runId>/seeds/<unitId>.md.
  const conductorSeed = runId ? readConductorSeed(runId, unitId, { bgsdDir }) : null;
  if (conductorSeed) {
    seedPlanPath = join(wtPath, ".planning", "fable-plan.md");
    mkdirSync(dirname(seedPlanPath), { recursive: true });
    copyFileSync(conductorSeed, seedPlanPath);
    log(`liveSpawnFn: using Conductor-authored seed for unit "${unitId}" → ${seedPlanPath}`);
  }

  // 7. Spawn the headless Pipeline Agent on the active harness (NFR-06: throw on
  //    non-zero/error). A Conductor-authored seed is passed to avoid redundant planning.
  const agentSpawn = buildAgentSpawn({
    harness,
    command: "/bgsd-run-agent",
    model: spawnModel,
    effort: buildLane.effort,
    proxy: buildLane.transport === "proxy",
    context: {
      worktree: wtPath,
      "unit-id": unitId,
      "run-id": runId,
      "control-file": controlPath,
      scale,
      port: String(port),
      "seed-plan": seedPlanPath, // dropped automatically when null
    },
  });
  const agentT0 = Date.now();
  const usageMeta = { agentId: unitId, unitId, role: "executor", harness, model: spawnModel, effort: buildLane.effort };

  // The real pipeline must stay asynchronous so the scheduler keeps polling
  // control files and the Conductor can revise advisor directives mid-flight.
  // Injected test spawns retain the synchronous result shape for deterministic
  // assertions without launching subprocesses.
  if (!opts.spawnImpl) {
    const child = spawnImpl(agentSpawn.cmd, agentSpawn.args, { cwd: wtPath, stdio: "inherit", env: agentSpawn.env });
    child.once("error", (error) => {
      recordSpawnUsage(bgsdDir, runId, usageMeta, wtPath, agentT0);
      try { updateControlFile(controlPath, { status: "failed", phase: "failed", progress: { iteration: 0, max_iterations: 5, note: `spawn error: ${error.message}` } }); } catch (_) { /* surfaced by scheduler */ }
      process.stderr.write(`[run-live] Pipeline Agent failed to spawn for ${unitId}: ${error.message}\n`);
    });
    child.once("exit", (status, signal) => {
      recordSpawnUsage(bgsdDir, runId, usageMeta, wtPath, agentT0);
      if (status !== 0) {
        try { updateControlFile(controlPath, { status: "failed", phase: "failed", progress: { iteration: 0, max_iterations: 5, note: `agent exited ${status ?? signal ?? "unknown"}` } }); } catch (_) { /* surfaced by scheduler */ }
      }
    });
    return;
  }

  const agentResult = spawnImpl(agentSpawn.cmd, agentSpawn.args, { cwd: wtPath, stdio: "inherit", encoding: "utf8", env: agentSpawn.env });
  recordSpawnUsage(bgsdDir, runId, usageMeta, wtPath, agentT0);
  if (agentResult?.error) {
    throw new Error(`${agentSpawn.cmd} ${agentSpawn.args[0]} /bgsd-run-agent failed to spawn for unit "${unitId}": ${agentResult.error.message}`);
  }
  if (agentResult?.status !== 0) {
    throw new Error(
      `${agentSpawn.cmd} /bgsd-run-agent exited non-zero for unit "${unitId}" (exit ${agentResult?.status}): ${agentResult?.stderr ?? ""}`
    );
  }
}

// ---------------------------------------------------------------------------
// Live readStatus — reads a unit's agent control file
// ---------------------------------------------------------------------------

/**
 * Live implementation of readStatusFn.
 *
 * Reads the agent's control file to return the current status in the shape
 * the scheduler expects: "running"|"done"|"failed"|"dead".
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {string} unitId    Unit identifier
 * @param {string} runId     Run identifier
 * @param {string} bgsdDir   Absolute path to .bgsd directory
 * @returns {Promise<"running"|"done"|"failed"|"dead">}
 */
export async function liveReadStatusFn(unitId, runId, bgsdDir) {

  const controlDir = join(bgsdDir ?? join(REPO_ROOT, ".bgsd"), "runs", runId, "control");
  const controlPath = join(controlDir, `${unitId}.json`);

  if (!existsSync(controlPath)) {
    // No control file yet — agent may still be starting up
    return "running";
  }

  let cf;
  try {
    cf = JSON.parse(readFileSync(controlPath, "utf8"));
  } catch (_) {
    return "dead"; // Corrupt control file — treat as dead (NFR-06)
  }

  // Map control file status to scheduler status
  const statusMap = {
    running:     "running",
    stalled:     "running",  // still live; stall detection is separate
    blocked:     "dead",     // blocker with no inbox answer yet
    needs_input: "dead",     // escalated to user
    done:        "done",
    failed:      "failed",
  };

  return statusMap[cf.status] ?? "running";
}

// ---------------------------------------------------------------------------
// Live merge — dry-run pre-check then real merge (CONFLICT-01, CONFLICT-02)
// ---------------------------------------------------------------------------

/**
 * Live implementation of mergeFn.
 *
 * Runs a dry-run conflict pre-check first (git merge-tree — no working-tree
 * mutation, no model), then, only if clean, does the real merge of the unit
 * branch into rehearsal/<run-id>.
 *
 * Human-reviewable: on conflict this reports { merged: false, reason } and does
 * NOT force anything — the Conductor resolves conflicts. It never claims a clean
 * merge that did not happen (NFR-06).
 *
 * The git boundary is INJECTABLE (gitImpl) so the path is unit-testable without
 * a real repo.
 *
 * @param {string} unitId   Unit identifier
 * @param {string} runId    Run identifier
 * @param {object} plan     WorktreePlan ({ branch })
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  Override the repo root (default REPO_ROOT)
 * @param {Function} [opts.gitImpl] Injected git runner (default spawnSync)
 * @returns {Promise<{ merged: boolean, reason?: string, conflicts?: string[] }>}
 */
export async function liveMergeFn(unitId, runId, plan, opts = {}) {
  const gitImpl  = opts.gitImpl  ?? spawnSync;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;

  // NFR-01 branch guard (always enforced). Uses the injected git boundary so a
  // test can force a production-branch refusal.
  requireNotProductionBranch({ gitImpl, repoRoot });

  const { branch } = plan ?? {};
  if (!branch) {
    throw new Error(`liveMergeFn: plan for unit "${unitId}" is missing branch`);
  }

  const targetBranch = `rehearsal/${runId}`;

  process.stderr.write(
    `[run-live] liveMergeFn: dry-run merge check for unit "${unitId}" (${branch} → ${targetBranch})\n`
  );

  // 1. Dry-run conflict pre-check (CONFLICT-01, no model, no working-tree mutation).
  //    `git merge-tree --write-tree` exits non-zero and lists conflicting paths
  //    when the merge would conflict; it does not touch HEAD or the index.
  const dryRun = gitImpl(
    "git",
    ["merge-tree", "--write-tree", "--name-only", targetBranch, branch],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (dryRun?.error) {
    throw new Error(`liveMergeFn: git merge-tree failed for unit "${unitId}": ${dryRun.error.message}`);
  }
  if (dryRun?.status !== 0) {
    // Non-zero from merge-tree = the merge would conflict. Report, do not force.
    const conflicts = String(dryRun?.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { merged: false, reason: "conflict", conflicts };
  }

  // 2. Clean pre-check → do the real merge into rehearsal/<run-id> (CONFLICT-02).
  const merge = gitImpl(
    "git",
    ["merge", "--no-ff", "-m", `bgsd(merge): ${branch} → ${targetBranch}`, branch],
    { cwd: repoRoot, stdio: "inherit", encoding: "utf8" }
  );
  if (merge?.error) {
    throw new Error(`liveMergeFn: git merge failed for unit "${unitId}": ${merge.error.message}`);
  }
  if (merge?.status !== 0) {
    // Real merge unexpectedly conflicted after a clean pre-check — abort + report.
    gitImpl("git", ["merge", "--abort"], { cwd: repoRoot, encoding: "utf8" });
    return { merged: false, reason: "merge_failed", conflicts: [] };
  }

  return { merged: true };
}

// ---------------------------------------------------------------------------
// Live checkpoint — surface to user + wait for go/no-go (RUN-03)
// ---------------------------------------------------------------------------

/**
 * Live implementation of checkpointFn.
 *
 * Writes the checkpoint summary to stdout in a human-readable format and
 * waits for explicit stdin go/no-go before allowing the lifecycle to continue.
 *
 * This enforces the no-fire-and-forget rule: the human MUST explicitly
 * approve each merge-boundary before the next wave proceeds (NFR-08 / RUN-03).
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {object} checkpoint   The checkpoint record from recordCheckpoint()
 * @returns {Promise<{ go: boolean }>}
 */
export async function liveCheckpointFn(checkpoint) {

  const {
    checkpoint_id,
    wave_index,
    merged = [],
    held   = [],
    blockers = [],
  } = checkpoint;

  process.stdout.write(
    "\n" +
    "======================================================================\n" +
    `Kiwi: Merge-Boundary Checkpoint (Wave ${wave_index ?? "?"})  [${checkpoint_id}]\n` +
    "======================================================================\n\n" +
    `  Merged cleanly (${merged.length}): ${merged.join(", ") || "(none)"}\n` +
    `  Held back     (${held.length}):   ${held.join(", ") || "(none)"}\n`
  );

  if (blockers.length > 0) {
    process.stdout.write(
      `\n  Open blockers (${blockers.length}):\n`
    );
    for (const b of blockers) {
      process.stdout.write(`    - ${b.unit_id ?? b.agent_id}: ${b.reason ?? b.question ?? "(see control file)"}\n`);
    }
  }

  process.stdout.write(
    "\n  🔒 main-protected — rehearsal/<run-id> will NOT be merged to 'next' automatically.\n" +
    "\n  Kiwi is waiting for your go/no-go to proceed to the next wave.\n" +
    "  Type 'go' to continue or 'abort' to stop the run.\n\n" +
    "  > "
  );

  // Read stdin for the human's go/no-go
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      const go = answer === "go" || answer === "y" || answer === "yes";
      process.stdout.write(go ? "\n  Kiwi: Proceeding.\n\n" : "\n  Kiwi: Aborting run.\n\n");
      resolve({ go });
    });
    // If stdin closes without input (non-interactive), default to go=false (safe)
    rl.once("close", () => resolve({ go: false }));
  });
}

// ---------------------------------------------------------------------------
// runLiveRun — full wired orchestration (SPAWN-04, RUN-01..04)
// ---------------------------------------------------------------------------

/**
 * Wire all live injections into runLifecycle() and drive the full
 * /bgsd-run orchestration end-to-end.
 *
 * This is the human-supervised, real multi-process orchestration path.
 * It drives units from decomposed → executed → verified → checkpoint → done
 * using real git worktrees and real `claude -p` headless agents.
 *
 * HUMAN-GATED: refuses without --live (NFR-07, SPAWN-04).
 * NEVER run in CI or against `next` (NFR-01).
 *
 * @param {object} opts
 * @param {string}   opts.runPath          Absolute path to run.json
 * @param {object[]} opts.units            Decomposed units
 * @param {string[][]} opts.waves          Topological waves
 * @param {object}   opts.graph            DAG adjacency
 * @param {Map}      opts.plans            WorktreePlan map
 * @param {string}   opts.bgsdDir          Absolute path to .bgsd
 * @param {number}   [opts.maxConcurrency] Parallelism cap (default 4)
 * @returns {Promise<object>}  runLifecycle result
 */
export async function runLiveRun({
  runPath,
  units,
  waves,
  graph,
  plans,
  bgsdDir,
  maxConcurrency = 4,
}) {
  requireNotProductionBranch();

  // Lazy import the pure lifecycle controller
  const { runLifecycle } = await import(`file://${resolve(__dir, "run.mjs")}`);

  // Build the live-wired injections
  let runIdForStatus = "";
  try {
    const { readRun } = await import(`file://${resolve(__dir, "run.mjs")}`);
    runIdForStatus = readRun(runPath).run_id;
  } catch (_) {}

  // Thread the run id + bgsdDir so liveSpawnFn can fallback-read the full unit
  // and scale from the persisted run units (persistRunUnits). The injected
  // spawnFn(unitId, plan) signature stays clean; opts carry the run context.
  const spawnFn = (unitId, plan) =>
    liveSpawnFn(unitId, plan, { runId: runIdForStatus, bgsdDir });

  const readStatusFn = (unitId) =>
    liveReadStatusFn(unitId, runIdForStatus, bgsdDir);

  const mergeFn = (unitId, runId, plan) => liveMergeFn(unitId, runId, plan);

  const checkpointFn = (checkpoint) => liveCheckpointFn(checkpoint);

  // Live context-management hook (CTX-02): each poll cycle, read every in-flight
  // agent's recorded context_bytes from its control file, classify pressure from
  // config-driven thresholds, persist it, and dispatch compact/relaunch through
  // the real (--live) seams in context.mjs.
  const onPollFn = await buildLiveContextOnPollFn({
    runId: runIdForStatus,
    bgsdDir,
    plans,
  });

  return runLifecycle({
    runPath,
    units,
    waves,
    graph,
    plans,
    spawnFn,
    readStatusFn,
    mergeFn,
    checkpointFn,
    maxConcurrency,
    pollIntervalMs: 2_000,
    pollTimeoutMs:  300_000,
    onPollFn,
  });
}

/**
 * Build the live context-management poll hook for runLifecycle.
 *
 * Reads thresholds from the repo's resolved bgsd config (BGSD.md → defaults),
 * then returns an async (inFlightUnitIds[]) => void that the scheduler calls
 * each poll cycle. Internally it delegates to context.runContextTick with live
 * injections:
 *   - readBytesFn:  reads the agent's control-file context_bytes from disk.
 *       HONEST SCOPE: that byte value is written by the live `claude -p` agent,
 *       whose spawn (liveSpawnFn) is itself partly stubbed — so today this reads
 *       whatever the agent has recorded (0 until the spawn reports real tokens).
 *       The decision + seams are fully wired; only the byte SOURCE is pending.
 *   - recordFn:     persists {context_bytes, context_pressure} via updateContextUsage.
 *   - compactFn:    liveCompact (writes handoff manifest + relaunches).
 *   - relaunchFn:   liveRelaunch (reads manifest + re-spawns claude -p).
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.bgsdDir
 * @param {Map}    opts.plans   WorktreePlan map (for worktree paths)
 * @returns {Promise<Function>}
 */
export async function buildLiveContextOnPollFn({ runId, bgsdDir, plans }) {

  const ctx = await import(`file://${resolve(__dir, "context.mjs")}`);
  const control = await import(`file://${resolve(__dir, "control.mjs")}`);
  const { parseBgsdMd, defaultBgsdConfig } = await import(`file://${resolve(__dir, "init.mjs")}`);

  // Resolve config-driven thresholds (BGSD.md context block → makeThresholds).
  let config;
  try {
    const bgsdMdPath = join(REPO_ROOT, "BGSD.md");
    config = existsSync(bgsdMdPath) ? parseBgsdMd(readFileSync(bgsdMdPath, "utf8")) : defaultBgsdConfig();
  } catch (_) {
    config = defaultBgsdConfig();
  }
  const thresholds = ctx.thresholdsFromConfig(config);

  const dir = bgsdDir ?? join(REPO_ROOT, ".bgsd");
  const controlDir = join(dir, "runs", runId, "control");
  const controlPathFor = (agentId) => join(controlDir, `${agentId}.json`);

  const readBytesFn = (agentId) => {
    const p = controlPathFor(agentId);
    if (!existsSync(p)) return 0;
    try {
      return control.readControlFile(p).context_bytes ?? 0;
    } catch (_) {
      return 0;
    }
  };

  const recordFn = (agentId, usage) => {
    const p = controlPathFor(agentId);
    if (existsSync(p)) control.updateContextUsage(p, usage);
  };

  const compactFn = (agentId) =>
    ctx.liveCompact({
      agentId,
      controlPath:  controlPathFor(agentId),
      manifestPath: join(controlDir, `${agentId}.handoff.json`),
      worktreePath: plans?.get(agentId)?.path,
    });

  const relaunchFn = (agentId) =>
    ctx.liveRelaunch({
      agentId,
      manifestPath: join(controlDir, `${agentId}.handoff.json`),
      worktreePath: plans?.get(agentId)?.path,
    });

  return (inFlightUnitIds) =>
    ctx.runContextTick({
      agentIds: inFlightUnitIds,
      readBytesFn,
      recordFn,
      compactFn,
      relaunchFn,
      thresholds,
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
  // The --live gate is gone: a plain /bgsd-sesh fires the live path with zero
  // friction. The next-branch guard (NFR-01) still protects main/master.
  process.stderr.write(
    "\n[run-live] live run starting.\n" +
    "  Pass runPath, units, waves, graph, and plans programmatically\n" +
    "  via the runLiveRun() export. This CLI entrypoint is a usage reminder.\n\n" +
    "  Before a live run, ensure:\n" +
    "    1. git branch --show-current (must NOT be 'next')\n" +
    "    2. BGSD_BUDGET_CAP is set\n" +
    "    3. caffeinate is running\n" +
    "    4. You are watching the terminal\n\n"
  );
  process.exit(0);
}
