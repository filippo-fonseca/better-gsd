#!/usr/bin/env node
/**
 * test-envprop.mjs — Unit tests for envprop.mjs (Phase 4 env propagation).
 * Run with: node bgsd/scripts/test-envprop.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { globToRegex, matchEnvFiles, propagateEnv, propagateEnvLive } from "./envprop.mjs";

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

process.stdout.write(`\nenvprop.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
