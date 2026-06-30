#!/usr/bin/env node
/**
 * decompose.mjs — Phase 1: GRAPH-01 (Decomposition)
 *
 * Decomposes a project prompt into a list of whole-GSD-pipeline-sized UNITS.
 * Each unit is a self-contained chunk of work that can be executed as an
 * independent GSD pipeline (discuss → plan → execute).
 *
 * DESIGN PRINCIPLES
 * =================
 * - Deterministic rule-based core: all structural logic (id generation, schema
 *   validation, per-unit difficulty scoring, config posture derivation) is pure
 *   and script-driven — zero model calls (NFR-05).
 * - MODEL SEAM (clearly marked): the actual decomposition of a raw prompt into
 *   unit titles/scopes/deps is the single highest-leverage model call in the
 *   whole system (GRAPH-01, Plan Part 11 "decompose prompt → dependency graph"
 *   row: Opus/xhigh). THIS FILE provides the contract + utilities that surround
 *   that call. The model seam is `parseDecompositionResponse()` — in production
 *   the Conductor calls Opus/xhigh and passes the response here. In unit tests
 *   the caller supplies fixture data directly to `buildUnits()`.
 * - Config seam only: per-unit model posture is written to
 *   .planning/config.json; zero edits to vendored GSD (NFR-03/04, GRAPH-04).
 *
 * UNIT SCHEMA
 * ===========
 * Each unit is a plain object:
 * {
 *   id:           string   — stable "unit-<slug>-<4hex>" identifier
 *   title:        string   — human-readable work item title
 *   scope:        string   — brief prose scope summary
 *   touched:      string[] — file globs / area names the unit will touch
 *   deps:         string[] — ids of units this unit depends on
 *   difficulty:   number   — score in [0, 1] (cheap heuristic, GRAPH-04)
 *   model_posture: object  — { executor, verifier, researcher } model×effort
 *                           (the per-worktree routing matrix written to config)
 * }
 *
 * GRAPH-04 ROUTING MATRIX
 * =======================
 * Per-unit model posture is derived from a cheap difficulty score:
 *   difficulty_score = 0.4 * touched_size_factor
 *                    + 0.3 * dep_count_factor
 *                    + 0.2 * title_word_factor
 *                    + 0.1 * scope_len_factor
 *
 * Resulting posture tiers:
 *   high (>= 0.7):   executor = { model: "opus",   effort: "xhigh" }
 *   medium (>= 0.4): executor = { model: "sonnet",  effort: "high"  }
 *   low  (< 0.4):    executor = { model: "haiku",   effort: "medium" }
 *
 * Researcher and verifier are always demoted relative to executor (Plan Part 11):
 *   researcher: one tier below executor (max sonnet/medium)
 *   verifier:   always haiku/low
 *
 * Usage (library):
 *   import { buildUnits, deriveModelPosture, parseDecompositionResponse,
 *            writeUnitConfig } from './decompose.mjs';
 *
 * Usage (CLI):
 *   node bgsd/scripts/decompose.mjs --fixture <path>   # parse a fixture JSON file
 *   node bgsd/scripts/decompose.mjs --help
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";

import { derivePhaseConfig, writeUnitPhaseConfig } from "./phaseconfig.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable unit id from a title slug + 4 random hex bytes.
 * Format: "unit-<slug>-<4hex>"
 *
 * @param {string} title
 * @returns {string}
 */
export function generateUnitId(title) {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hex = randomBytes(2).toString("hex");
  return `unit-${slug || "task"}-${hex}`;
}

// ---------------------------------------------------------------------------
// Difficulty scoring — cheap heuristic (GRAPH-04, NFR-05)
// ---------------------------------------------------------------------------

/**
 * Compute a cheap, deterministic difficulty score for a unit.
 * Returns a value in [0, 1]. Zero model calls.
 *
 * Factors:
 *   touched_size:  number of touched globs/areas (more = harder)
 *   dep_count:     number of declared dependencies (more deps = more complex)
 *   title_words:   word count of the title
 *   scope_len:     character length of the scope summary
 *
 * @param {object} opts
 * @param {string[]} opts.touched
 * @param {string[]} opts.deps
 * @param {string}   opts.title
 * @param {string}   opts.scope
 * @returns {number}  score in [0, 1]
 */
export function difficultyScore({ touched = [], deps = [], title = "", scope = "" }) {
  const touchedFactor = Math.min(touched.length / 8, 1.0);   // 8+ files = max
  const depFactor     = Math.min(deps.length / 4, 1.0);      // 4+ deps = max
  const titleFactor   = Math.min(title.trim().split(/\s+/).length / 10, 1.0); // 10+ words = max
  const scopeFactor   = Math.min(scope.trim().length / 300, 1.0); // 300+ chars = max

  return (
    0.4 * touchedFactor +
    0.3 * depFactor +
    0.2 * titleFactor +
    0.1 * scopeFactor
  );
}

// ---------------------------------------------------------------------------
// Model posture derivation (GRAPH-04)
// ---------------------------------------------------------------------------

/**
 * The per-role × per-effort routing matrix tiers.
 * Executor is promoted on hard units; researcher/verifier are always demoted.
 */
const POSTURE_TIERS = {
  high:   { model: "opus",   effort: "xhigh" },
  medium: { model: "sonnet", effort: "high"  },
  low:    { model: "haiku",  effort: "medium" },
};

const DEMOTION_MAP = {
  high:   "medium",  // executor=high -> researcher=medium
  medium: "low",     // executor=medium -> researcher=low
  low:    "low",     // executor=low -> researcher=low (already at floor)
};

/**
 * Derive the per-unit model posture from a difficulty score.
 * Returns the would-be .planning/config.json `bgsd_unit_posture` structure.
 *
 * Executor tier:
 *   score >= 0.7  -> high  (opus/xhigh)
 *   score >= 0.4  -> medium (sonnet/high)
 *   score < 0.4   -> low   (haiku/medium)
 *
 * Researcher: one tier below executor (never above sonnet/medium).
 * Verifier: always low (haiku/low) — cheap, deterministic verification.
 *
 * @param {number} score   difficulty score in [0, 1]
 * @returns {{ executor: object, researcher: object, verifier: object }}
 */
export function deriveModelPosture(score) {
  const tier = score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low";
  const researcherTier = DEMOTION_MAP[tier];

  return {
    executor:   { ...POSTURE_TIERS[tier] },
    researcher: { ...POSTURE_TIERS[researcherTier] },
    verifier:   { model: "haiku", effort: "low" }, // always haiku/low (Plan Part 11)
  };
}

// ---------------------------------------------------------------------------
// Config seam — write per-unit posture (GRAPH-04, NFR-03/04)
// ---------------------------------------------------------------------------

/**
 * Write the per-unit model posture to a worktree's .planning/config.json.
 * Only touches the bgsd_unit_posture key; preserves all other keys.
 * Zero edits to vendored GSD (NFR-03/04).
 *
 * @param {string} planningDir   path to the worktree's .planning/ directory
 * @param {object} posture       model posture from deriveModelPosture()
 * @param {string} unitId        the unit id (recorded in config for traceability)
 * @returns {string}  path written
 */
export function writeUnitConfig(planningDir, posture, unitId) {
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

  // Set model posture under the bgsd_unit_posture key (config seam, NFR-04)
  config.bgsd_unit_posture = { unit_id: unitId, ...posture };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

/**
 * Write BOTH per-unit config seams to a worktree's .planning/config.json:
 *   1. bgsd_unit_posture  — model × effort routing (GRAPH-04, writeUnitConfig)
 *   2. bgsd_phase_config  — which GSD phases run for this unit (Phase 7)
 *
 * The two seams are orthogonal and must coexist: writeUnitConfig sets the
 * posture key first, then writeUnitPhaseConfig layers the phase toggles on top
 * without clobbering posture (both functions preserve every other key). A
 * pipeline agent reads bgsd_phase_config to skip/add phases per worktree and
 * bgsd_unit_posture to route models.
 *
 * @param {string} planningDir   path to the worktree's .planning/ directory
 * @param {object} unit          the full unit object (has difficulty, touched,
 *                               model_posture, id)
 * @returns {string}  path written
 */
export function writeUnitWorktreeConfig(planningDir, unit) {
  // 1. Posture first (sets bgsd_unit_posture, preserves other keys).
  writeUnitConfig(planningDir, unit.model_posture, unit.id);
  // 2. Phase config next (sets bgsd_phase_config, preserves bgsd_unit_posture).
  const phaseConfig = derivePhaseConfig(unit);
  return writeUnitPhaseConfig(planningDir, phaseConfig, unit.id);
}

// ---------------------------------------------------------------------------
// MODEL SEAM — parseDecompositionResponse (GRAPH-01)
// *** THIS IS THE MODEL SEAM ***
// ---------------------------------------------------------------------------

/**
 * Parse a model-generated decomposition response into a raw units array.
 *
 * *** MODEL SEAM ***
 * In production the Conductor calls Opus/xhigh with the decomposition prompt
 * and receives JSON (or text) back. This function normalises that response
 * into the shape that buildUnits() expects. The model itself never runs here.
 *
 * Expected response shape (JSON string or already-parsed object):
 * {
 *   "units": [
 *     {
 *       "title":   "string (required)",
 *       "scope":   "string (optional, defaults to '')",
 *       "touched": ["glob", ...] (optional, defaults to []),
 *       "deps":    ["unit title or id", ...] (optional, resolved by buildUnits)
 *     },
 *     ...
 *   ]
 * }
 *
 * The model may return a JSON string or a plain object. Both are accepted.
 * Unknown keys are ignored. Missing optional keys are defaulted.
 *
 * @param {string|object} rawResponse  the model's output (JSON string or object)
 * @returns {Array<{title, scope, touched, deps}>}  normalised raw unit descriptors
 * @throws {Error} if the response is unparseable or missing the `units` array
 */
export function parseDecompositionResponse(rawResponse) {
  let parsed;
  if (typeof rawResponse === "string") {
    // Strip optional markdown code fences the model may wrap around JSON
    const stripped = rawResponse.replace(/^```[a-z]*\n?/m, "").replace(/```\s*$/m, "").trim();
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      throw new Error(
        `parseDecompositionResponse: could not parse model response as JSON: ${err.message}`
      );
    }
  } else if (rawResponse && typeof rawResponse === "object") {
    parsed = rawResponse;
  } else {
    throw new Error(
      `parseDecompositionResponse: expected a JSON string or object, got ${typeof rawResponse}`
    );
  }

  if (!Array.isArray(parsed.units)) {
    throw new Error(
      `parseDecompositionResponse: response must have a "units" array, got keys: [${Object.keys(parsed).join(", ")}]`
    );
  }

  return parsed.units.map((u, i) => {
    if (!u.title || typeof u.title !== "string" || !u.title.trim()) {
      throw new Error(`parseDecompositionResponse: unit[${i}] is missing a required "title"`);
    }
    return {
      title:   u.title.trim(),
      scope:   typeof u.scope   === "string" ? u.scope.trim()   : "",
      touched: Array.isArray(u.touched) ? u.touched.map(String) : [],
      deps:    Array.isArray(u.deps)    ? u.deps.map(String)    : [],
    };
  });
}

// ---------------------------------------------------------------------------
// buildUnits — assemble the full unit array (GRAPH-01)
// ---------------------------------------------------------------------------

/**
 * Build a fully-structured unit array from raw descriptors.
 *
 * Each unit gets:
 *   - A stable generated id
 *   - Difficulty score (cheap heuristic)
 *   - Derived model posture
 *   - Resolved dep ids (raw deps may reference titles; this resolves them by
 *     title match after ids are assigned, so callers can pass title-based deps)
 *
 * This is the only function in the decomposition path that requires a complete
 * descriptor list (because dep resolution is cross-unit). Everything else
 * operates on individual units.
 *
 * @param {Array<{title, scope?, touched?, deps?}>} rawDescriptors
 *   Array of raw descriptors (from parseDecompositionResponse or a fixture).
 * @returns {Array<UnitObject>}  fully-structured units
 */
export function buildUnits(rawDescriptors) {
  if (!Array.isArray(rawDescriptors) || rawDescriptors.length === 0) {
    throw new Error("buildUnits: rawDescriptors must be a non-empty array");
  }

  // Pass 1: assign ids and compute scores/postures
  const units = rawDescriptors.map((desc) => {
    if (!desc.title || !desc.title.trim()) {
      throw new Error("buildUnits: every descriptor must have a non-empty title");
    }
    const id      = generateUnitId(desc.title);
    const touched = Array.isArray(desc.touched) ? desc.touched : [];
    const deps    = Array.isArray(desc.deps)    ? desc.deps    : [];
    const title   = desc.title.trim();
    const scope   = typeof desc.scope === "string" ? desc.scope.trim() : "";

    const score   = difficultyScore({ touched, deps, title, scope });
    const posture = deriveModelPosture(score);

    return { id, title, scope, touched, deps, difficulty: score, model_posture: posture };
  });

  // Pass 2: resolve dep references from title strings to ids
  // A dep string may be an id (if already resolved by the caller) or a title.
  // We resolve titles to ids by case-insensitive prefix/exact match.
  const titleToId = new Map(units.map((u) => [u.title.toLowerCase(), u.id]));

  for (const unit of units) {
    unit.deps = unit.deps.map((dep) => {
      // If it's already an id (starts with "unit-"), keep it as-is
      if (dep.startsWith("unit-")) return dep;
      // Try exact title match (case-insensitive)
      const resolved = titleToId.get(dep.toLowerCase());
      if (resolved) return resolved;
      // Return as-is (graph builder will flag unknown deps during verification)
      return dep;
    });
  }

  return units;
}

// ---------------------------------------------------------------------------
// serializeUnits — produce the RUN.md units block (GRAPH-01 "serialize to RUN.md")
// ---------------------------------------------------------------------------

/**
 * Serialize a units array to a human-readable Markdown block for RUN.md.
 *
 * @param {object[]} units
 * @param {string}   [prompt]  the original decomposition prompt (optional)
 * @returns {string}  Markdown text
 */
export function serializeUnits(units, prompt) {
  const lines = [];
  lines.push("## Decomposition");
  lines.push("");
  if (prompt) {
    lines.push(`**Prompt:** ${prompt}`);
    lines.push("");
  }
  lines.push(`**Units:** ${units.length}`);
  lines.push("");

  for (const u of units) {
    lines.push(`### ${u.id}`);
    lines.push(`**Title:** ${u.title}`);
    if (u.scope) lines.push(`**Scope:** ${u.scope}`);
    if (u.touched.length > 0) {
      lines.push(`**Touched:** ${u.touched.join(", ")}`);
    }
    if (u.deps.length > 0) {
      lines.push(`**Deps:** ${u.deps.join(", ")}`);
    }
    lines.push(`**Difficulty:** ${u.difficulty.toFixed(3)} (executor: ${u.model_posture.executor.model}/${u.model_posture.executor.effort})`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const key = args[i].slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    }
    return flags;
  }

  const flags = parseFlags(process.argv.slice(2));

  if (!flags.fixture && !flags.help) {
    process.stderr.write(
      "Usage: node bgsd/scripts/decompose.mjs --fixture <path.json>\n" +
      "       The fixture JSON must be { units: [{ title, scope?, touched?, deps? }, ...] }\n"
    );
    process.exit(1);
  }

  if (flags.fixture) {
    const fixturePath = resolve(process.cwd(), flags.fixture);
    let raw;
    try {
      raw = readFileSync(fixturePath, "utf8");
    } catch (err) {
      process.stderr.write(`Could not read fixture: ${err.message}\n`);
      process.exit(1);
    }
    const descriptors = parseDecompositionResponse(raw);
    const units = buildUnits(descriptors);
    const md = serializeUnits(units, `fixture: ${fixturePath}`);
    process.stdout.write(md + "\n");
    process.stdout.write(`\n${units.length} unit(s) built.\n`);
  }
}
