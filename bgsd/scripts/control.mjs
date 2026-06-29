#!/usr/bin/env node
/**
 * control.mjs — Phase 2: Control-File Protocol + Heartbeat/Restart (CTRL-01..04)
 *
 * Implements the <agent-id>.json coordination contract for the Kiwi Conductor.
 * Each worker agent owns one control file under:
 *   .bgsd/runs/<run-id>/control/<agent-id>.json
 *
 * SCHEMA (CTRL-01)
 * ================
 * {
 *   agent_id:      string   — stable id, e.g. "agent-abc123"
 *   run_id:        string   — parent run, e.g. "bgsd-0001-my-feature"
 *   worktree:      string   — absolute path to the agent's worktree
 *   branch:        string   — git branch for this agent's work
 *   unit_id:       string   — id of the graph unit this agent is executing
 *   phase:         enum     — "discuss"|"ui"|"plan"|"execute"|"verify"|"fixing"|"done"|"blocked"|"failed"
 *   status:        enum     — "running"|"stalled"|"blocked"|"needs_input"|"done"|"failed"
 *   heartbeat_at:  string   — ISO timestamp, updated each poll cycle
 *   started_at:    string   — ISO timestamp of first write
 *   updated_at:    string   — ISO timestamp of last write
 *   progress:      object   — { iteration: number, max_iterations: number, note: string }
 *   commits:       string[] — list of commit SHAs this agent has made
 *   assumptions:   Assumption[]
 *   blockers:      Blocker[]
 *   escalations:   Escalation[]
 *   restart_count: number   — how many times this agent has been restarted
 *   inbox_path:    string|null — path to <agent-id>.inbox.md when the Conductor answered a blocker
 * }
 *
 * HEARTBEAT STATE MACHINE (CTRL-02)
 * ==================================
 * Given an injected now() clock and a staleness threshold, each agent is
 * classified as:
 *   alive  — heartbeat_at within the threshold
 *   stale  — heartbeat_at older than staleMs but within deadMs
 *   dead   — heartbeat_at older than deadMs (or never set)
 *
 * RESTART DECISION MACHINE (CTRL-02)
 * ====================================
 * dead → eligible_for_restart (if restart_count < maxRestarts)
 *      → give_up (if restart_count >= maxRestarts, escalate to user)
 * The actual restart is dependency-injected (restartFn) so this module is
 * testable with mocked spawns. No real process is launched here.
 *
 * ASSUMPTION / BLOCKER / ESCALATION PROTOCOL (CTRL-03, CTRL-04)
 * ==============================================================
 * Workers call:
 *   recordAssumption(controlPath, { description, basis? })
 *   raiseBlocker(controlPath, { question, severity, context? })
 *   addEscalation(controlPath, { question, severity, context? })
 *
 * Conductor reads across all agents in a run:
 *   aggregateOpenBlockers(runControlDir)  — returns all open blockers
 *   aggregateEscalations(runControlDir)   — returns all unresolved escalations
 *
 * DESIGN PRINCIPLES
 * =================
 * - All writes are atomic (write temp + rename) — no half-written control files.
 * - Schema validation rejects malformed control files (NFR-06: no silent green).
 * - No model calls, no process spawning — pure deterministic logic (NFR-05).
 * - Restart action is dependency-injected for unit-testability under mocked spawns.
 *
 * Usage (library):
 *   import {
 *     createControlFile, readControlFile, updateControlFile,
 *     recordAssumption, raiseBlocker, addEscalation,
 *     aggregateOpenBlockers, aggregateEscalations,
 *     classifyHeartbeat, computeRestartDecision
 *   } from './control.mjs';
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid phase values for an agent control file. */
export const PHASES = Object.freeze([
  "discuss",
  "ui",
  "plan",
  "execute",
  "verify",
  "fixing",
  "done",
  "blocked",
  "failed",
]);

/** Valid status values for an agent control file. */
export const STATUSES = Object.freeze([
  "running",
  "stalled",
  "blocked",
  "needs_input",
  "done",
  "failed",
]);

/** Heartbeat vitality classifications. */
export const HEARTBEAT_STATES = Object.freeze(["alive", "stale", "dead"]);

/** Restart decision outcomes. */
export const RESTART_DECISIONS = Object.freeze([
  "eligible_for_restart",
  "give_up",
  "alive",    // no restart needed
  "stale",    // not dead yet; watch
]);

// Default staleness thresholds (ms)
export const DEFAULT_STALE_MS = 2 * 60 * 1000;  // 2 minutes
export const DEFAULT_DEAD_MS  = 5 * 60 * 1000;  // 5 minutes
export const DEFAULT_MAX_RESTARTS = 3;

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate a control-file object against the expected schema.
 * Throws a descriptive Error if any required field is missing or has a bad type.
 * NFR-06: a corrupt or malformed control file is surfaced, never silently ignored.
 *
 * @param {unknown} obj
 * @returns {void}  throws on validation failure
 */
export function validateControlFile(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("control file must be a plain object");
  }

  const required = {
    agent_id:     "string",
    run_id:       "string",
    worktree:     "string",
    branch:       "string",
    unit_id:      "string",
    phase:        "string",
    status:       "string",
    heartbeat_at: "string",
    started_at:   "string",
    updated_at:   "string",
  };

  for (const [field, type] of Object.entries(required)) {
    if (!(field in obj)) {
      throw new Error(`control file missing required field: "${field}"`);
    }
    if (typeof obj[field] !== type) {
      throw new Error(
        `control file field "${field}" must be ${type}, got ${typeof obj[field]}`
      );
    }
  }

  if (!PHASES.includes(obj.phase)) {
    throw new Error(
      `control file field "phase" must be one of [${PHASES.join(", ")}], got "${obj.phase}"`
    );
  }

  if (!STATUSES.includes(obj.status)) {
    throw new Error(
      `control file field "status" must be one of [${STATUSES.join(", ")}], got "${obj.status}"`
    );
  }

  // Arrays
  for (const arr of ["commits", "assumptions", "blockers", "escalations"]) {
    if (arr in obj && !Array.isArray(obj[arr])) {
      throw new Error(`control file field "${arr}" must be an array`);
    }
  }

  // restart_count must be a non-negative integer when present
  if ("restart_count" in obj) {
    if (typeof obj.restart_count !== "number" || !Number.isInteger(obj.restart_count) || obj.restart_count < 0) {
      throw new Error(`control file field "restart_count" must be a non-negative integer`);
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic I/O helpers
// ---------------------------------------------------------------------------

/**
 * Write a control file atomically: serialize to a temp file, then rename.
 * Rename is atomic on POSIX; the file is never half-written.
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {object} data         The control-file object to write
 */
function writeAtomic(controlPath, data) {
  const tmpPath = controlPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmpPath, controlPath);
}

/**
 * Read and parse a control file from disk.
 * Validates the schema before returning.
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @returns {object}  The validated control-file object
 * @throws {Error} if the file does not exist, is not valid JSON, or fails schema validation
 */
export function readControlFile(controlPath) {
  if (!existsSync(controlPath)) {
    throw new Error(`control file not found: ${controlPath}`);
  }
  let raw;
  try {
    raw = readFileSync(controlPath, "utf8");
  } catch (err) {
    throw new Error(`control file read error at ${controlPath}: ${err.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`control file is not valid JSON at ${controlPath}: ${err.message}`);
  }
  // Schema validation — throws if malformed (NFR-06: no silent green)
  validateControlFile(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

/**
 * Create a new control file for an agent.
 * Ensures the parent directory exists, then writes atomically.
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {object} fields       Required: { agent_id, run_id, worktree, branch, unit_id }
 *                              Optional: { phase, status, progress, commits }
 * @returns {object}  The created control-file object
 */
export function createControlFile(controlPath, fields) {
  const {
    agent_id,
    run_id,
    worktree,
    branch,
    unit_id,
    phase       = "discuss",
    status      = "running",
    progress    = { iteration: 0, max_iterations: 5, note: "" },
    commits     = [],
  } = fields;

  const now = new Date().toISOString();

  const data = {
    agent_id,
    run_id,
    worktree,
    branch,
    unit_id,
    phase,
    status,
    heartbeat_at:  now,
    started_at:    now,
    updated_at:    now,
    progress,
    commits,
    assumptions:   [],
    blockers:      [],
    escalations:   [],
    restart_count: 0,
    inbox_path:    null,
  };

  // Validate before writing
  validateControlFile(data);

  // Ensure parent directory exists
  const dir = dirname(controlPath);
  mkdirSync(dir, { recursive: true });

  writeAtomic(controlPath, data);
  return data;
}

/**
 * Update fields on an existing control file.
 * Reads the current file, merges the provided fields, updates `updated_at`,
 * and writes atomically.
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {object} updates      Partial fields to merge (shallow)
 * @returns {object}  The updated control-file object
 */
export function updateControlFile(controlPath, updates) {
  const current = readControlFile(controlPath);
  const now = new Date().toISOString();

  // Deep-merge arrays if caller provides them (append, not replace)
  // For assumptions, blockers, escalations: the caller uses the specific
  // helper functions below. updateControlFile does a shallow merge.
  const merged = {
    ...current,
    ...updates,
    updated_at: now,
  };

  // Re-validate after merge
  validateControlFile(merged);

  writeAtomic(controlPath, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Heartbeat helpers
// ---------------------------------------------------------------------------

/**
 * Update the heartbeat_at field of a control file to the current time.
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {Function} [nowFn=Date.now]  Injectable clock (returns ms timestamp)
 * @returns {object}  The updated control-file object
 */
export function touchHeartbeat(controlPath, nowFn = Date.now) {
  const current = readControlFile(controlPath);
  const now = new Date(nowFn()).toISOString();
  const merged = {
    ...current,
    heartbeat_at: now,
    updated_at:   now,
  };
  validateControlFile(merged);
  writeAtomic(controlPath, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Assumption / blocker / escalation — worker-side helpers (CTRL-03)
// ---------------------------------------------------------------------------

/**
 * Record an assumption the worker is making and continuing under.
 * Workers prefer documented assumptions over stopping (CTRL-03).
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {object} assumption   { description: string, basis?: string }
 * @returns {object}  The updated control-file object
 */
export function recordAssumption(controlPath, assumption) {
  if (!assumption || typeof assumption.description !== "string" || !assumption.description.trim()) {
    throw new Error("recordAssumption: assumption.description is required");
  }
  const current = readControlFile(controlPath);
  const now = new Date().toISOString();
  const entry = {
    id:          `assumption-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    description: assumption.description.trim(),
    basis:       typeof assumption.basis === "string" ? assumption.basis.trim() : null,
    recorded_at: now,
  };
  const merged = {
    ...current,
    assumptions: [...(current.assumptions ?? []), entry],
    updated_at:  now,
  };
  validateControlFile(merged);
  writeAtomic(controlPath, merged);
  return merged;
}

/**
 * Raise a hard blocker: the worker cannot continue without input.
 * Sets status to "blocked" and appends to the blockers array.
 * A hard blocker is a clean exit — the worker writes this and stops (CTRL-03).
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {object} blocker      { question: string, severity: "low"|"medium"|"high", context?: string }
 * @returns {object}  The updated control-file object
 */
export function raiseBlocker(controlPath, blocker) {
  if (!blocker || typeof blocker.question !== "string" || !blocker.question.trim()) {
    throw new Error("raiseBlocker: blocker.question is required");
  }
  const validSeverities = ["low", "medium", "high"];
  if (!validSeverities.includes(blocker.severity)) {
    throw new Error(`raiseBlocker: blocker.severity must be one of [${validSeverities.join(", ")}]`);
  }
  const current = readControlFile(controlPath);
  const now = new Date().toISOString();
  const entry = {
    id:          `blocker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    question:    blocker.question.trim(),
    severity:    blocker.severity,
    context:     typeof blocker.context === "string" ? blocker.context.trim() : null,
    raised_at:   now,
    resolved:    false,
    answer:      null,
    answered_at: null,
  };
  const merged = {
    ...current,
    blockers:   [...(current.blockers ?? []), entry],
    status:     "blocked",
    phase:      "blocked",
    updated_at: now,
  };
  validateControlFile(merged);
  writeAtomic(controlPath, merged);
  return merged;
}

/**
 * Resolve a blocker: the Conductor writes the answer and marks the blocker resolved.
 * Also sets inbox_path so the re-launched agent knows where to look.
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {string} blockerId    The id of the blocker to resolve
 * @param {object} resolution   { answer: string, inboxPath: string }
 * @returns {object}  The updated control-file object
 */
export function resolveBlocker(controlPath, blockerId, resolution) {
  if (typeof resolution.answer !== "string" || !resolution.answer.trim()) {
    throw new Error("resolveBlocker: resolution.answer is required");
  }
  const current = readControlFile(controlPath);
  const now = new Date().toISOString();

  const blockers = (current.blockers ?? []).map((b) => {
    if (b.id !== blockerId) return b;
    return {
      ...b,
      resolved:    true,
      answer:      resolution.answer.trim(),
      answered_at: now,
    };
  });

  const allResolved = blockers.every((b) => b.resolved);

  const merged = {
    ...current,
    blockers,
    inbox_path:  resolution.inboxPath ?? current.inbox_path ?? null,
    status:      allResolved ? "running" : "blocked",
    phase:       allResolved ? "discuss" : "blocked",
    updated_at:  now,
  };
  validateControlFile(merged);
  writeAtomic(controlPath, merged);
  return merged;
}

/**
 * Add an escalation: an unanswerable, high-severity blocker that must reach the user.
 * The worker parks in "needs_input" (CTRL-04).
 *
 * @param {string} controlPath  Absolute path to <agent-id>.json
 * @param {object} escalation   { question: string, severity: "high", context?: string }
 * @returns {object}  The updated control-file object
 */
export function addEscalation(controlPath, escalation) {
  if (!escalation || typeof escalation.question !== "string" || !escalation.question.trim()) {
    throw new Error("addEscalation: escalation.question is required");
  }
  const current = readControlFile(controlPath);
  const now = new Date().toISOString();
  const entry = {
    id:          `escalation-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    question:    escalation.question.trim(),
    severity:    escalation.severity ?? "high",
    context:     typeof escalation.context === "string" ? escalation.context.trim() : null,
    raised_at:   now,
    resolved:    false,
    user_answer: null,
  };
  const merged = {
    ...current,
    escalations: [...(current.escalations ?? []), entry],
    status:      "needs_input",
    updated_at:  now,
  };
  validateControlFile(merged);
  writeAtomic(controlPath, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Conductor-side aggregators (CTRL-03, CTRL-04)
// ---------------------------------------------------------------------------

/**
 * Read all control files in a run's control directory.
 * Skips files that fail schema validation and returns their errors separately
 * so the Conductor can surface malformed files (NFR-06).
 *
 * @param {string} runControlDir  Absolute path to .bgsd/runs/<run-id>/control/
 * @returns {{ files: object[], errors: Array<{path: string, error: string}> }}
 */
export function readAllControlFiles(runControlDir) {
  if (!existsSync(runControlDir)) {
    return { files: [], errors: [] };
  }
  const entries = readdirSync(runControlDir).filter((f) => f.endsWith(".json"));
  const files = [];
  const errors = [];
  for (const entry of entries) {
    const p = join(runControlDir, entry);
    try {
      files.push(readControlFile(p));
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  return { files, errors };
}

/**
 * Aggregate all open (unresolved) blockers across all agents in a run.
 * Used by the Conductor to know where input is needed.
 *
 * @param {string} runControlDir  Absolute path to .bgsd/runs/<run-id>/control/
 * @returns {Array<{ agent_id: string, blocker: object }>}
 */
export function aggregateOpenBlockers(runControlDir) {
  const { files } = readAllControlFiles(runControlDir);
  const result = [];
  for (const cf of files) {
    for (const b of cf.blockers ?? []) {
      if (!b.resolved) {
        result.push({ agent_id: cf.agent_id, blocker: b });
      }
    }
  }
  return result;
}

/**
 * Aggregate all unresolved escalations across all agents in a run.
 * These are the items that must be surfaced to the user (CTRL-04).
 *
 * @param {string} runControlDir  Absolute path to .bgsd/runs/<run-id>/control/
 * @returns {Array<{ agent_id: string, escalation: object }>}
 */
export function aggregateEscalations(runControlDir) {
  const { files } = readAllControlFiles(runControlDir);
  const result = [];
  for (const cf of files) {
    for (const e of cf.escalations ?? []) {
      if (!e.resolved) {
        result.push({ agent_id: cf.agent_id, escalation: e });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Heartbeat classification — pure function, injected clock (CTRL-02)
// ---------------------------------------------------------------------------

/**
 * Classify an agent's heartbeat vitality.
 *
 * @param {object} opts
 * @param {string}   opts.heartbeat_at  ISO timestamp of the agent's last heartbeat
 * @param {Function} opts.nowFn         Injected clock: () => number (ms since epoch)
 * @param {number}   [opts.staleMs=DEFAULT_STALE_MS]  Threshold for "stale" (default 2 min)
 * @param {number}   [opts.deadMs=DEFAULT_DEAD_MS]    Threshold for "dead" (default 5 min)
 * @returns {"alive" | "stale" | "dead"}
 */
export function classifyHeartbeat({ heartbeat_at, nowFn, staleMs = DEFAULT_STALE_MS, deadMs = DEFAULT_DEAD_MS }) {
  if (!heartbeat_at) return "dead";
  const nowMs = nowFn();
  const heartbeatMs = new Date(heartbeat_at).getTime();
  if (isNaN(heartbeatMs)) return "dead";
  const ageMs = nowMs - heartbeatMs;
  if (ageMs < staleMs)  return "alive";
  if (ageMs < deadMs)   return "stale";
  return "dead";
}

// ---------------------------------------------------------------------------
// Restart decision state machine — CTRL-02
// ---------------------------------------------------------------------------

/**
 * Compute a restart decision for a single agent.
 *
 * State machine:
 *   alive  -> "alive"   (no restart needed)
 *   stale  -> "stale"   (watch; not yet dead)
 *   dead   + restart_count < maxRestarts  -> "eligible_for_restart"
 *   dead   + restart_count >= maxRestarts -> "give_up"   (escalate to user)
 *
 * The actual restart is performed by the injected restartFn when the caller
 * decides to act on "eligible_for_restart". This function only returns the
 * decision — it never spawns a process (NFR-05; mirrors loop1.mjs DI pattern).
 *
 * @param {object} opts
 * @param {string}   opts.heartbeat_at   ISO timestamp of the agent's last heartbeat
 * @param {number}   opts.restart_count  How many restarts have already occurred
 * @param {Function} opts.nowFn          Injected clock: () => number (ms)
 * @param {number}   [opts.staleMs]      Staleness threshold (ms)
 * @param {number}   [opts.deadMs]       Death threshold (ms)
 * @param {number}   [opts.maxRestarts=DEFAULT_MAX_RESTARTS]  Bounded restart cap
 * @returns {{ decision: "alive"|"stale"|"eligible_for_restart"|"give_up", vitality: "alive"|"stale"|"dead" }}
 */
export function computeRestartDecision({
  heartbeat_at,
  restart_count,
  nowFn,
  staleMs     = DEFAULT_STALE_MS,
  deadMs      = DEFAULT_DEAD_MS,
  maxRestarts = DEFAULT_MAX_RESTARTS,
}) {
  const vitality = classifyHeartbeat({ heartbeat_at, nowFn, staleMs, deadMs });

  if (vitality === "alive") {
    return { decision: "alive", vitality };
  }
  if (vitality === "stale") {
    return { decision: "stale", vitality };
  }
  // dead
  if (restart_count < maxRestarts) {
    return { decision: "eligible_for_restart", vitality };
  }
  return { decision: "give_up", vitality };
}

/**
 * Run a single tick of the Conductor's heartbeat monitor across all agents in a run.
 * For each agent in a "dead" state that has not exceeded the restart budget,
 * calls the injected restartFn (which in tests is a mock; in live runs spawns
 * the real process). Returns a summary of decisions taken.
 *
 * @param {object} opts
 * @param {string}   opts.runControlDir    Absolute path to .bgsd/runs/<run-id>/control/
 * @param {Function} opts.nowFn            Injected clock: () => number (ms)
 * @param {Function} opts.restartFn        async (agentId, controlPath) => void  — INJECTED
 *                                         In tests: a mock (no process spawn).
 *                                         In live: spawns headless claude -p on the worktree.
 * @param {number}   [opts.staleMs]        Staleness threshold
 * @param {number}   [opts.deadMs]         Death threshold
 * @param {number}   [opts.maxRestarts]    Bounded restart cap
 * @returns {Promise<Array<{
 *   agent_id: string,
 *   vitality: string,
 *   decision: string,
 *   restarted: boolean
 * }>>}
 */
export async function runHeartbeatTick({
  runControlDir,
  nowFn,
  restartFn,
  staleMs     = DEFAULT_STALE_MS,
  deadMs      = DEFAULT_DEAD_MS,
  maxRestarts = DEFAULT_MAX_RESTARTS,
}) {
  const { files, errors } = readAllControlFiles(runControlDir);

  // Surface malformed files to caller as structured errors (NFR-06)
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`[control] malformed control file at ${e.path}: ${e.error}\n`);
    }
  }

  const summary = [];

  for (const cf of files) {
    // Skip agents that are already in terminal states (done/failed)
    if (cf.status === "done" || cf.status === "failed") {
      summary.push({ agent_id: cf.agent_id, vitality: "N/A", decision: "terminal", restarted: false });
      continue;
    }

    const controlPath = join(runControlDir, `${cf.agent_id}.json`);
    const { decision, vitality } = computeRestartDecision({
      heartbeat_at: cf.heartbeat_at,
      restart_count: cf.restart_count ?? 0,
      nowFn,
      staleMs,
      deadMs,
      maxRestarts,
    });

    let restarted = false;

    if (decision === "eligible_for_restart") {
      // Increment restart_count before calling restartFn so the control file
      // reflects the in-flight restart (survives interruption).
      updateControlFile(controlPath, {
        restart_count: (cf.restart_count ?? 0) + 1,
        status: "running",
      });
      // Dependency-injected restart: never spawns a process in this module.
      await restartFn(cf.agent_id, controlPath);
      restarted = true;
    } else if (decision === "give_up") {
      // Park the agent in needs_input so the Conductor can surface to user (CTRL-04)
      updateControlFile(controlPath, {
        status: "needs_input",
      });
    }

    summary.push({ agent_id: cf.agent_id, vitality, decision, restarted });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI (minimal — mainly for smoke-testing)
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));

if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  process.stdout.write("control.mjs — Phase 2 control-file protocol (library module)\n");
  process.stdout.write("Import and use its exported functions from the Conductor or tests.\n");
  process.exit(0);
}
