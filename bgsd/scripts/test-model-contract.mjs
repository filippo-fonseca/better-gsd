#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PIPELINE_PROFILES, resolveModelContract, validateModelId, scrubApiKeyEnv,
  parseClaudeAuth, parseCodexAuth, detectConductor, buildLaneForUnit, harnessForLane,
  loadContractForRun,
} from "./model-contract.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  PASS  ${name}\n`); }

test("four pipeline profiles", () => assert.deepEqual(Object.keys(PIPELINE_PROFILES), ["claude", "openai", "claude-openai", "openai-claude"]));
test("hybrid profile resolves fixed defaults", () => {
  const c = resolveModelContract({ profile: "openai-claude", conductor: { provider: "openai", model: "gpt-5.6-sol" } });
  assert.equal(c.build.model, "gpt-5.6-sol");
  assert.equal(c.evaluate.model, "claude-opus-4-8");
  assert.equal(c.build.effort, "medium");
});
test("OpenAI lanes default to GPT-5.6 Sol at medium effort", () => {
  const c = resolveModelContract({ profile: "openai" });
  assert.deepEqual(c.build, { provider: "openai", harness: "codex", model: "gpt-5.6-sol", effort: "medium", transport: "direct" });
  assert.deepEqual(c.evaluate, { provider: "openai", harness: "codex", model: "gpt-5.6-sol", effort: "medium", transport: "direct" });
});
test("custom models remain provider-bound", () => {
  const c = resolveModelContract({ profile: "openai", buildModel: "gpt-5.6-terra" });
  assert.equal(c.build.model, "gpt-5.6-terra");
  assert.equal(validateModelId("openai", "claude-opus-4-8").ok, false);
});
test("proxy is explicit", () => assert.equal(resolveModelContract({ profile: "claude", proxy: true }).build.transport, "proxy"));
test("proxy hosts a foreign provider through Claude Code", () => {
  const c = resolveModelContract({ profile: "openai", proxy: true });
  assert.equal(c.build.provider, "openai");
  assert.equal(harnessForLane(c.build), "claude");
});
test("fixed routing ignores per-unit downgrade requests", () => {
  const lane = buildLaneForUnit(resolveModelContract({ profile: "claude" }), { tier: "light", reason: "small" });
  assert.equal(lane.model, "claude-opus-4-8");
  assert.equal(lane.assignment.source, "session");
});
test("adaptive routing applies an auditable Conductor assignment", () => {
  const c = resolveModelContract({ profile: "claude", routing: "adaptive", lightBuildModel: "claude-sonnet-4-6" });
  const lane = buildLaneForUnit(c, { tier: "light", reason: "isolated copy edit" });
  assert.equal(lane.model, "claude-sonnet-4-6");
  assert.deepEqual(lane.assignment, { tier: "light", reason: "isolated copy edit", source: "conductor" });
});
test("adaptive routing defaults to heavy without a Conductor assignment", () => {
  const lane = buildLaneForUnit(resolveModelContract({ profile: "openai", routing: "adaptive" }));
  assert.equal(lane.model, "gpt-5.6-sol");
  assert.equal(lane.effort, "medium");
  assert.equal(lane.assignment.source, "fail-safe");
});
test("adaptive routing REJECTS an assignment with no recorded reason (fail-safe to heavy)", () => {
  const c = resolveModelContract({ profile: "claude", routing: "adaptive", lightBuildModel: "claude-sonnet-4-6" });
  for (const bad of [{ tier: "light" }, { tier: "light", reason: "" }, { tier: "light", reason: "   " }]) {
    const lane = buildLaneForUnit(c, bad);
    assert.equal(lane.model, "claude-opus-4-8", "reason-less light assignment must not ride the light tier");
    assert.equal(lane.assignment.tier, "heavy");
    assert.equal(lane.assignment.source, "fail-safe");
    assert.match(lane.assignment.reason, /rejected/);
  }
});
test("contract rehydrates from run.json across the process boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-contract-"));
  try {
    const original = resolveModelContract({ profile: "openai-claude", routing: "adaptive" });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r1", model_contract: original }));
    // A bare env would revert to claude/fixed; the loader must restore the record.
    const rehydrated = loadContractForRun(dir, { env: { PATH: "/bin" } });
    assert.equal(rehydrated.profile, "openai-claude");
    assert.equal(rehydrated.routing, "adaptive");
    assert.equal(rehydrated.build.model, "gpt-5.6-sol");
    assert.equal(rehydrated.evaluate.model, "claude-opus-4-8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("rehydration falls back to env/defaults when no run.json exists", () => {
  const contract = loadContractForRun(null, { env: { PATH: "/bin" } });
  assert.equal(contract.profile, "claude");
  assert.equal(contract.routing, "fixed");
});
test("proxy stays FAIL-CLOSED across rehydration (missing proxy env throws, never direct)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-contract-"));
  try {
    const proxied = resolveModelContract({ profile: "openai", proxy: true });
    assert.equal(proxied.build.transport, "proxy");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ run_id: "r2", model_contract: proxied }));
    // No BGSD_PROXY_URL/TOKEN in this process → must throw, not silently revert to direct.
    assert.throws(() => loadContractForRun(dir, { env: { PATH: "/bin" } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("adaptive custom models remain provider-bound", () => {
  assert.throws(
    () => resolveModelContract({ profile: "openai", routing: "adaptive", lightBuildModel: "claude-sonnet-4-6" }),
    /provider_model_mismatch/
  );
});
test("API key env is scrubbed", () => {
  const env = scrubApiKeyEnv({ PATH: "/bin", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" });
  assert.deepEqual(env, { PATH: "/bin" });
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

process.stdout.write(`\nmodel-contract.mjs: ${passed} passed\n`);
