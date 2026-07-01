#!/usr/bin/env node
/**
 * test-run-units.mjs — Unit tests for run-units.mjs (SPAWN-04 threading helper)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-run-units.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Test groups:
 *   U01 — persistRunUnits → readRunUnit round-trips a FULL unit (all fields)
 *   U02 — readRunScale returns the persisted scale
 *   U03 — readRunUnit returns null for a missing unit
 *   U04 — readRunScale returns null when no run persisted
 *   U05 — persistRunUnits writes atomically + _meta lists unit ids in order
 *   U06 — persistRunUnits rejects a unit without an id (NFR-06)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  persistRunUnits,
  readRunUnit,
  readRunScale,
  runUnitsDir,
} from "./run-units.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-phaseconfig.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
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
  return mkdtempSync(join(tmpdir(), "bgsd-run-units-"));
}

const FULL_UNIT = {
  id: "unit-add-auth-ab12",
  title: "Add user authentication",
  scope: "Wire up login, session, and logout across the app.",
  touched: ["src/auth/login.ts", "src/auth/session.ts"],
  deps: ["unit-db-schema-cd34"],
  difficulty: 0.62,
  criteria: ["users can log in", "sessions persist", "logout clears session"],
  model_posture: {
    executor: { model: "opus", effort: "xhigh" },
    researcher: { model: "sonnet", effort: "xhigh" },
    verifier: { model: "haiku", effort: "low" },
  },
};

// ---------------------------------------------------------------------------

test("U01: persistRunUnits → readRunUnit round-trips a FULL unit", () => {
  const bgsdDir = makeTmpDir();
  try {
    persistRunUnits("bgsd-0001-add-auth", [FULL_UNIT], { bgsdDir, scale: "feature" });
    const read = readRunUnit("bgsd-0001-add-auth", FULL_UNIT.id, { bgsdDir });
    assert.deepEqual(read, FULL_UNIT, "the full unit must round-trip byte-for-byte");
    // Deep fields survive
    assert.equal(read.model_posture.executor.model, "opus");
    assert.deepEqual(read.criteria, FULL_UNIT.criteria);
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

test("U02: readRunScale returns the persisted scale", () => {
  const bgsdDir = makeTmpDir();
  try {
    persistRunUnits("bgsd-0002-thing", [FULL_UNIT], { bgsdDir, scale: "project" });
    assert.equal(readRunScale("bgsd-0002-thing", { bgsdDir }), "project");
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

test("U03: readRunUnit returns null for a missing unit", () => {
  const bgsdDir = makeTmpDir();
  try {
    persistRunUnits("bgsd-0003-x", [FULL_UNIT], { bgsdDir, scale: "quick" });
    assert.equal(readRunUnit("bgsd-0003-x", "unit-does-not-exist", { bgsdDir }), null);
    // Missing run entirely also returns null.
    assert.equal(readRunUnit("bgsd-9999-nope", FULL_UNIT.id, { bgsdDir }), null);
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

test("U04: readRunScale returns null when no run persisted", () => {
  const bgsdDir = makeTmpDir();
  try {
    assert.equal(readRunScale("bgsd-0004-empty", { bgsdDir }), null);
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

test("U05: persistRunUnits writes files + _meta lists unit ids in order", () => {
  const bgsdDir = makeTmpDir();
  try {
    const u2 = { ...FULL_UNIT, id: "unit-second-ff99", title: "Second" };
    const res = persistRunUnits("bgsd-0005-multi", [FULL_UNIT, u2], { bgsdDir, scale: "feature" });
    assert.deepEqual(res.unit_ids, [FULL_UNIT.id, u2.id]);
    assert.equal(res.scale, "feature");
    const dir = runUnitsDir("bgsd-0005-multi", { bgsdDir });
    assert.ok(existsSync(join(dir, `${FULL_UNIT.id}.json`)), "unit 1 file exists");
    assert.ok(existsSync(join(dir, `${u2.id}.json`)), "unit 2 file exists");
    assert.ok(existsSync(join(dir, "_meta.json")), "_meta.json exists");
    // No leftover temp files.
    assert.ok(!existsSync(join(dir, `${FULL_UNIT.id}.json.tmp`)), "no temp file left behind");
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

test("U06: persistRunUnits rejects a unit without an id (NFR-06)", () => {
  const bgsdDir = makeTmpDir();
  try {
    assert.throws(
      () => persistRunUnits("bgsd-0006-bad", [{ title: "no id" }], { bgsdDir, scale: "feature" }),
      /must be an object with an id/i
    );
    // Missing scale defaults to null (not an error).
    persistRunUnits("bgsd-0006-ok", [FULL_UNIT], { bgsdDir });
    assert.equal(readRunScale("bgsd-0006-ok", { bgsdDir }), null);
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\nrun-units.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
