#!/usr/bin/env node
/**
 * gui.mjs — pure model for the /bgsd-gui live dashboard.
 *
 * Turns a run's per-agent control files (see control.mjs) into a view model the
 * dashboard renders: every agent placed in a pipeline lane (Loop 1 pipeline
 * agents, verification, Loop 2 integration, review gate), tagged with its GSD
 * substage (discuss → ui → plan → execute → verify → done), status, and
 * progress. Pure and dependency-injected: the live seam (gui-live.mjs) supplies
 * the real control-file reads and serves this model over HTTP.
 */

/** The dashboard lanes, left to right. Each agent lands in exactly one. */
export const LANES = Object.freeze([
  { id: "loop1", title: "Loop 1 · Pipeline Agents" },
  { id: "verify", title: "Verification" },
  { id: "loop2", title: "Loop 2 · Integration" },
  { id: "review", title: "Review Gate" },
]);

/** The linear GSD substage flow, used for the per-agent progress indicator. */
export const GSD_FLOW = Object.freeze(["discuss", "ui", "plan", "execute", "verify", "done"]);

const SUBSTAGE_LABELS = Object.freeze({
  discuss: "Discuss",
  ui: "UI design",
  plan: "Plan",
  execute: "Execute",
  verify: "Verify",
  fixing: "Fix → re-verify",
  done: "Done",
  blocked: "Blocked",
  failed: "Failed",
});

/**
 * Infer an agent's role from its id / unit id. Control files do not carry an
 * explicit role, so we read it from naming conventions: verifier/tester,
 * integrator (Loop 2 / rehearsal), reviewer, else a plain pipeline agent.
 *
 * @param {object} agent  a control-file object
 * @returns {"verifier"|"integrator"|"reviewer"|"pipeline"}
 */
export function classifyAgentRole(agent) {
  const s = `${agent?.agent_id ?? ""} ${agent?.unit_id ?? ""}`.toLowerCase();
  if (/verif|tester|\btest\b/.test(s)) return "verifier";
  if (/integrat|loop2|rehears/.test(s)) return "integrator";
  if (/review|gate/.test(s)) return "reviewer";
  return "pipeline";
}

/** Which lane an agent belongs to, from its role. */
export function laneForAgent(agent) {
  switch (classifyAgentRole(agent)) {
    case "verifier": return "verify";
    case "integrator": return "loop2";
    case "reviewer": return "review";
    default: return "loop1";
  }
}

/** Friendly label for a GSD substage (phase). */
export function gsdSubstage(phase) {
  return SUBSTAGE_LABELS[phase] ?? phase ?? "—";
}

/**
 * Position of a phase in the linear GSD flow, for a progress bar. `fixing` maps
 * to the execute step (it is an execute-loop iteration). Terminal-bad phases
 * and unknowns clamp to 0.
 *
 * @param {string} phase
 * @returns {{ index: number, total: number }}
 */
export function phaseProgress(phase) {
  if (phase === "fixing") return { index: GSD_FLOW.indexOf("execute"), total: GSD_FLOW.length };
  const i = GSD_FLOW.indexOf(phase);
  return { index: i < 0 ? 0 : i, total: GSD_FLOW.length };
}

/**
 * Normalize one raw control-file object into the flat agent shape the UI uses.
 *
 * @param {object} agent
 */
export function normalizeAgent(agent) {
  const role = classifyAgentRole(agent);
  return {
    id: agent?.agent_id ?? "unknown",
    unit: agent?.unit_id ?? null,
    role,
    lane: laneForAgent(agent),
    phase: agent?.phase ?? "unknown",
    substage: gsdSubstage(agent?.phase),
    status: agent?.status ?? "unknown",
    iteration: agent?.progress?.iteration ?? 0,
    max_iterations: agent?.progress?.max_iterations ?? 0,
    note: agent?.progress?.note ?? "",
    heartbeat_at: agent?.heartbeat_at ?? null,
    context_pressure: agent?.context_pressure ?? null,
    progress: phaseProgress(agent?.phase),
  };
}

/**
 * Build the full dashboard view model from a run's control files.
 *
 * @param {object} opts
 * @param {object} [opts.run]      run metadata { run_id, scale, state }
 * @param {object[]} [opts.agents] raw control-file objects
 * @param {number} [opts.now]      clock (ms) for generated_at (injectable)
 * @returns {{
 *   run: { run_id, scale, state, generated_at },
 *   counts: { total, running, done, blocked, needs_input },
 *   lanes: { id, title, agents: object[] }[],
 *   agents: object[]
 * }}
 */
export function buildDashboardModel({ run = {}, agents = [], now = Date.now() } = {}) {
  const norm = agents.map(normalizeAgent);
  const lanes = LANES.map((l) => ({
    ...l,
    agents: norm.filter((a) => a.lane === l.id),
  }));
  const countBy = (pred) => norm.filter(pred).length;
  return {
    run: {
      run_id: run.run_id ?? null,
      scale: run.scale ?? null,
      state: run.state ?? null,
      generated_at: new Date(now).toISOString(),
    },
    counts: {
      total: norm.length,
      running: countBy((a) => a.status === "running"),
      done: countBy((a) => a.status === "done"),
      blocked: countBy((a) => a.status === "blocked" || a.status === "failed"),
      needs_input: countBy((a) => a.status === "needs_input"),
    },
    lanes,
    agents: norm,
  };
}
