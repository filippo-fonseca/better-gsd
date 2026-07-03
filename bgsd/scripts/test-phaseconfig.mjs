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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  matchesArea,
  derivePhaseConfig,
  writeUnitPhaseConfig,
  readUnitPhaseConfig,
  resolvePhasePlan,
} from "./phaseconfig.mjs";
import { writeUnitConfig, deriveModelPosture, writeUnitWorktreeConfig } from "./decompose.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

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
    assert.equal(config.bgsd_unit_posture.executor.model, "fable"); // 0.8 >= 0.5 -> fable
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
// readUnitPhaseConfig (read seam)
// ---------------------------------------------------------------------------

test("P11: readUnitPhaseConfig returns both seams written by writeUnitWorktreeConfig", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-phase-"));
  const planningDir = join(tmpDir, ".planning");
  try {
    const unit = { id: "unit-read-aa", difficulty: 0.85, touched: ["src/ui/App.tsx"],
      model_posture: deriveModelPosture(0.85) };
    writeUnitWorktreeConfig(planningDir, unit);

    const { phaseConfig, posture } = readUnitPhaseConfig(planningDir);
    assert.ok(phaseConfig, "phaseConfig must be present");
    assert.equal(phaseConfig.unit_id, "unit-read-aa");
    assert.equal(phaseConfig.ui_phase, true);
    assert.equal(phaseConfig.code_review, true);
    assert.ok(posture, "posture must be present");
    assert.equal(posture.unit_id, "unit-read-aa");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P12: readUnitPhaseConfig returns nulls for a missing/absent config (quick/fix unit)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-phase-"));
  try {
    // No config.json at all.
    const r1 = readUnitPhaseConfig(join(tmpDir, ".planning"));
    assert.deepEqual(r1, { phaseConfig: null, posture: null });
    // config.json exists but has no bgsd_* keys.
    const planningDir = join(tmpDir, ".planning");
    writeUnitConfig(planningDir, deriveModelPosture(0.9), "x"); // writes posture only
    const r2 = readUnitPhaseConfig(planningDir);
    assert.ok(r2.posture, "posture present");
    assert.equal(r2.phaseConfig, null, "no phase config -> null");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolvePhasePlan (phase run-list)
// ---------------------------------------------------------------------------

test("P13: resolvePhasePlan direct path when phaseConfig is null (quick/fix unit)", () => {
  const plan = resolvePhasePlan(null);
  assert.equal(plan.mode, "direct");
  assert.equal(plan.workflow, null);
  assert.equal(plan.phases.length, 1);
  assert.equal(plan.phases[0].command, "direct-fix");
});

test("P14: resolvePhasePlan direct path when scale is quick, even with a phaseConfig", () => {
  const plan = resolvePhasePlan(derivePhaseConfig({ difficulty: 0.9, touched: ["src/ui/App.tsx"] }),
    { scale: "quick" });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.phases[0].command, "direct-fix");
});

test("P15: resolvePhasePlan trivial GSD unit -> only plan + execute (no ui/ai/review)", () => {
  const plan = resolvePhasePlan(derivePhaseConfig({ difficulty: 0.2, touched: ["docs/x.md"] }));
  assert.equal(plan.mode, "gsd");
  assert.deepEqual(plan.phases.map((p) => p.id), ["plan", "execute"]);
  // research/plan_check false at difficulty 0.2 -> honored via workflow object.
  assert.equal(plan.workflow.research, false);
  assert.equal(plan.workflow.plan_check, false);
  assert.equal(plan.workflow.code_review, false);
});

test("P16: resolvePhasePlan UI unit -> ui-phase precedes plan/execute + code-review gate", () => {
  const plan = resolvePhasePlan(derivePhaseConfig({ difficulty: 0.6, touched: ["src/components/Nav.tsx"] }));
  assert.equal(plan.mode, "gsd");
  assert.deepEqual(plan.phases.map((p) => p.id), ["ui-phase", "plan", "execute", "code-review"]);
  assert.equal(plan.phases[0].command, "/gsd-ui-phase");
  assert.equal(plan.workflow.ui_phase, true);
  assert.equal(plan.workflow.code_review, true);
});

test("P17: resolvePhasePlan AI unit -> ai-integration-phase precedes plan/execute", () => {
  const plan = resolvePhasePlan(derivePhaseConfig({ difficulty: 0.4, touched: ["src/llm/agent.ts"] }));
  assert.equal(plan.mode, "gsd");
  assert.deepEqual(plan.phases.map((p) => p.id), ["ai-integration-phase", "plan", "execute"]);
  assert.equal(plan.workflow.ai_integration_phase, true);
  assert.equal(plan.workflow.code_review, false); // 0.4 < 0.5
});

test("P18: resolvePhasePlan hard UI+AI unit -> ui, ai, plan, execute, code-review in order", () => {
  const plan = resolvePhasePlan(derivePhaseConfig({ difficulty: 0.9, touched: ["src/ai/ui/Chat.tsx"] }));
  assert.deepEqual(plan.phases.map((p) => p.id),
    ["ui-phase", "ai-integration-phase", "plan", "execute", "code-review"]);
});

test("P19: resolvePhasePlan coerces truthy/missing toggles to strict booleans", () => {
  const plan = resolvePhasePlan({ research: 1, ui_phase: "yes" }); // odd inputs
  assert.equal(plan.workflow.research, true);
  assert.equal(plan.workflow.ui_phase, true);
  assert.equal(plan.workflow.code_review, false); // missing -> false
});

// ---------------------------------------------------------------------------
// CLI — `--plan <planningDir>` prints the resolved plan as JSON
// ---------------------------------------------------------------------------

test("P20: CLI --plan prints the resolved phase plan JSON for a GSD unit", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-phase-"));
  const planningDir = join(tmpDir, ".planning");
  try {
    writeUnitWorktreeConfig(planningDir, {
      id: "unit-cli-aa", difficulty: 0.6, touched: ["src/components/Nav.tsx"],
      model_posture: deriveModelPosture(0.6),
    });
    const script = join(__dir, "phaseconfig.mjs");
    const r = spawnSync(process.execPath, [script, "--plan", planningDir], { encoding: "utf8" });
    assert.equal(r.status, 0, `CLI should exit 0, stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "gsd");
    assert.deepEqual(out.phases.map((p) => p.id), ["ui-phase", "plan", "execute", "code-review"]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P21: CLI --plan on a config-less dir prints the direct path", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-phase-"));
  try {
    const script = join(__dir, "phaseconfig.mjs");
    const r = spawnSync(process.execPath, [script, "--plan", join(tmpDir, ".planning")], { encoding: "utf8" });
    assert.equal(r.status, 0, `CLI should exit 0, stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "direct");
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
