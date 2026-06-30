#!/usr/bin/env node
/**
 * test-phaseconfig.mjs — Unit tests for phaseconfig.mjs (Phase 7)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-phaseconfig.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Test groups:
 *   P01 — matchesArea: UI globs detected, non-UI rejected
 *   P02 — matchesArea: AI globs detected, non-AI rejected
 *   P03 — matchesArea: defensive on missing/non-array touched
 *   P04 — derivePhaseConfig: trivial unit (low difficulty, docs) -> all false
 *   P05 — derivePhaseConfig: UI unit -> research/plan_check/code_review + ui true, ai false
 *   P06 — derivePhaseConfig: AI unit -> ai_integration_phase true
 *   P07 — derivePhaseConfig: high-difficulty unit -> ai_integration_phase true w/o AI path
 *   P08 — derivePhaseConfig: missing difficulty/touched defaulted (0 / [])
 *   P09 — writeUnitPhaseConfig: writes bgsd_phase_config under unit_id
 *   P10 — writeUnitPhaseConfig: PRESERVES an existing bgsd_unit_posture key
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { matchesArea, derivePhaseConfig, writeUnitPhaseConfig } from "./phaseconfig.mjs";
import { writeUnitConfig, deriveModelPosture } from "./decompose.mjs";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${err.message}\n`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// matchesArea
// ---------------------------------------------------------------------------

test("P01: matchesArea detects UI globs, rejects non-UI", () => {
  assert.equal(matchesArea(["src/components/Nav.tsx"], "ui"), true);
  assert.equal(matchesArea(["app/pages/index.jsx"], "ui"), true);
  assert.equal(matchesArea(["styles/main.scss"], "ui"), true);
  assert.equal(matchesArea(["tailwind.config.js"], "ui"), true);
  assert.equal(matchesArea(["public/index.html"], "ui"), true);
  assert.equal(matchesArea(["src/lib/db.ts"], "ui"), false);
  assert.equal(matchesArea(["docs/x.md"], "ui"), false);
});

test("P02: matchesArea detects AI globs, rejects non-AI", () => {
  assert.equal(matchesArea(["src/llm/agent.ts"], "ai"), true);
  assert.equal(matchesArea(["src/prompt/templates.ts"], "ai"), true);
  assert.equal(matchesArea(["lib/embedding/index.ts"], "ai"), true);
  assert.equal(matchesArea(["ai/router.ts"], "ai"), true);
  assert.equal(matchesArea(["src/model/registry.ts"], "ai"), true); // \bmodel\b matches "model"
  // \bmodel\b is word-bounded: "models" does NOT match (trailing word char).
  assert.equal(matchesArea(["src/models/user.ts"], "ai"), false);
  assert.equal(matchesArea(["src/api/handler.ts"], "ai"), false);
  assert.equal(matchesArea(["docs/x.md"], "ai"), false);
});

test("P03: matchesArea is defensive on missing/non-array touched and unknown kind", () => {
  assert.equal(matchesArea(undefined, "ui"), false);
  assert.equal(matchesArea(null, "ai"), false);
  assert.equal(matchesArea("src/x.tsx", "ui"), false); // string, not array
  assert.equal(matchesArea([null, 42, "src/x.tsx"], "ui"), true); // ignores non-strings
  assert.equal(matchesArea(["src/x.tsx"], "nope"), false); // unknown kind
});

// ---------------------------------------------------------------------------
// derivePhaseConfig
// ---------------------------------------------------------------------------

test("P04: trivial unit (difficulty 0.2, docs) -> all flags false", () => {
  const cfg = derivePhaseConfig({ difficulty: 0.2, touched: ["docs/x.md"] });
  assert.deepEqual(cfg, {
    research: false,
    plan_check: false,
    code_review: false,
    ai_integration_phase: false,
    ui_phase: false,
  });
});

test("P05: UI unit (0.5, Nav.tsx) -> research/plan_check/code_review + ui true, ai false", () => {
  const cfg = derivePhaseConfig({ difficulty: 0.5, touched: ["src/components/Nav.tsx"] });
  assert.equal(cfg.research, true);
  assert.equal(cfg.plan_check, true);
  assert.equal(cfg.code_review, true);
  assert.equal(cfg.ui_phase, true);
  assert.equal(cfg.ai_integration_phase, false);
});

test("P06: AI unit (0.4, llm/agent.ts) -> ai_integration_phase true", () => {
  const cfg = derivePhaseConfig({ difficulty: 0.4, touched: ["src/llm/agent.ts"] });
  assert.equal(cfg.ai_integration_phase, true);
  assert.equal(cfg.research, true);   // 0.4 >= 0.4
  assert.equal(cfg.plan_check, true); // 0.4 >= 0.4
  assert.equal(cfg.code_review, false); // 0.4 < 0.5
  assert.equal(cfg.ui_phase, false);
});

test("P07: high-difficulty unit (0.85, no AI path) -> ai_integration_phase true", () => {
  const cfg = derivePhaseConfig({ difficulty: 0.85, touched: ["src/lib/scheduler.ts"] });
  assert.equal(cfg.ai_integration_phase, true); // 0.85 >= 0.8
  assert.equal(cfg.research, true);
  assert.equal(cfg.plan_check, true);
  assert.equal(cfg.code_review, true);
  assert.equal(cfg.ui_phase, false);
});

test("P08: missing difficulty/touched defaulted to 0 / []", () => {
  const cfg = derivePhaseConfig({});
  assert.deepEqual(cfg, {
    research: false,
    plan_check: false,
    code_review: false,
    ai_integration_phase: false,
    ui_phase: false,
  });
  // Called with no args at all
  assert.deepEqual(derivePhaseConfig(), cfg);
});

// ---------------------------------------------------------------------------
// writeUnitPhaseConfig (config seam)
// ---------------------------------------------------------------------------

test("P09: writeUnitPhaseConfig writes bgsd_phase_config with unit_id", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-phase-"));
  const planningDir = join(tmpDir, ".planning");
  try {
    const phaseConfig = derivePhaseConfig({ difficulty: 0.5, touched: ["src/ui/App.tsx"] });
    const configPath = writeUnitPhaseConfig(planningDir, phaseConfig, "unit-test-aa");

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.ok(config.bgsd_phase_config, "config must have bgsd_phase_config");
    assert.equal(config.bgsd_phase_config.unit_id, "unit-test-aa");
    assert.equal(config.bgsd_phase_config.ui_phase, true);
    assert.equal(config.bgsd_phase_config.code_review, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P10: writeUnitPhaseConfig PRESERVES an existing bgsd_unit_posture key", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-phase-"));
  const planningDir = join(tmpDir, ".planning");
  try {
    // 1. Write posture first via decompose's writeUnitConfig.
    const posture = deriveModelPosture(0.8);
    writeUnitConfig(planningDir, posture, "unit-test-bb");

    // 2. Write phase config next.
    const phaseConfig = derivePhaseConfig({ difficulty: 0.8, touched: ["src/llm/agent.ts"] });
    const configPath = writeUnitPhaseConfig(planningDir, phaseConfig, "unit-test-bb");

    // 3. Both keys must be present and intact.
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.ok(config.bgsd_unit_posture, "bgsd_unit_posture must be preserved");
    assert.equal(config.bgsd_unit_posture.unit_id, "unit-test-bb");
    assert.equal(config.bgsd_unit_posture.executor.model, "opus");
    assert.ok(config.bgsd_phase_config, "bgsd_phase_config must be present");
    assert.equal(config.bgsd_phase_config.unit_id, "unit-test-bb");
    assert.equal(config.bgsd_phase_config.ai_integration_phase, true);

    const keys = Object.keys(config);
    assert.ok(keys.includes("bgsd_unit_posture") && keys.includes("bgsd_phase_config"),
      "both seams must coexist");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\nphaseconfig.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
