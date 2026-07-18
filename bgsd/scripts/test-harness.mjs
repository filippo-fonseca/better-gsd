#!/usr/bin/env node
/**
 * test-harness.mjs — Unit tests for harness.mjs (Claude / Codex / Cursor).
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
  cursorPrompt,
} from "./harness.mjs";
import { DEFAULT_MODELS } from "./model-contract.mjs";
const LATEST_OPUS = DEFAULT_MODELS.claude.model;

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
  assert.equal(detectHarness({ BGSD_HARNESS: "cursor" }), "cursor");
});

test("H02 — detectHarness: AGENT=codex → codex, CLAUDECODE → claude, AGENT=cursor → cursor", () => {
  assert.equal(detectHarness({ AGENT: "codex" }), "codex");
  assert.equal(detectHarness({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectHarness({ CODEX_HOME: "/x" }), "codex");
  assert.equal(detectHarness({ AGENT: "cursor" }), "cursor");
});

test("H03 — detectHarness: empty env defaults to claude", () => {
  assert.equal(detectHarness({}), "claude");
});

test("H04 — resolveModel maps tiers per harness; claude opus = LATEST_OPUS", () => {
  assert.equal(resolveModel("opus", "claude"), LATEST_OPUS);
  assert.equal(resolveModel("opus", "codex"), "gpt-5.5");
  assert.equal(resolveModel("routine", "cursor"), "composer-2.5");
  assert.equal(resolveModel("hard", "cursor"), "cursor-grok-4.5-high");
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
    model: "gpt-5.5",
    context: { worktree: "/wt", "unit-id": "u1" },
  });
  assert.equal(s.cmd, "codex");
  assert.equal(s.args[0], "exec");
  assert.ok(s.args[1].includes("/bgsd-run-agent"));
  assert.ok(s.args[1].includes("worktree: /wt"));
  assert.deepEqual(s.args.slice(2), ["--model", "gpt-5.5", "--config", 'model_reasoning_effort="high"', "--sandbox", "workspace-write"]);
});

test("H07b — proxy spawn uses Claude Code and scoped proxy configuration", () => {
  const s = buildAgentSpawn({
    harness: "claude", command: "/bgsd-run-agent", model: "gpt-5.5", proxy: true,
    env: { BGSD_PROXY_URL: "http://localhost:8317", BGSD_PROXY_TOKEN: "x", OPENAI_API_KEY: "must-not-inherit" },
  });
  assert.equal(s.env.ANTHROPIC_BASE_URL, "http://localhost:8317");
  assert.equal(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-5.5");
  assert.equal(s.env.OPENAI_API_KEY, undefined);
});

test("9/10/11/12/14 — Cursor spawn uses cursor-agent noninteractive with model + BGSD context", () => {
  const s = buildAgentSpawn({
    harness: "cursor",
    command: "/bgsd-run-agent",
    model: "composer-2.5",
    context: {
      worktree: "/wt",
      "unit-id": "u1",
      "run-id": "r1",
      "control-file": "/ctrl.json",
      scale: "feature",
      port: "8080",
      "seed-plan": "/seed.md",
      "advisor-path": "/advisor.md",
    },
    env: { CURSOR_API_KEY: "must-scrub", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" },
  });
  assert.equal(s.cmd, "cursor-agent");
  assert.equal(s.args[0], "-p");
  assert.ok(s.args.includes("--force"));
  assert.ok(s.args.includes("--trust"));
  assert.ok(s.args.includes("stream-json"));
  const modelIdx = s.args.indexOf("--model");
  assert.equal(s.args[modelIdx + 1], "composer-2.5");
  const prompt = s.args[s.args.length - 1];
  assert.ok(prompt.includes("/bgsd-run-agent"));
  assert.ok(prompt.includes("worktree: /wt"));
  assert.ok(prompt.includes("unit-id: u1"));
  assert.ok(prompt.includes("control-file: /ctrl.json"));
  assert.ok(prompt.includes("scale: feature"));
  assert.ok(prompt.includes("Never edit the user's main checkout"));
  assert.equal(s.env.CURSOR_API_KEY, undefined);
  assert.equal(s.env.OPENAI_API_KEY, undefined);
});

test("13 — Cursor spawn is intended for worktree cwd (caller sets cwd)", () => {
  // buildAgentSpawn does not set cwd; run-live passes cwd: wtPath. Document the contract.
  const s = buildAgentSpawn({ harness: "cursor", command: "/bgsd-run-agent", model: "composer-2.5", context: { worktree: "/iso-wt" } });
  assert.ok(s.args.at(-1).includes("worktree: /iso-wt"));
});

test("15 — Unknown harnesses throw rather than falling through to Claude", () => {
  assert.throws(() => buildAgentSpawn({ harness: "windsurf", command: "/x" }), /Unknown harness/);
  assert.throws(() => buildAgentSpawn({ harness: undefined, command: "/x" }), /Unknown harness/);
});

test("16 — API-key environment variables are scrubbed on all harnesses", () => {
  for (const harness of ["claude", "codex", "cursor"]) {
    const s = buildAgentSpawn({
      harness, command: "/bgsd-run-agent", model: "composer-2.5",
      env: { CURSOR_API_KEY: "c", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", CLAUDE_API_KEY: "k", PATH: "/bin" },
    });
    assert.equal(s.env.CURSOR_API_KEY, undefined, harness);
    assert.equal(s.env.OPENAI_API_KEY, undefined, harness);
    assert.equal(s.env.PATH, "/bin");
  }
});

test("32/33 — --no-cursor yields Claude/Codex spawn shape; zero Cursor spawns", () => {
  const claude = buildAgentSpawn({ harness: "claude", command: "/bgsd-run-agent", model: LATEST_OPUS });
  assert.equal(claude.cmd, "claude");
  assert.notEqual(claude.cmd, "cursor-agent");
  const codex = buildAgentSpawn({ harness: "codex", command: "/bgsd-run-agent", model: "gpt-5.5" });
  assert.equal(codex.cmd, "codex");
  assert.notEqual(codex.cmd, "cursor-agent");
});

test("cursorPrompt includes safety + context", () => {
  const p = cursorPrompt({ command: "/bgsd-verify", context: { scale: "quick" }, instructions: "extra" });
  assert.ok(p.includes("Cursor Agent CLI"));
  assert.ok(p.includes("scale: quick"));
  assert.ok(p.includes("extra"));
  assert.ok(p.includes("Never claim success without verification evidence"));
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
    assert.equal(cfg.models.codex.opus, "gpt-5-pro");
    assert.equal(cfg.models.codex.haiku, "gpt-5.4-mini");
    assert.equal(cfg.models.claude.opus, LATEST_OPUS);
    assert.equal(cfg.cursor.models.routine, "composer-2.5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H09 — activeHarness: pinned config wins; auto falls back to env", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-harness2-"));
  try {
    assert.equal(activeHarness(root, { config: { active: "codex", models: DEFAULT_HARNESS_MODELS }, env: {} }), "codex");
    assert.equal(activeHarness(root, { config: { active: "cursor", models: DEFAULT_HARNESS_MODELS }, env: {} }), "cursor");
    assert.equal(activeHarness(root, { config: { active: "auto", models: DEFAULT_HARNESS_MODELS }, env: { AGENT: "codex" } }), "codex");
    assert.equal(activeHarness(root, { config: { active: "auto", models: DEFAULT_HARNESS_MODELS }, env: {} }), "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H10 — HARNESSES includes cursor + defaults are well-formed", () => {
  assert.deepEqual(HARNESSES, ["claude", "codex", "cursor"]);
  for (const h of ["claude", "codex"]) {
    for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
      assert.ok(DEFAULT_HARNESS_MODELS[h][tier], `${h}.${tier} has a default`);
    }
  }
  assert.ok(DEFAULT_HARNESS_MODELS.cursor.routine);
  assert.ok(DEFAULT_HARNESS_MODELS.cursor.hard);
});

process.stdout.write(`\nharness.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
