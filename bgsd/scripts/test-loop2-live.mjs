#!/usr/bin/env node
/**
 * test-loop2-live.mjs — Unit tests for loop2-live.mjs (LOOP2-05, Phase 2)
 *
 * The live seam is now WIRED and runs WITHOUT --live. These tests exercise the
 * real logic under INJECTED spawnImpl/gitImpl mocks — no real claude/bash/git
 * ever runs, and nothing touches the network.
 *
 * Coverage:
 *   Guards
 *     (a) requireNotProductionBranch() blocks "main"/"master" via injected git
 *     (b) requireNotProductionBranch() ALLOWS "next" + feature branches
 *   Boot + Integration Tester (liveVerify)
 *     (c) boots via `bash runtime-isolate.sh up <dir>`, parses PORT, tears down
 *     (d) spawns `claude -p /bgsd-verify <url> --criteria <file>`, returns PASS
 *     (e) returns FAIL + defects from the report on a failing verdict
 *     (f) missing report after Tester success => ERROR (no silent green) + teardown
 *     (g) teardown (`down`) runs even when the Tester spawn fails
 *     (h) parseIsolatePort() extracts the port from a PORT: line
 *   Fix dispatch (liveFix)
 *     (i) creates a worktree + spawns /gsd-quick per defect group with expected argv
 *     (j) throws when a fix spawn exits non-zero
 *   Re-merge (liveReMerge)
 *     (k) dry-run merge-tree then real merge --no-ff for a clean branch
 *     (l) reports conflicts (does NOT force) when merge-tree exits non-zero
 *   No --live required anywhere
 *     (m) liveVerify runs to completion with --live ABSENT from process.argv
 *
 * Uses node:assert — no external deps (NFR-05).
 * Exits non-zero on any failure (no silent green — NFR-06).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the harness so exact-argv assertions are deterministic regardless of the
// runner's environment (a Codex/CI env would otherwise flip detection).
process.env.BGSD_HARNESS = "claude";
process.env.BGSD_NO_CURSOR = "1";
process.env.BGSD_CURSOR = "0";

import {
  isLiveFlagSet,
  requireNotProductionBranch,
  parseIsolatePort,
  groupDefectsForFix,
  liveVerify,
  liveFix,
  liveReMerge,
} from "./loop2-live.mjs";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${label}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${label}\n         ${err.message}\n`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) process.stderr.write(`         ${l.trim()}\n`);
    }
    failed++;
  }
}

async function assertThrows(fn, check) {
  let threw = false;
  let err;
  try {
    await fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  assert.ok(threw, "Expected the function to throw, but it did not");
  if (check) check(err);
  return err;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * A git mock that records every invocation and returns per-branch stub results.
 * The current branch is fixed at "feat/bgsd-v0" (so the production guard passes)
 * unless `branch` is overridden.
 */
function makeGitMock({ branch = "feat/bgsd-v0", results = [], defaultResult } = {}) {
  const calls = [];
  let i = 0;
  const impl = (cmd, args = [], _opts = {}) => {
    calls.push({ cmd, args });
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { status: 0, stdout: `${branch}\n`, stderr: "" };
    }
    if (i < results.length) return results[i++];
    return defaultResult ?? { status: 0, stdout: "", stderr: "" };
  };
  impl.calls = calls;
  return impl;
}

/** A generic spawn mock that records calls and returns queued results. */
function makeSpawnMock(results = [], defaultResult = { status: 0, stdout: "", stderr: "" }) {
  const calls = [];
  let i = 0;
  const impl = (cmd, args = [], _opts = {}) => {
    calls.push({ cmd, args });
    if (i < results.length) return results[i++];
    return defaultResult;
  };
  impl.calls = calls;
  return impl;
}

// A tmp workspace for report files so liveVerify can read a real report on disk.
const WS = mkdtempSync(join(tmpdir(), "loop2-live-test-"));
function writeReport(runId, report) {
  const dir = join(WS, ".bgsd", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "integration-report.json"), JSON.stringify(report), "utf8");
  return join(dir, "integration-report.json");
}

// ---------------------------------------------------------------------------
// (a) requireNotProductionBranch blocks main/master (injected git)
// ---------------------------------------------------------------------------

await test("(a) requireNotProductionBranch() blocks 'main' and 'master' via injected git", async () => {
  for (const bad of ["main", "master"]) {
    await assertThrows(
      () => requireNotProductionBranch({ gitImpl: makeGitMock({ branch: bad }), repoRoot: WS }),
      (err) => {
        assert.ok(err.message.includes("NFR-01"), "should cite NFR-01");
        assert.ok(err.message.includes(`"${bad}"`), `should name "${bad}"`);
      }
    );
  }
});

// ---------------------------------------------------------------------------
// (b) requireNotProductionBranch allows next + feature branches
// ---------------------------------------------------------------------------

await test("(b) requireNotProductionBranch() ALLOWS next + feature branches", async () => {
  for (const ok of ["next", "feat/bgsd-v0", "fix/issue-42"]) {
    // Should NOT throw
    requireNotProductionBranch({ gitImpl: makeGitMock({ branch: ok }), repoRoot: WS });
  }
});

// ---------------------------------------------------------------------------
// (h) parseIsolatePort
// ---------------------------------------------------------------------------

await test("(h) parseIsolatePort() extracts the port from a PORT: line", async () => {
  assert.strictEqual(parseIsolatePort("PORT: 3123\nREADY\n"), 3123);
  assert.strictEqual(parseIsolatePort("Booting...\nPORT: 3999\nDATABASE_URL: file:x\n"), 3999);
  assert.strictEqual(parseIsolatePort("no port here"), null);
});

// ---------------------------------------------------------------------------
// (c) liveVerify boots, parses PORT, tears down
// ---------------------------------------------------------------------------

await test("(c) liveVerify boots via runtime-isolate.sh up, parses PORT, tears down", async () => {
  const runId = "bgsd-0001-boot";
  writeReport(runId, { verdict: "PASS", defects: [], criteria_results: [] });

  const spawn = makeSpawnMock([
    { status: 0, stdout: "PORT: 3123\nREADY\n", stderr: "" }, // up
    { status: 0, stdout: "PASS " + WS + "\n", stderr: "" },   // claude -p /bgsd-verify
    { status: 0, stdout: "", stderr: "" },                    // down
  ]);
  const git = makeGitMock();

  const res = await liveVerify({
    rehearsalBranch: "next",
    runId,
    rehearsalAppDir: "/app/rehearsal",
    integrationCriteria: "/crit/integration.md",
    bgsdDir: join(WS, ".bgsd"),
    repoRoot: WS,
    spawnImpl: spawn,
    gitImpl: git,
  });

  // boot argv
  const up = spawn.calls[0];
  assert.strictEqual(up.cmd, "bash");
  assert.strictEqual(up.args[1], "up");
  assert.strictEqual(up.args[2], "/app/rehearsal");
  assert.ok(up.args[0].endsWith("runtime-isolate.sh"), "boots runtime-isolate.sh");

  // teardown argv (last call)
  const down = spawn.calls[spawn.calls.length - 1];
  assert.strictEqual(down.cmd, "bash");
  assert.strictEqual(down.args[1], "down");
  assert.strictEqual(down.args[2], "/app/rehearsal");

  assert.strictEqual(res.verdict, "PASS");
});

// ---------------------------------------------------------------------------
// (d) liveVerify runs the Integration Tester with the url + criteria argv
// ---------------------------------------------------------------------------

await test("(d) liveVerify spawns `claude -p /bgsd-verify <url> --criteria <file>` and returns PASS", async () => {
  const runId = "bgsd-0002-tester";
  writeReport(runId, { verdict: "PASS", defects: [] });

  const spawn = makeSpawnMock([
    { status: 0, stdout: "PORT: 3200\nREADY\n", stderr: "" },
    { status: 0, stdout: "PASS\n", stderr: "" },
    { status: 0, stdout: "", stderr: "" },
  ]);

  const res = await liveVerify({
    rehearsalBranch: "next",
    runId,
    rehearsalAppDir: "/app",
    integrationCriteria: "/crit/i.md",
    bgsdDir: join(WS, ".bgsd"),
    repoRoot: WS,
    spawnImpl: spawn,
    gitImpl: makeGitMock(),
  });

  const tester = spawn.calls[1];
  assert.strictEqual(tester.cmd, "claude");
  assert.deepStrictEqual(tester.args, [
    "-p", "/bgsd-verify", "--model", "claude-opus-5", "http://localhost:3200", "--criteria", "/crit/i.md",
  ]);
  assert.strictEqual(res.verdict, "PASS");
});

// ---------------------------------------------------------------------------
// (e) liveVerify returns FAIL + defects from the report
// ---------------------------------------------------------------------------

await test("(e) liveVerify returns FAIL + defects from the report", async () => {
  const runId = "bgsd-0003-fail";
  const defects = [{ id: "d1", severity: "high", feature: "auth" }];
  writeReport(runId, {
    verdict: "FAIL",
    defects,
    criteria_results: [{ id: "c1", status: "fail" }],
    integration: { scrutiny: { cross_boundary_uat: true } },
  });

  const spawn = makeSpawnMock([
    { status: 0, stdout: "PORT: 3300\nREADY\n", stderr: "" },
    { status: 0, stdout: "FAIL\n", stderr: "" },
    { status: 0, stdout: "", stderr: "" },
  ]);

  const res = await liveVerify({
    rehearsalBranch: "next",
    runId,
    bgsdDir: join(WS, ".bgsd"),
    repoRoot: WS,
    spawnImpl: spawn,
    gitImpl: makeGitMock(),
  });

  assert.strictEqual(res.verdict, "FAIL");
  assert.deepStrictEqual(res.defects, defects);
  assert.strictEqual(res.scrutiny.cross_boundary_uat, true);
});

// ---------------------------------------------------------------------------
// (f) missing report after Tester success => ERROR (no silent green) + teardown
// ---------------------------------------------------------------------------

await test("(f) missing report after Tester success => ERROR + still tears down", async () => {
  const runId = "bgsd-0004-noreport"; // deliberately no report written

  const spawn = makeSpawnMock([
    { status: 0, stdout: "PORT: 3400\nREADY\n", stderr: "" },
    { status: 0, stdout: "PASS\n", stderr: "" }, // Tester claims success...
    { status: 0, stdout: "", stderr: "" },       // down
  ]);

  const res = await liveVerify({
    rehearsalBranch: "next",
    runId,
    bgsdDir: join(WS, ".bgsd"),
    repoRoot: WS,
    spawnImpl: spawn,
    gitImpl: makeGitMock(),
  });

  assert.strictEqual(res.verdict, "ERROR", "missing report is never a silent green");
  const down = spawn.calls[spawn.calls.length - 1];
  assert.strictEqual(down.args[1], "down", "teardown still runs");
});

// ---------------------------------------------------------------------------
// (g) teardown runs even when the Tester spawn fails
// ---------------------------------------------------------------------------

await test("(g) teardown runs even when the Tester spawn fails", async () => {
  const runId = "bgsd-0005-testerfail";

  const spawn = makeSpawnMock([
    { status: 0, stdout: "PORT: 3500\nREADY\n", stderr: "" }, // up OK
    { status: 1, stdout: "", stderr: "tester crashed" },      // Tester non-zero
    { status: 0, stdout: "", stderr: "" },                    // down MUST still run
  ]);

  const res = await liveVerify({
    rehearsalBranch: "next",
    runId,
    bgsdDir: join(WS, ".bgsd"),
    repoRoot: WS,
    spawnImpl: spawn,
    gitImpl: makeGitMock(),
  });

  assert.strictEqual(res.verdict, "ERROR");
  assert.strictEqual(spawn.calls.length, 3, "up + tester + down");
  assert.strictEqual(spawn.calls[2].args[1], "down", "teardown ran after failure");
});

// ---------------------------------------------------------------------------
// groupDefectsForFix sanity
// ---------------------------------------------------------------------------

await test("groupDefectsForFix groups by feature/file and separates independent items", async () => {
  const groups = groupDefectsForFix([
    { id: "d1", feature: "auth" },
    { id: "d2", feature: "auth" },
    { id: "d3", file: "src/db.ts" },
  ]);
  assert.strictEqual(groups.length, 2, "auth (2 defects) + db file (1)");
});

// ---------------------------------------------------------------------------
// (i) liveFix creates a worktree + spawns /gsd-quick per group with expected argv
// ---------------------------------------------------------------------------

await test("(i) liveFix creates a worktree + spawns /gsd-quick per defect group", async () => {
  const git = makeGitMock({ defaultResult: { status: 0, stdout: "", stderr: "" } });
  const spawn = makeSpawnMock([], { status: 0, stdout: "", stderr: "" });

  const created = await liveFix(
    [{ id: "d1", feature: "auth" }, { id: "d2", file: "src/db.ts" }],
    {
      iteration: 0,
      runId: "bgsd-0006-fix",
      rehearsalBranch: "next",
      rehearsalHead: "next",
      repoRoot: WS,
      worktreeRoot: join(WS, "wt"),
      spawnImpl: spawn,
      gitImpl: git,
    }
  );

  assert.strictEqual(created.length, 2, "one fix branch per group");

  // git worktree add calls (skip the branch --show-current guard call)
  const wtAdds = git.calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.strictEqual(wtAdds.length, 2, "two worktrees created");
  for (const c of wtAdds) {
    assert.strictEqual(c.args[3], "-b", "creates a new branch");
    assert.strictEqual(c.args[5], "next", "based off the rehearsal head");
  }

  // /gsd-quick spawns
  assert.strictEqual(spawn.calls.length, 2, "one /gsd-quick per group");
  for (const c of spawn.calls) {
    assert.strictEqual(c.cmd, "claude");
    assert.strictEqual(c.args[0], "-p");
    assert.strictEqual(c.args[1], "/gsd-quick");
    assert.strictEqual(c.args[2], "--model");
    assert.strictEqual(c.args[3], "claude-opus-5");
    assert.strictEqual(c.args[4], "--worktree");
    assert.ok(typeof c.args[5] === "string" && c.args[5].length > 0, "passes a worktree path");
  }
});

// ---------------------------------------------------------------------------
// (j) liveFix throws when a fix spawn exits non-zero
// ---------------------------------------------------------------------------

await test("(j) liveFix throws when the /gsd-quick spawn exits non-zero", async () => {
  const git = makeGitMock({ defaultResult: { status: 0, stdout: "", stderr: "" } });
  const spawn = makeSpawnMock([{ status: 2, stdout: "", stderr: "boom" }]);

  await assertThrows(
    () =>
      liveFix([{ id: "d1", feature: "auth" }], {
        runId: "bgsd-0007-fixfail",
        rehearsalBranch: "next",
        repoRoot: WS,
        worktreeRoot: join(WS, "wt2"),
        spawnImpl: spawn,
        gitImpl: git,
      }),
    (err) => assert.ok(err.message.includes("/gsd-quick"), "names the failing command")
  );
});

// ---------------------------------------------------------------------------
// (k) liveReMerge dry-run then real merge for a clean branch
// ---------------------------------------------------------------------------

await test("(k) liveReMerge does merge-tree dry-run then merge --no-ff for a clean branch", async () => {
  // Sequence AFTER the branch-guard call: [merge-tree (clean), merge (ok)]
  const git = makeGitMock({
    results: [
      { status: 0, stdout: "", stderr: "" }, // merge-tree clean
      { status: 0, stdout: "", stderr: "" }, // merge --no-ff ok
    ],
  });

  const res = await liveReMerge({
    iteration: 0,
    runId: "bgsd-0008-merge",
    rehearsalBranch: "next",
    fixBranches: [{ branch: "fix/bgsd-0008-i0-auth" }],
    repoRoot: WS,
    gitImpl: git,
  });

  const mergeTree = git.calls.find((c) => c.args[0] === "merge-tree");
  assert.ok(mergeTree, "ran a dry-run merge-tree pre-check");
  assert.strictEqual(mergeTree.args[1], "--write-tree");
  assert.strictEqual(mergeTree.args[3], "next", "base is the rehearsal branch");
  assert.strictEqual(mergeTree.args[4], "fix/bgsd-0008-i0-auth", "then the fix branch");

  const merge = git.calls.find((c) => c.args[0] === "merge" && c.args[1] === "--no-ff");
  assert.ok(merge, "ran a real merge --no-ff after a clean pre-check");

  assert.strictEqual(res.merged.length, 1);
  assert.strictEqual(res.conflicts.length, 0);
});

// ---------------------------------------------------------------------------
// (l) liveReMerge reports conflicts (does NOT force) when merge-tree fails
// ---------------------------------------------------------------------------

await test("(l) liveReMerge reports conflicts and does NOT force a merge", async () => {
  const git = makeGitMock({
    results: [
      { status: 1, stdout: "src/app.ts\nsrc/db.ts\n", stderr: "" }, // merge-tree conflict
    ],
  });

  const res = await liveReMerge({
    runId: "bgsd-0009-conflict",
    rehearsalBranch: "next",
    fixBranches: [{ branch: "fix/bgsd-0009-i0-auth" }],
    repoRoot: WS,
    gitImpl: git,
  });

  assert.strictEqual(res.merged.length, 0, "nothing merged on conflict");
  assert.strictEqual(res.conflicts.length, 1);
  assert.strictEqual(res.conflicts[0].reason, "conflict");
  assert.deepStrictEqual(res.conflicts[0].conflicts, ["src/app.ts", "src/db.ts"]);

  // Crucially: NO real `git merge --no-ff` was attempted.
  const forced = git.calls.find((c) => c.args[0] === "merge" && c.args[1] === "--no-ff");
  assert.ok(!forced, "conflict must NOT trigger a forced merge");
});

// ---------------------------------------------------------------------------
// (m) Nothing requires --live: the whole live path runs with --live absent
// ---------------------------------------------------------------------------

await test("(m) live seam runs with --live ABSENT (no gate)", async () => {
  assert.strictEqual(isLiveFlagSet(), false, "test env has no --live flag");

  const runId = "bgsd-0010-nolive";
  writeReport(runId, { verdict: "PASS", defects: [] });

  const spawn = makeSpawnMock([
    { status: 0, stdout: "PORT: 3600\nREADY\n", stderr: "" },
    { status: 0, stdout: "PASS\n", stderr: "" },
    { status: 0, stdout: "", stderr: "" },
  ]);

  // No throw despite --live being absent from process.argv.
  const res = await liveVerify({
    rehearsalBranch: "next",
    runId,
    bgsdDir: join(WS, ".bgsd"),
    repoRoot: WS,
    spawnImpl: spawn,
    gitImpl: makeGitMock(),
  });
  assert.strictEqual(res.verdict, "PASS", "live seam completed with no --live gate");
});

// ---------------------------------------------------------------------------
// Cleanup + final report
// ---------------------------------------------------------------------------

try { rmSync(WS, { recursive: true, force: true }); } catch (_) {}

process.stdout.write(`\n${"=".repeat(60)}\n`);
process.stdout.write(`test-loop2-live: ${passed} passed, ${failed} failed\n`);
process.stdout.write(`${"=".repeat(60)}\n\n`);

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
