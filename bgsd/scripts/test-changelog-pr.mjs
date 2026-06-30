#!/usr/bin/env node
/**
 * test-changelog-pr.mjs — Phase 5 unit tests (CHANGELOG-01..03)
 *
 * Tests:
 *   CHANGELOG-01 (per-agent aggregation):
 *     - aggregatePerAgentChangelog: one section per agent in entries array
 *     - aggregatePerAgentChangelog: changelog string contains per-agent sections
 *     - aggregatePerAgentChangelog: loop1/loop2/feedback grouping in changelog
 *     - aggregatePerAgentChangelog: integrationResult included when provided
 *     - aggregatePerAgentChangelog: feedbackRounds metadata included when provided
 *     - aggregatePerAgentChangelog: injectable generateChangelogFn used
 *
 *   CHANGELOG-02 (PR body assembly):
 *     - assemblePrBody: body contains per-agent sections
 *     - assemblePrBody: body contains test plan
 *     - assemblePrBody: body contains Closes #N only when issueNumber provided
 *     - assemblePrBody: body does NOT contain Closes when no issueNumber
 *     - assemblePrBody: title includes run id/slug + prompt excerpt
 *     - assemblePrBody: returns { title, body } as pure strings
 *
 *   CHANGELOG-03 (guarded live PR creation):
 *     - liveCreatePr: refuses with next as base even with --live conceptually
 *     - liveCreatePr: refuses with main as base
 *     - liveCreatePr: refuses with master as base
 *     - liveCreatePr: dry-run prints would-be command without --live
 *     - liveCreatePr: dry-run returns { dryRun: true }
 *     - liveCreatePr: requireLiveFlag throws without --live flag
 *     - requireNotDefaultBranch: throws for next/main/master
 *     - requireNotDefaultBranch: passes for a non-default branch
 *     - isLiveFlagSet: returns false in test environment
 *
 * Node 18+ built-ins only. Uses node:assert. No external deps. Exits non-zero on failure.
 */

import assert from "node:assert/strict";

import {
  aggregatePerAgentChangelog,
  assemblePrBody,
  liveCreatePr,
  requireLiveFlag,
  requireNotDefaultBranch,
  isLiveFlagSet,
} from "./changelog-pr.mjs";

// ---------------------------------------------------------------------------
// Minimal test harness (mirrors existing bgsd test style)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      await result;
    }
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed++;
    errors.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal 3-agent fixture covering loop1 + loop2 + feedback. */
function makeWorktrees() {
  return [
    {
      unitId:  "unit-auth",
      agentId: "agent-001",
      branch:  "run-2026/unit-auth",
      commits: ["abc1234", "def5678"],
      status:  "done",
      phase:   "execute",
      summary: "Implemented OAuth2 login flow",
      loop:    "loop1",
    },
    {
      unitId:  "unit-api",
      agentId: "agent-002",
      branch:  "run-2026/unit-api",
      commits: ["aaa1111"],
      status:  "done",
      phase:   "execute",
      loop:    "loop1",
    },
    {
      unitId:  "unit-auth-fix",
      agentId: "agent-003",
      branch:  "run-2026/unit-auth-fix",
      commits: ["bbb2222"],
      status:  "done",
      phase:   "fixing",
      summary: "Fixed integration defect in auth boundary",
      loop:    "loop2",
    },
    {
      unitId:        "unit-api-feedback",
      agentId:       "agent-004",
      branch:        "run-2026/unit-api-feedback",
      commits:       ["ccc3333"],
      status:        "done",
      phase:         "execute",
      summary:       "Applied user feedback: fixed rate-limit header",
      loop:          "feedback",
      feedbackRound: 1,
    },
  ];
}

function makeIntegrationResult() {
  return {
    verdict:      "PASS",
    reportPath:   ".bgsd/runs/run-2026/integration-report.json",
    defectCount:  2,
  };
}

function makeFeedbackRounds() {
  return [
    { round: 1, itemCount: 1, mode: "fast" },
  ];
}

// ---------------------------------------------------------------------------
// CHANGELOG-01 Tests: Per-Agent Aggregation
// ---------------------------------------------------------------------------

process.stdout.write("\n--- CHANGELOG-01: Per-Agent Aggregation ---\n");

await test("aggregatePerAgentChangelog: entries has one entry per worktree", () => {
  const worktrees = makeWorktrees();
  const { entries } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees });
  assert.equal(entries.length, worktrees.length,
    `expected ${worktrees.length} entries, got ${entries.length}`);
});

await test("aggregatePerAgentChangelog: each entry has correct unitId", () => {
  const worktrees = makeWorktrees();
  const { entries } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees });
  const ids = entries.map((e) => e.unitId);
  assert.ok(ids.includes("unit-auth"), "missing unit-auth entry");
  assert.ok(ids.includes("unit-api"),  "missing unit-api entry");
  assert.ok(ids.includes("unit-auth-fix"), "missing unit-auth-fix entry");
  assert.ok(ids.includes("unit-api-feedback"), "missing unit-api-feedback entry");
});

await test("aggregatePerAgentChangelog: changelog string contains per-agent sections", () => {
  const worktrees = makeWorktrees();
  const { changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees });
  assert.ok(changelog.includes("unit-auth"),    "changelog missing unit-auth section");
  assert.ok(changelog.includes("unit-api"),     "changelog missing unit-api section");
  assert.ok(changelog.includes("unit-auth-fix"), "changelog missing unit-auth-fix section");
  assert.ok(changelog.includes("unit-api-feedback"), "changelog missing unit-api-feedback section");
});

await test("aggregatePerAgentChangelog: loop1/loop2/feedback grouping in changelog", () => {
  const worktrees = makeWorktrees();
  const { changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees });
  assert.ok(changelog.includes("Loop 1"), "changelog missing Loop 1 header");
  assert.ok(changelog.includes("Loop 2"), "changelog missing Loop 2 header");
  assert.ok(changelog.includes("Feedback"), "changelog missing Feedback header");
});

await test("aggregatePerAgentChangelog: integrationResult section present when provided", () => {
  const worktrees = makeWorktrees();
  const ir = makeIntegrationResult();
  const { changelog } = aggregatePerAgentChangelog({
    runId: "run-2026",
    worktrees,
    integrationResult: ir,
  });
  assert.ok(changelog.includes("Integration Result"), "missing Integration Result section");
  assert.ok(changelog.includes("PASS"), "missing verdict in integration section");
});

await test("aggregatePerAgentChangelog: feedbackRounds summary present when provided", () => {
  const worktrees = makeWorktrees();
  const { changelog } = aggregatePerAgentChangelog({
    runId: "run-2026",
    worktrees,
    feedbackRounds: makeFeedbackRounds(),
  });
  assert.ok(changelog.includes("Feedback Rounds Summary"), "missing Feedback Rounds Summary");
  assert.ok(changelog.includes("Round 1"), "missing round 1 in feedback summary");
});

await test("aggregatePerAgentChangelog: injectable generateChangelogFn is called", () => {
  const worktrees = makeWorktrees();
  let called = false;
  const fakeGenerateChangelog = ({ runId: rid, worktrees: wts }) => {
    called = true;
    return { changelog: `## FAKE SEED for ${rid} (${wts.length} worktrees)` };
  };
  aggregatePerAgentChangelog({
    runId: "run-2026",
    worktrees,
    generateChangelogFn: fakeGenerateChangelog,
  });
  assert.ok(called, "injectable generateChangelogFn was not called");
});

await test("aggregatePerAgentChangelog: throws on missing runId", () => {
  assert.throws(
    () => aggregatePerAgentChangelog({ worktrees: [] }),
    /runId is required/
  );
});

await test("aggregatePerAgentChangelog: throws on non-array worktrees", () => {
  assert.throws(
    () => aggregatePerAgentChangelog({ runId: "r1", worktrees: null }),
    /worktrees must be an array/
  );
});

// ---------------------------------------------------------------------------
// CHANGELOG-02 Tests: PR Body Assembly
// ---------------------------------------------------------------------------

process.stdout.write("\n--- CHANGELOG-02: PR Body Assembly ---\n");

await test("assemblePrBody: returns { title, body } as strings", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { title, body } = assemblePrBody({ runId: "run-2026", entries, changelog });
  assert.equal(typeof title, "string", "title must be a string");
  assert.equal(typeof body,  "string", "body must be a string");
});

await test("assemblePrBody: title contains runId", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { title } = assemblePrBody({ runId: "run-2026", entries, changelog });
  assert.ok(title.includes("run-2026"), `title does not contain runId: "${title}"`);
});

await test("assemblePrBody: title includes prompt excerpt", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "r1", worktrees: wts });
  const { title } = assemblePrBody({
    runId: "r1",
    slug:  "my-feature",
    prompt: "Add OAuth and rate limiting",
    entries,
    changelog,
  });
  assert.ok(title.includes("Add OAuth"), `title missing prompt excerpt: "${title}"`);
});

await test("assemblePrBody: body contains per-agent CHANGELOG sections", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { body } = assemblePrBody({ runId: "run-2026", entries, changelog });
  assert.ok(body.includes("unit-auth"), "body missing unit-auth agent section");
  assert.ok(body.includes("unit-api"),  "body missing unit-api agent section");
});

await test("assemblePrBody: body contains ## Test Plan section", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { body } = assemblePrBody({ runId: "run-2026", entries, changelog });
  assert.ok(body.includes("## Test Plan"), "body missing ## Test Plan section");
});

await test("assemblePrBody: body contains Closes #N when issueNumber provided", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { body } = assemblePrBody({ runId: "run-2026", entries, changelog, issueNumber: 42 });
  assert.ok(body.includes("Closes #42"), `body should contain "Closes #42": ${body.slice(-200)}`);
});

await test("assemblePrBody: body does NOT contain Closes when no issueNumber", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { body } = assemblePrBody({ runId: "run-2026", entries, changelog });
  assert.ok(!body.includes("Closes #"), `body should NOT contain "Closes #": ${body.slice(-200)}`);
});

await test("assemblePrBody: body contains ## Summary section", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { body } = assemblePrBody({ runId: "run-2026", entries, changelog });
  assert.ok(body.includes("## Summary"), "body missing ## Summary section");
});

await test("assemblePrBody: integration result appears in summary when provided", () => {
  const wts = makeWorktrees();
  const { entries, changelog } = aggregatePerAgentChangelog({ runId: "run-2026", worktrees: wts });
  const { body } = assemblePrBody({
    runId: "run-2026",
    entries,
    changelog,
    integrationResult: makeIntegrationResult(),
  });
  assert.ok(body.includes("PASS"), "body missing PASS integration verdict");
});

await test("assemblePrBody: throws on missing runId", () => {
  assert.throws(
    () => assemblePrBody({ entries: [], changelog: "" }),
    /runId is required/
  );
});

await test("assemblePrBody: throws on non-array entries", () => {
  assert.throws(
    () => assemblePrBody({ runId: "r1", entries: null, changelog: "" }),
    /entries must be an array/
  );
});

// ---------------------------------------------------------------------------
// CHANGELOG-03 Tests: Guarded Live PR Creation
// ---------------------------------------------------------------------------

process.stdout.write("\n--- CHANGELOG-03: Guarded Live PR Creation ---\n");

await test("requireLiveFlag: throws without --live flag", () => {
  assert.ok(!isLiveFlagSet(), "isLiveFlagSet() must return false in test env (no --live)");
  assert.throws(
    () => requireLiveFlag(),
    /HUMAN-GATED/
  );
});

await test("isLiveFlagSet: returns false in test environment", () => {
  assert.equal(isLiveFlagSet(), false,
    "isLiveFlagSet() should return false in test environment (no --live in argv)");
});

await test("requireNotDefaultBranch: passes for 'next' (integration branch is allowed)", () => {
  requireNotDefaultBranch("next"); // next is the PR target now, not production
});

await test("requireNotDefaultBranch: throws for 'main'", () => {
  assert.throws(
    () => requireNotDefaultBranch("main"),
    /NFR-01 VIOLATION/
  );
});

await test("requireNotDefaultBranch: throws for 'master'", () => {
  assert.throws(
    () => requireNotDefaultBranch("master"),
    /NFR-01 VIOLATION/
  );
});

await test("requireNotDefaultBranch: passes for 'rehearsal/run-2026'", () => {
  // Should NOT throw — rehearsal branches are valid PR targets
  requireNotDefaultBranch("rehearsal/run-2026");
});

await test("requireNotDefaultBranch: passes for a feature branch", () => {
  requireNotDefaultBranch("feat/bgsd-v0");
});

await test("liveCreatePr: accepts 'next' as base (dry preview, no throw)", () => {
  // next is now the integration target: the branch guard passes, and without
  // --live liveCreatePr returns a dry preview rather than throwing.
  assert.doesNotThrow(() =>
    liveCreatePr({
      base:  "next",
      head:  "feat/some-unit",
      title: "test PR",
      body:  "test body",
    })
  );
});

await test("liveCreatePr: refuses 'main' as base", () => {
  assert.throws(
    () => liveCreatePr({
      base:  "main",
      head:  "rehearsal/run-2026",
      title: "test PR",
      body:  "test body",
    }),
    /NFR-01 VIOLATION/
  );
});

await test("liveCreatePr: refuses 'master' as base", () => {
  assert.throws(
    () => liveCreatePr({
      base:  "master",
      head:  "rehearsal/run-2026",
      title: "test PR",
      body:  "test body",
    }),
    /NFR-01 VIOLATION/
  );
});

await test("liveCreatePr: dry-run returns { dryRun: true } without --live", () => {
  let printed = "";
  const result = liveCreatePr({
    base:    "rehearsal/run-2026",
    head:    "run-2026/unit-auth",
    title:   "bgsd run: run-2026",
    body:    "## Test body",
    printFn: (msg) => { printed += msg; },
  });
  assert.equal(result.dryRun, true, "should return { dryRun: true }");
  assert.ok(result.url === undefined, "url should be absent in dry-run");
});

await test("liveCreatePr: dry-run prints would-be gh command", () => {
  let printed = "";
  liveCreatePr({
    base:    "rehearsal/run-2026",
    head:    "run-2026/unit-auth",
    title:   "bgsd run: run-2026",
    body:    "## Test body",
    printFn: (msg) => { printed += msg; },
  });
  assert.ok(printed.includes("gh pr create"), `printed output missing 'gh pr create': ${printed.slice(0, 400)}`);
});

await test("liveCreatePr: dry-run prints the assembled PR body", () => {
  let printed = "";
  const bodyText = "## Summary\n\n- **Run ID:** `run-2026`";
  liveCreatePr({
    base:    "rehearsal/run-2026",
    head:    "run-2026/unit-auth",
    title:   "bgsd run: run-2026",
    body:    bodyText,
    printFn: (msg) => { printed += msg; },
  });
  assert.ok(printed.includes("Run ID"), `printed output missing PR body content: ${printed.slice(0, 500)}`);
});

await test("liveCreatePr: dry-run mode forced via dryRun=true even if --live were set", () => {
  // Even if --live were conceptually set, dryRun:true forces the dry-run path.
  // We test the dryRun=true override without actually having --live in argv.
  let printed = "";
  const result = liveCreatePr({
    base:    "rehearsal/run-2026",
    head:    "run-2026/unit-auth",
    title:   "bgsd run: run-2026",
    body:    "## Test body",
    dryRun:  true,
    printFn: (msg) => { printed += msg; },
  });
  assert.equal(result.dryRun, true, "forced dryRun:true should always return { dryRun: true }");
  assert.ok(printed.includes("DRY-RUN"), "printed output should mention DRY-RUN");
});

await test("liveCreatePr: throws on missing base", () => {
  assert.throws(
    () => liveCreatePr({ head: "h", title: "t", body: "b" }),
    /base is required/
  );
});

await test("liveCreatePr: throws on missing head", () => {
  assert.throws(
    () => liveCreatePr({ base: "rehearsal/r", title: "t", body: "b" }),
    /head is required/
  );
});

// ---------------------------------------------------------------------------
// End-to-end integration: assemble changelog → PR body → dry-run guard
// ---------------------------------------------------------------------------

process.stdout.write("\n--- End-to-End: aggregation → assembly → guard ---\n");

await test("E2E: full aggregation + PR body + dry-run guard", () => {
  const worktrees = makeWorktrees();

  // CHANGELOG-01: aggregate
  const { entries, changelog } = aggregatePerAgentChangelog({
    runId: "run-e2e",
    worktrees,
    integrationResult: makeIntegrationResult(),
    feedbackRounds:    makeFeedbackRounds(),
  });
  assert.equal(entries.length, worktrees.length, "wrong entry count");

  // CHANGELOG-02: assemble PR body
  const { title, body } = assemblePrBody({
    runId:             "run-e2e",
    slug:              "my-feature",
    prompt:            "Add OAuth and rate limiting",
    entries,
    changelog,
    integrationResult: makeIntegrationResult(),
    ledgerPath:        ".bgsd/ledger.md",
    issueNumber:       99,
  });
  assert.ok(title.includes("my-feature"), "title missing slug");
  assert.ok(body.includes("unit-auth"),    "body missing unit-auth");
  assert.ok(body.includes("Test Plan"),    "body missing test plan");
  assert.ok(body.includes("Closes #99"),  "body missing closing keyword");

  // CHANGELOG-03: dry-run guard
  let printed = "";
  const result = liveCreatePr({
    base:    "rehearsal/run-e2e",
    head:    "run-e2e/main",
    title,
    body,
    printFn: (msg) => { printed += msg; },
  });
  assert.equal(result.dryRun, true, "E2E dry-run should return { dryRun: true }");
  assert.ok(printed.includes("gh pr create"), "E2E dry-run missing gh command");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${"=".repeat(60)}\n`);
process.stdout.write(`test-changelog-pr: ${passed} passed, ${failed} failed\n`);

if (errors.length > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const { name, err } of errors) {
    process.stdout.write(`  FAIL  ${name}\n`);
    process.stdout.write(`        ${err.stack ?? err.message}\n`);
  }
}

process.stdout.write(`${"=".repeat(60)}\n\n`);

if (failed > 0) {
  process.exit(1);
}
