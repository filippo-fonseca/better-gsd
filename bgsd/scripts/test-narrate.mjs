#!/usr/bin/env node
/**
 * test-narrate.mjs — Unit tests for narrate.mjs (Phase 5 Kiwi narration).
 * Run with: node bgsd/scripts/test-narrate.mjs
 */

import assert from "node:assert/strict";

import {
  stageForRunState,
  unitCounts,
  gateCommand,
  narrate,
  STAGE_LABELS,
} from "./narrate.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

test("NA01 — stageForRunState maps run states to pipeline stages", () => {
  assert.equal(stageForRunState("executing"), "loop1");
  assert.equal(stageForRunState("integrating"), "loop2");
  assert.equal(stageForRunState("review"), "review");
  assert.equal(stageForRunState("done"), "done");
  assert.equal(stageForRunState("weird"), "conductor");
});

test("NA02 — unitCounts tallies status/verified/merged", () => {
  const c = unitCounts([
    { status: "done", verified: true, merged: true },
    { status: "done", verified: true, merged: true },
    { status: "running" },
    { status: "blocked" },
  ]);
  assert.equal(c.total, 4);
  assert.equal(c.verified, 2);
  assert.equal(c.merged, 2);
  assert.equal(c.running, 1);
  assert.equal(c.blocked, 1);
});

test("NA03 — Loop 1 narration includes X/Y counts and the integration branch", () => {
  // 4 agents finished their GSD run; 2 verified + merged, 2 still verifying.
  const out = narrate({
    state: "executing",
    integrationBranch: "next",
    units: [
      { status: "done", verified: true, merged: true },
      { status: "done", verified: true, merged: true },
      { status: "done", verified: false, merged: false },
      { status: "done", verified: false, merged: false },
    ],
  });
  assert.equal(out.stage, "loop1");
  const line = out.lines[0];
  assert.ok(line.includes("4/4 Pipeline Agents finished"), line);
  assert.ok(line.includes("2/4 verified"), line);
  assert.ok(line.includes("merged into next"), line);
});

test("NA04 — gateCommand suggests the exact command at human gates", () => {
  assert.ok(gateCommand("review").includes("/bgsd-user-eval"));
  assert.equal(gateCommand("ship", { integrationBranch: "next" }), "git checkout main && git merge --no-ff next");
  assert.equal(gateCommand("loop1"), null);
});

test("NA05 — review stage narration ends with the gate command", () => {
  const out = narrate({ state: "review", units: [{ status: "done", merged: true }] });
  assert.equal(out.stage, "review");
  assert.ok(out.gateCommand && out.gateCommand.includes("/bgsd-user-eval"));
  assert.ok(out.lines.some((l) => l.includes("/bgsd-user-eval")));
});

test("NA06 — PRs are narrated with Closes references", () => {
  const out = narrate({
    state: "merging",
    prs: [{ number: 12, head: "bgsd-0001/u-auth", base: "next", closes: 7 }],
  });
  assert.ok(out.lines.some((l) => l.includes("Opened PR #12") && l.includes("Closes #7")));
});

test("NA07 — STAGE_LABELS cover every mapped stage", () => {
  for (const s of ["conductor", "loop1", "merge", "loop2", "review", "done"]) {
    assert.ok(STAGE_LABELS[s], `missing label for ${s}`);
  }
});

process.stdout.write(`\nnarrate.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
