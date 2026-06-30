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
 * Summarize one run from its control files.
 *
 * @param {object} run
 * @param {string} run.runId        The run id (the .bgsd/runs/<run-id> dir name).
 * @param {object[]} [run.controls] The parsed control-file objects for the run.
 * @param {number} [run.mtime]      Sort key — most recent activity (ms epoch).
 *                                   The live seam derives it from the newest
 *                                   `updated_at`/`heartbeat_at` across controls.
 * @returns {{
 *   run_id: string, mtime: number, resumable: boolean,
 *   total: number, pending: number,
 *   agents: { agent_id: string, unit_id: string|null, status: string,
 *             phase: string|null, heartbeat_at: string|null }[]
 * }}
 */
export function summarizeRun({ runId, controls = [], mtime = 0 }) {
  const agents = controls.map((c) => ({
    agent_id: c.agent_id ?? "unknown",
    unit_id: c.unit_id ?? null,
    status: c.status ?? "unknown",
    phase: c.phase ?? null,
    heartbeat_at: c.heartbeat_at ?? null,
  }));
  const pending = agents.filter((a) => !TERMINAL_AGENT_STATUSES.includes(a.status));
  return {
    run_id: runId,
    mtime,
    resumable: pending.length > 0,
    total: agents.length,
    pending: pending.length,
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
 * Build a compact, human-readable resume plan from a run summary. Lists each
 * unit with a glyph (✓ terminal, … in-flight) and ends with the next step.
 *
 * @param {object|null} run  A summary from summarizeRun/pickLatestResumable.
 * @returns {{ run_id: string|null, pending: number, lines: string[] }}
 */
export function buildResumeSummary(run) {
  if (!run) {
    return {
      run_id: null,
      pending: 0,
      lines: ["No resumable session found — every recorded run is finished."],
    };
  }
  const lines = [];
  lines.push(
    `Resuming run ${run.run_id} — ${run.pending}/${run.total} unit(s) still in flight:`
  );
  for (const a of run.agents) {
    const mark = TERMINAL_AGENT_STATUSES.includes(a.status) ? "✓" : "…";
    const label = a.unit_id && a.unit_id !== a.agent_id ? `${a.agent_id} (${a.unit_id})` : a.agent_id;
    lines.push(`  ${mark} ${label}  [${a.status}]${a.phase ? ` @ ${a.phase}` : ""}`);
  }
  lines.push(
    `Next: re-enter Loop 1 for the in-flight unit(s) from their last recorded phase.`
  );
  return { run_id: run.run_id, pending: run.pending, lines };
}
