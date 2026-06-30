#!/usr/bin/env node
/**
 * test-init-live.mjs — Integration tests for init-live.mjs against a real,
 * throwaway git repo (Phase 1 v0-init).
 *
 * No external framework. Uses node:assert + a temp `git init` repo.
 * Run with: node bgsd/scripts/test-init-live.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 *   L01 — detectBaseBranch falls back to main (no remote)
 *   L02 — executeInit (live deps) bootstraps a real repo
 *   L03 — executeInit is idempotent on a real repo
 *   L04 — ensureGsdConfig preserves existing keys
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { executeInit } from "./init.mjs";
import { liveDeps, detectBaseBranch, ensureGsdConfig } from "./init-live.mjs";

// ---------------------------------------------------------------------------
// Test harness
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
    process.stdout.write(`  FAIL  ${name}\n`);
    process.stdout.write(`        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Throwaway git repo helpers
// ---------------------------------------------------------------------------

function sh(cwd, args) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`cmd failed: ${args.join(" ")}\n${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-init-live-"));
  sh(dir, ["git", "init", "-q"]);
  sh(dir, ["git", "symbolic-ref", "HEAD", "refs/heads/main"]);
  sh(dir, ["git", "config", "user.email", "t@example.com"]);
  sh(dir, ["git", "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  sh(dir, ["git", "add", "."]);
  sh(dir, ["git", "commit", "-q", "-m", "init"]);
  return dir;
}

function withRepo(fn) {
  const dir = makeRepo();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("L01 — detectBaseBranch falls back to main", () => {
  withRepo((dir) => {
    assert.equal(detectBaseBranch(dir), "main");
  });
});

test("L02 — executeInit (live deps) bootstraps a real repo", () => {
  withRepo((dir) => {
    const res = executeInit(liveDeps(dir, () => {}));
    assert.equal(res.integrationBranch, "next");
    assert.equal(res.baseBranch, "main");

    assert.ok(existsSync(join(dir, ".bgsd", "config.json")), ".bgsd/config.json");
    assert.ok(existsSync(join(dir, "BGSD.md")), "BGSD.md");
    assert.ok(existsSync(join(dir, ".bgsd", "ledger.md")), "ledger.md");
    assert.ok(existsSync(join(dir, ".bgsd", "seshs", ".gitkeep")), "seshs/.gitkeep");
    assert.ok(readFileSync(join(dir, ".gitignore"), "utf8").includes(".bgsd/runs/"));

    const branches = sh(dir, ["git", "branch", "--list", "next"]);
    assert.ok(branches.includes("next"), "next branch created");

    const gsd = JSON.parse(readFileSync(join(dir, ".planning", "config.json"), "utf8"));
    assert.equal(gsd.git.branching_strategy, "none");
    assert.equal(gsd.git.base_branch, "next");
  });
});

test("L03 — executeInit is idempotent on a real repo", () => {
  withRepo((dir) => {
    executeInit(liveDeps(dir, () => {}));
    const res2 = executeInit(liveDeps(dir, () => {}));
    assert.equal(res2.alreadyInitialized, true);
    assert.ok(!res2.performed.includes("write_config"));
    assert.ok(!res2.performed.includes("create_integration_branch:next"));
    assert.ok(!res2.performed.includes("ensure_gsd_config"));
  });
});

test("L04 — ensureGsdConfig preserves existing keys", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, ".planning"), { recursive: true });
    writeFileSync(
      join(dir, ".planning", "config.json"),
      JSON.stringify({ project_code: "X", git: { create_tag: true } }, null, 2)
    );
    const changed = ensureGsdConfig(dir, "next");
    assert.equal(changed, true);

    const cfg = JSON.parse(readFileSync(join(dir, ".planning", "config.json"), "utf8"));
    assert.equal(cfg.project_code, "X", "preserves project_code");
    assert.equal(cfg.git.create_tag, true, "preserves git.create_tag");
    assert.equal(cfg.git.branching_strategy, "none");
    assert.equal(cfg.git.base_branch, "next");

    assert.equal(ensureGsdConfig(dir, "next"), false, "second call is a no-op");
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\ninit-live.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
