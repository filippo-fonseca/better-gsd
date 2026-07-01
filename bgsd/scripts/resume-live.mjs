#!/usr/bin/env node
/**
 * resume-live.mjs — live seam for /bgsd-resume (real fs over .bgsd/runs).
 *
 * Wires real filesystem reads into the pure resume core (resume.mjs). It scans
 * `.bgsd/runs/<run-id>/control/*.json`, summarizes each run, and selects the
 * most recent run still in flight, then prints a resume plan. Mirrors the seam
 * pattern of init-live.mjs / run-live.mjs.
 *
 * TARGET REPO RESOLUTION: the repo is resolved from cwd via
 * `git rev-parse --show-toplevel`, not from the plugin location (bgsd runs in
 * the USER's repo; its engine lives at ${CLAUDE_PLUGIN_ROOT}).
 *
 * Usage (CLI):
 *   node resume-live.mjs               # plan to resume the latest interrupted run
 *   node resume-live.mjs <run-id>      # plan to resume a specific run
 *   node resume-live.mjs --plan-only   # explicit preview (same read-only output)
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAllControlFiles } from "./control.mjs";
import {
  summarizeRun,
  pickLatestResumable,
  findRun,
  buildResumeSummary,
} from "./resume.mjs";
import { resumePausedRun } from "./pause.mjs";
import { resolveRepoRoot } from "./init-live.mjs";

/**
 * Best-effort read of a run's run.json. Returns null when absent/corrupt so a
 * missing macro record never breaks the control-file-driven resume scan.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @returns {object|null}
 */
function readRunJson(runsDir, runId) {
  const p = join(runsDir, runId, "run.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * Newest activity timestamp (ms epoch) across a run's control objects, from the
 * `updated_at` then `heartbeat_at` ISO fields. Falls back to 0 when absent.
 */
function newestActivity(controls) {
  let newest = 0;
  for (const c of controls) {
    for (const field of [c.updated_at, c.heartbeat_at, c.started_at]) {
      const t = field ? Date.parse(field) : NaN;
      if (!Number.isNaN(t) && t > newest) newest = t;
    }
  }
  return newest;
}

/**
 * Read every run under `.bgsd/runs/` and summarize it from its control files.
 *
 * @param {string} repoRoot
 * @returns {object[]} run summaries (from summarizeRun)
 */
export function readRuns(repoRoot) {
  const runsDir = join(repoRoot, ".bgsd", "runs");
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const controlDir = join(runsDir, runId, "control");
    let controls = [];
    try {
      controls = existsSync(controlDir) ? readAllControlFiles(controlDir).files : [];
    } catch (_) {
      controls = [];
    }
    let mtime = newestActivity(controls);
    // Read run.json so a PAUSED run is surfaced as resumable even when its
    // control files all look terminal (a pause taken between waves, or before
    // any fan-out, leaves no in-flight control file).
    const runJson = readRunJson(runsDir, runId);
    if (mtime === 0 && runJson?.updated_at) {
      const t = Date.parse(runJson.updated_at);
      if (!Number.isNaN(t)) mtime = t;
    }
    if (mtime === 0) {
      // No usable timestamps anywhere: fall back to the run dir mtime.
      try {
        mtime = statSync(join(runsDir, runId)).mtimeMs;
      } catch (_) {
        mtime = 0;
      }
    }
    out.push(
      summarizeRun({
        runId,
        controls,
        mtime,
        runState: runJson?.state ?? null,
        resumeState: runJson?.resume_state ?? null,
        pausedAt: runJson?.paused_at ?? null,
        pauseReason: runJson?.pause_reason ?? null,
      })
    );
  }
  return out;
}

/**
 * Resolve the run to resume: an explicit id if given (and resumable), else the
 * latest resumable run. Returns { run, reason }.
 *
 * @param {string} repoRoot
 * @param {string|null} [runId]
 */
export function planResume(repoRoot, runId = null) {
  const runs = readRuns(repoRoot);
  if (runId) {
    const run = findRun(runs, runId);
    if (!run) return { run: null, reason: `no run "${runId}" found under .bgsd/runs` };
    if (!run.resumable) return { run: null, reason: `run "${runId}" is already finished` };
    return { run, reason: null };
  }
  const run = pickLatestResumable(runs);
  return {
    run,
    reason: run ? null : "no interrupted session found (every run is finished)",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const out = (s) => process.stdout.write(s);
  const repoRoot = resolveRepoRoot();
  const rawArgs = process.argv.slice(2);
  const planOnly = rawArgs.includes("--plan-only") || rawArgs.includes("--dry-run");
  const args = rawArgs.filter((a) => a !== "--plan-only" && a !== "--dry-run");
  const runId = args[0] ?? null;

  const { run, reason } = planResume(repoRoot, runId);

  out(`\nbgsd-resume — repo: ${repoRoot}\n`);
  if (!run) {
    out(`  ${reason}.\n`);
    out(`  Start fresh with /bgsd-sesh "<what you need>", or check /bgsd-status.\n\n`);
    return;
  }
  const summary = buildResumeSummary(run);
  for (const line of summary.lines) out(`  ${line}\n`);

  // A PAUSED run is restored to its exact recorded state on a real resume (never
  // on a read-only preview). This clears the paused marker and moves run.json
  // back to resume_state so the session continues from precisely where it was.
  if (run.paused && !planOnly) {
    const restored = resumePausedRun({ runId: run.run_id, bgsdDir: join(repoRoot, ".bgsd") });
    out(`\n  Restored ${run.run_id} to "${restored.state}" — paused marker cleared.\n`);
  } else if (run.paused && planOnly) {
    out(`\n  (preview) Would restore ${run.run_id} to "${run.resume_state ?? "its recorded state"}".\n`);
  }

  out(`\n  Execution re-entry is a live seam (run-live orchestration). This preview\n`);
  out(`  shows the recovered state; wiring re-spawns the in-flight unit(s) from\n`);
  out(`  their last phase, with main still protected. Re-run under the session to\n`);
  out(`  continue, or pass the run id to /bgsd-sesh tooling.\n\n`);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]resume-live\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
