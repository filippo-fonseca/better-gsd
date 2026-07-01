#!/usr/bin/env node
/**
 * phaseconfig.mjs — Phase 7: per-unit dynamic GSD phase selection
 *
 * Today bgsd tunes model + effort per work unit (bgsd_unit_posture, written by
 * writeUnitConfig in decompose.mjs). This module adds the orthogonal axis: WHICH
 * GSD phases run for a given unit. A trivial unit can skip research/plan-check/
 * code-review; a UI-heavy unit can add the UI phase; an AI unit can add the
 * AI-integration phase. The result is a deterministic `bgsd_phase_config` block
 * written to the same .planning/config.json — a pipeline agent reads it to
 * skip or add GSD phases per worktree.
 *
 * DESIGN PRINCIPLES
 * =================
 * - Pure + deterministic core: derivePhaseConfig is a pure function of the unit
 *   (its difficulty score + an area signal from its touched globs). Zero model
 *   calls (NFR-05).
 * - Config seam only: phase toggles are written under the bgsd_phase_config key
 *   in .planning/config.json. Every other key is preserved — crucially the
 *   sibling bgsd_unit_posture written by writeUnitConfig is never clobbered.
 *   Zero edits to vendored GSD (NFR-03/04).
 * - Atomic writes: temp file + rename, mirroring control.mjs writeAtomic, so the
 *   config file is never half-written.
 *
 * PHASE_CONFIG SCHEMA
 * ===================
 * derivePhaseConfig(unit) returns:
 * {
 *   research:             boolean — run the research phase (harder units only)
 *   plan_check:           boolean — run the plan-check phase
 *   code_review:          boolean — run the code-review phase
 *   ai_integration_phase: boolean — run the AI-integration phase (AI area OR very hard)
 *   ui_phase:             boolean — run the UI phase (UI area)
 * }
 *
 * writeUnitPhaseConfig writes { unit_id, ...phaseConfig } under bgsd_phase_config.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Area detection — cheap regex signal from a unit's touched globs (NFR-05)
// ---------------------------------------------------------------------------

/**
 * Regexes that classify a touched glob/area string as UI- or AI-flavored.
 * Matched against any single glob in the unit's `touched` array.
 */
const AREA_PATTERNS = {
  ui: /(ui|frontend|component|pages?|styles?|tailwind|\.(tsx|jsx|css|scss|html|vue|svelte))/i,
  ai: /(\bai\b|llm|agent|prompt|embedding|\bmodel\b)/i,
};

/**
 * Return true if ANY glob in `touched` matches the area `kind` pattern.
 *
 * @param {string[]} touched   the unit's touched file globs / area names
 * @param {"ui"|"ai"} kind     which area pattern to test
 * @returns {boolean}
 */
export function matchesArea(touched, kind) {
  const pattern = AREA_PATTERNS[kind];
  if (!pattern) return false;
  if (!Array.isArray(touched)) return false;
  return touched.some((glob) => typeof glob === "string" && pattern.test(glob));
}

// ---------------------------------------------------------------------------
// Phase config derivation — deterministic, pure (NFR-05)
// ---------------------------------------------------------------------------

/**
 * Derive the per-unit GSD phase toggles from a unit's difficulty + area signal.
 *
 * Rules (deterministic, no model calls):
 *   research:             difficulty >= 0.4
 *   plan_check:           difficulty >= 0.4
 *   code_review:          difficulty >= 0.5
 *   ai_integration_phase: touched matches AI area OR difficulty >= 0.8
 *   ui_phase:             touched matches UI area
 *
 * Missing difficulty is treated as 0; missing touched is treated as [].
 *
 * @param {{ difficulty?: number, touched?: string[] }} unit
 * @returns {{ research: boolean, plan_check: boolean, code_review: boolean,
 *             ai_integration_phase: boolean, ui_phase: boolean }}
 */
export function derivePhaseConfig(unit = {}) {
  const difficulty = typeof unit.difficulty === "number" ? unit.difficulty : 0;
  const touched = Array.isArray(unit.touched) ? unit.touched : [];

  return {
    research:             difficulty >= 0.4,
    plan_check:           difficulty >= 0.4,
    code_review:          difficulty >= 0.5,
    ai_integration_phase: matchesArea(touched, "ai") || difficulty >= 0.8,
    ui_phase:             matchesArea(touched, "ui"),
  };
}

// ---------------------------------------------------------------------------
// Config seam — write per-unit phase config (NFR-03/04, mirrors writeUnitConfig)
// ---------------------------------------------------------------------------

/**
 * Write the per-unit GSD phase config to a worktree's .planning/config.json.
 *
 * Sets ONLY the bgsd_phase_config key; preserves all other keys — in
 * particular it must not clobber the sibling bgsd_unit_posture written by
 * decompose.mjs's writeUnitConfig. Writes atomically (temp file + rename, like
 * control.mjs writeAtomic) so the config file is never half-written.
 * Zero edits to vendored GSD (NFR-03/04).
 *
 * @param {string} planningDir   path to the worktree's .planning/ directory
 * @param {object} phaseConfig   phase toggles from derivePhaseConfig()
 * @param {string} unitId        the unit id (recorded in config for traceability)
 * @returns {string}  path written
 */
export function writeUnitPhaseConfig(planningDir, phaseConfig, unitId) {
  mkdirSync(planningDir, { recursive: true });
  const configPath = join(planningDir, "config.json");

  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (_) {
      config = {};
    }
  }

  // Set phase config under the bgsd_phase_config key (config seam, NFR-04).
  // Every other key — including bgsd_unit_posture — is preserved.
  config.bgsd_phase_config = { unit_id: unitId, ...phaseConfig };

  // Atomic write: temp file + rename (POSIX-atomic, mirrors control.mjs).
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
  renameSync(tmpPath, configPath);
  return configPath;
}

// ---------------------------------------------------------------------------
// READ SEAM — read the per-unit seams back out of a worktree config
// ---------------------------------------------------------------------------

/**
 * Read the two per-unit seams from a worktree's .planning/config.json.
 *
 * Returns whatever is present; a missing file or missing key yields null for
 * that seam. A quick/fix unit (no decompose ran) has no bgsd_phase_config, so
 * phaseConfig comes back null — the signal for the light "direct fix" path.
 *
 * @param {string} planningDir   path to the worktree's .planning/ directory
 * @returns {{ phaseConfig: object|null, posture: object|null }}
 */
export function readUnitPhaseConfig(planningDir) {
  const configPath = join(planningDir, "config.json");
  if (!existsSync(configPath)) return { phaseConfig: null, posture: null };
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (_) {
    return { phaseConfig: null, posture: null };
  }
  return {
    phaseConfig: config.bgsd_phase_config ?? null,
    posture: config.bgsd_unit_posture ?? null,
  };
}

// ---------------------------------------------------------------------------
// PHASE PLAN — resolve toggles + scale into an ordered GSD phase run-list
// ---------------------------------------------------------------------------

/**
 * The ordered GSD phase vocabulary a pipeline agent can run for one unit.
 * ui-phase / ai-integration-phase are design-contract phases that run BEFORE
 * planning; plan + execute always run for a GSD unit; code-review is a gate
 * after execute. research / plan_check are honored INSIDE plan-phase via the
 * GSD workflow toggles (they are not standalone commands), which is why the
 * returned `workflow` object mirrors the phase config for GSD to read.
 */
const GSD_PHASE_COMMANDS = Object.freeze({
  "ui-phase": "/gsd-ui-phase",
  "ai-integration-phase": "/gsd-ai-integration-phase",
  plan: "/gsd-plan-phase",
  execute: "/gsd-execute-phase",
  "code-review": "/gsd-code-review",
});

/**
 * Resolve a unit's phase config + scale into an executable phase plan for a
 * pipeline agent (the /bgsd-run-agent reader consumes this).
 *
 * Two shapes:
 *   - DIRECT (light) path — when there is no phaseConfig (a quick/fix unit that
 *     never went through decompose) OR scale === "quick". The agent just makes
 *     the change directly; no GSD phases run. Loop 1 verify still runs after,
 *     separately, so "no GSD" never means "unverified".
 *   - GSD path — feature/project units. An ordered list of phases gated by the
 *     toggles, plus a `workflow` object (the same toggles) for the agent to
 *     write into GSD's config so research/plan_check/code_review are honored.
 *
 * Deterministic + pure: zero model calls (NFR-05).
 *
 * @param {object|null} phaseConfig   the unit's bgsd_phase_config, or null
 * @param {object} [opts]
 * @param {string} [opts.scale]       session scale (quick forces the direct path)
 * @returns {{ mode: "direct"|"gsd", workflow: object|null,
 *             phases: Array<{ id: string, command: string, run: boolean, reason: string }> }}
 */
export function resolvePhasePlan(phaseConfig, { scale } = {}) {
  if (!phaseConfig || scale === "quick") {
    return {
      mode: "direct",
      workflow: null,
      phases: [
        {
          id: "execute",
          command: "direct-fix",
          run: true,
          reason: scale === "quick"
            ? "quick scale — pipeline agent applies the change directly, no GSD"
            : "no per-unit phase config — quick/fix unit, direct change, no GSD",
        },
      ],
    };
  }

  // Normalize toggles to strict booleans (GSD workflow contract).
  const wf = {
    research:             !!phaseConfig.research,
    plan_check:           !!phaseConfig.plan_check,
    code_review:          !!phaseConfig.code_review,
    ai_integration_phase: !!phaseConfig.ai_integration_phase,
    ui_phase:             !!phaseConfig.ui_phase,
  };

  const phases = [];
  if (wf.ui_phase) {
    phases.push({ id: "ui-phase", command: GSD_PHASE_COMMANDS["ui-phase"], run: true,
      reason: "UI area — produce the UI-SPEC design contract before planning" });
  }
  if (wf.ai_integration_phase) {
    phases.push({ id: "ai-integration-phase", command: GSD_PHASE_COMMANDS["ai-integration-phase"], run: true,
      reason: "AI area or very high difficulty — produce the AI-SPEC before planning" });
  }
  phases.push({ id: "plan", command: GSD_PHASE_COMMANDS.plan, run: true,
    reason: wf.research
      ? "plan the unit (research + plan-check honored via workflow toggles)"
      : "plan the unit (research skipped — trivial enough)" });
  phases.push({ id: "execute", command: GSD_PHASE_COMMANDS.execute, run: true,
    reason: "execute the plan with atomic commits" });
  if (wf.code_review) {
    phases.push({ id: "code-review", command: GSD_PHASE_COMMANDS["code-review"], run: true,
      reason: "harder unit — run the code-review gate over changed files" });
  }

  return { mode: "gsd", workflow: wf, phases };
}

// ---------------------------------------------------------------------------
// CLI entrypoint — `--plan <planningDir> [--scale <scale>]`
// Prints the resolved phase plan as JSON so the /bgsd-run-agent markdown reader
// can fetch its marching orders with one deterministic call (no model needed).
// ---------------------------------------------------------------------------
if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://") ? import.meta.url : `file://${process.cwd()}/`
  ).href
) {
  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const key = args[i].slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) { flags[key] = next; i++; }
        else { flags[key] = true; }
      }
    }
    return flags;
  }

  const flags = parseFlags(process.argv.slice(2));

  if (flags.help || !flags.plan) {
    process.stderr.write(
      "Usage: node bgsd/scripts/phaseconfig.mjs --plan <planningDir> [--scale quick|feature|project]\n" +
      "  Reads <planningDir>/config.json and prints the resolved phase plan as JSON:\n" +
      "    { mode, workflow, phases }\n" +
      "  mode=direct  -> quick/fix unit, apply the change directly (no GSD phases)\n" +
      "  mode=gsd     -> run the listed /gsd-* phases in order; write `workflow` into GSD config\n"
    );
    process.exit(flags.help ? 0 : 1);
  }

  const planningDir = resolve(process.cwd(), String(flags.plan));
  const { phaseConfig } = readUnitPhaseConfig(planningDir);
  const scale = typeof flags.scale === "string" ? flags.scale : undefined;
  const plan = resolvePhasePlan(phaseConfig, { scale });
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
}
