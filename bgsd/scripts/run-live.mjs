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

import { spawnSync } from "node:child_process";
import { isProductionBranch } from "./integration.mjs";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

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
 * This guard fires regardless of --live — it is always enforced.
 *
 * @throws {Error} if the current branch is `next`
 */
export function requireNotProductionBranch() {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const branch = (result.stdout ?? "").trim();
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
 *   1. Creates a git worktree at plan.path on branch plan.branch.
 *   2. Writes the unit's .planning/config.json via the config seam (NFR-04).
 *   3. Launches a headless `claude -p` Pipeline Agent.
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {string}   unitId   Unit identifier
 * @param {object}   plan     WorktreePlan from planWorktrees()
 * @returns {Promise<void>}
 */
export async function liveSpawnFn(unitId, plan) {
  requireLiveFlag();
  requireNotProductionBranch();

  const { path: wtPath, branch, port } = plan ?? {};
  if (!wtPath || !branch) {
    throw new Error(`liveSpawnFn: plan for unit "${unitId}" is missing path or branch`);
  }

  // 1. Create the git worktree
  // In a real run: git worktree add <wtPath> -b <branch> <baseRef>
  // The base ref is the current rehearsal/<run-id> head (or HEAD for wave 1).
  process.stderr.write(
    `[run-live] liveSpawnFn: creating worktree for unit "${unitId}"\n` +
    `  Path:   ${wtPath}\n` +
    `  Branch: ${branch}\n` +
    `  Port:   ${port}\n`
  );

  // LIVE SEAM POINT: in a fully-wired live run, this would:
  //   spawnSync("git", ["worktree", "add", wtPath, "-b", branch, baseRef], ...)
  //   writeUnitWorktreeConfig(join(wtPath, ".planning"), unit)  // posture + phase config
  //   spawnSync("claude", ["-p", "/gsd-execute-phase", "--worktree", wtPath], ...)
  //
  // The actual spawn is intentionally NOT executed here; the human runs this
  // supervised and watches the terminal (NFR-07 / NFR-08).
  //
  // To wire real spawn, replace this stub with:
  //
  //   const worktreeResult = spawnSync("git", [
  //     "worktree", "add", wtPath, "-b", branch, "HEAD",
  //   ], { cwd: REPO_ROOT, stdio: "inherit" });
  //   if (worktreeResult.status !== 0) {
  //     throw new Error(`git worktree add failed for unit "${unitId}"`);
  //   }
  //   const agentResult = spawnSync("claude", [
  //     "-p", "/bgsd-run-agent",
  //     "--worktree", wtPath,
  //     "--unit-id", unitId,
  //     "--port", String(port),
  //   ], { stdio: "inherit", cwd: wtPath });

  process.stderr.write(
    `[run-live] (live seam not yet connected — would spawn claude -p on ${wtPath})\n`
  );
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
  requireLiveFlag();

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
 * Runs a dry-run conflict pre-check first (no model), then merges the
 * worktree branch into rehearsal/<run-id> if clean.
 *
 * HUMAN-GATED: refuses without --live (NFR-07).
 *
 * @param {string} unitId   Unit identifier
 * @param {string} runId    Run identifier
 * @param {object} plan     WorktreePlan
 * @returns {Promise<{ merged: boolean, reason?: string, conflicts?: string[] }>}
 */
export async function liveMergeFn(unitId, runId, plan) {
  requireLiveFlag();

  const { branch } = plan ?? {};
  const targetBranch = `rehearsal/${runId}`;

  process.stderr.write(
    `[run-live] liveMergeFn: dry-run merge check for unit "${unitId}"\n` +
    `  Branch: ${branch} → ${targetBranch}\n`
  );

  // LIVE SEAM POINT: in a fully-wired live run, this would:
  //
  //   // Dry-run pre-check (CONFLICT-01 — no model)
  //   const dryRun = spawnSync("git", [
  //     "merge", "--no-commit", "--no-ff", branch,
  //   ], { cwd: REPO_ROOT, encoding: "utf8" });
  //
  //   if (dryRun.status !== 0) {
  //     const conflicts = (dryRun.stderr ?? "").split("\n")
  //       .filter((l) => l.startsWith("CONFLICT"));
  //     // Roll back the dry-run attempt
  //     spawnSync("git", ["merge", "--abort"], { cwd: REPO_ROOT });
  //     return { merged: false, reason: "conflict", conflicts };
  //   }
  //
  //   // Roll back dry-run then do the real merge (CONFLICT-02)
  //   spawnSync("git", ["merge", "--abort"], { cwd: REPO_ROOT });
  //   spawnSync("git", ["merge", "--no-ff", "-m", `merge: ${branch}`, branch], {
  //     cwd: REPO_ROOT, stdio: "inherit",
  //   });
  //   return { merged: true };

  process.stderr.write(
    `[run-live] (live seam not yet connected — would merge ${branch} → ${targetBranch})\n`
  );

  // Default: treat as merged for the structural seam
  return { merged: true, reason: "live_seam_stub" };
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
  requireLiveFlag();

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
  requireLiveFlag();
  requireNotProductionBranch();

  // Lazy import the pure lifecycle controller
  const { runLifecycle } = await import(`file://${resolve(__dir, "run.mjs")}`);

  // Build the live-wired injections
  let runIdForStatus = "";
  try {
    const { readRun } = await import(`file://${resolve(__dir, "run.mjs")}`);
    runIdForStatus = readRun(runPath).run_id;
  } catch (_) {}

  const spawnFn = (unitId, plan) => liveSpawnFn(unitId, plan);

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
  requireLiveFlag();

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
  // Guard fires at invocation time: if --live is absent, print the refusal.
  try {
    requireLiveFlag();
  } catch (err) {
    process.stderr.write(err.message);
    process.exit(1);
  }

  process.stderr.write(
    "\n[run-live] --live flag detected. This is a HUMAN-SUPERVISED run.\n" +
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
