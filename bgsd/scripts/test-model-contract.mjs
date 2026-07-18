#!/usr/bin/env node
/**
 * test-model-contract.mjs — Contract v3 (Cursor default) + v2 legacy/--no-cursor.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PIPELINE_PROFILES, resolveModelContract, validateModelId, scrubApiKeyEnv,
  parseClaudeAuth, parseCodexAuth, parseCursorAuth, detectConductor, buildLaneForUnit,
  harnessForLane, loadContractForRun, isForbiddenCursorSelector, isCursorContract,
  DEFAULT_CURSOR_MODELS, recordEscalation, contractRuntimes, exportContractEnv,
  SCRUBBED_API_KEYS,
} from "./model-contract.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  PASS  ${name}\n`); }

test("four pipeline profiles", () => assert.deepEqual(Object.keys(PIPELINE_PROFILES), ["claude", "openai", "claude-openai", "openai-claude"]));

test("1 — no flag resolves Cursor enabled", () => {
  const c = resolveModelContract({ profile: "claude", env: { PATH: "/bin" } });
  assert.equal(c.version, 3);
  assert.equal(c.cursor.enabled, true);
  assert.equal(isCursorContract(c), true);
});

test("2 — routine lane resolves to Composer Standard selector", () => {
  const c = resolveModelContract({ env: { PATH: "/bin" } });
  assert.equal(c.cursor.routine.model, DEFAULT_CURSOR_MODELS.routine);
  assert.equal(c.cursor.routine.model, "composer-2.5");
  assert.equal(c.cursor.routine.harness, "cursor");
  assert.equal(c.cursor.routine.transport, "direct");
});

test("3 — hard lane resolves to Grok base selector", () => {
  const c = resolveModelContract({ env: { PATH: "/bin" } });
  assert.equal(c.cursor.hard.model, "cursor-grok-4.5-high");
  assert.equal(isForbiddenCursorSelector(c.cursor.hard.model).forbidden, false);
});

test("4 — Conductor remains the live-session model", () => {
  const c = resolveModelContract({
    conductor: { provider: "claude", harness: "claude", model: "claude-fable-5", source: "live-session" },
    env: { PATH: "/bin" },
  });
  assert.equal(c.conductor.model, "claude-fable-5");
  assert.equal(c.conductor.source, "live-session");
});

test("5 — Cursor hard/legacy assignments require recorded reasons", () => {
  const c = resolveModelContract({ env: { PATH: "/bin" } });
  assert.throws(() => buildLaneForUnit(c, { tier: "hard" }), /reason/);
  assert.throws(() => buildLaneForUnit(c, { tier: "legacy", reason: "" }), /reason/);
  const hard = buildLaneForUnit(c, { tier: "hard", reason: "cross-cutting auth refactor" });
  assert.equal(hard.model, "cursor-grok-4.5-high");
  assert.equal(hard.assignment.tier, "hard");
});

test("6 — Legacy v2 contracts still rehydrate as Cursor-disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-v2-"));
  try {
    const v2 = {
      version: 2,
      profile: "openai-claude",
      routing: "adaptive",
      build: { provider: "openai", harness: "codex", model: "gpt-5.6-sol", effort: "medium", transport: "direct" },
      adaptive: { heavy: { model: "gpt-5.6-sol", effort: "medium" }, light: { model: "gpt-5.5", effort: "high" } },
      evaluate: { provider: "claude", harness: "claude", model: "claude-opus-4-8", effort: "high", transport: "direct" },
      conductor: { provider: "openai", model: "gpt-5.6-sol" },
      auth: { policy: "subscription-only", verified_at: null },
    };
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r1", model_contract: v2 }));
    const rehydrated = loadContractForRun(dir, { env: { PATH: "/bin" } });
    assert.equal(rehydrated.cursor.enabled, false);
    assert.equal(rehydrated.build.model, "gpt-5.6-sol");
    assert.equal(rehydrated.evaluate.model, "claude-opus-4-8");
    assert.equal(rehydrated.migrated_from, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("7 — Cursor v3 contracts rehydrate", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-v3-"));
  try {
    const original = resolveModelContract({ env: { PATH: "/bin" } });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r3", model_contract: original }));
    const rehydrated = loadContractForRun(dir, { env: { PATH: "/bin", BGSD_NO_CURSOR: "1" } });
    // Stored enabled=true must win over ambient --no-cursor env on a Cursor run.
    assert.equal(rehydrated.cursor.enabled, true);
    assert.equal(rehydrated.cursor.routine.model, "composer-2.5");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("8 — --no-cursor persists across processes and resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-nocursor-"));
  try {
    const original = resolveModelContract({ cursor: false, profile: "claude", env: { PATH: "/bin" } });
    assert.equal(original.cursor.enabled, false);
    assert.equal(original.build.provider, "claude");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r4", model_contract: original }));
    // Ambient env would enable Cursor by default — rehydration must keep disabled.
    const rehydrated = loadContractForRun(dir, { env: { PATH: "/bin" } });
    assert.equal(rehydrated.cursor.enabled, false);
    assert.equal(rehydrated.build.harness, "claude");
    const exported = exportContractEnv(original, { PATH: "/bin" });
    assert.equal(exported.BGSD_NO_CURSOR, "1");
    assert.equal(exported.BGSD_CURSOR, "0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy hybrid profile resolves with --no-cursor", () => {
  const c = resolveModelContract({ profile: "openai-claude", cursor: false, conductor: { provider: "openai", model: "gpt-5.6-sol" } });
  assert.equal(c.build.model, "gpt-5.6-sol");
  assert.equal(c.evaluate.model, "claude-opus-4-8");
  assert.equal(c.build.effort, "medium");
});

test("OpenAI lanes default to GPT-5.6 Sol at medium effort when --no-cursor", () => {
  const c = resolveModelContract({ profile: "openai", cursor: false });
  assert.deepEqual(c.build, { provider: "openai", harness: "codex", model: "gpt-5.6-sol", effort: "medium", transport: "direct" });
});

test("Fast and Auto Cursor selectors are rejected", () => {
  assert.equal(isForbiddenCursorSelector("composer-2.5-fast").forbidden, true);
  assert.equal(isForbiddenCursorSelector("cursor-grok-4.5-high-fast").forbidden, true);
  assert.equal(isForbiddenCursorSelector("auto").forbidden, true);
  assert.equal(validateModelId("cursor", "composer-2.5-fast").ok, false);
  assert.throws(() => resolveModelContract({ cursorRoutineModel: "composer-2.5-fast", env: { PATH: "/bin" } }));
});

test("25 — unassigned Cursor unit defaults visibly to routine/Composer", () => {
  const lane = buildLaneForUnit(resolveModelContract({ env: { PATH: "/bin" } }));
  assert.equal(lane.model, "composer-2.5");
  assert.equal(lane.assignment.tier, "routine");
  assert.equal(lane.assignment.source, "session");
  assert.match(lane.assignment.reason, /session default/i);
});

test("26 — Conductor hard assignment routes to Grok", () => {
  const lane = buildLaneForUnit(resolveModelContract({ env: { PATH: "/bin" } }), {
    tier: "hard", reason: "ambiguous concurrency failure",
  });
  assert.equal(lane.model, "cursor-grok-4.5-high");
  assert.equal(lane.assignment.backend, "cursor");
});

test("27/29 — Composer failure does not autonomously change models; no auto legacy", () => {
  const c = resolveModelContract({ env: { PATH: "/bin" } });
  const again = buildLaneForUnit(c, null);
  assert.equal(again.assignment.tier, "routine");
  assert.notEqual(again.assignment.tier, "legacy");
});

test("28 — Recorded escalation routes next attempt to Grok", () => {
  let c = resolveModelContract({ env: { PATH: "/bin" } });
  c = recordEscalation(c, { from: "routine", to: "hard", reason: "Composer failed verification twice", unitId: "u1" });
  assert.equal(c.escalation_history.length, 1);
  const lane = buildLaneForUnit(c, { tier: "hard", reason: "Composer failed verification twice", attempt: 2 });
  assert.equal(lane.model, "cursor-grok-4.5-high");
  assert.equal(lane.assignment.attempt, 2);
});

test("fixed routing ignores per-unit downgrade under --no-cursor", () => {
  const lane = buildLaneForUnit(resolveModelContract({ profile: "claude", cursor: false }), { tier: "light", reason: "small" });
  assert.equal(lane.model, "claude-opus-4-8");
  assert.equal(lane.assignment.source, "session");
});

test("adaptive routing applies auditable assignment under --no-cursor", () => {
  const c = resolveModelContract({ profile: "claude", routing: "adaptive", lightBuildModel: "claude-sonnet-4-6", cursor: false });
  const lane = buildLaneForUnit(c, { tier: "light", reason: "isolated copy edit" });
  assert.equal(lane.model, "claude-sonnet-4-6");
  assert.equal(lane.assignment.tier, "light");
});

test("adaptive routing REJECTS reason-less light under --no-cursor", () => {
  const c = resolveModelContract({ profile: "claude", routing: "adaptive", lightBuildModel: "claude-sonnet-4-6", cursor: false });
  const lane = buildLaneForUnit(c, { tier: "light" });
  assert.equal(lane.assignment.tier, "heavy");
  assert.equal(lane.assignment.source, "fail-safe");
});

test("proxy hosts foreign provider through Claude under --no-cursor", () => {
  const c = resolveModelContract({ profile: "openai", proxy: true, cursor: false });
  assert.equal(harnessForLane(c.build), "claude");
});

test("proxy stays FAIL-CLOSED across rehydration", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-proxy-"));
  try {
    const proxied = resolveModelContract({ profile: "openai", proxy: true, cursor: false });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r2", model_contract: proxied }));
    assert.throws(() => loadContractForRun(dir, { env: { PATH: "/bin" } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API key env is scrubbed including CURSOR_API_KEY", () => {
  const env = scrubApiKeyEnv({
    PATH: "/bin", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y", CLAUDE_API_KEY: "z", CURSOR_API_KEY: "c",
  });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.ok(SCRUBBED_API_KEYS.includes("CURSOR_API_KEY"));
});

test("Cursor auth rejects API key env and non-login apiKeySource", () => {
  assert.equal(parseCursorAuth({ isAuthenticated: true }, { env: { CURSOR_API_KEY: "x" } }).ok, false);
  assert.equal(parseCursorAuth({ isAuthenticated: true, apiKeySource: "env" }).ok, false);
  assert.equal(parseCursorAuth({ isAuthenticated: true, apiKeySource: "login" }).ok, true);
  assert.equal(parseCursorAuth({ status: "authenticated" }).ok, true);
});

test("subscription auth parsers fail closed", () => {
  assert.equal(parseClaudeAuth({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }).ok, true);
  assert.equal(parseClaudeAuth({ loggedIn: true, authMethod: "apiKey" }).ok, false);
  assert.equal(parseCodexAuth("Logged in using ChatGPT").ok, true);
  assert.equal(parseCodexAuth("Logged in using an API key").ok, false);
});

test("conductor detection honors explicit provider/model", () => {
  const c = detectConductor({ BGSD_CONDUCTOR_PROVIDER: "openai", BGSD_CONDUCTOR_MODEL: "gpt-5.6-sol" });
  assert.equal(c.harness, "codex");
  assert.equal(c.model, "gpt-5.6-sol");
});

test("contractRuntimes: cursor vs legacy", () => {
  assert.deepEqual(contractRuntimes(resolveModelContract({ env: { PATH: "/bin" } })), ["cursor"]);
  assert.deepEqual(contractRuntimes(resolveModelContract({ cursor: false, profile: "claude" })), ["claude"]);
});

test("BGSD_NO_CURSOR env disables Cursor", () => {
  const c = resolveModelContract({ env: { PATH: "/bin", BGSD_NO_CURSOR: "1" } });
  assert.equal(c.cursor.enabled, false);
});

process.stdout.write(`\nmodel-contract.mjs: ${passed} passed\n`);
