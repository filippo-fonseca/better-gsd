#!/usr/bin/env node
/**
 * test-issues-live.mjs — Integration tests for issues-live.mjs.
 *
 * No external framework. Uses node:assert + a temp git repo. Does NOT call gh
 * (no --live), so no real issues are created.
 * Run with: node bgsd/scripts/test-issues-live.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { hasGitHubRemote, requireLiveFlag, isLiveFlagSet } from "./issues-live.mjs";

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

function sh(cwd, args) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cmd failed: ${args.join(" ")}\n${r.stderr ?? ""}`);
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-issues-"));
  sh(dir, ["git", "init", "-q"]);
  return dir;
}

test("IL01 — requireLiveFlag throws without --live", () => {
  assert.equal(isLiveFlagSet(), false);
  assert.throws(() => requireLiveFlag(), /without --live/i);
});

test("IL02 — hasGitHubRemote: false with no remote", () => {
  const dir = makeRepo();
  try {
    assert.equal(hasGitHubRemote(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IL03 — hasGitHubRemote: true for a github origin", () => {
  const dir = makeRepo();
  try {
    sh(dir, ["git", "remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    assert.equal(hasGitHubRemote(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IL04 — hasGitHubRemote: false for a non-github origin", () => {
  const dir = makeRepo();
  try {
    sh(dir, ["git", "remote", "add", "origin", "https://gitlab.com/acme/widgets.git"]);
    assert.equal(hasGitHubRemote(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

process.stdout.write(`\nissues-live.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
