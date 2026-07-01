#!/usr/bin/env node
/**
 * run-units.mjs — per-run unit persistence (SPAWN-04 threading helper)
 *
 * The live spawn boundary (liveSpawnFn in run-live.mjs) needs the FULL decomposed
 * unit (title, scope, criteria, touched, difficulty, model_posture, ...) plus the
 * run's scale to write .planning/config.json + .planning/bgsd-unit.json inside a
 * worktree. runLifecycle only records unit IDS into run.json, and the injected
 * spawnFn signature is (unitId, plan) — it does not carry the unit blob.
 *
 * This module bridges that gap without widening every function signature: at the
 * point where the run first records its units, the caller persists each full unit
 * (and the scale) to disk under the run directory. liveSpawnFn then reads the unit
 * back by id (a robust fallback that keeps the injected signature clean).
 *
 * LAYOUT
 * ======
 *   .bgsd/runs/<runId>/units/<unitId>.json   — one full unit object per file
 *   .bgsd/runs/<runId>/units/_meta.json      — { scale, unit_ids, written_at }
 *
 * All writes are atomic (temp + rename on the same fs) so a reader never sees a
 * half-written file (mirrors control.mjs / run.mjs atomic I/O).
 *
 * Usage (library):
 *   import { persistRunUnits, readRunUnit, readRunScale } from './run-units.mjs';
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

/** Default .bgsd directory when a caller does not override it. */
function defaultBgsdDir() {
  return join(REPO_ROOT, ".bgsd");
}

/** Absolute path to a run's units directory. */
export function runUnitsDir(runId, { bgsdDir } = {}) {
  return join(bgsdDir ?? defaultBgsdDir(), "runs", runId, "units");
}

/** Write JSON atomically (temp + rename). */
function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

/**
 * Persist every decomposed unit + the run scale for a run.
 *
 * Writes one file per unit (keyed by unit id) plus a `_meta.json` carrying the
 * scale and the ordered list of unit ids. Idempotent: re-running overwrites.
 *
 * @param {string}   runId    The run id (e.g. "bgsd-0001-add-auth")
 * @param {object[]} units    Full decomposed unit objects (from decompose.buildUnits)
 * @param {object}   [opts]
 * @param {string}   [opts.bgsdDir]  Override the .bgsd dir (default <repo>/.bgsd)
 * @param {string}   [opts.scale]    Run scale ("quick"|"feature"|"project")
 * @returns {{ dir: string, unit_ids: string[], scale: string|null }}
 */
export function persistRunUnits(runId, units, { bgsdDir, scale } = {}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("persistRunUnits: runId is required and must be a string");
  }
  if (!Array.isArray(units)) {
    throw new Error("persistRunUnits: units must be an array");
  }

  const dir = runUnitsDir(runId, { bgsdDir });
  mkdirSync(dir, { recursive: true });

  const unitIds = [];
  for (const unit of units) {
    if (!unit || typeof unit !== "object" || !unit.id) {
      throw new Error("persistRunUnits: every unit must be an object with an id");
    }
    writeJsonAtomic(join(dir, `${unit.id}.json`), unit);
    unitIds.push(unit.id);
  }

  const meta = {
    scale: scale ?? null,
    unit_ids: unitIds,
    written_at: new Date().toISOString(),
  };
  writeJsonAtomic(join(dir, "_meta.json"), meta);

  return { dir, unit_ids: unitIds, scale: meta.scale };
}

/**
 * Read a single persisted unit back by id.
 *
 * @param {string} runId
 * @param {string} unitId
 * @param {object} [opts]
 * @param {string} [opts.bgsdDir]
 * @returns {object|null}  The full unit object, or null if not persisted.
 */
export function readRunUnit(runId, unitId, { bgsdDir } = {}) {
  const p = join(runUnitsDir(runId, { bgsdDir }), `${unitId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

/**
 * Read the persisted scale for a run.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.bgsdDir]
 * @returns {string|null}  The scale, or null if not persisted.
 */
export function readRunScale(runId, { bgsdDir } = {}) {
  const p = join(runUnitsDir(runId, { bgsdDir }), "_meta.json");
  if (!existsSync(p)) return null;
  try {
    const meta = JSON.parse(readFileSync(p, "utf8"));
    return meta.scale ?? null;
  } catch (_) {
    return null;
  }
}
