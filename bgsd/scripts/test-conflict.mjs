#!/usr/bin/env node
/**
 * test-conflict.mjs — Unit tests for conflict.mjs (Phase 5: CONFLICT-01..04)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-conflict.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * SAFETY RULES
 * ============
 * - This test file NEVER touches this repo's git state. (The danger note in
 *   the prompt is taken seriously.)
 * - Conflict pre-check tests that need real git behavior use a THROWAWAY temp
 *   git repo created with mkdtempSync under os.tmpdir(). That temp repo is
 *   cleaned up after each test in a try/finally block.
 * - All merge executor tests use fully mocked mergeFn / resolverFn / escalateFn.
 * - The liveGitMergeFn guard test confirms it throws without --live in argv.
 *
 * Test groups:
 *
 * --- parseMergeTreeOutput (CONFLICT-01 parsing) ---
 *   CF01 — returns [] for empty stdout
 *   CF02 — returns [] for stdout with no conflict markers
 *   CF03 — parses a single-file conflict with file name from section header
 *   CF04 — parses a conflict block with multiple hunks in the same file
 *
 * --- preCheckMerge with injected gitFn (CONFLICT-01, non-destructive) ---
 *   CF05 — clean merge: injected gitFn returns empty string → clean=true, conflicts=[]
 *   CF06 — conflict: injected gitFn returns conflict markers → clean=false, conflicts non-empty
 *   CF07 — git error: injected gitFn throws → safe non-clean result (no crash)
 *   CF08 — real temp repo: two branches with no conflict → clean=true (uses real git)
 *   CF09 — real temp repo: two branches with conflicting edits → clean=false (uses real git)
 *   CF10 — preCheckMerge throws on missing base
 *   CF11 — preCheckMerge throws on missing branch
 *
 * --- computeMergeOrder (CONFLICT-02, dependency order) ---
 *   CF12 — single unit, passed, no deps → appears in order
 *   CF13 — unit not passed → excluded from order
 *   CF14 — unit passed but dep not merged → excluded (held back)
 *   CF15 — three-unit chain A→B→C (A has no deps, C depends on B which depends on A)
 *           all passed → order is [A, B, C]
 *   CF16 — two independent units both passed → both appear (sorted for determinism)
 *   CF17 — alreadyMerged set is respected: unit whose dep is already merged is included
 *   CF18 — waves with mixed pass/fail: only passed units with all deps merged appear
 *
 * --- executeMerges: clean path (CONFLICT-02) ---
 *   CF19 — clean pre-check → mergeFn called once, result.outcome="merged"
 *   CF20 — multiple units, all clean → mergeFn called once per unit in order
 *
 * --- executeMerges: high-confidence resolver (CONFLICT-03) ---
 *   CF21 — conflict + high-confidence resolver → mergeFn called, outcome="merged"
 *   CF22 — resolver confidence exactly at threshold → auto-applied (>=)
 *
 * --- executeMerges: low-confidence escalation (CONFLICT-04, NFR-06) ---
 *   CF23 — conflict + low-confidence resolver → escalateFn called, outcome="needs_input"
 *   CF24 — low-confidence: mergeFn is NOT called (branch held back)
 *   CF25 — low-confidence: escalateFn receives conflicts + resolution
 *
 * --- executeMerges: mixed (CONFLICT-02..04) ---
 *   CF26 — mixed order: unit A clean, unit B conflicted+low-confidence →
 *           A merged, B needs_input; one escalation, one merge
 *
 * --- liveGitMergeFn guard (CONFLICT-02, mirrors loop1-live pattern) ---
 *   CF27 — liveGitMergeFn throws without --live in argv
 *   CF28 — isLiveFlagSet() returns false in test environment
 *
 * --- no-silent-green: bad inputs (NFR-06) ---
 *   CF29 — executeMerges throws on non-array mergeOrder
 *   CF30 — executeMerges throws on missing mergeFn
 *   CF31 — computeMergeOrder throws on non-array waves
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join }    from "node:path";
import { tmpdir }  from "node:os";
import { execSync, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
  parseMergeTreeOutput,
  preCheckMerge,
  computeMergeOrder,
  executeMerges,
  liveGitMergeFn,
  isLiveFlagSet,
  CONFIDENCE_THRESHOLD,
} from "./conflict.mjs";

// ---------------------------------------------------------------------------
// Test runner helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // async tests — collected and awaited below
      return result.then(
        () => { passed++; process.stdout.write(`  PASS  ${name}\n`); },
        (err) => {
          failed++;
          failures.push({ name, err });
          process.stdout.write(`  FAIL  ${name}\n    ${err.message}\n`);
        }
      );
    }
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
    return Promise.resolve();
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}\n    ${err.message}\n`);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Temp repo helper — creates a throwaway git repo for real-git tests
// ---------------------------------------------------------------------------

/**
 * Create a throwaway git repo in the OS temp directory.
 * Returns { dir, cleanup }.
 * The caller MUST call cleanup() in a finally block.
 * This repo is entirely separate from the main project repo.
 */
function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-conflict-test-"));
  // Init
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@bgsd.local"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name",  "bgsd-test"],       { cwd: dir, stdio: "ignore" });
  return {
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    },
    commit(msg) {
      spawnSync("git", ["add", "-A"],              { cwd: dir, stdio: "ignore" });
      spawnSync("git", ["commit", "-m", msg],      { cwd: dir, stdio: "ignore" });
    },
    branch(name) {
      spawnSync("git", ["checkout", "-b", name],   { cwd: dir, stdio: "ignore" });
    },
    checkout(name) {
      spawnSync("git", ["checkout", name],         { cwd: dir, stdio: "ignore" });
    },
    write(file, content) {
      writeFileSync(join(dir, file), content, "utf8");
    },
    headSha(ref = "HEAD") {
      const r = spawnSync("git", ["rev-parse", ref], { cwd: dir, encoding: "utf8", stdio: ["ignore","pipe","ignore"] });
      return (r.stdout ?? "").trim();
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic merge-tree output fixtures
// ---------------------------------------------------------------------------

const CLEAN_STDOUT = ""; // git merge-tree exits 1 but empty stdout = no conflicts

const CONFLICT_STDOUT = `
changed in both
      base  100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa src/foo.ts
      our   100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb src/foo.ts
      their 100644 cccccccccccccccccccccccccccccccccccccccc src/foo.ts
@@
<<<<<<< .our
export function foo() { return 1; }
=======
export function foo() { return 2; }
>>>>>>> .their
`;

// ---------------------------------------------------------------------------
// Tests — parseMergeTreeOutput
// ---------------------------------------------------------------------------

process.stdout.write("\n=== parseMergeTreeOutput ===\n");

await test("CF01 — returns [] for empty stdout", () => {
  assert.deepEqual(parseMergeTreeOutput(""), []);
  assert.deepEqual(parseMergeTreeOutput(null), []);
});

await test("CF02 — returns [] for stdout with no conflict markers", () => {
  const stdout = "  our   100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa src/bar.ts\n";
  const result = parseMergeTreeOutput(stdout);
  // No conflict markers (<<<<<<<), so no conflicts
  assert.equal(result.length, 0);
});

await test("CF03 — parses a single-file conflict with file name from section header", () => {
  const result = parseMergeTreeOutput(CONFLICT_STDOUT);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, "src/foo.ts");
  assert.equal(result[0].hunks.length, 1);
  assert.ok(result[0].hunks[0].includes("<<<<<<<"), "hunk should contain conflict marker");
  assert.ok(result[0].hunks[0].includes(">>>>>>>"), "hunk should contain end marker");
});

await test("CF04 — parses conflict block containing both sides", () => {
  const result = parseMergeTreeOutput(CONFLICT_STDOUT);
  const hunk = result[0].hunks[0];
  assert.ok(hunk.includes("return 1"), "ours side should appear in hunk");
  assert.ok(hunk.includes("return 2"), "theirs side should appear in hunk");
  assert.ok(hunk.includes("======="),  "separator should appear in hunk");
});

// ---------------------------------------------------------------------------
// Tests — preCheckMerge with injected gitFn
// ---------------------------------------------------------------------------

process.stdout.write("\n=== preCheckMerge (injected gitFn) ===\n");

await test("CF05 — clean merge: empty stdout → clean=true, conflicts=[]", () => {
  const gitFn = () => CLEAN_STDOUT;
  const result = preCheckMerge({ base: "main", branch: "feat/x", gitFn });
  assert.equal(result.clean, true);
  assert.deepEqual(result.conflicts, []);
});

await test("CF06 — conflict: stdout with markers → clean=false, conflicts non-empty", () => {
  const gitFn = () => CONFLICT_STDOUT;
  const result = preCheckMerge({ base: "main", branch: "feat/x", gitFn });
  assert.equal(result.clean, false);
  assert.ok(result.conflicts.length > 0, "should have at least one conflict");
  assert.equal(result.conflicts[0].file, "src/foo.ts");
});

await test("CF07 — git error: injected gitFn throws → safe non-clean result (no crash)", () => {
  const gitFn = () => { throw new Error("git: not a repository"); };
  const result = preCheckMerge({ base: "main", branch: "feat/x", gitFn });
  assert.equal(result.clean, false);
  assert.ok(result.conflicts.length > 0, "should produce an error conflict entry");
  assert.equal(result.conflicts[0].file, "<git-error>");
});

await test("CF08 — real temp repo: two branches no conflict → clean=true", () => {
  const repo = makeTempRepo();
  try {
    // Create initial commit on main
    repo.write("hello.txt", "hello world\n");
    repo.commit("init");

    // Branch A: edits file-a.txt (new file)
    repo.branch("branch-a");
    repo.write("file-a.txt", "branch-a content\n");
    repo.commit("branch-a work");

    // Back to main, create branch B touching a different file
    repo.checkout("main");
    repo.branch("branch-b");
    repo.write("file-b.txt", "branch-b content\n");
    repo.commit("branch-b work");

    // Pre-check: merge branch-a into branch-b (or main) — no conflict
    repo.checkout("main");
    const mainSha = repo.headSha("main");
    const branchASha = repo.headSha("branch-a");

    const result = preCheckMerge({ base: mainSha, branch: branchASha, cwd: repo.dir });
    assert.equal(result.clean, true, "disjoint branches should be clean");
    assert.deepEqual(result.conflicts, []);
  } finally {
    repo.cleanup();
  }
});

await test("CF09 — real temp repo: conflicting edits → clean=false", () => {
  const repo = makeTempRepo();
  try {
    // Create initial commit on main with shared.txt
    repo.write("shared.txt", "line 1\nline 2\nline 3\n");
    repo.commit("init");

    const mainSha = repo.headSha("main");

    // Branch A: modifies shared.txt
    repo.branch("branch-a");
    repo.write("shared.txt", "line 1 MODIFIED BY A\nline 2\nline 3\n");
    repo.commit("branch-a modifies shared.txt");
    const branchASha = repo.headSha("branch-a");

    // Back to main base, create branch B also modifying shared.txt differently
    repo.checkout("main");
    repo.branch("branch-b");
    repo.write("shared.txt", "line 1 MODIFIED BY B\nline 2\nline 3\n");
    repo.commit("branch-b modifies shared.txt");
    const branchBSha = repo.headSha("branch-b");

    // Pre-check: merge branch-a into branch-b — both changed line 1, should conflict
    const result = preCheckMerge({ base: mainSha, branch: branchASha, cwd: repo.dir });
    // Note: git merge-tree <base> <branch-a> against the current working tree
    // checks merge of branch-a onto base. We test against branchBSha as "base"
    // to simulate merging branch-a into rehearsal (which is at branch-b's state).
    const result2 = preCheckMerge({ base: branchBSha, branch: branchASha, cwd: repo.dir });
    assert.equal(result2.clean, false, "both branches modified the same line; should conflict");
    assert.ok(result2.conflicts.length > 0, "conflict entries expected");
  } finally {
    repo.cleanup();
  }
});

await test("CF10 — preCheckMerge throws on missing base", () => {
  assert.throws(
    () => preCheckMerge({ base: "", branch: "feat/x" }),
    /base is required/
  );
});

await test("CF11 — preCheckMerge throws on missing branch", () => {
  assert.throws(
    () => preCheckMerge({ base: "main", branch: null }),
    /branch is required/
  );
});

// ---------------------------------------------------------------------------
// Tests — computeMergeOrder
// ---------------------------------------------------------------------------

process.stdout.write("\n=== computeMergeOrder ===\n");

await test("CF12 — single passed unit, no deps → appears in order", () => {
  const waves        = [["unit-a"]];
  const unitStatuses = new Map([["unit-a", "passed"]]);
  const edges        = new Map([["unit-a", new Set()]]);
  const order = computeMergeOrder({ waves, unitStatuses, edges });
  assert.deepEqual(order, ["unit-a"]);
});

await test("CF13 — unit not passed → excluded from order", () => {
  const waves        = [["unit-a"]];
  const unitStatuses = new Map([["unit-a", "failed"]]);
  const edges        = new Map([["unit-a", new Set()]]);
  const order = computeMergeOrder({ waves, unitStatuses, edges });
  assert.deepEqual(order, []);
});

await test("CF14 — unit passed but dep not yet merged → held back (excluded)", () => {
  const waves        = [["unit-a"], ["unit-b"]];
  const unitStatuses = new Map([["unit-a", "failed"], ["unit-b", "passed"]]);
  // unit-b depends on unit-a
  const edges = new Map([
    ["unit-a", new Set()],
    ["unit-b", new Set(["unit-a"])],
  ]);
  const order = computeMergeOrder({ waves, unitStatuses, edges });
  // unit-a failed → not merged; unit-b's dep not satisfied → excluded
  assert.deepEqual(order, []);
});

await test("CF15 — three-unit chain A→B→C all passed → order is [A, B, C]", () => {
  // Wave 0: A (no deps); Wave 1: B (dep A); Wave 2: C (dep B)
  const waves        = [["unit-a"], ["unit-b"], ["unit-c"]];
  const unitStatuses = new Map([
    ["unit-a", "passed"],
    ["unit-b", "passed"],
    ["unit-c", "passed"],
  ]);
  const edges = new Map([
    ["unit-a", new Set()],
    ["unit-b", new Set(["unit-a"])],
    ["unit-c", new Set(["unit-b"])],
  ]);
  const order = computeMergeOrder({ waves, unitStatuses, edges });
  assert.deepEqual(order, ["unit-a", "unit-b", "unit-c"]);
});

await test("CF16 — two independent units both passed → both appear (sorted for determinism)", () => {
  const waves        = [["unit-b", "unit-a"]]; // unsorted on purpose
  const unitStatuses = new Map([
    ["unit-a", "passed"],
    ["unit-b", "passed"],
  ]);
  const edges = new Map([
    ["unit-a", new Set()],
    ["unit-b", new Set()],
  ]);
  const order = computeMergeOrder({ waves, unitStatuses, edges });
  // Sorted within wave: ["unit-a", "unit-b"]
  assert.deepEqual(order, ["unit-a", "unit-b"]);
});

await test("CF17 — alreadyMerged set respected: dep already merged → dependent included", () => {
  const waves        = [["unit-b"]]; // unit-a not in waves (already done)
  const unitStatuses = new Map([["unit-b", "passed"]]);
  const edges        = new Map([["unit-b", new Set(["unit-a"])]]);
  const alreadyMerged = new Set(["unit-a"]);
  const order = computeMergeOrder({ waves, unitStatuses, edges, alreadyMerged });
  assert.deepEqual(order, ["unit-b"]);
});

await test("CF18 — mixed pass/fail: only passed units with all deps merged appear", () => {
  const waves        = [["unit-a", "unit-b"], ["unit-c", "unit-d"]];
  const unitStatuses = new Map([
    ["unit-a", "passed"],
    ["unit-b", "failed"],
    ["unit-c", "passed"],  // depends on unit-a (which is passed)
    ["unit-d", "passed"],  // depends on unit-b (which failed — dep not merged)
  ]);
  const edges = new Map([
    ["unit-a", new Set()],
    ["unit-b", new Set()],
    ["unit-c", new Set(["unit-a"])],
    ["unit-d", new Set(["unit-b"])],
  ]);
  const order = computeMergeOrder({ waves, unitStatuses, edges });
  // unit-a: passes (no dep). unit-b: fails. unit-c: dep unit-a merged. unit-d: dep unit-b NOT merged.
  assert.deepEqual(order, ["unit-a", "unit-c"]);
});

// ---------------------------------------------------------------------------
// Tests — executeMerges: clean path (CONFLICT-02)
// ---------------------------------------------------------------------------

process.stdout.write("\n=== executeMerges: clean path ===\n");

await test("CF19 — clean pre-check → mergeFn called once, outcome='merged'", async () => {
  let mergeCalls = 0;
  const mergeFn    = async () => { mergeCalls++; };
  const resolverFn = async () => ({ confidence: 0.99, resolution: {}, summary: "" });
  const escalateFn = async () => {};

  const preCheckFn = () => ({ clean: true, conflicts: [] });

  const results = await executeMerges({
    mergeOrder: ["unit-a"],
    runId:      "bgsd-0001-test",
    mergeFn,
    resolverFn,
    escalateFn,
    preCheckFn,
  });

  assert.equal(mergeCalls, 1, "mergeFn should be called once");
  assert.equal(results.length, 1);
  assert.equal(results[0].unitId,     "unit-a");
  assert.equal(results[0].outcome,    "merged");
  assert.equal(results[0].conflicted, false);
  assert.equal(results[0].escalated,  false);
});

await test("CF20 — multiple clean units → mergeFn called once per unit in order", async () => {
  const mergeCallOrder = [];
  const mergeFn    = async (unitId) => { mergeCallOrder.push(unitId); };
  const resolverFn = async () => ({ confidence: 0.99, resolution: {}, summary: "" });
  const escalateFn = async () => {};
  const preCheckFn = () => ({ clean: true, conflicts: [] });

  const results = await executeMerges({
    mergeOrder: ["unit-a", "unit-b", "unit-c"],
    runId:      "bgsd-0001-test",
    mergeFn,
    resolverFn,
    escalateFn,
    preCheckFn,
  });

  assert.deepEqual(mergeCallOrder, ["unit-a", "unit-b", "unit-c"], "merge order must be preserved");
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.outcome, "merged");
  }
});

// ---------------------------------------------------------------------------
// Tests — executeMerges: high-confidence resolver (CONFLICT-03)
// ---------------------------------------------------------------------------

process.stdout.write("\n=== executeMerges: high-confidence resolver ===\n");

await test("CF21 — conflict + high-confidence resolver → mergeFn called, outcome='merged'", async () => {
  let mergeCalls = 0;
  let resolverCalls = 0;
  const mergeFn    = async () => { mergeCalls++; };
  const resolverFn = async () => { resolverCalls++; return { confidence: 0.95, resolution: { strategy: "take-ours" }, summary: "resolved" }; };
  const escalateFn = async () => {};
  const preCheckFn = () => ({ clean: false, conflicts: [{ file: "src/foo.ts", hunks: ["<<<<<<< .our\nours\n=======\ntheirs\n>>>>>>> .their"] }] });

  const results = await executeMerges({
    mergeOrder: ["unit-x"],
    runId:      "bgsd-0001-test",
    mergeFn,
    resolverFn,
    escalateFn,
    preCheckFn,
  });

  assert.equal(resolverCalls, 1, "resolverFn should be called");
  assert.equal(mergeCalls,    1, "mergeFn should be called after high-confidence resolve");
  assert.equal(results[0].outcome,    "merged");
  assert.equal(results[0].conflicted, true);
  assert.equal(results[0].escalated,  false);
  assert.ok(results[0].resolution,    "resolution should be attached");
});

await test("CF22 — resolver confidence exactly at threshold → auto-applied (>= threshold)", async () => {
  let mergeCalls = 0;
  const mergeFn    = async () => { mergeCalls++; };
  const resolverFn = async () => ({ confidence: CONFIDENCE_THRESHOLD, resolution: {}, summary: "" });
  const escalateFn = async () => {};
  const preCheckFn = () => ({ clean: false, conflicts: [{ file: "x.ts", hunks: [] }] });

  const results = await executeMerges({
    mergeOrder: ["unit-y"],
    runId:      "bgsd-0001-test",
    mergeFn, resolverFn, escalateFn, preCheckFn,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
  });

  assert.equal(mergeCalls, 1, "at-threshold confidence should auto-apply");
  assert.equal(results[0].outcome, "merged");
});

// ---------------------------------------------------------------------------
// Tests — executeMerges: low-confidence escalation (CONFLICT-04, NFR-06)
// ---------------------------------------------------------------------------

process.stdout.write("\n=== executeMerges: low-confidence escalation ===\n");

await test("CF23 — conflict + low-confidence resolver → escalateFn called, outcome='needs_input'", async () => {
  let escalateCalls = 0;
  let mergeCalls    = 0;
  const mergeFn    = async () => { mergeCalls++; };
  const resolverFn = async () => ({ confidence: 0.3, resolution: { strategy: "unsure" }, summary: "uncertain" });
  const escalateFn = async () => { escalateCalls++; };
  const preCheckFn = () => ({ clean: false, conflicts: [{ file: "src/bar.ts", hunks: [] }] });

  const results = await executeMerges({
    mergeOrder: ["unit-z"],
    runId:      "bgsd-0001-test",
    mergeFn, resolverFn, escalateFn, preCheckFn,
  });

  assert.equal(escalateCalls, 1, "escalateFn should be called once");
  assert.equal(results[0].outcome,   "needs_input");
  assert.equal(results[0].escalated, true);
});

await test("CF24 — low-confidence: mergeFn is NOT called (branch held back — NFR-06)", async () => {
  let mergeCalls = 0;
  const mergeFn    = async () => { mergeCalls++; };
  const resolverFn = async () => ({ confidence: 0.1, resolution: {}, summary: "" });
  const escalateFn = async () => {};
  const preCheckFn = () => ({ clean: false, conflicts: [{ file: "src/baz.ts", hunks: [] }] });

  await executeMerges({
    mergeOrder: ["unit-w"],
    runId:      "bgsd-0001-test",
    mergeFn, resolverFn, escalateFn, preCheckFn,
  });

  assert.equal(mergeCalls, 0, "mergeFn must NOT be called for low-confidence resolution");
});

await test("CF25 — low-confidence: escalateFn receives conflicts + resolution", async () => {
  let escalateArgs = null;
  const mergeFn    = async () => {};
  const resolverFn = async () => ({ confidence: 0.2, resolution: { strategy: "manual" }, summary: "needs human" });
  const escalateFn = async (unitId, info) => { escalateArgs = { unitId, info }; };
  const preCheckFn = () => ({
    clean:     false,
    conflicts: [{ file: "src/conflict.ts", hunks: ["<<<<<<< .our\na\n=======\nb\n>>>>>>> .their"] }],
  });

  await executeMerges({
    mergeOrder: ["unit-v"],
    runId:      "bgsd-0001-test",
    mergeFn, resolverFn, escalateFn, preCheckFn,
  });

  assert.ok(escalateArgs,                        "escalateFn should have been called");
  assert.equal(escalateArgs.unitId, "unit-v",    "unitId should be passed to escalateFn");
  assert.ok(escalateArgs.info.conflicts.length > 0, "conflicts should be in escalate info");
  assert.ok(escalateArgs.info.resolution,        "resolution should be in escalate info");
});

// ---------------------------------------------------------------------------
// Tests — executeMerges: mixed (CONFLICT-02..04)
// ---------------------------------------------------------------------------

process.stdout.write("\n=== executeMerges: mixed ===\n");

await test("CF26 — mixed: unit-A clean merged, unit-B low-confidence escalated", async () => {
  const mergedUnits   = [];
  const escalatedUnits = [];

  const mergeFn = async (unitId) => { mergedUnits.push(unitId); };
  const resolverFn = async () => ({ confidence: 0.15, resolution: {}, summary: "" });
  const escalateFn = async (unitId) => { escalatedUnits.push(unitId); };

  // unit-a: clean; unit-b: conflict
  const preCheckFn = (unitId) => {
    if (unitId === "unit-a") return { clean: true, conflicts: [] };
    return { clean: false, conflicts: [{ file: "src/shared.ts", hunks: [] }] };
  };

  const results = await executeMerges({
    mergeOrder: ["unit-a", "unit-b"],
    runId:      "bgsd-0001-test",
    mergeFn, resolverFn, escalateFn, preCheckFn,
  });

  assert.deepEqual(mergedUnits,   ["unit-a"],  "only clean unit should be merged");
  assert.deepEqual(escalatedUnits, ["unit-b"], "conflicted low-confidence unit should be escalated");
  assert.equal(results[0].outcome, "merged");
  assert.equal(results[1].outcome, "needs_input");
  assert.equal(results[1].escalated, true);
});

// ---------------------------------------------------------------------------
// Tests — liveGitMergeFn guard (mirrors loop1-live.mjs pattern)
// ---------------------------------------------------------------------------

process.stdout.write("\n=== liveGitMergeFn guard ===\n");

await test("CF27 — liveGitMergeFn throws without --live in argv", () => {
  // In the test environment, --live is NOT in process.argv
  assert.throws(
    () => liveGitMergeFn("unit-a", "bgsd-0001-test"),
    /HUMAN-GATED/
  );
});

await test("CF28 — isLiveFlagSet() returns false in test environment", () => {
  // --live is not in process.argv when running tests
  assert.equal(isLiveFlagSet(), false);
});

// ---------------------------------------------------------------------------
// Tests — no-silent-green: bad inputs (NFR-06)
// ---------------------------------------------------------------------------

process.stdout.write("\n=== no-silent-green: bad inputs ===\n");

await test("CF29 — executeMerges throws on non-array mergeOrder", async () => {
  await assert.rejects(
    () => executeMerges({
      mergeOrder: null,
      runId:      "x",
      mergeFn:    async () => {},
      resolverFn: async () => {},
      escalateFn: async () => {},
    }),
    /mergeOrder must be an array/
  );
});

await test("CF30 — executeMerges throws on missing mergeFn", async () => {
  await assert.rejects(
    () => executeMerges({
      mergeOrder: [],
      runId:      "x",
      mergeFn:    null,
      resolverFn: async () => {},
      escalateFn: async () => {},
    }),
    /mergeFn must be a function/
  );
});

await test("CF31 — computeMergeOrder throws on non-array waves", () => {
  assert.throws(
    () => computeMergeOrder({ waves: null, unitStatuses: new Map(), edges: new Map() }),
    /waves must be an array/
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write("\n");
process.stdout.write(`Results: ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const { name, err } of failures) {
    process.stdout.write(`  - ${name}\n    ${err.stack ?? err.message}\n`);
  }
  process.exit(1);
}

process.exit(0);
