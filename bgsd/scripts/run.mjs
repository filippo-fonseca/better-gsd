#!/usr/bin/env node
/**
 * run.mjs — Phase 4: /bgsd-run Lifecycle + Run State Machine (RUN-01..04)
 *
 * Implements the full /bgsd-run orchestration lifecycle as a deterministic
 * state machine. The scheduler + spawn + merge are DEPENDENCY-INJECTED so the
 * entire lifecycle is unit-testable under mocked spawns (NFR-05).
 *
 * LIFECYCLE STATE MACHINE (RUN-02)
 * =================================
 *   created → decomposed → spawning → executing → verifying →
 *   merging → checkpoint → (done | aborted | blocked | needs_input)
 *
 * Each transition is timestamped and written atomically to:
 *   .bgsd/runs/<run-id>/run.json
 *
 * MERGE-BOUNDARY CHECKPOINT (RUN-03)
 * ====================================
 * Before each wave merges into rehearsal/<run-id>, the lifecycle halts and
 * records a checkpoint record. The caller (Conductor) must explicitly call
 * resumeFromCheckpoint() to continue. This enforces the no-fire-and-forget
 * rule (NFR-08). The checkpoint record is also written to run.json.
 *
 * ABORT (RUN-04)
 * ==============
 * abortRun() sets the run state to "aborted" and records the abort in
 * run.json. In a live run the caller must have already signalled worker
 * processes to exit; in test paths the scheduler is mocked so no real
 * processes exist. The run record is always preserved for inspection.
 *
 * DEPENDENCY INJECTION (SPAWN-04, mirroring loop1/scheduler DI)
 * ==============================================================
 * The following boundary functions are injected:
 *   spawnFn(unitId, plan)         — in tests: mock; in live: real worktree spawn
 *   readStatusFn(unitId)          — in tests: mock; in live: reads control file
 *   mergeFn(unitId, runId, plan)  — in tests: mock; in live: git merge
 *   checkpointFn(checkpoint)      — in tests: mock; in live: user-facing pause
 *
 * The lifecycle never holds the whole run in context. It reads/writes small
 * run.json state files and passes pointers, not blobs (NFR-09).
 *
 * RUN-ID FORMAT (RUN-01)
 * =======================
 * bgsd-<NNNN>-<slug>
 * The sequence number is derived from a monotonic counter file at
 * .bgsd/run-counter (created + incremented atomically).
 * The slug is a sanitized, 24-char max version of the first 5 words of the prompt.
 *
 * Usage (library):
 *   import { mintRunId, createRun, advanceState, abortRun,
 *            runLifecycle, resumeFromCheckpoint } from './run.mjs';
 *
 * Usage (CLI):
 *   node bgsd/scripts/run.mjs --prompt "..." [--dry-run] [--live]
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Run lifecycle states (RUN-02)
// ---------------------------------------------------------------------------

/**
 * Valid lifecycle states, in order of progression.
 * "aborted", "blocked", "needs_input", and "done" are terminal.
 */
export const RUN_STATES = Object.freeze([
  "created",
  "decomposed",
  "spawning",
  "executing",
  "verifying",
  "merging",
  "checkpoint",
  // v3 Loop 2 + Review Gate states (REVIEW-01..04, LOOP2-01)
  "integrating",
  "review",
  "done",
  "aborted",
  "blocked",
  "needs_input",
]);

/** Terminal states — a run in one of these states will not transition further. */
export const TERMINAL_STATES = new Set(["done", "aborted", "blocked", "needs_input"]);

// ---------------------------------------------------------------------------
// Run-ID generation (RUN-01)
// ---------------------------------------------------------------------------

/**
 * Derive a 24-char-max slug from the prompt's first 5 words.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function promptSlug(prompt) {
  return (prompt ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "run";
}

/**
 * Mint a monotonic run ID: bgsd-<NNNN>-<slug>
 *
 * Reads and increments the counter at .bgsd/run-counter atomically.
 * If the counter does not exist it is created starting at 1.
 *
 * @param {string} prompt            The decomposition prompt
 * @param {string} [bgsdDir]         Override the .bgsd dir path (default: <repo>/.bgsd)
 * @returns {{ runId: string, seq: number }}
 */
export function mintRunId(prompt, bgsdDir) {
  const dir = bgsdDir ?? join(REPO_ROOT, ".bgsd");
  mkdirSync(dir, { recursive: true });

  const counterPath = join(dir, "run-counter");
  let seq = 1;
  if (existsSync(counterPath)) {
    const raw = readFileSync(counterPath, "utf8").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) {
      seq = parsed + 1;
    }
  }

  // Write the new counter atomically
  const tmpPath = counterPath + ".tmp";
  writeFileSync(tmpPath, String(seq), "utf8");
  renameSync(tmpPath, counterPath);

  const seqStr = String(seq).padStart(4, "0");
  const slug = promptSlug(prompt);
  const runId = `bgsd-${seqStr}-${slug}`;

  return { runId, seq };
}

// ---------------------------------------------------------------------------
// Atomic run.json I/O (RUN-02)
// ---------------------------------------------------------------------------

/**
 * Return the path to the run.json state file for a run.
 *
 * @param {string} bgsdDir   Absolute path to the .bgsd directory
 * @param {string} runId     Run identifier
 * @returns {string}
 */
export function runJsonPath(bgsdDir, runId) {
  return join(bgsdDir, "runs", runId, "run.json");
}

/**
 * Write run.json atomically (write temp + rename — POSIX atomic on same fs).
 *
 * @param {string} runPath   Absolute path to run.json
 * @param {object} data      The run state object to write
 */
function writeRunAtomic(runPath, data) {
  const tmpPath = runPath + ".tmp";
  const dir = dirname(runPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmpPath, runPath);
}

/**
 * Read and parse run.json.
 *
 * @param {string} runPath   Absolute path to run.json
 * @returns {object}  The run state object
 * @throws {Error} if the file does not exist or is not valid JSON
 */
export function readRun(runPath) {
  if (!existsSync(runPath)) {
    throw new Error(`run.json not found at ${runPath}`);
  }
  let raw;
  try {
    raw = readFileSync(runPath, "utf8");
  } catch (err) {
    throw new Error(`run.json read error at ${runPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`run.json is not valid JSON at ${runPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Run creation (RUN-01)
// ---------------------------------------------------------------------------

/**
 * Create a new run record under .bgsd/runs/<run-id>/run.json.
 * Writes the initial state ("created") with a timestamp.
 *
 * @param {object} opts
 * @param {string}   opts.runId    Run identifier (from mintRunId)
 * @param {string}   opts.prompt   The original decomposition prompt
 * @param {string}   [opts.bgsdDir]  Absolute path to .bgsd directory
 * @returns {object}  The created run state object
 */
export function createRun({ runId, prompt, bgsdDir }) {
  const dir = bgsdDir ?? join(REPO_ROOT, ".bgsd");
  const runPath = runJsonPath(dir, runId);

  const now = new Date().toISOString();
  const data = {
    run_id:       runId,
    prompt,
    state:        "created",
    created_at:   now,
    updated_at:   now,
    transitions:  [{ from: null, to: "created", at: now, meta: {} }],
    checkpoints:  [],
    units:        [],
    waves:        [],
    scheduler_result: null,
    abort_reason: null,
    error:        null,
  };

  writeRunAtomic(runPath, data);
  return data;
}

// ---------------------------------------------------------------------------
// State transitions (RUN-02)
// ---------------------------------------------------------------------------

/**
 * Advance the run to a new lifecycle state, timestamping the transition
 * and writing it to run.json atomically.
 *
 * Validates that the new state is a known RUN_STATE. Terminal states cannot
 * be transitioned out of (NFR-06: no silent green on corrupt state).
 *
 * @param {string} runPath   Absolute path to run.json
 * @param {string} toState   The new state to advance to
 * @param {object} [meta]    Optional metadata for the transition record
 * @returns {object}  The updated run state object
 */
export function advanceState(runPath, toState, meta = {}) {
  if (!RUN_STATES.includes(toState)) {
    throw new Error(
      `advanceState: unknown state "${toState}". Valid states: [${RUN_STATES.join(", ")}]`
    );
  }

  const current = readRun(runPath);

  // Terminal states cannot be transitioned out of
  if (TERMINAL_STATES.has(current.state) && current.state !== toState) {
    throw new Error(
      `advanceState: run "${current.run_id}" is in terminal state "${current.state}" — cannot transition to "${toState}"`
    );
  }

  const now = new Date().toISOString();
  const transition = { from: current.state, to: toState, at: now, meta };

  const updated = {
    ...current,
    state:       toState,
    updated_at:  now,
    transitions: [...(current.transitions ?? []), transition],
  };

  writeRunAtomic(runPath, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Merge-boundary checkpoint (RUN-03)
// ---------------------------------------------------------------------------

/**
 * Record a merge-boundary checkpoint in run.json and advance state to
 * "checkpoint". The lifecycle halts here until resumeFromCheckpoint() is called.
 *
 * A checkpoint record is written to run.json.checkpoints[]. The Conductor
 * surfaces the checkpoint summary to the user and waits for explicit go/no-go.
 *
 * @param {string} runPath   Absolute path to run.json
 * @param {object} summary   What to show at the checkpoint:
 *   {
 *     waveIndex: number,
 *     merged:  string[]   — unit ids that merged cleanly,
 *     held:    string[]   — unit ids held back (non-PASS),
 *     blockers: Array<{agent_id, question}> — consolidated open blockers,
 *   }
 * @returns {object}  The checkpoint record (including a checkpoint_id)
 */
export function recordCheckpoint(runPath, summary) {
  const current = readRun(runPath);
  const now = new Date().toISOString();

  const checkpoint = {
    checkpoint_id:  `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    wave_index:     summary.waveIndex ?? null,
    merged:         Array.isArray(summary.merged)   ? summary.merged  : [],
    held:           Array.isArray(summary.held)     ? summary.held    : [],
    blockers:       Array.isArray(summary.blockers) ? summary.blockers : [],
    recorded_at:    now,
    resumed_at:     null,
    go:             null,  // null = pending; true = approved; false = rejected
  };

  const updated = {
    ...current,
    state:        "checkpoint",
    updated_at:   now,
    transitions:  [...(current.transitions ?? []), {
      from: current.state,
      to:   "checkpoint",
      at:   now,
      meta: { checkpoint_id: checkpoint.checkpoint_id, wave_index: summary.waveIndex },
    }],
    checkpoints:  [...(current.checkpoints ?? []), checkpoint],
  };

  writeRunAtomic(runPath, updated);
  return checkpoint;
}

/**
 * Resume a run from a checkpoint. Marks the checkpoint as approved (go=true)
 * and advances the state to "merging" to continue the lifecycle.
 *
 * If go=false (the human rejected the merge), advances to "aborted".
 *
 * @param {string} runPath          Absolute path to run.json
 * @param {string} checkpointId     The checkpoint_id to resume
 * @param {object} [opts]
 * @param {boolean} [opts.go=true]  true = approved; false = rejected (abort)
 * @returns {object}  The updated run state object
 */
export function resumeFromCheckpoint(runPath, checkpointId, opts = {}) {
  const { go = true } = opts;
  const current = readRun(runPath);

  if (current.state !== "checkpoint") {
    throw new Error(
      `resumeFromCheckpoint: run "${current.run_id}" is in state "${current.state}", expected "checkpoint"`
    );
  }

  const now = new Date().toISOString();
  const checkpoints = (current.checkpoints ?? []).map((c) => {
    if (c.checkpoint_id !== checkpointId) return c;
    return { ...c, resumed_at: now, go };
  });

  const nextState = go ? "merging" : "aborted";
  const updated = {
    ...current,
    state:       nextState,
    updated_at:  now,
    transitions: [...(current.transitions ?? []), {
      from: "checkpoint",
      to:   nextState,
      at:   now,
      meta: { checkpoint_id: checkpointId, go },
    }],
    checkpoints,
    ...(go ? {} : { abort_reason: "checkpoint_rejected" }),
  };

  writeRunAtomic(runPath, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Abort (RUN-04)
// ---------------------------------------------------------------------------

/**
 * Abort an in-flight run. Sets the run state to "aborted" and records the
 * abort reason + timestamp. Preserves all branches, control files, and the
 * run record for inspection.
 *
 * In the mocked model (tests): this is purely a record-keeping operation.
 * In a live run: the caller must have already signalled worker processes to
 * exit before calling abortRun() — this function does NOT kill processes.
 *
 * @param {string} runPath   Absolute path to run.json
 * @param {string} [reason]  Human-readable abort reason
 * @returns {object}  The updated run state object
 */
export function abortRun(runPath, reason = "manual_abort") {
  const current = readRun(runPath);

  // Already in a terminal state — allow idempotent abort
  if (current.state === "aborted") {
    return current;
  }

  const now = new Date().toISOString();
  const updated = {
    ...current,
    state:        "aborted",
    updated_at:   now,
    abort_reason: reason,
    transitions:  [...(current.transitions ?? []), {
      from: current.state,
      to:   "aborted",
      at:   now,
      meta: { reason },
    }],
  };

  writeRunAtomic(runPath, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// runLifecycle — main lifecycle driver (RUN-01..04, SPAWN-04)
// ---------------------------------------------------------------------------

/**
 * Drive the full /bgsd-run lifecycle as a deterministic state machine.
 *
 * States driven:
 *   created → decomposed → spawning → executing → verifying →
 *   merging → checkpoint → (done | aborted)
 *
 * The scheduler, spawn, merge, and checkpoint actions are ALL INJECTED —
 * this function is fully unit-testable under mocked injections.
 *
 * @param {object} opts
 * @param {string}   opts.runPath           Absolute path to run.json
 * @param {object[]} opts.units             Decomposed units from decompose.mjs
 * @param {string[][]} opts.waves           Topological waves from topoWaves()
 * @param {{ edges: Map, reverseEdges: Map }} opts.graph  Graph adjacency
 * @param {Map}      opts.plans             WorktreePlan map from planWorktrees()
 *
 * INJECTED boundaries (SPAWN-04 / NFR-05):
 * @param {Function} opts.spawnFn           async (unitId, plan) => void
 * @param {Function} opts.readStatusFn      async (unitId) => "running"|"done"|"failed"|"dead"
 * @param {Function} opts.mergeFn           async (unitId, runId, plan) => { merged: bool, reason? }
 * @param {Function} opts.checkpointFn      async (checkpoint) => { go: boolean }
 *   The Conductor pauses here, surfaces the checkpoint summary to the user,
 *   and waits for explicit go/no-go. Returns { go: true|false }.
 *
 * Scheduler options (forwarded to runScheduler):
 * @param {number}   [opts.maxConcurrency=4]
 * @param {number}   [opts.pollIntervalMs=0]    Set to 0 in tests for speed
 * @param {number}   [opts.pollTimeoutMs=300000]
 *
 * @returns {Promise<{
 *   outcome: "done" | "aborted" | "blocked",
 *   runId:   string,
 *   merged:  string[],
 *   held:    string[],
 *   aborted: boolean,
 * }>}
 */
export async function runLifecycle({
  runPath,
  units,
  waves,
  graph,
  plans,
  spawnFn,
  readStatusFn,
  mergeFn,
  checkpointFn,
  maxConcurrency  = 4,
  pollIntervalMs  = 0,
  pollTimeoutMs   = 300_000,
}) {
  // Validate required injections (fail loud — NFR-06)
  if (typeof spawnFn !== "function") {
    throw new Error("runLifecycle: spawnFn must be injected (use a mock in tests)");
  }
  if (typeof readStatusFn !== "function") {
    throw new Error("runLifecycle: readStatusFn must be injected (use a mock in tests)");
  }
  if (typeof mergeFn !== "function") {
    throw new Error("runLifecycle: mergeFn must be injected (use a mock in tests)");
  }
  if (typeof checkpointFn !== "function") {
    throw new Error("runLifecycle: checkpointFn must be injected (use a mock in tests)");
  }

  const current = readRun(runPath);
  const runId = current.run_id;

  // Track overall merge results across all waves
  const mergedAll = [];
  const heldAll   = [];

  // -------------------------------------------------------------------------
  // 1. decomposed — record units + waves
  // -------------------------------------------------------------------------
  advanceState(runPath, "decomposed", {
    units: units.map((u) => u.id),
    wave_count: waves.length,
  });

  // Record units and waves into run.json for persistence/resumability
  {
    const run = readRun(runPath);
    writeRunAtomic(runPath, {
      ...run,
      units:      units.map((u) => u.id),
      waves:      waves.map((w, i) => ({ wave: i, units: w })),
    });
  }

  // -------------------------------------------------------------------------
  // 2. spawning — drive the scheduler wave-by-wave
  // -------------------------------------------------------------------------
  advanceState(runPath, "spawning", { wave_count: waves.length });

  // Import runScheduler dynamically so this file stays testable without
  // accidentally pulling in live dependencies.
  const { runScheduler } = await import(`file://${resolve(__dir, "scheduler.mjs")}`);

  // -------------------------------------------------------------------------
  // 3. executing / verifying — let the scheduler run each wave
  //
  // We run the scheduler across ALL waves, then do per-wave merge-boundary
  // checkpoints. The scheduler's mocked readStatusFn lets us drive unit
  // completions from tests without any real processes.
  // -------------------------------------------------------------------------
  advanceState(runPath, "executing", {});

  let schedulerResult;
  try {
    schedulerResult = await runScheduler({
      waves,
      graph,
      plans,
      spawnFn,
      readStatusFn,
      maxConcurrency,
      pollIntervalMs,
      pollTimeoutMs,
    });
  } catch (err) {
    // Scheduler threw unexpectedly — park as blocked (NFR-06)
    const run = readRun(runPath);
    writeRunAtomic(runPath, { ...run, error: err.message });
    abortRun(runPath, `scheduler_error: ${err.message}`);
    return {
      outcome: "aborted",
      runId,
      merged:  mergedAll,
      held:    heldAll,
      aborted: true,
    };
  }

  // Record scheduler result
  {
    const run = readRun(runPath);
    writeRunAtomic(runPath, { ...run, scheduler_result: schedulerResult });
  }

  advanceState(runPath, "verifying", { scheduler_done: schedulerResult.done.length });

  // -------------------------------------------------------------------------
  // 4. merging + checkpoint — per-wave merge-boundary checkpoint (RUN-03)
  // -------------------------------------------------------------------------
  advanceState(runPath, "merging", {});

  // Process each wave: merge done units, hold back failed/blocked ones,
  // then pause at the merge-boundary checkpoint.
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const waveUnits = waves[waveIdx];
    const waveMerged = [];
    const waveHeld   = [];

    for (const unitId of waveUnits) {
      const plan = plans?.get(unitId);

      // Only attempt merge for units that completed successfully
      if (schedulerResult.done.includes(unitId)) {
        const mergeResult = await mergeFn(unitId, runId, plan);
        if (mergeResult?.merged !== false) {
          waveMerged.push(unitId);
          mergedAll.push(unitId);
        } else {
          waveHeld.push(unitId);
          heldAll.push(unitId);
        }
      } else {
        // failed, dead, or blocked unit — hold back (NFR-06: no silent green)
        waveHeld.push(unitId);
        heldAll.push(unitId);
      }
    }

    // Collect any open blockers for the checkpoint summary
    const blockers = schedulerResult.failed.includes
      ? waveUnits
          .filter((u) => schedulerResult.failed.includes(u))
          .map((u) => ({ unit_id: u, reason: "failed" }))
      : [];

    // Halt at the merge-boundary checkpoint (RUN-03)
    const checkpoint = recordCheckpoint(runPath, {
      waveIndex: waveIdx,
      merged:    waveMerged,
      held:      waveHeld,
      blockers,
    });

    // Surface checkpoint to the Conductor / user (INJECTED)
    let checkpointResponse;
    try {
      checkpointResponse = await checkpointFn(checkpoint);
    } catch (err) {
      abortRun(runPath, `checkpoint_error: ${err.message}`);
      return {
        outcome: "aborted",
        runId,
        merged:  mergedAll,
        held:    heldAll,
        aborted: true,
      };
    }

    const go = checkpointResponse?.go !== false; // default to go=true

    // Resume from checkpoint (or abort if rejected)
    resumeFromCheckpoint(runPath, checkpoint.checkpoint_id, { go });

    if (!go) {
      abortRun(runPath, "checkpoint_rejected_by_user");
      return {
        outcome: "aborted",
        runId,
        merged:  mergedAll,
        held:    heldAll,
        aborted: true,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 5. done
  // -------------------------------------------------------------------------
  // Re-read to get the latest state (may be "merging" after final checkpoint resume)
  advanceState(runPath, "done", {
    merged_count: mergedAll.length,
    held_count:   heldAll.length,
  });

  return {
    outcome: "done",
    runId,
    merged:  mergedAll,
    held:    heldAll,
    aborted: false,
  };
}

// ---------------------------------------------------------------------------
// Rehearsal branch name helper (RUN-01, REHEARSE-01)
// ---------------------------------------------------------------------------

/**
 * Return the rehearsal branch name for a run.
 * Format: rehearsal/<run-id>
 * Never dev/develop/next (NFR-01).
 *
 * @param {string} runId
 * @returns {string}
 */
export function rehearsalBranch(runId) {
  return `rehearsal/${runId}`;
}

// ---------------------------------------------------------------------------
// Ledger entry (RUN-01)
// ---------------------------------------------------------------------------

/**
 * Append an entry to the global .bgsd/ledger.md index.
 * Each run gets one line: run-id, state, created_at, prompt excerpt.
 *
 * @param {string} bgsdDir   Absolute path to .bgsd
 * @param {object} run       The run state object
 */
export function appendLedgerEntry(bgsdDir, run) {
  const ledgerPath = join(bgsdDir, "ledger.md");
  const prompt = (run.prompt ?? "").slice(0, 60).replace(/\n/g, " ");
  const line =
    `| ${run.run_id} | ${run.state} | ${run.created_at} | ${prompt} |\n`;

  // Create ledger with header if it does not exist
  if (!existsSync(ledgerPath)) {
    writeFileSync(
      ledgerPath,
      "# bgsd Run Ledger\n\n" +
      "| Run ID | State | Created At | Prompt |\n" +
      "|--------|-------|------------|--------|\n",
      "utf8"
    );
  }

  // Append the new entry
  const existing = readFileSync(ledgerPath, "utf8");
  writeFileSync(ledgerPath, existing + line, "utf8");
}

// ---------------------------------------------------------------------------
// CLI entrypoint (dry-run only — live run is in run-live.mjs)
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
        const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    }
    return flags;
  }

  const flags = parseFlags(process.argv.slice(2));

  if (flags.live) {
    process.stderr.write(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: use run-live.mjs for the --live path.\n" +
      "  node bgsd/scripts/run-live.mjs --live --prompt \"...\"\n" +
      "======================================================================\n\n"
    );
    process.exit(1);
  }

  const prompt = flags.prompt ?? flags.p ?? "";
  if (!prompt) {
    process.stderr.write(
      "Usage: node bgsd/scripts/run.mjs --prompt \"<your prompt>\" [--dry-run]\n" +
      "       For the live run: node bgsd/scripts/run-live.mjs --live --prompt \"...\"\n"
    );
    process.exit(1);
  }

  const { runId, seq } = mintRunId(prompt);
  const bgsdDir = join(REPO_ROOT, ".bgsd");

  if (flags.dryRun || !flags.live) {
    process.stdout.write(
      `\n[bgsd --dry-run] /bgsd-run lifecycle\n` +
      `${"=".repeat(60)}\n\n` +
      `  Run ID:  ${runId}\n` +
      `  Seq:     ${seq}\n` +
      `  Prompt:  ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}\n\n` +
      `  Lifecycle would progress:\n` +
      `    created → decomposed → spawning → executing → verifying →\n` +
      `    merging → checkpoint → done\n\n` +
      `  Rehearsal branch: rehearsal/${runId}\n\n` +
      `  [dry-run] No worktrees, processes, or merges were created.\n` +
      `            Use run-live.mjs --live to run for real (human-gated).\n\n`
    );
    process.exit(0);
  }
}
