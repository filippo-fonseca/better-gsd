#!/usr/bin/env node
/**
 * test-bgsdmd.mjs — Unit tests for bgsdmd.mjs (Phase 5 Kiwi self-edit).
 * Run with: node bgsd/scripts/test-bgsdmd.mjs
 */

import assert from "node:assert/strict";

import { renderBgsdMd, parseBgsdMd, defaultBgsdConfig } from "./init.mjs";
import {
  setConfigValue,
  applySetting,
  appendPreference,
  slugifyName,
} from "./bgsdmd.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

test("BM01 — setConfigValue deep-sets a dotted path + returns oldValue", () => {
  const cfg = defaultBgsdConfig();
  const { config, oldValue } = setConfigValue(cfg, "model_posture.verifier.model", "sonnet");
  assert.equal(oldValue, "opus");
  assert.equal(config.model_posture.verifier.model, "sonnet");
  // original not mutated
  assert.equal(cfg.model_posture.verifier.model, "opus");
});

test("BM02 — applySetting updates the json block while preserving prose", () => {
  const text = renderBgsdMd(defaultBgsdConfig());
  const res = applySetting(text, "model_posture.verifier.model", "sonnet");
  assert.equal(res.oldValue, "opus");
  assert.equal(res.newValue, "sonnet");
  // settings round-trip reflects the change
  assert.equal(parseBgsdMd(res.text).model_posture.verifier.model, "sonnet");
  // prose preserved
  assert.ok(res.text.includes("## Settings"));
  assert.ok(res.text.includes("## Notes"));
});

test("BM03 — applySetting can change the integration branch", () => {
  const text = renderBgsdMd(defaultBgsdConfig());
  const res = applySetting(text, "integration_branch", "develop");
  assert.equal(parseBgsdMd(res.text).integration_branch, "develop");
});

test("BM04 — appendPreference adds a bullet under Notes", () => {
  const text = renderBgsdMd(defaultBgsdConfig());
  const out = appendPreference(text, "Always ask before deleting files.");
  assert.ok(out.includes("- Always ask before deleting files."));
  // Notes section still present exactly once
  assert.equal((out.match(/##\s*Notes/g) || []).length, 1);
});

test("BM05 — appendPreference creates a Notes section if missing", () => {
  const out = appendPreference("# BGSD\n\njust prose", "Prefer terse PRs.");
  assert.ok(out.includes("## Notes"));
  assert.ok(out.includes("- Prefer terse PRs."));
});

test("BM06 — slugifyName produces a safe filename stem", () => {
  assert.equal(slugifyName("User prefers Sonnet!"), "user-prefers-sonnet");
  assert.equal(slugifyName(""), "note");
});

process.stdout.write(`\nbgsdmd.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
