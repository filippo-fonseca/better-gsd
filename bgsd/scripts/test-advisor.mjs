#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_CHECKPOINTS, ADVISOR_DUTIES, advisorActive, advisorDirectivePath,
  advisorGateReason, conductorSeedPath, normalizeAdvisorSetting, readConductorSeed,
  writeAdvisorDirective,
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
  assert.deepEqual(ADVISOR_DUTIES.map((d) => d.id), ["review-plan", "steer-pre-exec", "steer-active-workers", "author-seeds"]);
  assert.equal(JSON.stringify(ADVISOR_DUTIES).includes("Fable"), false);
});
test("seed paths are stable and readable", () => {
  const path = conductorSeedPath("run-1", "unit-1", { bgsdDir: "/tmp/.bgsd" });
  assert.equal(path, "/tmp/.bgsd/runs/run-1/seeds/unit-1.md");
  assert.equal(readConductorSeed("run-1", "unit-1", { bgsdDir: "/tmp/.bgsd", existsFn: (p) => p === path }), path);
});
test("steering directives are durable and name every checkpoint", () => {
  const bgsdDir = mkdtempSync(join(tmpdir(), "bgsd-advisor-"));
  try {
    const path = writeAdvisorDirective("run-1", "unit-1", {
      bgsdDir, scale: "feature", message: "Keep the migration reversible.", now: new Date("2026-07-13T00:00:00Z"),
    });
    assert.equal(path, advisorDirectivePath("run-1", "unit-1", { bgsdDir }));
    const text = readFileSync(path, "utf8");
    assert.match(text, /Keep the migration reversible/);
    for (const checkpoint of ADVISOR_CHECKPOINTS) assert.ok(text.includes(checkpoint));
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

process.stdout.write(`\nadvisor.mjs: ${passed} passed\n`);
