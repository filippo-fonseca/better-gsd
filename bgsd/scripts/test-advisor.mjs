#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  ADVISOR_DUTIES, advisorActive, advisorGateReason,
  conductorSeedPath, normalizeAdvisorSetting, readConductorSeed,
} from "./advisor.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  PASS  ${name}\n`); }

test("advisor defaults on for every conductor model", () => {
  assert.equal(advisorActive({ conductor: { provider: "openai", model: "gpt-5.6-sol" } }), true);
  assert.equal(advisorActive({ conductor: { provider: "claude", model: "claude-fable-5" } }), true);
});
test("explicit false disables advisor", () => assert.equal(advisorActive({ setting: false }), false));
test("setting normalization is migration tolerant", () => {
  assert.equal(normalizeAdvisorSetting("off"), false);
  assert.equal(normalizeAdvisorSetting("yes"), true);
  assert.equal(normalizeAdvisorSetting("legacy-value"), "auto");
});
test("gate reason names the live conductor", () => {
  assert.match(advisorGateReason({ conductor: { provider: "openai", model: "gpt-5.6-sol" } }).reason, /openai\/gpt-5\.6-sol/);
});
test("four duties remain provider neutral", () => {
  assert.deepEqual(ADVISOR_DUTIES.map((d) => d.id), ["review-plan", "steer-pre-exec", "checkin-commits", "author-seeds"]);
  assert.equal(JSON.stringify(ADVISOR_DUTIES).includes("Fable"), false);
});
test("seed paths are stable and readable", () => {
  const path = conductorSeedPath("run-1", "unit-1", { bgsdDir: "/tmp/.bgsd" });
  assert.equal(path, "/tmp/.bgsd/runs/run-1/seeds/unit-1.md");
  assert.equal(readConductorSeed("run-1", "unit-1", { bgsdDir: "/tmp/.bgsd", existsFn: (p) => p === path }), path);
});

process.stdout.write(`\nadvisor.mjs: ${passed} passed\n`);
