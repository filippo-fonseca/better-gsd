#!/usr/bin/env node
/**
 * test-loop1-live.mjs — Unit tests for loop1-live.mjs (Phase 3 live seam)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-loop1-live.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * NEVER spawns a real `claude` and NEVER hits the network: every test injects
 * a mock spawnImpl that records argv + opts and returns a controllable result,
 * plus a mock verification-report.json on disk so liveVerify can read a PASS,
 * a FAIL, or a missing report. The `--live` gate is gone — these tests run
 * with no --live in process.argv and prove the seam fires anyway.
 *
 * Test groups:
 *   V01 — liveVerify spawns `claude -p /bgsd-verify` with --boot + --criteria
 *   V02 — liveVerify default usage/headless flags: full mode, no headless
 *   V03 — liveVerify code-only (usageTesting=false) adds --no-usage-verification
 *   V04 — liveVerify headless (headlessUi=true) adds --headless-ui
 *   V05 — liveVerify reads a PASS report and returns verdict PASS, no defects
 *   V06 — liveVerify reads a FAIL report and returns verdict FAIL + defects
 *   V07 — liveVerify: missing report after spawn -> ERROR (no silent green)
 *   V08 — liveVerify: spawn error throws (NFR-06)
 *   V09 — liveVerify appDir override boots the given dir, not the worktree
 *   F01 — liveFix spawns `claude -p <gsdCommand> --worktree ...` with args
 *   F02 — liveFix writes defects-for-fix.json context file
 *   F03 — liveFix throws on non-zero exit (NFR-06)
 *   F04 — liveFix throws on spawn error (NFR-06)
 *   F05 — liveFix defaults gsd_command to /gsd-quick when absent
 *   G01 — isLiveFlagSet() is false during tests; seam does NOT require --live
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// Pin the harness so exact-argv assertions are deterministic regardless of the
// runner's environment (a Codex/CI env would otherwise flip detection).
process.env.BGSD_HARNESS = "claude";
process.env.BGSD_NO_CURSOR = "1";
process.env.BGSD_CURSOR = "0";

import { liveVerify, liveFix, isLiveFlagSet } from "./loop1-live.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test harness (mirrors test-phaseconfig.mjs)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock spawnImpl that records every call and returns a fixed result.
 * @param {object} [result]  what the mock returns (default { status: 0 })
 * @returns {{ mock: Function, calls: object[] }}
 */
function makeSpawnMock(result = { status: 0 }) {
  const calls = [];
  const mock = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { mock, calls };
}

/**
 * Write a mock verification-report.json into a worktree at the runId path
 * where /bgsd-verify would write it.
 * @returns {string} the report path
 */
function writeMockReport(worktreePath, runId, report) {
  const runsDir = join(worktreePath, ".bgsd", "runs", runId);
  mkdirSync(runsDir, { recursive: true });
  const p = join(runsDir, "verification-report.json");
  writeFileSync(p, JSON.stringify(report), "utf8");
  return p;
}

function makeWorktree() {
  return mkdtempSync(join(tmpdir(), "bgsd-loop1-live-"));
}

// ---------------------------------------------------------------------------
// liveVerify — argv shape
// ---------------------------------------------------------------------------

await test("V01: liveVerify spawns `claude -p /bgsd-verify` with --boot + --criteria", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v01";
    writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock, calls } = makeSpawnMock({ status: 0 });

    await liveVerify({
      worktreePath: wt,
      runId,
      criteriaFile: "/tmp/criteria.md",
      spawnImpl: mock,
    });

    assert.equal(calls.length, 1, "liveVerify must spawn exactly once");
    const { cmd, args, opts } = calls[0];
    assert.equal(cmd, "claude", "must spawn claude");
    assert.equal(args[0], "-p", "first arg is -p");
    assert.equal(args[1], "/bgsd-verify", "second arg is /bgsd-verify");
    // --boot <worktree>
    const bootIdx = args.indexOf("--boot");
    assert.ok(bootIdx >= 0, "must pass --boot");
    assert.equal(args[bootIdx + 1], wt, "--boot value is the worktree by default");
    // --criteria <file>
    const critIdx = args.indexOf("--criteria");
    assert.ok(critIdx >= 0, "must pass --criteria");
    assert.equal(args[critIdx + 1], "/tmp/criteria.md", "--criteria value is the file");
    // cwd is the worktree
    assert.equal(opts.cwd, wt, "spawn cwd is the worktree");
    assert.equal(opts.stdio, "inherit", "stdio is inherit");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V02: liveVerify default usage/headless -> full mode, no --no-usage/--headless flags", async () => {
  const wt = makeWorktree();
  const prevUsage = process.env.BGSD_USAGE_TESTING;
  const prevHeadless = process.env.BGSD_HEADLESS_UI;
  try {
    delete process.env.BGSD_USAGE_TESTING; // unset -> full mode default
    delete process.env.BGSD_HEADLESS_UI;   // unset -> not headless
    const runId = "r-v02";
    writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock, calls } = makeSpawnMock({ status: 0 });

    await liveVerify({ worktreePath: wt, runId, spawnImpl: mock });

    const { args, opts } = calls[0];
    assert.ok(!args.includes("--no-usage-verification"), "full mode: no --no-usage-verification");
    assert.ok(!args.includes("--headless-ui"), "not headless: no --headless-ui");
    // env still carries the posture
    assert.equal(opts.env.BGSD_USAGE_TESTING, "1", "env BGSD_USAGE_TESTING=1 in full mode");
    assert.equal(opts.env.BGSD_HEADLESS_UI, "0", "env BGSD_HEADLESS_UI=0 when not headless");
  } finally {
    if (prevUsage === undefined) delete process.env.BGSD_USAGE_TESTING; else process.env.BGSD_USAGE_TESTING = prevUsage;
    if (prevHeadless === undefined) delete process.env.BGSD_HEADLESS_UI; else process.env.BGSD_HEADLESS_UI = prevHeadless;
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V03: liveVerify code-only (usageTesting=false) adds --no-usage-verification", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v03";
    writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock, calls } = makeSpawnMock({ status: 0 });

    await liveVerify({ worktreePath: wt, runId, usageTesting: false, spawnImpl: mock });

    const { args, opts } = calls[0];
    assert.ok(args.includes("--no-usage-verification"), "code-only adds --no-usage-verification");
    assert.equal(opts.env.BGSD_USAGE_TESTING, "0", "env BGSD_USAGE_TESTING=0 in code-only mode");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V04: liveVerify headless (headlessUi=true) adds --headless-ui", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v04";
    writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock, calls } = makeSpawnMock({ status: 0 });

    await liveVerify({ worktreePath: wt, runId, headlessUi: true, spawnImpl: mock });

    const { args, opts } = calls[0];
    assert.ok(args.includes("--headless-ui"), "headless adds --headless-ui");
    assert.equal(opts.env.BGSD_HEADLESS_UI, "1", "env BGSD_HEADLESS_UI=1 when headless");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// liveVerify — report read / verdict
// ---------------------------------------------------------------------------

await test("V05: liveVerify reads a PASS report and returns verdict PASS, no defects", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v05";
    const reportPath = writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock } = makeSpawnMock({ status: 0 });

    const result = await liveVerify({ worktreePath: wt, runId, spawnImpl: mock });

    assert.equal(result.verdict, "PASS", "verdict must be PASS");
    assert.deepEqual(result.defects, [], "no defects on PASS");
    assert.equal(result.reportPath, reportPath, "reportPath points at the report");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V06: liveVerify reads a FAIL report and returns verdict FAIL + defects", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v06";
    const defects = [
      { id: "DEF-01", severity: "high", source: "console", description: "boom" },
      { id: "DEF-02", severity: "medium", source: "dom", description: "missing node" },
    ];
    const reportPath = writeMockReport(wt, runId, { verdict: "FAIL", defects });
    const { mock } = makeSpawnMock({ status: 0 });

    const result = await liveVerify({ worktreePath: wt, runId, spawnImpl: mock });

    assert.equal(result.verdict, "FAIL", "verdict must be FAIL");
    assert.equal(result.defects.length, 2, "both defects surfaced");
    assert.equal(result.defects[0].id, "DEF-01");
    assert.equal(result.reportPath, reportPath, "reportPath points at the report");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V07: liveVerify missing report after spawn -> ERROR (no silent green)", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v07";
    // Deliberately do NOT write a report. Mock claims success (status 0).
    const { mock } = makeSpawnMock({ status: 0 });

    const result = await liveVerify({ worktreePath: wt, runId, spawnImpl: mock });

    assert.equal(result.verdict, "ERROR", "missing report is ERROR, never a silent PASS");
    assert.deepEqual(result.defects, [], "no defects on ERROR");
    assert.equal(result.reportPath, null, "reportPath is null when report is missing");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V08: liveVerify throws when the spawn errors (NFR-06)", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v08";
    const { mock } = makeSpawnMock({ error: new Error("ENOENT: claude not found") });

    await assert.rejects(
      () => liveVerify({ worktreePath: wt, runId, spawnImpl: mock }),
      /failed to spawn/,
      "liveVerify must throw on spawn error"
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("V09: liveVerify appDir override boots the given dir, not the worktree", async () => {
  const wt = makeWorktree();
  try {
    const runId = "r-v09";
    writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock, calls } = makeSpawnMock({ status: 0 });

    await liveVerify({ worktreePath: wt, runId, appDir: "/some/app", spawnImpl: mock });

    const { args } = calls[0];
    const bootIdx = args.indexOf("--boot");
    assert.equal(args[bootIdx + 1], "/some/app", "--boot value is the explicit appDir");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// liveFix
// ---------------------------------------------------------------------------

await test("F01: liveFix spawns `claude -p <gsdCommand> --worktree ...` with args", async () => {
  const wt = makeWorktree();
  try {
    const { mock, calls } = makeSpawnMock({ status: 0 });
    const item = { id: "item-f01", gsd_command: "/gsd-quick" };
    const defects = [{ id: "DEF-01", description: "x" }];

    await liveFix(defects, { effort: "high", model: "opus" }, {
      worktreePath: wt,
      item,
      runId: "r-f01",
      spawnImpl: mock,
    });

    assert.equal(calls.length, 1, "liveFix must spawn exactly once");
    const { cmd, args, opts } = calls[0];
    assert.equal(cmd, "claude", "must spawn claude");
    assert.deepEqual(
      args,
      ["-p", "/gsd-quick", "--model", "claude-opus-5", "--worktree", wt, "--effort", "high", "--model-profile", "opus"],
      "argv matches the gsd fix contract"
    );
    assert.equal(opts.cwd, wt, "spawn cwd is the worktree");
    assert.equal(opts.stdio, "inherit", "stdio is inherit");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("F02: liveFix writes defects-for-fix.json context file", async () => {
  const wt = makeWorktree();
  try {
    const { mock } = makeSpawnMock({ status: 0 });
    const item = { id: "item-f02", gsd_command: "/gsd-quick" };
    const defects = [{ id: "DEF-01", description: "x" }, { id: "DEF-02", description: "y" }];

    await liveFix(defects, { effort: "medium", model: "balanced" }, {
      worktreePath: wt,
      item,
      runId: "r-f02",
      spawnImpl: mock,
    });

    const ctxPath = join(wt, ".bgsd", "runs", "r-f02", "defects-for-fix.json");
    assert.ok(existsSync(ctxPath), "defects-for-fix.json must be written");
    const ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
    assert.equal(ctx.gsd_command, "/gsd-quick");
    assert.equal(ctx.effort, "medium");
    assert.equal(ctx.model, "balanced");
    assert.equal(ctx.defect_count, 2);
    assert.equal(ctx.defects.length, 2);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("F03: liveFix throws on non-zero exit (NFR-06)", async () => {
  const wt = makeWorktree();
  try {
    const { mock } = makeSpawnMock({ status: 2, stderr: "gsd blew up" });
    const item = { id: "item-f03", gsd_command: "/gsd-quick" };

    await assert.rejects(
      () => liveFix([], {}, { worktreePath: wt, item, runId: "r-f03", spawnImpl: mock }),
      /exited non-zero/,
      "liveFix must throw when the fix command exits non-zero"
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("F04: liveFix throws on spawn error (NFR-06)", async () => {
  const wt = makeWorktree();
  try {
    const { mock } = makeSpawnMock({ error: new Error("ENOENT: claude not found") });
    const item = { id: "item-f04", gsd_command: "/gsd-quick" };

    await assert.rejects(
      () => liveFix([], {}, { worktreePath: wt, item, runId: "r-f04", spawnImpl: mock }),
      /failed to spawn/,
      "liveFix must throw on spawn error"
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

await test("F05: liveFix defaults gsd_command to /gsd-quick and effort/model when absent", async () => {
  const wt = makeWorktree();
  try {
    const { mock, calls } = makeSpawnMock({ status: 0 });
    const item = { id: "item-f05" }; // no gsd_command

    await liveFix([], undefined, { worktreePath: wt, item, runId: "r-f05", spawnImpl: mock });

    const { args } = calls[0];
    assert.equal(args[1], "/gsd-quick", "defaults command to /gsd-quick");
    const effIdx = args.indexOf("--effort");
    assert.equal(args[effIdx + 1], "medium", "defaults effort to medium");
    const modIdx = args.indexOf("--model-profile");
    assert.equal(args[modIdx + 1], "balanced", "defaults model to balanced");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gate removal
// ---------------------------------------------------------------------------

await test("G01: isLiveFlagSet() is false during tests; the seam runs WITHOUT --live", async () => {
  assert.equal(isLiveFlagSet(), false, "no --live in process.argv during tests");
  // The proof that the gate is gone: V01..F05 all executed spawns with no --live
  // and never threw a HUMAN-GATED refusal. Assert the happy path once more here.
  const wt = makeWorktree();
  try {
    const runId = "r-g01";
    writeMockReport(wt, runId, { verdict: "PASS", defects: [] });
    const { mock } = makeSpawnMock({ status: 0 });
    const result = await liveVerify({ worktreePath: wt, runId, spawnImpl: mock });
    assert.equal(result.verdict, "PASS", "seam ran and returned PASS without --live");
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary (no silent green — NFR-06)
// ---------------------------------------------------------------------------

process.stdout.write(`\nloop1-live.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
