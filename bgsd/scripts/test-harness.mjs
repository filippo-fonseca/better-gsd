#!/usr/bin/env node
/**
 * test-harness.mjs — Unit tests for harness.mjs (LLM/CLI-agnostic layer).
 * Run with: node bgsd/scripts/test-harness.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HARNESSES,
  DEFAULT_HARNESS_MODELS,
  detectHarness,
  resolveHarnessConfig,
  activeHarness,
  resolveModel,
  buildAgentSpawn,
} from "./harness.mjs";
import { LATEST_OPUS } from "./decompose.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

test("H01 — detectHarness: BGSD_HARNESS override wins", () => {
  assert.equal(detectHarness({ BGSD_HARNESS: "codex", CLAUDECODE: "1" }), "codex");
  assert.equal(detectHarness({ BGSD_HARNESS: "claude", AGENT: "codex" }), "claude");
});

test("H02 — detectHarness: AGENT=codex → codex, CLAUDECODE → claude", () => {
  assert.equal(detectHarness({ AGENT: "codex" }), "codex");
  assert.equal(detectHarness({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectHarness({ CODEX_HOME: "/x" }), "codex");
});

test("H03 — detectHarness: empty env defaults to claude", () => {
  assert.equal(detectHarness({}), "claude");
});

test("H04 — resolveModel maps tiers per harness; claude opus = LATEST_OPUS", () => {
  assert.equal(resolveModel("opus", "claude"), LATEST_OPUS);
  assert.equal(resolveModel("opus", "codex"), "gpt-5-codex");
  assert.equal(resolveModel("haiku", "codex"), "gpt-5-mini");
  assert.equal(resolveModel("fable", "claude"), "claude-fable-5");
});

test("H05 — resolveModel passes through a concrete id it doesn't recognize", () => {
  assert.equal(resolveModel("gpt-5-turbo", "codex"), "gpt-5-turbo");
});

test("H06 — buildAgentSpawn (claude) → claude -p <cmd> --model … --k v", () => {
  const s = buildAgentSpawn({
    harness: "claude",
    command: "/bgsd-run-agent",
    model: LATEST_OPUS,
    context: { worktree: "/wt", "unit-id": "u1", "seed-plan": null },
  });
  assert.equal(s.cmd, "claude");
  assert.deepEqual(s.args, ["-p", "/bgsd-run-agent", "--model", LATEST_OPUS, "--worktree", "/wt", "--unit-id", "u1"]);
});

test("H07 — buildAgentSpawn (codex) → codex exec \"<prompt>\" --model … --sandbox", () => {
  const s = buildAgentSpawn({
    harness: "codex",
    command: "/bgsd-run-agent",
    model: "gpt-5-codex",
    context: { worktree: "/wt", "unit-id": "u1" },
  });
  assert.equal(s.cmd, "codex");
  assert.equal(s.args[0], "exec");
  assert.ok(s.args[1].includes("/bgsd-run-agent"));
  assert.ok(s.args[1].includes("worktree: /wt"));
  assert.deepEqual(s.args.slice(2), ["--model", "gpt-5-codex", "--sandbox", "workspace-write"]);
});

test("H08 — resolveHarnessConfig reads BGSD.md harness block + merges defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-harness-"));
  try {
    writeFileSync(
      join(root, "BGSD.md"),
      "```json bgsd-settings\n" +
        JSON.stringify({ harness: { active: "codex", models: { codex: { opus: "gpt-5-pro" } } } }) +
        "\n```\n"
    );
    const cfg = resolveHarnessConfig(root);
    assert.equal(cfg.active, "codex");
    assert.equal(cfg.models.codex.opus, "gpt-5-pro");       // overridden
    assert.equal(cfg.models.codex.haiku, "gpt-5-mini");     // default preserved
    assert.equal(cfg.models.claude.opus, LATEST_OPUS);      // other harness intact
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H09 — activeHarness: pinned config wins; auto falls back to env", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-harness2-"));
  try {
    assert.equal(activeHarness(root, { config: { active: "codex", models: DEFAULT_HARNESS_MODELS }, env: {} }), "codex");
    assert.equal(activeHarness(root, { config: { active: "auto", models: DEFAULT_HARNESS_MODELS }, env: { AGENT: "codex" } }), "codex");
    assert.equal(activeHarness(root, { config: { active: "auto", models: DEFAULT_HARNESS_MODELS }, env: {} }), "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H10 — HARNESSES + defaults are well-formed", () => {
  assert.deepEqual(HARNESSES, ["claude", "codex"]);
  for (const h of HARNESSES) {
    for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
      assert.ok(DEFAULT_HARNESS_MODELS[h][tier], `${h}.${tier} has a default`);
    }
  }
});

process.stdout.write(`\nharness.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
