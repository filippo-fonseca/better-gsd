#!/usr/bin/env node
/**
 * test-clean.mjs — Unit tests for the pure planner in clean.mjs.
 *
 * Run with: node bgsd/scripts/test-clean.mjs
 *
 * Test groups:
 *   C01 — merged bgsd branch and worktree are in the removal plan
 *   C02 — unmerged bgsd branch is skipped (without --force)
 *   C03 — protected branches (next, main, master) are never in the plan
 *   C04 — current branch is never in the plan
 *   C05 — non-bgsd branches are never in the plan
 *   C06 — force flag includes unmerged bgsd branches
 *   C07 — force flag still never includes protected branches
 *   C08 — force flag still never includes the current branch
 *   C09 — empty inputs produce empty plan with no errors
 *   C10 — worktree checked out on a merged branch is in removeWorktrees
 *   C11 — worktree on an unmerged branch is skipped without force
 *   C12 — worktree on an unmerged branch is removed with force
 *   C13 — skipped list includes reason strings
 *   C14 — multiple bgsd branches: merged ones selected, unmerged ones skipped
 *   C15 — extra protected branches passed via opts.protected are honored
 */

import assert from "node:assert/strict";
import { planClean, PROTECTED } from "./clean.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${label}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${label}\n`);
    process.stdout.write(`         ${err.message}\n`);
    failures.push({ label, message: err.message });
    failed++;
  }
}

process.stdout.write("\n[test-clean.mjs] Running C01..C15\n\n");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function base() {
  return {
    branches:        [],
    worktrees:       [],
    worktreeBranches: [],
    mergedBranches:  [],
    currentBranch:   "next",
    protected:       [],
    force:           false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// C01 — merged bgsd branch ends up in deleteBranches
test("C01 — merged bgsd branch is in deleteBranches", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0001-auth/unit-api"],
    mergedBranches: ["bgsd-0001-auth/unit-api"],
  });
  assert.ok(plan.deleteBranches.includes("bgsd-0001-auth/unit-api"), "expected branch in deleteBranches");
  assert.equal(plan.skipped.filter((s) => s.name === "bgsd-0001-auth/unit-api").length, 0, "should not be skipped");
});

// C02 — unmerged bgsd branch is skipped without force
test("C02 — unmerged bgsd branch is skipped without force", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0002-feat/unit-ui"],
    mergedBranches: [],
    force:          false,
  });
  assert.equal(plan.deleteBranches.length, 0, "expected no branches to delete");
  const sk = plan.skipped.find((s) => s.name === "bgsd-0002-feat/unit-ui");
  assert.ok(sk, "expected branch in skipped list");
  assert.ok(sk.reason.includes("unmerged"), "expected 'unmerged' in reason");
});

// C03 — protected branches never in plan
test("C03 — protected branches (next, main, master) never in deleteBranches", () => {
  for (const p of PROTECTED) {
    const plan = planClean({
      ...base(),
      branches:       [p],
      mergedBranches: [p],
      force:          true,
    });
    assert.equal(plan.deleteBranches.length, 0, `expected ${p} to not be deleted`);
  }
});

// C04 — current branch never in plan
test("C04 — current branch is never in deleteBranches", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0003-my/unit-x"],
    mergedBranches: ["bgsd-0003-my/unit-x"],
    currentBranch:  "bgsd-0003-my/unit-x",
    force:          true,
  });
  assert.equal(plan.deleteBranches.length, 0, "expected current branch to not be deleted");
  const sk = plan.skipped.find((s) => s.name === "bgsd-0003-my/unit-x");
  assert.ok(sk, "expected current branch in skipped");
  assert.ok(sk.reason.includes("current"), "expected 'current' in reason");
});

// C05 — non-bgsd branches are ignored entirely
test("C05 — non-bgsd branches are never in the plan", () => {
  const plan = planClean({
    ...base(),
    branches:       ["feat/my-feature", "fix/some-bug", "main"],
    mergedBranches: ["feat/my-feature", "fix/some-bug", "main"],
    force:          true,
  });
  assert.equal(plan.deleteBranches.length, 0, "expected no non-bgsd branches to be deleted");
});

// C06 — force includes unmerged bgsd branches
test("C06 — force flag includes unmerged bgsd branches in deleteBranches", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0004-work/unit-a"],
    mergedBranches: [],
    force:          true,
  });
  assert.ok(plan.deleteBranches.includes("bgsd-0004-work/unit-a"), "expected branch in deleteBranches under force");
});

// C07 — force still never touches protected branches
test("C07 — force flag still never includes protected branches", () => {
  const plan = planClean({
    ...base(),
    branches:       ["next", "main", "master", "bgsd-0005-ok/unit-b"],
    mergedBranches: [],
    force:          true,
  });
  assert.ok(!plan.deleteBranches.includes("next"), "next must not be deleted");
  assert.ok(!plan.deleteBranches.includes("main"), "main must not be deleted");
  assert.ok(!plan.deleteBranches.includes("master"), "master must not be deleted");
  assert.ok(plan.deleteBranches.includes("bgsd-0005-ok/unit-b"), "bgsd branch should be deleted under force");
});

// C08 — force still never touches current branch
test("C08 — force flag still never deletes the current branch", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0006-curr/unit-c"],
    mergedBranches: [],
    currentBranch:  "bgsd-0006-curr/unit-c",
    force:          true,
  });
  assert.equal(plan.deleteBranches.length, 0, "current branch must not be deleted even with force");
});

// C09 — empty inputs produce an empty plan
test("C09 — empty inputs produce empty removeWorktrees and deleteBranches", () => {
  const plan = planClean(base());
  assert.deepEqual(plan.removeWorktrees, []);
  assert.deepEqual(plan.deleteBranches, []);
});

// C10 — worktree on a merged branch ends up in removeWorktrees
test("C10 — worktree checked out on a merged bgsd branch is in removeWorktrees", () => {
  const plan = planClean({
    ...base(),
    branches:         ["bgsd-0007-x/unit-d"],
    worktrees:        ["/repo/.bgsd/runs/bgsd-0007-x/worktrees/unit-d"],
    worktreeBranches: ["bgsd-0007-x/unit-d"],
    mergedBranches:   ["bgsd-0007-x/unit-d"],
  });
  assert.ok(plan.removeWorktrees.includes("/repo/.bgsd/runs/bgsd-0007-x/worktrees/unit-d"),
    "expected worktree in removeWorktrees");
});

// C11 — worktree on unmerged branch is skipped without force
test("C11 — worktree on unmerged bgsd branch is skipped without force", () => {
  const plan = planClean({
    ...base(),
    branches:         ["bgsd-0008-y/unit-e"],
    worktrees:        ["/repo/.bgsd/runs/bgsd-0008-y/worktrees/unit-e"],
    worktreeBranches: ["bgsd-0008-y/unit-e"],
    mergedBranches:   [],
    force:            false,
  });
  assert.equal(plan.removeWorktrees.length, 0, "expected no worktrees to remove");
  const sk = plan.skipped.find((s) => s.name.includes("unit-e"));
  assert.ok(sk, "expected worktree in skipped");
  assert.ok(sk.reason.includes("unmerged"), "expected 'unmerged' in reason");
});

// C12 — worktree on unmerged branch IS removed with force
test("C12 — worktree on unmerged bgsd branch is removed under force", () => {
  const plan = planClean({
    ...base(),
    branches:         ["bgsd-0009-z/unit-f"],
    worktrees:        ["/repo/.bgsd/runs/bgsd-0009-z/worktrees/unit-f"],
    worktreeBranches: ["bgsd-0009-z/unit-f"],
    mergedBranches:   [],
    force:            true,
  });
  assert.ok(plan.removeWorktrees.includes("/repo/.bgsd/runs/bgsd-0009-z/worktrees/unit-f"),
    "expected worktree in removeWorktrees under force");
});

// C13 — skipped entries always have a reason string
test("C13 — every skipped entry has a non-empty reason", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0010-a/unit-g", "main", "bgsd-0010-a/unit-h"],
    mergedBranches: ["bgsd-0010-a/unit-h"],
    currentBranch:  "bgsd-0010-a/unit-g",
    force:          false,
  });
  for (const s of plan.skipped) {
    assert.ok(typeof s.reason === "string" && s.reason.length > 0,
      `skipped entry "${s.name}" has no reason`);
  }
});

// C14 — multiple branches: merged ones selected, unmerged ones skipped
test("C14 — of multiple bgsd branches, only merged ones are in deleteBranches", () => {
  const plan = planClean({
    ...base(),
    branches:       [
      "bgsd-0011-m/unit-a",
      "bgsd-0011-m/unit-b",
      "bgsd-0011-m/unit-c",
    ],
    mergedBranches: ["bgsd-0011-m/unit-a", "bgsd-0011-m/unit-c"],
    force:          false,
  });
  assert.ok(plan.deleteBranches.includes("bgsd-0011-m/unit-a"), "unit-a merged → should delete");
  assert.ok(plan.deleteBranches.includes("bgsd-0011-m/unit-c"), "unit-c merged → should delete");
  assert.ok(!plan.deleteBranches.includes("bgsd-0011-m/unit-b"), "unit-b unmerged → must not delete");
  const sk = plan.skipped.find((s) => s.name === "bgsd-0011-m/unit-b");
  assert.ok(sk, "unit-b should be in skipped");
});

// C15 — extra protected branches in opts.protected are honored
test("C15 — extra protected branch via opts.protected is never deleted", () => {
  const plan = planClean({
    ...base(),
    branches:       ["bgsd-0012-n/unit-staging"],
    mergedBranches: ["bgsd-0012-n/unit-staging"],
    protected:      ["bgsd-0012-n/unit-staging"],
    force:          true,
  });
  assert.equal(plan.deleteBranches.length, 0, "extra-protected branch must not be deleted");
  const sk = plan.skipped.find((s) => s.name === "bgsd-0012-n/unit-staging");
  assert.ok(sk, "extra-protected branch should be in skipped");
  assert.ok(sk.reason.includes("protected"), "reason should mention 'protected'");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write("\n" + "─".repeat(52) + "\n");
process.stdout.write(`  ${passed} passed, ${failed} failed\n`);
process.stdout.write("─".repeat(52) + "\n\n");

if (failed > 0) {
  process.stdout.write("FAILURES:\n");
  for (const f of failures) {
    process.stdout.write(`  [${f.label}] ${f.message}\n`);
  }
  process.stdout.write("\n");
  process.exit(1);
}

process.stdout.write("All tests passed.\n\n");
process.exit(0);
