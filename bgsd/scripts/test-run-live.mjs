#!/usr/bin/env node
/**
 * test-run-live.mjs — Unit tests for the WIRED live seam in run-live.mjs
 *                     (SPAWN-04 / CONFLICT-01/02 / NFR-01 / NFR-06)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-run-live.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Everything is fully mocked — NEVER spawns a real `claude`, NEVER runs a real
 * `git worktree`/merge, NEVER hits the network:
 *   - spawnImpl / gitImpl are injected mocks that record calls + return {status:0}.
 *   - The git branch-check is injected too, so a production-branch refusal is
 *     forced WITHOUT a real checkout.
 *   - Filesystem I/O uses OS temp dirs, cleaned up after each test.
 *
 * Test groups:
 *   L01 — liveSpawnFn creates the worktree via git (git worktree add HEAD)
 *   L02 — liveSpawnFn writes .planning/config.json (both bgsd seams)
 *   L03 — liveSpawnFn writes .planning/bgsd-unit.json brief
 *   L04 — liveSpawnFn writes the agent control file
 *   L05 — liveSpawnFn spawns `claude -p /bgsd-run-agent` with the EXACT argv
 *   L06 — liveSpawnFn throws if git worktree add fails (NFR-06)
 *   L07 — liveSpawnFn falls back to reading the unit + scale from disk
 *   L08 — liveMergeFn: clean dry-run → real merge → { merged: true }
 *   L09 — liveMergeFn: conflicting dry-run → { merged: false, reason } (no merge)
 *   L10 — NFR-01: liveSpawnFn refuses on a production branch
 *   L11 — NFR-01: liveMergeFn refuses on a production branch
 *   L12 — neither liveSpawnFn nor liveMergeFn requires --live (gate removed)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { liveSpawnFn, liveMergeFn } from "./run-live.mjs";
import { persistRunUnits } from "./run-units.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-phaseconfig.mjs) — with async support
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${err.message}\n`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "bgsd-run-live-"));
}

const FEATURE_BRANCH = "feat/bgsd-v0";

/**
 * Build an injectable git mock that dispatches on argv.
 *   - `git branch --show-current` → returns { stdout: branch }
 *   - anything else               → returns { status } and records the call
 *
 * @param {object} [o]
 * @param {string} [o.branch]       what the branch-check reports (default a feature branch)
 * @param {number} [o.status]       status for non-branch git calls (default 0)
 * @param {string} [o.mergeTreeOut] stdout for `git merge-tree` (conflict paths)
 * @param {number} [o.mergeTreeStatus] status for `git merge-tree` (0 clean, !=0 conflict)
 */
function makeGitMock({ branch = FEATURE_BRANCH, status = 0, mergeTreeOut = "", mergeTreeStatus = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { status: 0, stdout: branch, stderr: "" };
    }
    if (args[0] === "merge-tree") {
      return { status: mergeTreeStatus, stdout: mergeTreeOut, stderr: "" };
    }
    return { status, stdout: "", stderr: "" };
  };
  impl.calls = calls;
  return impl;
}

/** Build an injectable claude spawn mock that records its argv. */
function makeSpawnMock({ status = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status, stdout: "", stderr: "" };
  };
  impl.calls = calls;
  return impl;
}

const UNIT = {
  id: "unit-add-auth-ab12",
  title: "Add user authentication",
  scope: "Wire up login + session.",
  touched: ["src/auth/login.ts"],
  deps: [],
  difficulty: 0.62,
  criteria: ["users can log in", "sessions persist"],
  model_posture: {
    executor: { model: "opus", effort: "xhigh" },
    researcher: { model: "sonnet", effort: "xhigh" },
    verifier: { model: "haiku", effort: "low" },
  },
};

const PLAN = { path: "", branch: "run/unit-add-auth-ab12", port: 3157 };

// ---------------------------------------------------------------------------
// liveSpawnFn — happy path
// ---------------------------------------------------------------------------

await test("L01–L05: liveSpawnFn creates worktree, writes seams+brief+control, spawns claude with EXACT argv", async () => {
  const bgsdDir = makeTmpDir();
  const wtPath  = join(makeTmpDir(), "wt");
  const plan    = { ...PLAN, path: wtPath };
  const gitImpl = makeGitMock();
  const spawnImpl = makeSpawnMock();
  const runId = "bgsd-0001-add-auth";

  try {
    await liveSpawnFn(UNIT.id, plan, {
      runId,
      scale: "feature",
      unit: UNIT,
      bgsdDir,
      repoRoot: bgsdDir, // env propagation reads root; empty root is fine (no .env)
      gitImpl,
      spawnImpl,
    });

    // L01 — worktree created via git worktree add ... HEAD
    const wtCall = gitImpl.calls.find((c) => c.args[0] === "worktree");
    assert.ok(wtCall, "git worktree add must be called");
    assert.deepEqual(wtCall.args, ["worktree", "add", wtPath, "-b", plan.branch, "HEAD"]);

    // L02 — .planning/config.json has BOTH bgsd seams
    const cfgPath = join(wtPath, ".planning", "config.json");
    assert.ok(existsSync(cfgPath), ".planning/config.json must exist");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.ok(cfg.bgsd_unit_posture, "bgsd_unit_posture seam present");
    assert.equal(cfg.bgsd_unit_posture.unit_id, UNIT.id);
    assert.equal(cfg.bgsd_unit_posture.executor.model, "opus");
    assert.ok(cfg.bgsd_phase_config, "bgsd_phase_config seam present");
    assert.equal(cfg.bgsd_phase_config.unit_id, UNIT.id);

    // L03 — .planning/bgsd-unit.json brief
    const briefPath = join(wtPath, ".planning", "bgsd-unit.json");
    assert.ok(existsSync(briefPath), "bgsd-unit.json must exist");
    const brief = JSON.parse(readFileSync(briefPath, "utf8"));
    assert.equal(brief.unit_id, UNIT.id);
    assert.equal(brief.run_id, runId);
    assert.equal(brief.scale, "feature");
    assert.equal(brief.title, UNIT.title);
    assert.equal(brief.scope, UNIT.scope);
    assert.deepEqual(brief.criteria, UNIT.criteria);
    assert.deepEqual(brief.touched, UNIT.touched);

    // L04 — control file written under .bgsd/runs/<runId>/control/<unitId>.json
    const controlPath = join(bgsdDir, "runs", runId, "control", `${UNIT.id}.json`);
    assert.ok(existsSync(controlPath), "control file must exist");
    const cf = JSON.parse(readFileSync(controlPath, "utf8"));
    assert.equal(cf.agent_id, UNIT.id);
    assert.equal(cf.run_id, runId);
    assert.equal(cf.worktree, wtPath);
    assert.equal(cf.branch, plan.branch);
    assert.equal(cf.unit_id, UNIT.id);
    assert.equal(cf.phase, "plan");
    assert.equal(cf.status, "running");

    // L05 — claude -p /bgsd-run-agent spawned with the EXACT argv
    assert.equal(spawnImpl.calls.length, 1, "exactly one claude spawn");
    const call = spawnImpl.calls[0];
    assert.equal(call.cmd, "claude");
    assert.deepEqual(call.args, [
      "-p", "/bgsd-run-agent",
      "--worktree", wtPath,
      "--unit-id", UNIT.id,
      "--run-id", runId,
      "--control-file", controlPath,
      "--scale", "feature",
      "--port", "3157",
    ]);
    assert.equal(call.opts.cwd, wtPath, "spawn cwd must be the worktree");
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
    rmSync(wtPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// liveSpawnFn — failure + fallback
// ---------------------------------------------------------------------------

await test("L06: liveSpawnFn throws if git worktree add fails (NFR-06)", async () => {
  const bgsdDir = makeTmpDir();
  const wtPath  = join(makeTmpDir(), "wt");
  const plan    = { ...PLAN, path: wtPath };
  // Branch check clean, but non-branch git calls fail with status 1.
  const gitImpl = makeGitMock({ status: 1 });
  const spawnImpl = makeSpawnMock();
  try {
    await assert.rejects(
      () => liveSpawnFn(UNIT.id, plan, {
        runId: "bgsd-0001-x", scale: "feature", unit: UNIT,
        bgsdDir, repoRoot: bgsdDir, gitImpl, spawnImpl,
      }),
      /git worktree add failed/i
    );
    // No claude spawn if the worktree failed.
    assert.equal(spawnImpl.calls.length, 0, "claude must NOT spawn after worktree failure");
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
    rmSync(wtPath, { recursive: true, force: true });
  }
});

await test("L07: liveSpawnFn falls back to reading the unit + scale from disk", async () => {
  const bgsdDir = makeTmpDir();
  const wtPath  = join(makeTmpDir(), "wt");
  const plan    = { ...PLAN, path: wtPath };
  const gitImpl = makeGitMock();
  const spawnImpl = makeSpawnMock();
  const runId = "bgsd-0007-fallback";

  try {
    // Persist the unit + scale — but DO NOT pass unit/scale in opts.
    persistRunUnits(runId, [UNIT], { bgsdDir, scale: "project" });

    await liveSpawnFn(UNIT.id, plan, {
      runId, bgsdDir, repoRoot: bgsdDir, gitImpl, spawnImpl,
    });

    // Brief must reflect the disk-read unit + scale.
    const brief = JSON.parse(readFileSync(join(wtPath, ".planning", "bgsd-unit.json"), "utf8"));
    assert.equal(brief.title, UNIT.title, "title came from disk-read unit");
    assert.equal(brief.scale, "project", "scale came from disk-read _meta");

    // Spawn argv used the disk-read scale.
    const call = spawnImpl.calls[0];
    assert.ok(call.args.includes("project"), "spawn used the disk-read scale");
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
    rmSync(wtPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// liveMergeFn — dry-run then merge
// ---------------------------------------------------------------------------

await test("L08: liveMergeFn clean dry-run → real merge → { merged: true }", async () => {
  const gitImpl = makeGitMock({ mergeTreeStatus: 0 });
  const res = await liveMergeFn("u1", "bgsd-0001-x", { branch: "run/u1" }, {
    repoRoot: "/tmp/fake-repo", gitImpl,
  });
  assert.deepEqual(res, { merged: true });
  // A merge-tree dry-run AND a real merge were both issued.
  const mergeTree = gitImpl.calls.find((c) => c.args[0] === "merge-tree");
  const realMerge = gitImpl.calls.find((c) => c.args[0] === "merge" && c.args[1] === "--no-ff");
  assert.ok(mergeTree, "dry-run merge-tree must run first");
  assert.ok(realMerge, "real merge must run after a clean pre-check");
});

await test("L09: liveMergeFn conflicting dry-run → { merged: false, reason } (no real merge)", async () => {
  const gitImpl = makeGitMock({ mergeTreeStatus: 1, mergeTreeOut: "src/auth/login.ts\nsrc/db.ts" });
  const res = await liveMergeFn("u1", "bgsd-0001-x", { branch: "run/u1" }, {
    repoRoot: "/tmp/fake-repo", gitImpl,
  });
  assert.equal(res.merged, false, "conflicting pre-check must NOT claim a clean merge");
  assert.equal(res.reason, "conflict");
  assert.deepEqual(res.conflicts, ["src/auth/login.ts", "src/db.ts"]);
  // No real `git merge --no-ff` was issued.
  const realMerge = gitImpl.calls.find((c) => c.args[0] === "merge" && c.args[1] === "--no-ff");
  assert.ok(!realMerge, "no real merge on conflict");
});

// ---------------------------------------------------------------------------
// NFR-01 — production-branch refusal (BOTH functions)
// ---------------------------------------------------------------------------

await test("L10: NFR-01 — liveSpawnFn refuses on a production branch", async () => {
  // PRODUCTION_BRANCHES is ["main","master"] — `next` is the standing integration
  // branch (the merge TARGET), so it is intentionally not blocked here.
  const gitImpl = makeGitMock({ branch: "main" }); // force production branch
  const spawnImpl = makeSpawnMock();
  await assert.rejects(
    () => liveSpawnFn(UNIT.id, { ...PLAN, path: "/tmp/nope" }, {
      runId: "bgsd-0001-x", unit: UNIT, bgsdDir: "/tmp/nope-bgsd",
      repoRoot: "/tmp/nope", gitImpl, spawnImpl,
    }),
    /NFR-01/i
  );
  // Refused before ever spawning claude or adding a worktree.
  assert.equal(spawnImpl.calls.length, 0, "no claude spawn on production branch");
  assert.ok(!gitImpl.calls.some((c) => c.args[0] === "worktree"), "no worktree on production branch");
});

await test("L11: NFR-01 — liveMergeFn refuses on a production branch", async () => {
  const gitImpl = makeGitMock({ branch: "main" }); // force production branch
  await assert.rejects(
    () => liveMergeFn("u1", "bgsd-0001-x", { branch: "run/u1" }, {
      repoRoot: "/tmp/nope", gitImpl,
    }),
    /NFR-01/i
  );
  assert.ok(!gitImpl.calls.some((c) => c.args[0] === "merge-tree"), "no dry-run on production branch");
});

// ---------------------------------------------------------------------------
// SPAWN-04 — the --live gate is GONE for both functions
// ---------------------------------------------------------------------------

await test("L12: neither liveSpawnFn nor liveMergeFn requires --live (no HUMAN-GATED refusal)", async () => {
  // We are running WITHOUT --live in argv. If the gate were still present these
  // would reject with /HUMAN-GATED/. Instead they run to completion / their own
  // guards. (liveMergeFn happy path is the clearest proof.)
  assert.ok(!process.argv.includes("--live"), "sanity: --live is not set in this test run");
  const gitImpl = makeGitMock({ mergeTreeStatus: 0 });
  const res = await liveMergeFn("u1", "bgsd-0001-x", { branch: "run/u1" }, {
    repoRoot: "/tmp/fake-repo", gitImpl,
  });
  assert.deepEqual(res, { merged: true }, "liveMergeFn ran without --live");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\nrun-live.mjs (wired seam): ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
