#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  PIPELINE_PROFILES, resolveModelContract, validateModelId, scrubApiKeyEnv,
  parseClaudeAuth, parseCodexAuth, detectConductor, buildLaneForUnit, harnessForLane,
} from "./model-contract.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  PASS  ${name}\n`); }

test("four pipeline profiles", () => assert.deepEqual(Object.keys(PIPELINE_PROFILES), ["claude", "openai", "claude-openai", "openai-claude"]));
test("hybrid profile resolves fixed defaults", () => {
  const c = resolveModelContract({ profile: "openai-claude", conductor: { provider: "openai", model: "gpt-5.6-sol" } });
  assert.equal(c.build.model, "gpt-5.5");
  assert.equal(c.evaluate.model, "claude-opus-4-8");
  assert.equal(c.build.effort, "high");
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
  assert.equal(lane.model, "gpt-5.5");
  assert.equal(lane.assignment.source, "fail-safe");
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
