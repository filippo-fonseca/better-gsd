#!/usr/bin/env node
/**
 * narrate.mjs — Kiwi's stage-aware narration over BGSD state.
 *
 * Pure: turns a run snapshot (run state + per-unit status + PR/merge info) into
 * the conversational lines Kiwi speaks, using the CANONICAL pipeline names and
 * X/Y progress counts, plus the exact command to run at each human gate. The
 * Conductor builds the snapshot from run.json + control files and prints these,
 * so the narration always reflects real state (never improvised).
 */

export const STAGE_LABELS = Object.freeze({
  conductor: "Conductor",
  loop1: "Loop 1 (parallel worktrees)",
  merge: "merge into the integration branch",
  loop2: "Loop 2 (integration verification)",
  review: "User Review Gate",
  ship: "merge to main",
  done: "done",
});

const RUN_STATE_TO_STAGE = Object.freeze({
  created: "conductor",
  decomposed: "conductor",
  spawning: "loop1",
  executing: "loop1",
  verifying: "loop1",
  merging: "merge",
  checkpoint: "merge",
  integrating: "loop2",
  review: "review",
  done: "done",
});

export function stageForRunState(state) {
  return RUN_STATE_TO_STAGE[state] ?? "conductor";
}

/** Tally per-unit snapshots into the counts Kiwi narrates. */
export function unitCounts(units = []) {
  const c = {
    total: units.length,
    finished: 0,
    verified: 0,
    merged: 0,
    running: 0,
    blocked: 0,
    failed: 0,
    needsInput: 0,
  };
  for (const u of units) {
    if (u.status === "running" || u.status === "stalled") c.running++;
    if (u.status === "failed") c.failed++;
    if (u.status === "blocked") c.blocked++;
    if (u.status === "needs_input") c.needsInput++;
    if (u.status === "done" || u.phase === "done") c.finished++;
    if (u.verified) c.verified++;
    if (u.merged) c.merged++;
  }
  return c;
}

/** The exact command Kiwi suggests at a human gate (or null when not a gate). */
export function gateCommand(stage, { integrationBranch = "next" } = {}) {
  if (stage === "review") {
    return '/bgsd-user-eval   (boots the app + hands you a URL)   ·   /bgsd-feedback "<what is wrong>"';
  }
  if (stage === "ship") {
    return `git checkout main && git merge --no-ff ${integrationBranch}`;
  }
  return null;
}

/**
 * Build the narration for a snapshot.
 *
 * @param {object} snap
 * @param {string}   [snap.integrationBranch="next"]
 * @param {string}   snap.state    run.json state
 * @param {Array}    [snap.units]  per-unit snapshots { status, phase, verified, merged }
 * @param {Array}    [snap.prs]    [{ number, head, base, closes }]
 * @returns {{ stage, stageLabel, counts, lines: string[], gateCommand: string|null }}
 */
export function narrate({ integrationBranch = "next", state, units = [], prs = [] } = {}) {
  const stage = stageForRunState(state);
  const c = unitCounts(units);
  const lines = [];

  switch (stage) {
    case "conductor":
      lines.push(`Conductor: decomposed into ${c.total} unit(s); preparing the wave plan.`);
      break;
    case "loop1":
      lines.push(
        `Loop 1: ${c.finished}/${c.total} Pipeline Agents finished, ` +
          `${c.verified}/${c.total} verified by their Testers and merged into ${integrationBranch}; ` +
          `${c.running} still running.`
      );
      break;
    case "merge":
      lines.push(
        `Merging verified branches into ${integrationBranch} (${c.merged}/${c.total} in); resolving conflicts.`
      );
      break;
    case "loop2":
      lines.push(
        `Loop 2: Integration Tester running whole-app UAT on ${integrationBranch}; ` +
          `parallel fix agents looping until clean.`
      );
      break;
    case "review":
      lines.push(
        `User Review Gate: all loops passed. ${c.total} unit(s) merged into ${integrationBranch}, ready for your eyes.`
      );
      break;
    case "done":
      lines.push(`Done: ${integrationBranch} holds the verified work, yours to ship.`);
      break;
  }

  for (const pr of prs) {
    if (pr.number && pr.head && pr.base) {
      lines.push(
        `Opened PR #${pr.number}: ${pr.head} → ${pr.base}` +
          (pr.closes ? ` (Closes #${pr.closes})` : "") +
          "."
      );
    }
  }

  if (c.blocked || c.needsInput) {
    lines.push(`${c.blocked + c.needsInput} unit(s) need input; every other unit keeps moving.`);
  }

  const cmd = gateCommand(stage, { integrationBranch });
  if (cmd) lines.push(`When you're ready: ${cmd}`);

  return { stage, stageLabel: STAGE_LABELS[stage], counts: c, lines, gateCommand: cmd };
}
