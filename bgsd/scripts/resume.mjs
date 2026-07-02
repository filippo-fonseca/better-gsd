#!/usr/bin/env node
/**
 * resume.mjs — pure core for /bgsd-resume (pick up an interrupted session).
 *
 * A bgsd session persists per-agent control files under
 * `.bgsd/runs/<run-id>/control/<agent-id>.json` (see control.mjs). If the
 * Claude Code instance driving a session is lost, those control files are the
 * durable record of where every unit stopped. This module is the PURE,
 * dependency-injected logic that, given the control files for each run, decides
 * which run is the most recent one still in flight and builds a compact resume
 * plan. The live seam (resume-live.mjs) supplies the real filesystem reads.
 *
 * A run is "resumable" when at least one of its agents is in a non-terminal
 * status (running / stalled / blocked / needs_input). A run whose every agent
 * is done or failed is finished, not resumable.
 *
 * PAUSED runs (PAUSE-01): a run explicitly paused via /bgsd-pause carries
 * `state: "paused"` and a `resume_state` on its run.json (see pause.mjs). Such a
 * run is ALWAYS resumable regardless of its control files — even if every agent
 * looks terminal (a pause taken between waves, or before fan-out, has no
 * in-flight control file). The live seam passes the run.json `state` +
 * `resume_state` + `paused_at` through so this module can surface the pause
 * snapshot and resume to the exact recorded state.
 */

// Terminal agent statuses (mirror control.mjs STATUSES). Everything else
// ("running", "stalled", "blocked", "needs_input") is in-flight and resumable.
export const TERMINAL_AGENT_STATUSES = Object.freeze(["done", "failed"]);

/**
 * Is a single agent control object in a terminal (finished) status?
 * @param {object} control
 * @returns {boolean}
 */
export function isTerminalAgent(control) {
  return TERMINAL_AGENT_STATUSES.includes(control?.status);
}

/**
 * Summarize one run from its control files (and, optionally, its run.json).
 *
 * @param {object} run
 * @param {string} run.runId        The run id (the .bgsd/runs/<run-id> dir name).
 * @param {object[]} [run.controls] The parsed control-file objects for the run.
 * @param {number} [run.mtime]      Sort key — most recent activity (ms epoch).
 *                                   The live seam derives it from the newest
 *                                   `updated_at`/`heartbeat_at` across controls.
 * @param {string} [run.runState]   run.json `state` (e.g. "paused"). When
 *                                   "paused", the run is resumable regardless of
 *                                   its control files.
 * @param {string} [run.resumeState] run.json `resume_state` — the exact state a
 *                                   paused run returns to on resume.
 * @param {string} [run.pausedAt]   run.json `paused_at` (ISO), when paused.
 * @param {string} [run.pauseReason] run.json `pause_reason`, when paused.
 * @returns {{
 *   run_id: string, mtime: number, resumable: boolean,
 *   total: number, pending: number,
 *   paused: boolean, resume_state: string|null,
 *   paused_at: string|null, pause_reason: string|null,
 *   agents: { agent_id: string, unit_id: string|null, status: string,
 *             phase: string|null, heartbeat_at: string|null }[]
 * }}
 */
export function summarizeRun({
  runId,
  controls = [],
  mtime = 0,
  runState = null,
  resumeState = null,
  pausedAt = null,
  pauseReason = null,
}) {
  const agents = controls.map((c) => ({
    agent_id: c.agent_id ?? "unknown",
    unit_id: c.unit_id ?? null,
    status: c.status ?? "unknown",
    phase: c.phase ?? null,
    heartbeat_at: c.heartbeat_at ?? null,
  }));
  const pending = agents.filter((a) => !TERMINAL_AGENT_STATUSES.includes(a.status));
  const paused = runState === "paused";
  return {
    run_id: runId,
    mtime,
    // A paused run is always resumable; otherwise it needs an in-flight agent.
    resumable: paused || pending.length > 0,
    total: agents.length,
    pending: pending.length,
    paused,
    resume_state: paused ? resumeState ?? null : null,
    paused_at: paused ? pausedAt ?? null : null,
    pause_reason: paused ? pauseReason ?? null : null,
    agents,
  };
}

/**
 * Given a list of runs (raw `{ runId, controls, mtime }` or already-summarized
 * objects), return the most-recently-active run that is still resumable, or
 * null if none is. Terminal runs are skipped.
 *
 * @param {object[]} runs
 * @returns {object|null} the summary of the latest resumable run
 */
export function pickLatestResumable(runs) {
  const summaries = (runs ?? []).map((r) =>
    Array.isArray(r.agents) ? r : summarizeRun(r)
  );
  const resumable = summaries.filter((s) => s.resumable);
  if (resumable.length === 0) return null;
  resumable.sort((a, b) => b.mtime - a.mtime);
  return resumable[0];
}

/**
 * Find a specific run by id among a list of runs, summarized. Returns null if
 * the id is not present.
 *
 * @param {object[]} runs
 * @param {string} runId
 * @returns {object|null}
 */
export function findRun(runs, runId) {
  const summaries = (runs ?? []).map((r) =>
    Array.isArray(r.agents) ? r : summarizeRun(r)
  );
  return summaries.find((s) => s.run_id === runId) ?? null;
}

/**
 * Validate a Conductor compaction handoff (the structured note the Conductor
 * writes to `.bgsd/runs/<run-id>/compact-handoff.json` right before running
 * /compact, so the post-compaction session rehydrates from a schema'd record
 * instead of a free-form RUN.md note).
 *
 * Required shape:
 *   { stage: string, wave: integer >= 0,
 *     agent_states: { id, phase, status }[],
 *     pending_gates: string[],
 *     next_step: string, written_at: ISO string }
 *
 * Collects every problem instead of stopping at the first, so the writer gets
 * one readable report. Never throws.
 *
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCompactHandoff(obj) {
  const errors = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["handoff must be a plain object"] };
  }
  const nonEmptyString = (field) => {
    if (typeof obj[field] !== "string" || obj[field].trim() === "") {
      errors.push(`"${field}" must be a non-empty string`);
      return false;
    }
    return true;
  };
  nonEmptyString("stage");
  nonEmptyString("next_step");
  if (
    typeof obj.wave !== "number" ||
    !Number.isInteger(obj.wave) ||
    obj.wave < 0
  ) {
    errors.push(`"wave" must be a non-negative integer`);
  }
  if (!Array.isArray(obj.agent_states)) {
    errors.push(`"agent_states" must be an array of { id, phase, status }`);
  } else {
    obj.agent_states.forEach((a, i) => {
      if (a === null || typeof a !== "object" || Array.isArray(a)) {
        errors.push(`"agent_states[${i}]" must be a plain object`);
        return;
      }
      for (const field of ["id", "phase", "status"]) {
        if (typeof a[field] !== "string" || a[field].trim() === "") {
          errors.push(`"agent_states[${i}].${field}" must be a non-empty string`);
        }
      }
    });
  }
  if (!Array.isArray(obj.pending_gates)) {
    errors.push(`"pending_gates" must be an array of strings`);
  } else {
    obj.pending_gates.forEach((g, i) => {
      if (typeof g !== "string") {
        errors.push(`"pending_gates[${i}]" must be a string`);
      }
    });
  }
  if (typeof obj.written_at !== "string" || Number.isNaN(Date.parse(obj.written_at))) {
    errors.push(`"written_at" must be an ISO date string`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Human-readable lines for a validated compaction handoff: stage/wave header,
 * one line per agent, pending gates, and the recorded next step.
 *
 * @param {object} handoff  A handoff that passed validateCompactHandoff.
 * @returns {string[]}
 */
export function buildHandoffLines(handoff) {
  const lines = [
    `Compaction handoff on record (written ${handoff.written_at}) — picking up mid-flight state:`,
    `  Stage: ${handoff.stage} · wave ${handoff.wave}`,
  ];
  if (handoff.agent_states.length === 0) {
    lines.push(`  Agents: none in flight at handoff time`);
  }
  for (const a of handoff.agent_states) {
    lines.push(`  · ${a.id}  [${a.status}] @ ${a.phase}`);
  }
  lines.push(
    handoff.pending_gates.length > 0
      ? `  Pending gates: ${handoff.pending_gates.join(", ")}`
      : `  Pending gates: none`
  );
  lines.push(`  Next step: ${handoff.next_step}`);
  return lines;
}

/**
 * The full resume brief: the standard resume summary, with a compaction
 * handoff (when one is present) surfaced FIRST — the handoff is the freshest,
 * most specific record of where the Conductor stood, so it leads the brief
 * and the control-file summary follows as corroboration.
 *
 * @param {object|null} run       A summary from summarizeRun/pickLatestResumable.
 * @param {object|null} [handoff] A validated compaction handoff, or null.
 * @returns {{ run_id: string|null, pending: number, paused: boolean,
 *             resume_state: string|null, handoff: object|null, lines: string[] }}
 */
export function buildResumeBrief(run, handoff = null) {
  const base = buildResumeSummary(run);
  if (!handoff) return { ...base, handoff: null };
  return { ...base, handoff, lines: [...buildHandoffLines(handoff), ...base.lines] };
}

/**
 * Build a compact, human-readable resume plan from a run summary. Lists each
 * unit with a glyph (✓ terminal, … in-flight) and ends with the next step.
 *
 * For a PAUSED run (PAUSE-01) the header calls out the pause and the exact
 * `resume_state` the run returns to, and the next-step line points at restoring
 * that state (see PAUSE.md for the full snapshot).
 *
 * @param {object|null} run  A summary from summarizeRun/pickLatestResumable.
 * @returns {{ run_id: string|null, pending: number, paused: boolean,
 *             resume_state: string|null, lines: string[] }}
 */
export function buildResumeSummary(run) {
  if (!run) {
    return {
      run_id: null,
      pending: 0,
      paused: false,
      resume_state: null,
      lines: ["No resumable session found — every recorded run is finished."],
    };
  }
  const lines = [];
  if (run.paused) {
    lines.push(
      `Resuming PAUSED run ${run.run_id} — restoring to state "${run.resume_state ?? "?"}"` +
      `${run.paused_at ? ` (paused ${run.paused_at})` : ""}:`
    );
  } else {
    lines.push(
      `Resuming run ${run.run_id} — ${run.pending}/${run.total} unit(s) still in flight:`
    );
  }
  for (const a of run.agents) {
    const mark = TERMINAL_AGENT_STATUSES.includes(a.status) ? "✓" : "…";
    const label = a.unit_id && a.unit_id !== a.agent_id ? `${a.agent_id} (${a.unit_id})` : a.agent_id;
    lines.push(`  ${mark} ${label}  [${a.status}]${a.phase ? ` @ ${a.phase}` : ""}`);
  }
  if (run.paused) {
    lines.push(
      `Next: restore the run to "${run.resume_state ?? "its recorded state"}" (clear the ` +
      `paused marker) and continue from that exact stage — see PAUSE.md for the full snapshot.`
    );
  } else {
    lines.push(
      `Next: re-enter Loop 1 for the in-flight unit(s) from their last recorded phase.`
    );
  }
  return {
    run_id: run.run_id,
    pending: run.pending,
    paused: !!run.paused,
    resume_state: run.paused ? run.resume_state ?? null : null,
    lines,
  };
}
