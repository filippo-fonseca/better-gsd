#!/usr/bin/env node
/**
 * test-pause.mjs — Unit tests for pause.mjs (/bgsd-pause ↔ /bgsd-resume).
 *
 * No external framework. node:assert + a local runner. Exits non-zero on any
 * failure (no silent green — NFR-06).
 *
 * Uses OS temp dirs + a couple of mock control files (via control.mjs) so the
 * whole pause/resume snapshot is exercised without any real run.
 *
 * P01 — pauseRun: sets state=paused, records resume_state + pause markers
 * P02 — pauseRun: writes PAUSE.md capturing in-flight agents + resume step
 * P03 — pauseRun: appends a "PAUSED at <stage>" ledger line
 * P04 — pauseRun: refuses to pause a terminal run
 * P05 — pauseRun: pausing an already-paused run keeps the original resume_state
 * P06 — pauseRun: returns a compact summary (counts, snapshot path)
 * P07 — resumePausedRun: restores the run to resume_state + clears markers
 * P08 — resumePausedRun: a non-paused run is returned unchanged (no-op)
 * P09 — resume core: summarizeRun marks a paused run resumable + surfaces state
 * P10 — resume core: buildResumeSummary renders the paused header + next step
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  mintRunId,
  createRun,
  advanceState,
  runJsonPath,
  readRun,
  writeRunAtomic,
} from "./run.mjs";
import { createControlFile, updateControlFile } from "./control.mjs";
import { pauseRun, resumePausedRun, pauseSnapshotPath } from "./pause.mjs";
import { summarizeRun, buildResumeSummary } from "./resume.mjs";

let total = 0;
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  total++;
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

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "bgsd-test-pause-"));
}

/**
 * Synchronous fixture: a run advanced to "executing" with stage + units set and
 * two mock control files (one in-flight @ execute, one finished @ done). The
 * whole thing lives under an OS temp dir the caller cleans up.
 */
function fixture(prompt = "add search bar and billing dashboard") {
  const tmpDir = makeTmpDir();
  const bgsdDir = join(tmpDir, ".bgsd");
  const { runId } = mintRunId(prompt, bgsdDir);
  createRun({ runId, prompt, title: "Add Search Bar", bgsdDir });
  const runPath = runJsonPath(bgsdDir, runId);

  advanceState(runPath, "decomposed");
  advanceState(runPath, "spawning");
  advanceState(runPath, "executing");

  // Stamp stage + units + waves onto run.json (the dashboard pipeline stage).
  const run = readRun(runPath);
  writeRunAtomic(runPath, {
    ...run,
    stage: "loop1",
    units: ["search-bar", "billing"],
    waves: [{ wave: 0, units: ["search-bar", "billing"] }],
  });

  // Mock control files.
  const controlDir = join(bgsdDir, "runs", runId, "control");
  const searchPath = join(controlDir, "search-bar.json");
  createControlFile(searchPath, {
    agent_id: "search-bar",
    run_id: runId,
    worktree: "/fake/wt/search-bar",
    branch: "run/search-bar",
    unit_id: "search-bar",
  });
  updateControlFile(searchPath, {
    phase: "execute",
    status: "running",
    progress: { iteration: 2, max_iterations: 5, note: "wiring the results dropdown" },
  });

  const billingPath = join(controlDir, "billing.json");
  createControlFile(billingPath, {
    agent_id: "billing",
    run_id: runId,
    worktree: "/fake/wt/billing",
    branch: "run/billing",
    unit_id: "billing",
  });
  updateControlFile(billingPath, { phase: "done", status: "done" });

  return { tmpDir, bgsdDir, runId, runPath };
}

process.stdout.write("\nbgsd pause unit tests\n\n");

test("P01 — pauseRun: sets state=paused, records resume_state + pause markers", () => {
  const { tmpDir, bgsdDir, runId, runPath } = fixture();
  const before = readRun(runPath);
  assert.equal(before.state, "executing");

  pauseRun({ runId, bgsdDir, reason: "manual_pause", note: "stepping away", now: () => 1_700_000_000_000 });

  const after = readRun(runPath);
  assert.equal(after.state, "paused", "state flips to paused");
  assert.equal(after.resume_state, "executing", "resume_state is the pre-pause state");
  assert.equal(after.resume_stage, "loop1", "resume_stage captures the dashboard stage");
  assert.equal(after.pause_reason, "manual_pause");
  assert.equal(after.pause_note, "stepping away");
  assert.ok(typeof after.paused_at === "string" && after.paused_at.length > 0, "paused_at set");
  // A pause transition was recorded.
  const last = after.transitions[after.transitions.length - 1];
  assert.equal(last.from, "executing");
  assert.equal(last.to, "paused");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P02 — pauseRun: writes PAUSE.md capturing in-flight agents + resume step", () => {
  const { tmpDir, bgsdDir, runId } = fixture();
  pauseRun({ runId, bgsdDir, note: "handoff note" });

  const snapPath = pauseSnapshotPath(bgsdDir, runId);
  assert.ok(existsSync(snapPath), "PAUSE.md exists");
  const snap = readFileSync(snapPath, "utf8");

  assert.match(snap, /PAUSED/, "titled as PAUSED");
  assert.match(snap, /Add Search Bar/, "carries the session title");
  assert.match(snap, /loop1/, "shows the current stage");
  assert.match(snap, /Resume state/i, "names the resume state");
  assert.match(snap, /executing/, "resume state is the pre-pause state");
  // In-flight agent with its one-line note.
  assert.match(snap, /search-bar/, "lists the in-flight unit");
  assert.match(snap, /wiring the results dropdown/, "shows the in-flight agent's note");
  assert.match(snap, /execute/, "shows the in-flight agent's phase");
  // Finished unit is recorded separately (not re-done on resume).
  assert.match(snap, /Finished units/i, "has a finished-units section");
  assert.match(snap, /billing/, "lists the finished unit");
  assert.match(snap, /handoff note/, "carries the pause note");
  // The exact next step to resume.
  assert.match(snap, /resume-live\.mjs/, "includes the resume command");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P03 — pauseRun: appends a 'PAUSED at <stage>' ledger line", () => {
  const { tmpDir, bgsdDir, runId } = fixture();
  pauseRun({ runId, bgsdDir });

  const ledgerPath = join(bgsdDir, "ledger.md");
  assert.ok(existsSync(ledgerPath), "ledger.md created");
  const ledger = readFileSync(ledgerPath, "utf8");
  assert.match(ledger, /bgsd Run Ledger/i, "has the ledger header");
  assert.match(ledger, new RegExp(runId), "contains the run id");
  assert.match(ledger, /paused/, "row state is paused");
  assert.match(ledger, /PAUSED at loop1/, "prompt column reads PAUSED at <stage>");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P04 — pauseRun: refuses to pause a terminal run", () => {
  const { tmpDir, bgsdDir, runId, runPath } = fixture();
  advanceState(runPath, "done");
  assert.throws(
    () => pauseRun({ runId, bgsdDir }),
    /terminal state "done"/i
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P05 — pauseRun: pausing an already-paused run keeps the original resume_state", () => {
  const { tmpDir, bgsdDir, runId, runPath } = fixture();
  pauseRun({ runId, bgsdDir });
  assert.equal(readRun(runPath).resume_state, "executing");
  // Pause again — resume_state must NOT become "paused".
  pauseRun({ runId, bgsdDir, note: "second pause" });
  const after = readRun(runPath);
  assert.equal(after.state, "paused");
  assert.equal(after.resume_state, "executing", "original resume_state preserved");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P06 — pauseRun: returns a compact summary (counts, snapshot path)", () => {
  const { tmpDir, bgsdDir, runId } = fixture();
  const summary = pauseRun({ runId, bgsdDir });
  assert.equal(summary.run_id, runId);
  assert.equal(summary.resume_state, "executing");
  assert.equal(summary.stage, "loop1");
  assert.equal(summary.in_flight, 1, "one in-flight unit (search-bar)");
  // billing finished -> not pending; search-bar in-flight -> still pending.
  assert.equal(summary.pending, 1, "one pending unit (the in-flight search-bar)");
  assert.ok(summary.snapshot_path.endsWith("PAUSE.md"));
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P07 — resumePausedRun: restores the run to resume_state + clears markers", () => {
  const { tmpDir, bgsdDir, runId, runPath } = fixture();
  pauseRun({ runId, bgsdDir, note: "n" });
  assert.equal(readRun(runPath).state, "paused");

  const restored = resumePausedRun({ runId, bgsdDir });
  assert.equal(restored.state, "executing", "restored to the recorded resume_state");
  assert.equal(restored.stage, "loop1", "stage restored from resume_stage");
  assert.equal(restored.resume_state, null, "pause marker cleared");
  assert.equal(restored.paused_at, null, "paused_at cleared");
  assert.equal(restored.pause_reason, null, "pause_reason cleared");
  assert.ok(typeof restored.resumed_from_pause_at === "string", "records the resume timestamp");
  // A pause→resume_state transition was recorded.
  const last = restored.transitions[restored.transitions.length - 1];
  assert.equal(last.from, "paused");
  assert.equal(last.to, "executing");
  // Persisted to disk.
  assert.equal(readRun(runPath).state, "executing");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P08 — resumePausedRun: a non-paused run is returned unchanged (no-op)", () => {
  const { tmpDir, bgsdDir, runId, runPath } = fixture();
  // Never paused — still "executing".
  const out = resumePausedRun({ runId, bgsdDir });
  assert.equal(out.state, "executing", "unchanged when not paused");
  assert.equal(readRun(runPath).state, "executing");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("P09 — resume core: summarizeRun marks a paused run resumable + surfaces state", () => {
  // Even with EVERY agent terminal, a paused run must be resumable.
  const s = summarizeRun({
    runId: "run-p",
    controls: [
      { agent_id: "u1", status: "done" },
      { agent_id: "u2", status: "failed" },
    ],
    mtime: 10,
    runState: "paused",
    resumeState: "merging",
    pausedAt: "2026-06-30T12:00:00.000Z",
    pauseReason: "manual_pause",
  });
  assert.equal(s.paused, true);
  assert.equal(s.resumable, true, "paused runs are resumable even with all-terminal agents");
  assert.equal(s.resume_state, "merging");
  assert.equal(s.paused_at, "2026-06-30T12:00:00.000Z");

  // A non-paused all-terminal run stays NOT resumable (unchanged behavior).
  const s2 = summarizeRun({
    runId: "run-q",
    controls: [{ agent_id: "u1", status: "done" }],
    mtime: 5,
  });
  assert.equal(s2.paused, false);
  assert.equal(s2.resumable, false);
  assert.equal(s2.resume_state, null);
});

test("P10 — resume core: buildResumeSummary renders the paused header + next step", () => {
  const run = summarizeRun({
    runId: "run-p",
    controls: [{ agent_id: "search-bar", status: "running", phase: "execute", unit_id: "search-bar" }],
    mtime: 1,
    runState: "paused",
    resumeState: "executing",
    pausedAt: "2026-06-30T12:00:00.000Z",
  });
  const out = buildResumeSummary(run);
  assert.equal(out.paused, true);
  assert.equal(out.resume_state, "executing");
  assert.ok(/PAUSED run run-p/.test(out.lines[0]), "header calls out the paused run");
  assert.ok(out.lines.some((l) => /restoring to state "executing"/.test(l)), "header names the resume state");
  assert.ok(out.lines.some((l) => /PAUSE\.md/.test(l)), "next step points at the snapshot");

  // Non-paused summary keeps its original header/next-step shape.
  const normal = buildResumeSummary(
    summarizeRun({ runId: "run-n", controls: [{ agent_id: "u1", status: "running" }], mtime: 1 })
  );
  assert.equal(normal.paused, false);
  assert.ok(/still in flight/.test(normal.lines[0]), "unpaused header unchanged");
});

process.stdout.write(`\n${total} test(s) defined: ${passed} passed, ${failed} failed\n\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("All tests PASSED.\n");
