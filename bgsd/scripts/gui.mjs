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

/**
 * The macro pipeline a run moves through, shown as a timeline/stepper above the
 * lanes. This is what makes the pre-fan-out phases visible: discuss and
 * decompose happen before any agent (and thus any control file) exists, so the
 * dashboard reads the run's `stage` from run.json and lights the current step.
 */
export const PIPELINE_STAGES = Object.freeze([
  { id: "discuss",   label: "Discuss" },
  { id: "decompose", label: "Decompose" },
  { id: "loop1",     label: "Loop 1" },
  { id: "merge",     label: "Merge" },
  { id: "loop2",     label: "Loop 2" },
  { id: "review",    label: "Review" },
  { id: "done",      label: "Done" },
]);

/**
 * Build the pipeline timeline from the run's current macro-stage. Each stage is
 * marked done (before current), active (current), or pending (after). An unknown
 * or null stage leaves every step pending.
 *
 * @param {string|null} currentStage
 * @returns {{ id: string, label: string, status: "done"|"active"|"pending" }[]}
 */
export function buildPipeline(currentStage) {
  const idx = PIPELINE_STAGES.findIndex((s) => s.id === currentStage);
  return PIPELINE_STAGES.map((s, i) => ({
    ...s,
    status: idx < 0 ? "pending" : i < idx ? "done" : i === idx ? "active" : "pending",
  }));
}

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
 * Build an agent's OWN GSD flow (discuss → ui → plan → execute → verify → done)
 * as an ordered array, marking each step done / active / pending / blocked
 * relative to where the agent currently sits in its own flow. This is what lets
 * a card show not just a single label, but the agent's position within its own
 * pipeline (say, on "execute" of its discuss→…→done flow).
 *
 * Rules:
 *  - Steps before the current phase are "done", the current phase is "active",
 *    later steps are "pending".
 *  - `fixing` maps onto the `execute` step being active (the fix / re-verify loop
 *    is an execute-loop iteration, so it re-lights execute).
 *  - A terminal agent `status` of `done` marks the WHOLE flow done.
 *  - A `blocked` / `failed` phase or status marks the current step "blocked".
 *
 * @param {object} agent  a raw control-file object
 * @returns {{ phase: string, label: string, status: "done"|"active"|"pending"|"blocked" }[]}
 */
export function agentFlow(agent) {
  const phase = agent?.phase ?? null;
  const status = agent?.status ?? null;

  // Which GSD_FLOW step is the agent's current one?
  let currentIdx;
  if (status === "done" || phase === "done") {
    currentIdx = GSD_FLOW.length; // whole flow complete: every step is before "current"
  } else if (phase === "fixing") {
    currentIdx = GSD_FLOW.indexOf("execute"); // fix/re-verify loop re-lights execute
  } else {
    currentIdx = GSD_FLOW.indexOf(phase);
    if (currentIdx < 0) currentIdx = 0; // unknown / pre-flow phase clamps to discuss
  }

  const isBad =
    status === "blocked" || status === "failed" || phase === "blocked" || phase === "failed";

  return GSD_FLOW.map((p, i) => {
    let stepStatus;
    if (i < currentIdx) stepStatus = "done";
    else if (i === currentIdx) stepStatus = isBad ? "blocked" : "active";
    else stepStatus = "pending";
    return { phase: p, label: gsdSubstage(p), status: stepStatus };
  });
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
    flow: agentFlow(agent),
  };
}

/**
 * Derive a single overall run status from the agent counts, for the header badge.
 * Priority: blocked wins, then needs_input, then running, then done; an empty run
 * (no agents at all) reads "idle".
 *
 * @param {{ total: number, running: number, done: number, blocked: number, needs_input: number }} counts
 * @returns {"blocked"|"needs_input"|"running"|"done"|"idle"}
 */
export function overallStatus(counts) {
  if (!counts || counts.total === 0) return "idle";
  if (counts.blocked > 0) return "blocked";
  if (counts.needs_input > 0) return "needs_input";
  if (counts.running > 0) return "running";
  return "done";
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
 *   overall: "blocked"|"needs_input"|"running"|"done"|"idle",
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
  const counts = {
    total: norm.length,
    running: countBy((a) => a.status === "running"),
    done: countBy((a) => a.status === "done"),
    blocked: countBy((a) => a.status === "blocked" || a.status === "failed"),
    needs_input: countBy((a) => a.status === "needs_input"),
  };
  return {
    run: {
      run_id: run.run_id ?? null,
      scale: run.scale ?? null,
      state: run.state ?? null,
      stage: run.stage ?? null,
      note: run.note ?? null,
      generated_at: new Date(now).toISOString(),
    },
    counts,
    overall: overallStatus(counts),
    pipeline: buildPipeline(run.stage ?? null),
    lanes,
    agents: norm,
  };
}

/** Phases/statuses that mean an agent has finished its work for good. */
const TERMINAL_DONE = Object.freeze(new Set(["done", "completed", "complete"]));
/** Statuses that mean an agent hit a wall (needs input or failed). */
const TERMINAL_BAD = Object.freeze(new Set(["blocked", "failed", "aborted"]));
/** run.state values that mean the whole run is finished successfully. */
const RUN_DONE_STATES = Object.freeze(new Set(["done", "completed", "complete", "finished"]));
/** run.state values that mean the whole run ended badly. */
const RUN_BAD_STATES = Object.freeze(new Set(["aborted", "failed", "cancelled", "canceled", "error"]));

/**
 * Roll a single agent's status/phase down to one of "done", "bad", or "active".
 * A control file can express its terminal state via either `status` or `phase`.
 *
 * @param {object} agent  a raw control-file object
 * @returns {"done"|"bad"|"active"}
 */
function agentDisposition(agent) {
  const status = String(agent?.status ?? "").toLowerCase();
  const phase = String(agent?.phase ?? "").toLowerCase();
  if (TERMINAL_BAD.has(status)) return "bad";
  if (status === "running" || status === "needs_input") {
    return status === "needs_input" ? "bad" : "active";
  }
  if (TERMINAL_DONE.has(status) || TERMINAL_DONE.has(phase)) return "done";
  return "active";
}

/**
 * Derive a session-level status from its run metadata and agents.
 *
 * - "completed": run.state is a done state, or there are agents and all are
 *   terminal-done.
 * - "aborted": run.state is a bad state, or some agent failed/blocked while none
 *   are still running.
 * - "in-progress": anything else (still working, or nothing has happened yet).
 *
 * @param {object|null} run       parsed run.json (or null)
 * @param {object[]} controls     raw control-file objects
 * @returns {"completed"|"aborted"|"in-progress"}
 */
export function sessionStatus(run, controls = []) {
  const state = String(run?.state ?? "").toLowerCase();
  if (RUN_BAD_STATES.has(state)) return "aborted";
  if (RUN_DONE_STATES.has(state)) return "completed";

  const dispositions = controls.map(agentDisposition);
  const anyRunning = dispositions.includes("active");
  const anyBad = dispositions.includes("bad");
  if (anyBad && !anyRunning) return "aborted";
  if (dispositions.length > 0 && dispositions.every((d) => d === "done")) return "completed";
  return "in-progress";
}

/**
 * Summarize every bgsd run into a compact list for the "All sessions" tab.
 * Pure: the live seam supplies the scanned runs. Sorted newest-first by mtime.
 *
 * @param {Array<{ runId: string, run: object|null, controls: object[], mtime?: number }>} runs
 * @returns {Array<{
 *   run_id: string,
 *   scale: string|null,
 *   state: string|null,
 *   stage: string|null,
 *   status: "completed"|"aborted"|"in-progress",
 *   counts: { total, running, done, blocked, needs_input },
 *   updated_at: string|null
 * }>}
 */
export function summarizeSessions(runs = []) {
  return runs
    .map((entry) => {
      const run = entry?.run ?? null;
      const controls = Array.isArray(entry?.controls) ? entry.controls : [];
      const model = buildDashboardModel({
        run: {
          run_id: entry?.runId ?? run?.run_id ?? null,
          scale: run?.scale ?? null,
          state: run?.state ?? null,
          stage: run?.stage ?? null,
        },
        agents: controls,
      });
      const mtime = typeof entry?.mtime === "number" ? entry.mtime : 0;
      return {
        run_id: entry?.runId ?? run?.run_id ?? null,
        scale: run?.scale ?? null,
        state: run?.state ?? null,
        stage: run?.stage ?? null,
        status: sessionStatus(run, controls),
        counts: model.counts,
        updated_at: mtime ? new Date(mtime).toISOString() : null,
        _mtime: mtime,
      };
    })
    .sort((a, b) => b._mtime - a._mtime)
    .map(({ _mtime, ...rest }) => rest);
}
