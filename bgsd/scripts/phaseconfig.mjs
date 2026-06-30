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
import { join } from "node:path";

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
