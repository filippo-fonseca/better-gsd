#!/usr/bin/env node
/**
 * test-envprop.mjs — Unit tests for envprop.mjs (Phase 4 env propagation).
 * Run with: node bgsd/scripts/test-envprop.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  globToRegex,
  matchEnvFiles,
  propagateEnv,
  propagateEnvLive,
  resolveEnvConfig,
  propagateEnvForConfig,
  detectEnvFiles,
} from "./envprop.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

const PATTERNS = [".env", ".env.local", ".env.*.local"];

test("EP01 — globToRegex anchors and expands *", () => {
  assert.ok(globToRegex(".env").test(".env"));
  assert.ok(!globToRegex(".env").test(".env.local"));
  assert.ok(globToRegex(".env.*.local").test(".env.production.local"));
});

test("EP02 — matchEnvFiles selects only env files", () => {
  const got = matchEnvFiles(
    [".env", ".env.local", ".env.production.local", "package.json", "README.md", ".env.example"],
    PATTERNS
  );
  assert.deepEqual(got.sort(), [".env", ".env.local", ".env.production.local"].sort());
});

test("EP03 — propagateEnv (DI) copies matched files", () => {
  const copies = [];
  const res = propagateEnv({
    patterns: PATTERNS,
    destDir: "/wt/unit-1",
    deps: {
      listRoot: () => [".env", ".env.local", "package.json"],
      copy: (name, destDir) => copies.push([name, destDir]),
    },
  });
  assert.deepEqual(res.copied.sort(), [".env", ".env.local"].sort());
  assert.equal(copies.length, 2);
  assert.deepEqual(copies[0][1], "/wt/unit-1");
});

test("EP04 — propagateEnvLive copies real files into a destination", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-env-root-"));
  const dest = mkdtempSync(join(tmpdir(), "bgsd-env-dest-"));
  try {
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.production.local"), "X=2\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    const res = propagateEnvLive({ repoRoot: root, destDir: dest, patterns: PATTERNS });
    assert.equal(res.copied.length, 2);
    assert.ok(existsSync(join(dest, ".env")));
    assert.ok(existsSync(join(dest, ".env.production.local")));
    assert.ok(!existsSync(join(dest, "package.json")), "non-env files not copied");
    assert.equal(readFileSync(join(dest, ".env"), "utf8"), "SECRET=1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("EP05 — resolveEnvConfig falls back to defaults when no BGSD.md", () => {
  const cfg = resolveEnvConfig("/no/such/repo", undefined, () => false);
  assert.equal(cfg.propagate, true);
  assert.deepEqual(cfg.files, [".env", ".env.local", ".env.*.local"]);
});

test("EP06 — resolveEnvConfig reads env.files + env.propagate from BGSD.md", () => {
  const bgsdMd =
    "# BGSD\n```json bgsd-settings\n" +
    JSON.stringify({ env: { propagate: false, files: [".env", ".env.staging"] } }) +
    "\n```\n";
  const cfg = resolveEnvConfig(
    "/repo",
    (p) => (p.endsWith("BGSD.md") ? bgsdMd : ""),
    (p) => p.endsWith("BGSD.md")
  );
  assert.equal(cfg.propagate, false);
  assert.deepEqual(cfg.files, [".env", ".env.staging"]);
});

test("EP07 — propagateEnvForConfig copies configured files into a worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-cfg-root-"));
  const dest = mkdtempSync(join(tmpdir(), "bgsd-cfg-dest-"));
  try {
    writeFileSync(join(root, ".env"), "A=1\n");
    writeFileSync(join(root, ".env.staging"), "B=2\n");
    writeFileSync(join(root, ".env.other"), "C=3\n");
    writeFileSync(
      join(root, "BGSD.md"),
      "```json bgsd-settings\n" +
        JSON.stringify({ env: { propagate: true, files: [".env", ".env.staging"] } }) +
        "\n```\n"
    );
    const res = propagateEnvForConfig({ repoRoot: root, destDir: dest });
    assert.deepEqual(res.copied.sort(), [".env", ".env.staging"].sort());
    assert.ok(existsSync(join(dest, ".env.staging")));
    assert.ok(!existsSync(join(dest, ".env.other")), "unconfigured env file not copied");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("EP08 — propagateEnvForConfig no-ops when propagate=false", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-off-root-"));
  const dest = mkdtempSync(join(tmpdir(), "bgsd-off-dest-"));
  try {
    writeFileSync(join(root, ".env"), "A=1\n");
    writeFileSync(
      join(root, "BGSD.md"),
      "```json bgsd-settings\n" + JSON.stringify({ env: { propagate: false } }) + "\n```\n"
    );
    const res = propagateEnvForConfig({ repoRoot: root, destDir: dest });
    assert.equal(res.skipped, "disabled");
    assert.equal(res.copied.length, 0);
    assert.ok(!existsSync(join(dest, ".env")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("EP09 — propagateEnvForConfig no-ops when destDir === repoRoot", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-same-root-"));
  try {
    writeFileSync(join(root, ".env"), "A=1\n");
    const res = propagateEnvForConfig({ repoRoot: root, destDir: join(root, ".", "") });
    assert.equal(res.skipped, "same-dir");
    assert.equal(res.copied.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EP10 — detectEnvFiles splits covered vs uncovered env-looking files", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-detect-"));
  try {
    writeFileSync(join(root, ".env"), "A=1\n");
    writeFileSync(join(root, ".env.local"), "B=2\n");
    writeFileSync(join(root, ".env.production"), "C=3\n"); // env-looking, NOT in default globs
    writeFileSync(join(root, "package.json"), "{}\n");     // not env-looking
    // No BGSD.md → default globs [".env", ".env.local", ".env.*.local"].
    const r = detectEnvFiles(root);
    assert.equal(r.propagate, true);
    assert.deepEqual(r.covered.sort(), [".env", ".env.local"].sort());
    assert.deepEqual(r.uncovered, [".env.production"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EP11 — detectEnvFiles reports no ambiguity when globs cover everything", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-detect2-"));
  try {
    writeFileSync(join(root, ".env"), "A=1\n");
    writeFileSync(
      join(root, "BGSD.md"),
      "```json bgsd-settings\n" +
        JSON.stringify({ env: { propagate: true, files: [".env", ".env.*"] } }) +
        "\n```\n"
    );
    writeFileSync(join(root, ".env.production"), "C=3\n");
    const r = detectEnvFiles(root);
    assert.deepEqual(r.uncovered, []); // ".env.*" covers .env.production
    assert.ok(r.covered.includes(".env.production"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write(`\nenvprop.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
