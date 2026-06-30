#!/usr/bin/env node
/**
 * test-rehearsal.mjs — Phase 6 unit tests (REHEARSE-01..04)
 *
 * Tests:
 *   - planRehearsalAssembly: dependency order respected (mocked merges)
 *   - executeRehearsalAssembly: calls mergeFn in order, handles errors
 *   - aggregateDocs: produces expected RUN.md + AGENTS.md from fixture inputs
 *   - updateLedger: appends correct row to ledger.md
 *   - generateChangelog: per-agent CHANGELOG has correct structure (REHEARSE-04)
 *   - planBranchCleanup: never includes rehearsal/* or unmerged branches in toDelete
 *   - executeBranchCleanup dry-run: reports without deleting (REHEARSE-03)
 *   - executeBranchCleanup live: records recovery SHAs BEFORE deletion (REHEARSE-03)
 *   - live seam: liveAssembleFn + liveDeleteBranchFn refuse without --live (NFR-08)
 *   - isLiveFlagSet: returns false in test environment
 *
 * Node 18+ built-ins only. Uses node:assert. No external deps. Exits non-zero on failure.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  planRehearsalAssembly,
  executeRehearsalAssembly,
  aggregateDocs,
  updateLedger,
  generateChangelog,
  planBranchCleanup,
  executeBranchCleanup,
  liveAssembleFn,
  liveDeleteBranchFn,
  isLiveFlagSet,
} from "./rehearsal.mjs";

// ---------------------------------------------------------------------------
// Minimal test harness (mirrors existing bgsd test style)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => { passed++; process.stdout.write(`  PASS  ${name}\n`); },
        (err) => {
          failed++;
          errors.push({ name, err });
          process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
        }
      );
    }
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed++;
    errors.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a simple 3-unit graph: A → B (B depends on A), C is independent */
function makeGraph() {
  const waves = [["A", "C"], ["B"]];           // A+C in wave 0, B in wave 1
  const edges = { A: new Set(), B: new Set(["A"]), C: new Set() };
  return { waves, edges };
}

/** All 3 units passed */
const allPassed = { A: "passed", B: "passed", C: "passed" };

/** A failed, B+C passed */
const aFailed   = { A: "failed", B: "passed", C: "passed" };

/** Build a minimal worktrees fixture */
function makeWorktrees(overrides = []) {
  return [
    {
      unitId:      "A",
      agentId:     "agent-aaa",
      worktree:    "/tmp/wt-a",
      branch:      "bgsd-0001-test/A",
      commits:     ["abc1234"],
      phase:       "done",
      status:      "done",
      assumptions: [{ description: "no auth needed" }],
      blockers:    [],
    },
    {
      unitId:      "B",
      agentId:     "agent-bbb",
      worktree:    "/tmp/wt-b",
      branch:      "bgsd-0001-test/B",
      commits:     ["def5678"],
      phase:       "done",
      status:      "done",
      assumptions: [],
      blockers:    [{ question: "which DB?", severity: "low" }],
    },
    ...overrides,
  ];
}

// ---------------------------------------------------------------------------
// REHEARSE-01: planRehearsalAssembly
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-01: Rehearsal Assembly Plan\n");

await test("RH01 — planRehearsalAssembly: all-passed produces order respecting deps (A,C before B)", () => {
  const { waves, edges } = makeGraph();
  const { assemblyOrder, skipped } = planRehearsalAssembly({
    waves,
    unitStatuses: allPassed,
    edges,
  });
  // B depends on A: A must appear before B
  const idxA = assemblyOrder.indexOf("A");
  const idxB = assemblyOrder.indexOf("B");
  const idxC = assemblyOrder.indexOf("C");
  assert.ok(idxA >= 0, "A should be in assemblyOrder");
  assert.ok(idxB >= 0, "B should be in assemblyOrder");
  assert.ok(idxC >= 0, "C should be in assemblyOrder");
  assert.ok(idxA < idxB, "A must come before B (dependency order)");
  assert.deepEqual(skipped, [], "no units should be skipped");
});

await test("RH02 — planRehearsalAssembly: failed unit is skipped + its dependent is also skipped", () => {
  const { waves, edges } = makeGraph();
  const { assemblyOrder, skipped } = planRehearsalAssembly({
    waves,
    unitStatuses: aFailed,
    edges,
  });
  // A failed → B (which depends on A) should also be skipped
  assert.ok(!assemblyOrder.includes("A"), "A (failed) should not be assembled");
  assert.ok(!assemblyOrder.includes("B"), "B (dep on failed A) should not be assembled");
  assert.ok(assemblyOrder.includes("C"), "C (independent, passed) should be assembled");
  assert.ok(skipped.includes("A"), "A should be in skipped");
  assert.ok(skipped.includes("B"), "B should be in skipped");
});

await test("RH03 — planRehearsalAssembly: alreadyMerged units are excluded from output", () => {
  const { waves, edges } = makeGraph();
  const { assemblyOrder, skipped } = planRehearsalAssembly({
    waves,
    unitStatuses: allPassed,
    edges,
    alreadyMerged: new Set(["A"]),
  });
  // A is already merged: it should not appear in assemblyOrder
  // But B can now be assembled (its dep A is in alreadyMerged)
  assert.ok(!assemblyOrder.includes("A"), "A already merged, should not re-appear");
  assert.ok(assemblyOrder.includes("B"), "B should be assembled now A is in alreadyMerged");
});

await test("RH04 — planRehearsalAssembly: throws on non-array waves", () => {
  assert.throws(
    () => planRehearsalAssembly({ waves: null, unitStatuses: {}, edges: {} }),
    /waves must be an array/
  );
});

await test("RH05 — planRehearsalAssembly: empty waves returns empty order", () => {
  const { assemblyOrder, skipped } = planRehearsalAssembly({
    waves: [],
    unitStatuses: {},
    edges: {},
  });
  assert.deepEqual(assemblyOrder, []);
  assert.deepEqual(skipped, []);
});

// ---------------------------------------------------------------------------
// REHEARSE-01: executeRehearsalAssembly
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-01: executeRehearsalAssembly (mocked mergeFn)\n");

await test("RH06 — executeRehearsalAssembly: calls mergeFn in assemblyOrder and collects assembled", async () => {
  const { waves, edges } = makeGraph();
  const { assemblyOrder } = planRehearsalAssembly({
    waves,
    unitStatuses: allPassed,
    edges,
  });

  const callLog = [];
  const mockMergeFn = async (unitId, runId) => {
    callLog.push({ unitId, runId });
  };

  const result = await executeRehearsalAssembly({
    assemblyOrder,
    runId: "bgsd-0001-test",
    mergeFn: mockMergeFn,
  });

  assert.deepEqual(result.assembled, assemblyOrder, "assembled should match assemblyOrder");
  assert.deepEqual(result.failed, [], "nothing should fail with mock");
  assert.deepEqual(callLog.map((c) => c.unitId), assemblyOrder, "mergeFn called in order");
  assert.ok(callLog.every((c) => c.runId === "bgsd-0001-test"), "runId passed to mergeFn");
});

await test("RH07 — executeRehearsalAssembly: mergeFn error lands unit in failed[]", async () => {
  const failMergeFn = async (unitId) => {
    if (unitId === "B") throw new Error("simulated merge failure");
  };
  const result = await executeRehearsalAssembly({
    assemblyOrder: ["A", "B", "C"],
    runId: "bgsd-0002-err",
    mergeFn: failMergeFn,
  });
  assert.ok(result.assembled.includes("A"), "A assembled");
  assert.ok(result.assembled.includes("C"), "C assembled");
  assert.ok(result.failed.includes("B"), "B in failed");
});

await test("RH08 — executeRehearsalAssembly: mergeFn returning { error } lands unit in failed[]", async () => {
  const errMergeFn = async (unitId) => {
    if (unitId === "C") return { error: "conflict unresolved" };
  };
  const result = await executeRehearsalAssembly({
    assemblyOrder: ["A", "C"],
    runId: "bgsd-0003-erret",
    mergeFn: errMergeFn,
  });
  assert.ok(result.assembled.includes("A"));
  assert.ok(result.failed.includes("C"));
});

await test("RH09 — executeRehearsalAssembly: throws on non-array assemblyOrder", async () => {
  await assert.rejects(
    async () => executeRehearsalAssembly({ assemblyOrder: null, runId: "x", mergeFn: async () => {} }),
    /assemblyOrder must be an array/
  );
});

await test("RH10 — executeRehearsalAssembly: throws on missing mergeFn", async () => {
  await assert.rejects(
    async () => executeRehearsalAssembly({ assemblyOrder: [], runId: "x" }),
    /mergeFn must be a function/
  );
});

await test("RH11 — executeRehearsalAssembly: throws on missing runId", async () => {
  await assert.rejects(
    async () => executeRehearsalAssembly({ assemblyOrder: [], runId: "", mergeFn: async () => {} }),
    /runId is required/
  );
});

// ---------------------------------------------------------------------------
// REHEARSE-02: aggregateDocs
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-02: aggregateDocs\n");

await test("RH12 — aggregateDocs: produces RUN.md with prompt, units, and timeline", () => {
  const worktrees = makeWorktrees();
  const written = {};
  const { runMd } = aggregateDocs({
    runId:     "bgsd-0001-test",
    prompt:    "Build the new auth system",
    units:     ["A", "B"],
    worktrees,
    bgsdDir:   null,   // suppress real writes
    readFileFn: () => { throw new Error("not found"); },
    writeFn:   (p, c) => { written[p] = c; },
    existsFn:  () => false,
  });

  assert.ok(runMd.includes("bgsd-0001-test"), "run id in RUN.md");
  assert.ok(runMd.includes("Build the new auth system"), "prompt in RUN.md");
  assert.ok(runMd.includes("A"), "unit A in RUN.md");
  assert.ok(runMd.includes("B"), "unit B in RUN.md");
  assert.ok(runMd.includes("agent-aaa"), "agent-aaa in RUN.md");
  assert.ok(runMd.includes("agent-bbb"), "agent-bbb in RUN.md");
});

await test("RH13 — aggregateDocs: produces AGENTS.md with per-agent sections", () => {
  const worktrees = makeWorktrees();
  const { agentsMd } = aggregateDocs({
    runId:     "bgsd-0001-test",
    prompt:    "Build the new auth system",
    units:     ["A", "B"],
    worktrees,
    bgsdDir:   null,
    readFileFn: () => { throw new Error("not found"); },
    writeFn:   () => {},
    existsFn:  () => false,
  });

  assert.ok(agentsMd.includes("Agent: agent-aaa"), "agent-aaa section in AGENTS.md");
  assert.ok(agentsMd.includes("Agent: agent-bbb"), "agent-bbb section in AGENTS.md");
  assert.ok(agentsMd.includes("no auth needed"), "assumption in AGENTS.md");
  assert.ok(agentsMd.includes("which DB?"), "blocker in AGENTS.md");
  assert.ok(agentsMd.includes("abc1234"), "commit sha in AGENTS.md");
});

await test("RH14 — aggregateDocs: reads worktree .planning/RUN.md when it exists", () => {
  const worktrees = [
    {
      unitId:      "A",
      agentId:     "agent-aaa",
      worktree:    "/tmp/wt-a",
      branch:      "bgsd-0001-test/A",
      commits:     [],
      phase:       "done",
      status:      "done",
      assumptions: [],
      blockers:    [],
    },
  ];

  const fakeContent = "## Plan for A\nDo the thing.";
  const { runMd } = aggregateDocs({
    runId:     "bgsd-0002-plan",
    prompt:    "test prompt",
    units:     ["A"],
    worktrees,
    bgsdDir:   null,
    readFileFn: (p) => {
      if (p.includes("RUN.md")) return fakeContent;
      throw new Error("not found");
    },
    writeFn:   () => {},
    existsFn:  (p) => p.includes("RUN.md"),
  });

  assert.ok(runMd.includes("Plan for A"), "worktree RUN.md content in aggregated RUN.md");
  assert.ok(runMd.includes("Do the thing."), "worktree RUN.md content verbatim");
});

await test("RH15 — aggregateDocs: writes files when bgsdDir is provided (injectable writeFn)", () => {
  const worktrees = makeWorktrees();
  const written = {};
  aggregateDocs({
    runId:     "bgsd-0003-write",
    prompt:    "test",
    units:     ["A", "B"],
    worktrees,
    bgsdDir:   "/fake/bgsd",
    readFileFn: () => { throw new Error("no"); },
    writeFn:   (p, c) => { written[p] = c; },
    existsFn:  () => false,
  });

  const paths = Object.keys(written);
  assert.ok(paths.some((p) => p.endsWith("RUN.md")), "RUN.md written");
  assert.ok(paths.some((p) => p.endsWith("AGENTS.md")), "AGENTS.md written");
  assert.ok(paths.some((p) => p.endsWith("ledger.md")), "ledger.md updated");
});

await test("RH16 — aggregateDocs: throws on missing runId", () => {
  assert.throws(
    () => aggregateDocs({ runId: "", prompt: "", units: [], worktrees: [], bgsdDir: null }),
    /runId is required/
  );
});

await test("RH17 — aggregateDocs: throws on non-array worktrees", () => {
  assert.throws(
    () => aggregateDocs({ runId: "x", prompt: "", units: [], worktrees: null, bgsdDir: null }),
    /worktrees must be an array/
  );
});

// ---------------------------------------------------------------------------
// REHEARSE-02: updateLedger
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-02: updateLedger\n");

await test("RH18 — updateLedger: creates ledger with header when it does not exist", () => {
  const written = {};
  updateLedger({
    bgsdDir:      "/fake/bgsd",
    runId:        "bgsd-0001-ledger",
    state:        "done",
    prompt:       "test prompt",
    mergedCount:  2,
    heldCount:    0,
    writeFn:      (p, c) => { written[p] = c; },
    readFn:       (p) => { throw new Error("not found"); },
    existsFn:     () => false,
  });

  const ledger = written["/fake/bgsd/ledger.md"];
  assert.ok(ledger, "ledger.md written");
  assert.ok(ledger.includes("# bgsd Run Ledger"), "header present");
  assert.ok(ledger.includes("bgsd-0001-ledger"), "run id in ledger");
  assert.ok(ledger.includes("done"), "state in ledger");
  assert.ok(ledger.includes("test prompt"), "prompt in ledger");
  assert.ok(ledger.includes("2"), "merged count in ledger");
});

await test("RH19 — updateLedger: appends to existing ledger", () => {
  const EXISTING = "# bgsd Run Ledger\n\n| Run ID | State | Merged | Held | Created At | Prompt |\n|--------|-------|--------|------|------------|--------|\n| bgsd-0001-old | done | 1 | 0 | 2026-01-01T00:00:00.000Z | old prompt |\n";
  const written = {};
  updateLedger({
    bgsdDir:     "/fake/bgsd",
    runId:       "bgsd-0002-new",
    state:       "done",
    prompt:      "new prompt",
    mergedCount: 3,
    heldCount:   1,
    writeFn:     (p, c) => { written[p] = c; },
    readFn:      () => EXISTING,
    existsFn:    () => true,
  });

  const ledger = written["/fake/bgsd/ledger.md"];
  assert.ok(ledger.includes("bgsd-0001-old"), "previous entry preserved");
  assert.ok(ledger.includes("bgsd-0002-new"), "new entry appended");
  assert.ok(ledger.includes("new prompt"), "new prompt in new entry");
});

// ---------------------------------------------------------------------------
// REHEARSE-04: generateChangelog
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-04: generateChangelog\n");

await test("RH20 — generateChangelog: produces per-agent sections with commits", () => {
  const worktrees = [
    { unitId: "A", agentId: "agent-aaa", branch: "run/A", commits: ["abc"], status: "done", phase: "done" },
    { unitId: "B", agentId: "agent-bbb", branch: "run/B", commits: ["def", "ghi"], status: "done", phase: "done" },
  ];
  const { changelog } = generateChangelog({ runId: "bgsd-0001-cl", worktrees });

  assert.ok(changelog.includes("CHANGELOG: bgsd-0001-cl"), "run id in changelog");
  assert.ok(changelog.includes("agent-aaa"), "agent-aaa in changelog");
  assert.ok(changelog.includes("agent-bbb"), "agent-bbb in changelog");
  assert.ok(changelog.includes("`abc`"), "commit abc in changelog");
  assert.ok(changelog.includes("`def`"), "commit def in changelog");
  assert.ok(changelog.includes("`ghi`"), "commit ghi in changelog");
});

await test("RH21 — generateChangelog: includes v3 enrichment note for sections without summary", () => {
  const worktrees = [
    { unitId: "A", agentId: "agent-aaa", branch: "run/A", commits: [], status: "done", phase: "done" },
  ];
  const { changelog } = generateChangelog({ runId: "bgsd-0002-cl", worktrees });
  assert.ok(changelog.includes("v3"), "v3 enrichment note present");
  assert.ok(changelog.includes("Haiku"), "Haiku reference present (REHEARSE-04 spec)");
});

await test("RH22 — generateChangelog: respects custom summary when provided", () => {
  const worktrees = [
    {
      unitId: "A", agentId: "agent-aaa", branch: "run/A",
      commits: ["abc"], status: "done", phase: "done",
      summary: "Added the login flow.",
    },
  ];
  const { changelog } = generateChangelog({ runId: "bgsd-0003-cl", worktrees });
  assert.ok(changelog.includes("Added the login flow."), "custom summary in changelog");
});

await test("RH23 — generateChangelog: throws on missing runId", () => {
  assert.throws(
    () => generateChangelog({ runId: "", worktrees: [] }),
    /runId is required/
  );
});

await test("RH24 — generateChangelog: throws on non-array worktrees", () => {
  assert.throws(
    () => generateChangelog({ runId: "x", worktrees: null }),
    /worktrees must be an array/
  );
});

// ---------------------------------------------------------------------------
// REHEARSE-03: planBranchCleanup
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-03: planBranchCleanup\n");

await test("RH25 — planBranchCleanup: merged units go to toDelete, rehearsal/* always in toRetain", () => {
  const { toDelete, toRetain } = planBranchCleanup({
    mergedUnits: ["A", "B", "C"],
    heldUnits:   [],
    runId:       "bgsd-0001-cl",
  });

  assert.equal(toDelete.length, 3, "3 merged branches to delete");
  assert.ok(toDelete.every((b) => !b.branch.startsWith("rehearsal/")),
    "no rehearsal/* in toDelete");

  const integrationEntry = toRetain.find((b) => b.branch === "next");
  assert.ok(integrationEntry, "integration branch (next) in toRetain");
});

await test("RH26 — planBranchCleanup: held units are never in toDelete", () => {
  const { toDelete, toRetain } = planBranchCleanup({
    mergedUnits: ["A"],
    heldUnits:   ["B", "C"],
    runId:       "bgsd-0001-cl",
  });

  assert.ok(toDelete.every((b) => b.unitId === "A"), "only A in toDelete");
  const heldBranches = toRetain.filter((b) => ["B", "C"].includes(b.unitId));
  assert.equal(heldBranches.length, 2, "B and C in toRetain");
});

await test("RH27 — planBranchCleanup: custom unitBranchFn is used", () => {
  const { toDelete } = planBranchCleanup({
    mergedUnits: ["X"],
    heldUnits:   [],
    runId:       "run-1",
    unitBranchFn: (runId, unitId) => `feature/${runId}/${unitId}`,
  });
  assert.equal(toDelete[0].branch, "feature/run-1/X", "custom branch naming used");
});

await test("RH28 — planBranchCleanup: throws on non-array mergedUnits", () => {
  assert.throws(
    () => planBranchCleanup({ mergedUnits: null, runId: "x" }),
    /mergedUnits must be an array/
  );
});

await test("RH29 — planBranchCleanup: throws on missing runId", () => {
  assert.throws(
    () => planBranchCleanup({ mergedUnits: [], runId: "" }),
    /runId is required/
  );
});

// ---------------------------------------------------------------------------
// REHEARSE-03: executeBranchCleanup (dry-run)
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-03: executeBranchCleanup (dry-run)\n");

await test("RH30 — executeBranchCleanup dry-run: reports what would be deleted, deletes nothing", async () => {
  const plan = {
    toDelete: [{ unitId: "A", branch: "bgsd-0001/A" }, { unitId: "B", branch: "bgsd-0001/B" }],
    toRetain: [{ unitId: "__rehearsal__", branch: "rehearsal/bgsd-0001" }],
  };

  let deleteCallCount = 0;
  const result = await executeBranchCleanup({
    plan,
    runId:    "bgsd-0001",
    bgsdDir:  null,
    dry:      true,
    deleteFn: async () => { deleteCallCount++; },
  });

  assert.equal(deleteCallCount, 0, "deleteFn NOT called in dry-run");
  assert.equal(result.deleted.length, 0, "deleted[] empty in dry-run");
  assert.equal(result.dry, true, "result.dry is true");
  assert.equal(result.recoveryPath, null, "no recovery file in dry-run");
});

await test("RH31 — executeBranchCleanup dry-run: returns retained list", async () => {
  const plan = {
    toDelete: [{ unitId: "A", branch: "bgsd-0001/A" }],
    toRetain: [{ unitId: "__rehearsal__", branch: "rehearsal/bgsd-0001" }],
  };

  const result = await executeBranchCleanup({
    plan,
    runId: "bgsd-0001",
    dry:   true,
  });

  assert.ok(result.retained.some((b) => b.branch.startsWith("rehearsal/")),
    "rehearsal branch in retained");
});

// ---------------------------------------------------------------------------
// REHEARSE-03: executeBranchCleanup (live with mocked deleteFn + --live guard)
// ---------------------------------------------------------------------------

process.stdout.write("\nREHEARSE-03: executeBranchCleanup (live, mocked)\n");

await test("RH32 — executeBranchCleanup live: writes recovery file BEFORE calling deleteFn", async () => {
  // Simulate --live by directly testing with injected functions
  // We do NOT set process.argv --live; instead we bypass requireLiveFlag()
  // by using the injected deleteFn path through a workaround:
  // The live path in executeBranchCleanup requires --live. We call it
  // indirectly by mocking the requireLiveFlag check using process.argv injection.
  // Since we cannot set process.argv without side-effects, we verify the
  // ORDERING GUARANTEE by checking that the writeFn (recovery) is called
  // BEFORE the deleteFn, using the injectable writeFn + deleteFn pattern.

  const callOrder = [];
  const written = {};

  // Patch process.argv temporarily so requireLiveFlag() passes
  const origArgv = process.argv;
  process.argv = [...origArgv, "--live"];

  try {
    const plan = {
      toDelete: [
        { unitId: "A", branch: "bgsd-0001/A" },
        { unitId: "B", branch: "bgsd-0001/B" },
      ],
      toRetain: [{ unitId: "__rehearsal__", branch: "rehearsal/bgsd-0001" }],
    };

    const result = await executeBranchCleanup({
      plan,
      runId:   "bgsd-0001",
      bgsdDir: "/fake/bgsd",
      dry:     false,
      deleteFn: async ({ branch, sha, unitId }) => {
        callOrder.push({ type: "delete", branch });
      },
      gitRevParseFn: (branch) => `sha-for-${branch.replace(/\//g, "-")}`,
      writeFn: (p, c) => {
        callOrder.push({ type: "write", path: p });
        written[p] = c;
      },
    });

    // Verify recovery file was written before deletions
    const writeIdx  = callOrder.findIndex((e) => e.type === "write" && e.path.includes("branch-recovery"));
    const deleteIdx = callOrder.findIndex((e) => e.type === "delete");
    assert.ok(writeIdx >= 0, "recovery file written");
    assert.ok(deleteIdx >= 0, "deleteFn called");
    assert.ok(writeIdx < deleteIdx, "recovery file written BEFORE first deletion");

    // Verify recovery file content
    const recoveryContent = written[result.recoveryPath];
    assert.ok(recoveryContent, "recovery file has content");
    const recovery = JSON.parse(recoveryContent);
    assert.ok(Array.isArray(recovery.recoverable), "recoverable array in recovery file");
    assert.ok(recovery.recoverable.every((r) => r.sha && r.recover_cmd),
      "each entry has sha + recover_cmd");

    assert.equal(result.deleted.length, 2, "both branches deleted");
    assert.equal(result.dry, false, "result.dry is false");
  } finally {
    process.argv = origArgv;
  }
});

await test("RH33 — executeBranchCleanup live: deleteFn error keeps branch in retained", async () => {
  const origArgv = process.argv;
  process.argv = [...origArgv, "--live"];

  try {
    const plan = {
      toDelete: [
        { unitId: "A", branch: "bgsd-0001/A" },
        { unitId: "B", branch: "bgsd-0001/B" },
      ],
      toRetain: [{ unitId: "__rehearsal__", branch: "rehearsal/bgsd-0001" }],
    };

    const result = await executeBranchCleanup({
      plan,
      runId:   "bgsd-0001",
      bgsdDir: "/fake/bgsd",
      dry:     false,
      deleteFn: async ({ branch }) => {
        if (branch === "bgsd-0001/B") throw new Error("deletion refused");
      },
      gitRevParseFn: () => "deadbeef",
      writeFn: () => {},
    });

    assert.ok(result.deleted.some((b) => b.unitId === "A"), "A deleted successfully");
    assert.ok(result.retained.some((b) => b.unitId === "B"), "B kept in retained on error");
  } finally {
    process.argv = origArgv;
  }
});

await test("RH34 — executeBranchCleanup: throws on non-array plan.toDelete", async () => {
  await assert.rejects(
    async () => executeBranchCleanup({ plan: { toDelete: null, toRetain: [] }, runId: "x" }),
    /toDelete must be an array/
  );
});

await test("RH35 — executeBranchCleanup: throws on missing runId", async () => {
  await assert.rejects(
    async () => executeBranchCleanup({ plan: { toDelete: [], toRetain: [] }, runId: "" }),
    /runId is required/
  );
});

// ---------------------------------------------------------------------------
// Live seam: liveAssembleFn + liveDeleteBranchFn refuse without --live
// ---------------------------------------------------------------------------

process.stdout.write("\nLive seam guards (NFR-08)\n");

await test("RH36 — liveAssembleFn: throws HUMAN-GATED error without --live", () => {
  // Ensure --live is NOT in argv
  const origArgv = process.argv;
  process.argv = origArgv.filter((a) => a !== "--live");

  try {
    assert.throws(
      () => liveAssembleFn("A", "bgsd-0001"),
      /HUMAN-GATED/
    );
  } finally {
    process.argv = origArgv;
  }
});

await test("RH37 — liveDeleteBranchFn: throws HUMAN-GATED error without --live", () => {
  const origArgv = process.argv;
  process.argv = origArgv.filter((a) => a !== "--live");

  try {
    assert.throws(
      () => liveDeleteBranchFn({ branch: "bgsd-0001/A", sha: "abc", unitId: "A" }),
      /HUMAN-GATED/
    );
  } finally {
    process.argv = origArgv;
  }
});

await test("RH38 — liveDeleteBranchFn: throws on rehearsal/* branch even with --live", () => {
  const origArgv = process.argv;
  process.argv = [...origArgv, "--live"];

  try {
    assert.throws(
      () => liveDeleteBranchFn({ branch: "rehearsal/bgsd-0001", sha: "abc", unitId: "__rehearsal__" }),
      /REFUSED to delete rehearsal branch/
    );
  } finally {
    process.argv = origArgv;
  }
});

await test("RH39 — isLiveFlagSet: returns false in normal test run (no --live in argv)", () => {
  const origArgv = process.argv;
  process.argv = origArgv.filter((a) => a !== "--live");
  try {
    assert.equal(isLiveFlagSet(), false, "isLiveFlagSet() returns false without --live");
  } finally {
    process.argv = origArgv;
  }
});

await test("RH40 — isLiveFlagSet: returns true when --live is injected", () => {
  const origArgv = process.argv;
  process.argv = [...origArgv, "--live"];
  try {
    assert.equal(isLiveFlagSet(), true, "isLiveFlagSet() returns true with --live");
  } finally {
    process.argv = origArgv;
  }
});

// ---------------------------------------------------------------------------
// Full pipeline integration test (mocked end-to-end)
// ---------------------------------------------------------------------------

process.stdout.write("\nEnd-to-end pipeline integration (mocked)\n");

await test("RH41 — full pipeline: plan → execute → aggregate → changelog → cleanup (all mocked)", async () => {
  const { waves, edges } = makeGraph();
  const runId = "bgsd-0099-integration";

  // 1. Plan assembly
  const { assemblyOrder, skipped } = planRehearsalAssembly({
    waves,
    unitStatuses: allPassed,
    edges,
  });
  assert.equal(skipped.length, 0, "nothing skipped when all passed");

  // 2. Execute assembly with mock
  const assembled = [];
  const { assembled: got, failed } = await executeRehearsalAssembly({
    assemblyOrder,
    runId,
    mergeFn: async (unitId) => { assembled.push(unitId); },
  });
  assert.deepEqual(got, assemblyOrder, "all units assembled");
  assert.deepEqual(failed, [], "no failures");

  // 3. Aggregate docs (no real FS)
  const worktrees = makeWorktrees();
  const written = {};
  const { runMd, agentsMd } = aggregateDocs({
    runId,
    prompt:    "integration test prompt",
    units:     assemblyOrder,
    worktrees,
    bgsdDir:   "/fake/bgsd",
    readFileFn: () => { throw new Error("no"); },
    writeFn:   (p, c) => { written[p] = c; },
    existsFn:  () => false,
  });
  assert.ok(runMd.length > 0, "RUN.md generated");
  assert.ok(agentsMd.length > 0, "AGENTS.md generated");

  // 4. Generate changelog
  const { changelog } = generateChangelog({ runId, worktrees });
  assert.ok(changelog.includes(runId), "runId in changelog");

  // 5. Plan cleanup
  const { toDelete, toRetain } = planBranchCleanup({
    mergedUnits: assemblyOrder,
    heldUnits:   skipped,
    runId,
  });
  assert.equal(toDelete.length, assemblyOrder.length, "assembled units scheduled for cleanup");
  assert.ok(toRetain.some((b) => b.branch === "next"), "integration branch (next) retained");

  // 6. Dry-run cleanup
  const cleanupResult = await executeBranchCleanup({
    plan:  { toDelete, toRetain },
    runId,
    dry:   true,
  });
  assert.equal(cleanupResult.deleted.length, 0, "dry-run deletes nothing");
  assert.equal(cleanupResult.dry, true);
});

// ---------------------------------------------------------------------------
// Real filesystem integration (temp dir, no real git) — REHEARSE-02 SC
// ---------------------------------------------------------------------------

process.stdout.write("\nReal filesystem (temp dir)\n");

await test("RH42 — aggregateDocs + updateLedger: writes real files in temp dir", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-test-rehearsal-"));
  try {
    const bgsdDir = join(tmpDir, ".bgsd");
    mkdirSync(bgsdDir, { recursive: true });

    const runId = "bgsd-9999-fstest";
    const worktrees = makeWorktrees();

    // Use real FS (no injectable overrides)
    const { runMd, agentsMd } = aggregateDocs({
      runId,
      prompt:    "fs test prompt",
      units:     ["A", "B"],
      worktrees,
      bgsdDir,
      runState:  "done",
    });

    // Verify files were written
    const runMdPath    = join(bgsdDir, "runs", runId, "RUN.md");
    const agentsMdPath = join(bgsdDir, "runs", runId, "AGENTS.md");
    const ledgerPath   = join(bgsdDir, "ledger.md");

    assert.ok(existsSync(runMdPath),    "RUN.md exists on disk");
    assert.ok(existsSync(agentsMdPath), "AGENTS.md exists on disk");
    assert.ok(existsSync(ledgerPath),   "ledger.md exists on disk");

    const diskRunMd = readFileSync(runMdPath, "utf8");
    assert.ok(diskRunMd.includes(runId), "run id in written RUN.md");
    assert.ok(diskRunMd.includes("fs test prompt"), "prompt in written RUN.md");

    const ledger = readFileSync(ledgerPath, "utf8");
    assert.ok(ledger.includes(runId), "run id in ledger.md");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const { name, err } of errors) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) process.stdout.write(`        ${l}\n`);
    }
  }
  process.exit(1);
}

process.stdout.write("\nAll tests PASSED.\n");
