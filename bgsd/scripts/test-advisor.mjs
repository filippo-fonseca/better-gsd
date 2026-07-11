#!/usr/bin/env node
/**
 * test-advisor.mjs — Unit tests for advisor.mjs (Fable-as-Advisor gate).
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-advisor.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Test groups:
 *   A01 — isFableBrain: id / substring / harness-map hits, and misses
 *   A02 — normalizeAdvisorSetting: bools, strings, default-to-auto
 *   A03 — fableAdvisorActive: the three OR-criteria each enable it
 *   A04 — fableAdvisorActive: OFF when no criterion holds
 *   A05 — fableAdvisorActive: explicit setting overrides the criteria
 *   A06 — advisorGateReason: reports which criterion fired
 *   A07 — conductorSeedPath / readConductorSeed: path shape + exists gating
 */

import assert from "node:assert/strict";

import {
  FABLE_MODEL_ID,
  isFableBrain,
  normalizeAdvisorSetting,
  fableAdvisorActive,
  advisorGateReason,
  conductorSeedPath,
  readConductorSeed,
  ADVISOR_DUTIES,
} from "./advisor.mjs";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failures++;
    process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
  }
}

// A01 — isFableBrain
test("A01: isFableBrain matches the canonical id and bare substring", () => {
  assert.equal(isFableBrain(FABLE_MODEL_ID), true);
  assert.equal(isFableBrain("claude-fable-5"), true);
  assert.equal(isFableBrain("Claude-Fable-6-Preview"), true, "case-insensitive substring");
});
test("A01: isFableBrain matches a harness fable mapping", () => {
  assert.equal(
    isFableBrain("some-fable-alias", { claude: { fable: "some-fable-alias" } }),
    true
  );
});
test("A01: isFableBrain is false for Opus/Sonnet/empty", () => {
  assert.equal(isFableBrain("claude-opus-4-8"), false);
  assert.equal(isFableBrain("sonnet"), false);
  assert.equal(isFableBrain(""), false);
  assert.equal(isFableBrain(undefined), false);
});

// A02 — normalizeAdvisorSetting
test("A02: normalizeAdvisorSetting handles bools, strings, and defaults to auto", () => {
  assert.equal(normalizeAdvisorSetting(true), true);
  assert.equal(normalizeAdvisorSetting(false), false);
  assert.equal(normalizeAdvisorSetting("on"), true);
  assert.equal(normalizeAdvisorSetting("OFF"), false);
  assert.equal(normalizeAdvisorSetting("auto"), "auto");
  assert.equal(normalizeAdvisorSetting(undefined), "auto");
  assert.equal(normalizeAdvisorSetting("nonsense"), "auto");
});

// A03 — each criterion enables it (setting defaults to auto)
test("A03: criterion (a) — Conductor brain is Fable enables advisor", () => {
  assert.equal(fableAdvisorActive({ sessionModel: "claude-fable-5" }), true);
});
test("A03: criterion (b) — --fable enables advisor even on Opus", () => {
  assert.equal(fableAdvisorActive({ sessionModel: "claude-opus-4-8", fableFlag: true }), true);
});
test("A03: criterion (c) — approved proposal enables advisor even on Opus", () => {
  assert.equal(fableAdvisorActive({ sessionModel: "claude-opus-4-8", approved: true }), true);
});

// A04 — OFF when nothing holds
test("A04: OFF on Opus with no flag and no approval", () => {
  assert.equal(fableAdvisorActive({ sessionModel: "claude-opus-4-8" }), false);
});
test("A04: OFF with an empty context (safe default)", () => {
  assert.equal(fableAdvisorActive(), false);
  assert.equal(fableAdvisorActive({}), false);
});

// A05 — explicit setting overrides the criteria
test("A05: setting=false hard-disables even on Fable", () => {
  assert.equal(fableAdvisorActive({ sessionModel: "claude-fable-5", setting: false }), false);
  assert.equal(fableAdvisorActive({ sessionModel: "claude-fable-5", setting: "off" }), false);
});
test("A05: setting=true forces on even on Opus with no flag", () => {
  assert.equal(fableAdvisorActive({ sessionModel: "claude-opus-4-8", setting: true }), true);
  assert.equal(fableAdvisorActive({ sessionModel: "claude-opus-4-8", setting: "on" }), true);
});

// A06 — advisorGateReason
test("A06: advisorGateReason reports the firing criterion", () => {
  assert.match(advisorGateReason({ sessionModel: "claude-fable-5" }).reason, /brain is Fable/);
  assert.match(advisorGateReason({ fableFlag: true }).reason, /--fable/);
  assert.match(advisorGateReason({ approved: true }).reason, /approved/);
  assert.match(advisorGateReason({ setting: false }).reason, /disabled/);
  assert.match(advisorGateReason({ setting: true }).reason, /forced on/);
  const off = advisorGateReason({ sessionModel: "opus" });
  assert.equal(off.active, false);
  assert.match(off.reason, /no --fable/);
});

// A07 — seed seam
test("A07: conductorSeedPath builds the .bgsd/runs/<run>/seeds/<unit>.md path", () => {
  const p = conductorSeedPath("run-123", "unit-abc", { bgsdDir: "/tmp/.bgsd" });
  assert.equal(p, "/tmp/.bgsd/runs/run-123/seeds/unit-abc.md");
});
test("A07: readConductorSeed returns the path when it exists, null otherwise", () => {
  const present = readConductorSeed("r", "u", { bgsdDir: "/x", existsFn: () => true });
  assert.equal(present, "/x/runs/r/seeds/u.md");
  const absent = readConductorSeed("r", "u", { bgsdDir: "/x", existsFn: () => false });
  assert.equal(absent, null);
});

// Sanity: duties are well-formed
test("A07: ADVISOR_DUTIES has the four duties with hooks", () => {
  assert.equal(ADVISOR_DUTIES.length, 4);
  for (const d of ADVISOR_DUTIES) {
    assert.ok(d.id && d.label && d.hook && Array.isArray(d.reads));
  }
});

if (failures > 0) {
  process.stdout.write(`\n${failures} test(s) failed.\n`);
  process.exit(1);
}
process.stdout.write("\nAll advisor tests passed.\n");
