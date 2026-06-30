#!/usr/bin/env node
/**
 * test-integration.mjs — Unit tests for integration.mjs (Phase 2 topology).
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-integration.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  INTEGRATION_BRANCH_DEFAULT,
  PRODUCTION_BRANCHES,
  resolveIntegrationBranch,
  integrationBranchForRun,
  isProductionBranch,
  requireNotProductionBranch,
} from "./integration.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
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

test("G01 — default integration branch is next", () => {
  assert.equal(INTEGRATION_BRANCH_DEFAULT, "next");
  assert.equal(resolveIntegrationBranch(), "next");
});

test("G02 — explicit override wins", () => {
  assert.equal(resolveIntegrationBranch({ integrationBranch: "develop" }), "develop");
});

test("G03 — config override", () => {
  assert.equal(
    resolveIntegrationBranch({ config: { integration_branch: "trunk-int" } }),
    "trunk-int"
  );
});

test("G04 — reads BGSD.md from repoRoot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-int-"));
  try {
    writeFileSync(
      join(dir, "BGSD.md"),
      '```json bgsd-settings\n{ "integration_branch": "staging" }\n```\n'
    );
    assert.equal(resolveIntegrationBranch({ repoRoot: dir }), "staging");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G05 — integrationBranchForRun ignores runId, returns next", () => {
  assert.equal(integrationBranchForRun("bgsd-0001-foo"), "next");
  assert.equal(integrationBranchForRun("bgsd-0002-bar", { integrationBranch: "x" }), "x");
});

test("G06 — isProductionBranch covers main/master + extras", () => {
  assert.equal(isProductionBranch("main"), true);
  assert.equal(isProductionBranch("master"), true);
  assert.equal(isProductionBranch("next"), false);
  assert.equal(isProductionBranch("trunk", ["trunk"]), true);
  assert.deepEqual([...PRODUCTION_BRANCHES], ["main", "master"]);
});

test("G07 — requireNotProductionBranch throws on main/master, allows next", () => {
  assert.throws(() => requireNotProductionBranch("main"), /never writes to the production/i);
  assert.throws(() => requireNotProductionBranch("master"), /production/i);
  assert.throws(() => requireNotProductionBranch("trunk", { defaultBranch: "trunk" }), /production/i);
  // next + feature branches are allowed (no throw)
  requireNotProductionBranch("next");
  requireNotProductionBranch("bgsd-0001-foo/unit-auth");
});

test("G08 — requireNotProductionBranch rejects non-strings", () => {
  assert.throws(() => requireNotProductionBranch(""), /required/i);
  assert.throws(() => requireNotProductionBranch(null), /required/i);
});

process.stdout.write(`\nintegration.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
