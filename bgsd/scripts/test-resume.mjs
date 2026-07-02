#!/usr/bin/env node
/**
 * test-resume.mjs — Unit tests for resume.mjs (interrupted-session pickup).
 *
 * No external framework. node:assert + a local runner. Exits non-zero on any
 * failure (no silent green).
 *
 * R01 — summarizeRun: resumable when any agent is non-terminal
 * R02 — summarizeRun: not resumable when every agent is done/failed
 * R03 — pickLatestResumable: newest resumable run wins
 * R04 — pickLatestResumable: terminal runs are skipped
 * R05 — pickLatestResumable: empty / all-terminal -> null
 * R06 — findRun: locates a run by id; null when absent
 * R07 — buildResumeSummary: shape + per-unit glyphs; null -> "no resumable"
 * R08 — isTerminalAgent: done/failed terminal; others not
 * R09 — summarizeRun: a paused run is resumable + surfaces resume_state (PAUSE-01)
 * R10 — pickLatestResumable: a paused all-terminal run still wins over finished
 * R11 — buildResumeSummary: paused run renders the paused header + resume step
 * R12 — validateCompactHandoff: happy path (full valid handoff, empty arrays ok)
 * R13 — validateCompactHandoff: sad paths (missing/mistyped fields, all collected)
 * R14 — buildResumeBrief: handoff lines lead the brief, summary follows
 * R15 — buildResumeBrief: no handoff -> identical to buildResumeSummary + handoff:null
 */

import assert from "node:assert/strict";

import {
  TERMINAL_AGENT_STATUSES,
  isTerminalAgent,
  summarizeRun,
  pickLatestResumable,
  findRun,
  buildResumeSummary,
  validateCompactHandoff,
  buildResumeBrief,
} from "./resume.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

const ctl = (agent_id, status, extra = {}) => ({ agent_id, status, ...extra });

process.stdout.write("\nbgsd resume unit tests\n\n");

test("R01 — summarizeRun: resumable when any agent is non-terminal", () => {
  const s = summarizeRun({
    runId: "run-a",
    controls: [ctl("u1", "done"), ctl("u2", "running", { phase: "execute" })],
    mtime: 100,
  });
  assert.equal(s.resumable, true);
  assert.equal(s.total, 2);
  assert.equal(s.pending, 1);
  assert.equal(s.agents[1].phase, "execute");
});

test("R02 — summarizeRun: not resumable when every agent is terminal", () => {
  const s = summarizeRun({
    runId: "run-b",
    controls: [ctl("u1", "done"), ctl("u2", "failed")],
    mtime: 50,
  });
  assert.equal(s.resumable, false);
  assert.equal(s.pending, 0);
});

test("R03 — pickLatestResumable: newest resumable run wins", () => {
  const runs = [
    { runId: "old", controls: [ctl("u1", "needs_input")], mtime: 10 },
    { runId: "new", controls: [ctl("u1", "running")], mtime: 99 },
    { runId: "mid", controls: [ctl("u1", "blocked")], mtime: 50 },
  ];
  const pick = pickLatestResumable(runs);
  assert.equal(pick.run_id, "new");
});

test("R04 — pickLatestResumable: terminal runs are skipped even if newest", () => {
  const runs = [
    { runId: "finished-newest", controls: [ctl("u1", "done")], mtime: 1000 },
    { runId: "live-older", controls: [ctl("u1", "stalled")], mtime: 5 },
  ];
  const pick = pickLatestResumable(runs);
  assert.equal(pick.run_id, "live-older");
});

test("R05 — pickLatestResumable: empty / all-terminal -> null", () => {
  assert.equal(pickLatestResumable([]), null);
  assert.equal(
    pickLatestResumable([{ runId: "x", controls: [ctl("u1", "failed")], mtime: 1 }]),
    null
  );
});

test("R06 — findRun: locates by id; null when absent", () => {
  const runs = [
    { runId: "r1", controls: [ctl("u1", "running")], mtime: 1 },
    { runId: "r2", controls: [ctl("u1", "done")], mtime: 2 },
  ];
  assert.equal(findRun(runs, "r2").run_id, "r2");
  assert.equal(findRun(runs, "nope"), null);
});

test("R07 — buildResumeSummary: shape + glyphs; null -> no-resumable line", () => {
  const run = summarizeRun({
    runId: "run-c",
    controls: [ctl("u1", "done"), ctl("u2", "running", { unit_id: "search-bar" })],
    mtime: 1,
  });
  const out = buildResumeSummary(run);
  assert.equal(out.run_id, "run-c");
  assert.equal(out.pending, 1);
  assert.ok(out.lines[0].includes("run-c"));
  assert.ok(out.lines.some((l) => l.includes("✓") && l.includes("u1")));
  assert.ok(out.lines.some((l) => l.includes("…") && l.includes("search-bar")));

  const none = buildResumeSummary(null);
  assert.equal(none.run_id, null);
  assert.ok(/no resumable/i.test(none.lines[0]));
});

test("R08 — isTerminalAgent: done/failed terminal; others not", () => {
  assert.deepEqual([...TERMINAL_AGENT_STATUSES], ["done", "failed"]);
  assert.equal(isTerminalAgent({ status: "done" }), true);
  assert.equal(isTerminalAgent({ status: "failed" }), true);
  for (const s of ["running", "stalled", "blocked", "needs_input"]) {
    assert.equal(isTerminalAgent({ status: s }), false, `${s} must be non-terminal`);
  }
});

test("R09 — summarizeRun: a paused run is resumable + surfaces resume_state (PAUSE-01)", () => {
  // Every agent terminal, but the run is PAUSED → still resumable.
  const s = summarizeRun({
    runId: "paused-run",
    controls: [ctl("u1", "done"), ctl("u2", "failed")],
    mtime: 42,
    runState: "paused",
    resumeState: "merging",
    pausedAt: "2026-06-30T12:00:00.000Z",
    pauseReason: "manual_pause",
  });
  assert.equal(s.paused, true);
  assert.equal(s.resumable, true, "paused runs are resumable regardless of agent state");
  assert.equal(s.resume_state, "merging");
  assert.equal(s.paused_at, "2026-06-30T12:00:00.000Z");

  // A NON-paused all-terminal run is unchanged: not resumable, no pause fields.
  const s2 = summarizeRun({ runId: "done-run", controls: [ctl("u1", "done")], mtime: 1 });
  assert.equal(s2.paused, false);
  assert.equal(s2.resumable, false);
  assert.equal(s2.resume_state, null);
});

test("R10 — pickLatestResumable: a paused all-terminal run still wins over finished", () => {
  const runs = [
    { runId: "finished", controls: [ctl("u1", "done")], mtime: 1000 },
    { runId: "paused", controls: [ctl("u1", "done")], mtime: 5, runState: "paused", resumeState: "executing" },
  ];
  const pick = pickLatestResumable(runs);
  assert.equal(pick.run_id, "paused", "the paused run is the only resumable one");
  assert.equal(pick.paused, true);
});

test("R11 — buildResumeSummary: paused run renders the paused header + resume step", () => {
  const run = summarizeRun({
    runId: "paused-run",
    controls: [ctl("u1", "running", { unit_id: "search-bar", phase: "execute" })],
    mtime: 1,
    runState: "paused",
    resumeState: "executing",
    pausedAt: "2026-06-30T12:00:00.000Z",
  });
  const out = buildResumeSummary(run);
  assert.equal(out.paused, true);
  assert.equal(out.resume_state, "executing");
  assert.ok(/PAUSED run paused-run/.test(out.lines[0]), "header calls out the paused run");
  assert.ok(out.lines.some((l) => /restoring to state "executing"/.test(l)));
  assert.ok(out.lines.some((l) => /PAUSE\.md/.test(l)), "next-step line points at the snapshot");
});

const validHandoff = () => ({
  stage: "loop1",
  wave: 2,
  agent_states: [
    { id: "u1", phase: "execute", status: "running" },
    { id: "u2", phase: "verify", status: "blocked" },
  ],
  pending_gates: ["review-gate:u2"],
  next_step: "answer u2's blocker, then re-check the wave",
  written_at: "2026-07-01T10:00:00.000Z",
});

test("R12 — validateCompactHandoff: happy path (full valid handoff, empty arrays ok)", () => {
  assert.deepEqual(validateCompactHandoff(validHandoff()), { ok: true, errors: [] });
  const minimal = { ...validHandoff(), agent_states: [], pending_gates: [], wave: 0 };
  assert.deepEqual(validateCompactHandoff(minimal), { ok: true, errors: [] });
});

test("R13 — validateCompactHandoff: sad paths (missing/mistyped fields, all collected)", () => {
  for (const bad of [null, [], "x", 7]) {
    const r = validateCompactHandoff(bad);
    assert.equal(r.ok, false);
    assert.ok(/plain object/.test(r.errors[0]));
  }

  const r1 = validateCompactHandoff({});
  assert.equal(r1.ok, false);
  for (const field of ["stage", "wave", "agent_states", "pending_gates", "next_step", "written_at"]) {
    assert.ok(r1.errors.some((e) => e.includes(`"${field}"`)), `missing "${field}" must be reported`);
  }

  const r2 = validateCompactHandoff({
    ...validHandoff(),
    stage: "  ",
    wave: 1.5,
    agent_states: [{ id: "u1", phase: "execute" }, "nope"],
    pending_gates: ["ok", 42],
    written_at: "not-a-date",
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes(`"stage"`)));
  assert.ok(r2.errors.some((e) => e.includes(`"wave"`) && /non-negative integer/.test(e)));
  assert.ok(r2.errors.some((e) => e.includes(`agent_states[0].status`)));
  assert.ok(r2.errors.some((e) => e.includes(`agent_states[1]`) && /plain object/.test(e)));
  assert.ok(r2.errors.some((e) => e.includes(`pending_gates[1]`)));
  assert.ok(r2.errors.some((e) => e.includes(`"written_at"`)));

  assert.equal(validateCompactHandoff({ ...validHandoff(), wave: -1 }).ok, false);
});

test("R14 — buildResumeBrief: handoff lines lead the brief, summary follows", () => {
  const run = summarizeRun({
    runId: "run-h",
    controls: [ctl("u1", "done"), ctl("u2", "running", { phase: "execute" })],
    mtime: 1,
  });
  const brief = buildResumeBrief(run, validHandoff());
  assert.equal(brief.run_id, "run-h");
  assert.equal(brief.handoff.stage, "loop1");
  assert.ok(/Compaction handoff/.test(brief.lines[0]), "handoff header must lead the brief");
  assert.ok(/Stage: loop1 · wave 2/.test(brief.lines[1]));
  assert.ok(brief.lines.some((l) => /u2\s+\[blocked\] @ verify/.test(l)));
  assert.ok(brief.lines.some((l) => /Pending gates: review-gate:u2/.test(l)));
  assert.ok(brief.lines.some((l) => /Next step: answer u2's blocker/.test(l)));
  const handoffNextIdx = brief.lines.findIndex((l) => /Next step:/.test(l));
  const summaryHeaderIdx = brief.lines.findIndex((l) => /Resuming run run-h/.test(l));
  assert.ok(summaryHeaderIdx > handoffNextIdx, "control-file summary follows the handoff");

  const empty = buildResumeBrief(run, { ...validHandoff(), agent_states: [], pending_gates: [] });
  assert.ok(empty.lines.some((l) => /Agents: none in flight/.test(l)));
  assert.ok(empty.lines.some((l) => /Pending gates: none/.test(l)));
});

test("R15 — buildResumeBrief: no handoff -> identical to buildResumeSummary + handoff:null", () => {
  const run = summarizeRun({ runId: "run-p", controls: [ctl("u1", "running")], mtime: 1 });
  const brief = buildResumeBrief(run);
  assert.equal(brief.handoff, null);
  assert.deepEqual(brief.lines, buildResumeSummary(run).lines);

  const none = buildResumeBrief(null, null);
  assert.equal(none.run_id, null);
  assert.ok(/no resumable/i.test(none.lines[0]));
});

process.stdout.write(`\nresume.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("\nAll tests PASSED.\n");
