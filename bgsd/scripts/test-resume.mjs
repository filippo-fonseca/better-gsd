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
 */

import assert from "node:assert/strict";

import {
  TERMINAL_AGENT_STATUSES,
  isTerminalAgent,
  summarizeRun,
  pickLatestResumable,
  findRun,
  buildResumeSummary,
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

process.stdout.write(`\nresume.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("\nAll tests PASSED.\n");
