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
 *   node resume-live.mjs handoff-write --run-id <id> [--json '<payload>']
 *                                      # validate + write a compaction handoff to
 *                                      # .bgsd/runs/<id>/compact-handoff.json
 *                                      # (payload from --json, else stdin;
 *                                      #  written_at auto-stamped if omitted)
 *
 * COMPACTION HANDOFF (read side): a real resume that finds a
 * compact-handoff.json for the selected run surfaces it FIRST in the brief,
 * then CONSUMES it by renaming to compact-handoff.consumed.json so it is never
 * replayed on a later resume. `--plan-only` reads but never consumes.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

import { readAllControlFiles } from "./control.mjs";
import {
  summarizeRun,
  pickLatestResumable,
  findRun,
  buildResumeBrief,
  validateCompactHandoff,
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
// Compaction handoff (write / read / consume)
// ---------------------------------------------------------------------------

export function handoffPath(repoRoot, runId) {
  return join(repoRoot, ".bgsd", "runs", runId, "compact-handoff.json");
}

/**
 * Validate + write a compaction handoff for a run. `written_at` is auto-stamped
 * when omitted (the write moment IS the handoff moment). Throws with every
 * validation error joined into one readable message; the run dir must already
 * exist (a handoff for a nonexistent run is always a typo).
 *
 * @returns {{ path: string, handoff: object }}
 */
export function writeCompactHandoff(repoRoot, runId, payload, nowFn = () => new Date().toISOString()) {
  const runDir = join(repoRoot, ".bgsd", "runs", runId);
  if (!existsSync(runDir)) {
    throw new Error(`no run "${runId}" under .bgsd/runs — cannot write a handoff for it`);
  }
  const handoff = { ...payload };
  if (handoff.written_at === undefined) handoff.written_at = nowFn();
  const { ok, errors } = validateCompactHandoff(handoff);
  if (!ok) {
    throw new Error(`invalid compaction handoff:\n  - ${errors.join("\n  - ")}`);
  }
  const p = handoffPath(repoRoot, runId);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(handoff, null, 2), "utf8");
  renameSync(tmp, p);
  return { path: p, handoff };
}

/**
 * Read a run's compact-handoff.json, if any. A missing file is the normal case
 * ({ handoff: null, error: null }); a present-but-corrupt or invalid file is
 * surfaced as an error string, never silently ignored (NFR-06).
 *
 * @returns {{ handoff: object|null, error: string|null }}
 */
export function readCompactHandoff(repoRoot, runId) {
  const p = handoffPath(repoRoot, runId);
  if (!existsSync(p)) return { handoff: null, error: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { handoff: null, error: `compact-handoff.json is not valid JSON: ${err.message}` };
  }
  const { ok, errors } = validateCompactHandoff(parsed);
  if (!ok) return { handoff: null, error: `compact-handoff.json is invalid: ${errors.join("; ")}` };
  return { handoff: parsed, error: null };
}

/**
 * Mark a run's handoff consumed by renaming it to compact-handoff.consumed.json
 * (kept as a record; never re-read by resume). Returns the consumed path, or
 * null when there was nothing to consume.
 */
export function consumeCompactHandoff(repoRoot, runId) {
  const p = handoffPath(repoRoot, runId);
  if (!existsSync(p)) return null;
  const consumed = join(repoRoot, ".bgsd", "runs", runId, "compact-handoff.consumed.json");
  renameSync(p, consumed);
  return consumed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return flags;
}

function handoffWriteCli(args) {
  const out = (s) => process.stdout.write(s);
  const repoRoot = resolveRepoRoot();
  const flags = parseFlags(args);
  const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : null;
  if (!runId) {
    throw new Error(`handoff-write requires --run-id <id>`);
  }
  let raw;
  if (typeof flags.json === "string") {
    raw = flags.json;
  } else if (!process.stdin.isTTY) {
    raw = readFileSync(0, "utf8");
  } else {
    throw new Error(`handoff-write needs a payload: pass --json '<...>' or pipe JSON on stdin`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`handoff payload is not valid JSON: ${err.message}`);
  }
  const { path } = writeCompactHandoff(repoRoot, runId, payload);
  out(`\nbgsd-resume handoff-write — repo: ${repoRoot}\n`);
  out(`  Handoff recorded for ${runId} → ${path}\n`);
  out(`  The next /bgsd-resume of this run will surface it first, then consume it.\n\n`);
}

export function main() {
  const out = (s) => process.stdout.write(s);
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "handoff-write") return handoffWriteCli(rawArgs.slice(1));
  const repoRoot = resolveRepoRoot();
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
  const { handoff, error: handoffError } = readCompactHandoff(repoRoot, run.run_id);
  const summary = buildResumeBrief(run, handoff);
  for (const line of summary.lines) out(`  ${line}\n`);
  if (handoffError) {
    out(`  WARNING: a compaction handoff exists for ${run.run_id} but is unusable — ${handoffError}\n`);
    out(`  Resuming from control files alone; inspect/remove compact-handoff.json by hand.\n`);
  }
  if (handoff && !planOnly) {
    const consumed = consumeCompactHandoff(repoRoot, run.run_id);
    out(`\n  Handoff consumed → ${consumed} (will not replay on the next resume).\n`);
  } else if (handoff && planOnly) {
    out(`\n  (preview) Handoff left in place — a real resume will consume it.\n`);
  }

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
