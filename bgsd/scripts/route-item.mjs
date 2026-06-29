#!/usr/bin/env node
/**
 * route-item.mjs — Phase 2: ROUTE-02, ROUTE-03, ROUTE-04
 *
 * Maps a classified queue item (route_class) to a concrete /gsd-* quick-path
 * invocation, writes the chosen route onto the item, sets the model posture in
 * the worktree's .planning/config.json (config seam, ROUTE-04), and advances
 * the item from `classified` to `routed`.
 *
 * DESIGN PRINCIPLES
 * =================
 * - Pure, table-driven: the ROUTING_TABLE below is the single source of truth.
 *   Adding a new route class = adding one row.
 * - bgsd calls /gsd-* command names; it does NOT reimplement GSD execution
 *   (NFR-04, ROUTE-02). Execution is Phase 3.
 * - Config seam only: model posture is written to .planning/config.json;
 *   zero edits to vendored GSD (NFR-03/04).
 * - ROUTE-03: needs-clarification is handled by classifyItem() before routeItem()
 *   is ever called. routeItem() throws if given a needs-clarification item.
 *
 * GSD QUICK-PATH COMMANDS (verified against commands/gsd/ directory)
 * ===================================================================
 *   /gsd-fast      — trivial tasks, no discussion, inline execution
 *   /gsd-quick     — scoped tasks, quick path, no full workflow
 *   /gsd-plan-phase + /gsd-execute-phase — feature items (discuss→plan→execute chain)
 *
 * All three are real command names in the vendored commands/gsd/ directory.
 *
 * ROUTING TABLE
 * =============
 *   trivial-fix        -> /gsd-fast        (model: fast, effort: low)
 *   scoped-fix         -> /gsd-quick       (model: balanced, effort: medium)
 *   feature            -> /gsd-plan-phase  (then /gsd-execute-phase) (model: quality, effort: high)
 *
 * CONFIG OVERRIDES (ROUTE-04)
 * ===========================
 * The caller (or queue start) can pass an optional `configOverrides` object read
 * from the worktree's .planning/config.json `bgsd_routing` key. When present,
 * the override table replaces the default ROUTING_TABLE entries for that class.
 *
 * Usage (library):
 *   import { routeItem } from './route-item.mjs';
 *   routeItem(item, transitionFn, { configDir: '/path/to/.planning' });
 *
 * Usage (CLI, for manual testing):
 *   node bgsd/scripts/route-item.mjs --class trivial-fix
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Default planning dir: repo root / .planning
const DEFAULT_PLANNING_DIR = resolve(__dir, "../../.planning");

// ---------------------------------------------------------------------------
// Routing table — the single source of truth (ROUTE-02)
// ---------------------------------------------------------------------------

/**
 * Each entry defines the GSD command surface and model posture for a route class.
 *
 * Fields:
 *   command      — the primary /gsd-* command name to invoke (Phase 3 executes this)
 *   chain        — optional follow-up commands (e.g. the plan→execute chain)
 *   model_profile — GSD config.json model_profile value to write (ROUTE-04)
 *   effort       — human-readable effort hint recorded on the item
 *   notes        — description of the routing decision (auditable)
 *
 * To extend: add a row here. Nothing else needs to change.
 *
 * @type {Record<string, { command: string, chain: string[], model_profile: string, effort: string, notes: string }>}
 */
export const ROUTING_TABLE = Object.freeze({
  "trivial-fix": {
    command: "/gsd-fast",
    chain: [],
    model_profile: "fast",
    effort: "low",
    notes:
      "Trivial fix: inline execution via /gsd-fast (no discussion, no full workflow). " +
      "Cheapest model posture; fast turnaround expected.",
  },
  "scoped-fix": {
    command: "/gsd-quick",
    chain: [],
    model_profile: "balanced",
    effort: "medium",
    notes:
      "Scoped bug fix: quick-path via /gsd-quick (scoped execution, no full GSD workflow). " +
      "Balanced model posture; moderate complexity.",
  },
  "feature": {
    command: "/gsd-plan-phase",
    chain: ["/gsd-execute-phase"],
    model_profile: "quality",
    effort: "high",
    notes:
      "Feature or non-trivial change: discuss→plan→execute chain via /gsd-plan-phase + /gsd-execute-phase. " +
      "Quality model posture; higher complexity warrants full GSD workflow.",
  },
});

/**
 * Default model profile when config override is unreadable or absent.
 */
const DEFAULT_MODEL_PROFILE = "balanced";

// ---------------------------------------------------------------------------
// Difficulty scorer (cheap heuristic for ROUTE-04 effort hint)
// ---------------------------------------------------------------------------

/**
 * Compute a cheap, deterministic difficulty score from item properties.
 * Returns a value in [0, 1] that is used to select the effort hint.
 * This never makes a model call (NFR-05).
 *
 * Factors:
 *   - body length (longer = more context = harder)
 *   - prior attempt count (more attempts = harder than expected)
 *   - title word count (more words = more scope)
 *
 * @param {object} item
 * @returns {number} score in [0, 1]
 */
export function difficultyScore(item) {
  const bodyLen = (item.body ?? "").trim().length;
  const titleWords = (item.title ?? "").trim().split(/\s+/).length;
  const attempts = item.attempts ?? 0;

  // Normalize each factor to [0, 1] with soft caps
  const bodyFactor = Math.min(bodyLen / 500, 1.0);   // 500+ chars = max
  const titleFactor = Math.min(titleWords / 12, 1.0); // 12+ words = max
  const attemptFactor = Math.min(attempts / 3, 1.0);  // 3+ attempts = max

  // Weighted average: body carries the most signal
  return 0.5 * bodyFactor + 0.3 * titleFactor + 0.2 * attemptFactor;
}

// ---------------------------------------------------------------------------
// Config seam — read/write .planning/config.json (ROUTE-04)
// ---------------------------------------------------------------------------

/**
 * Read the bgsd_routing section from .planning/config.json if it exists.
 * Returns null if the file is absent, unreadable, or has no bgsd_routing key.
 * Zero edits to vendored GSD (NFR-03): only touches .planning/config.json.
 *
 * @param {string} planningDir  path to the .planning/ directory
 * @returns {object|null}  the bgsd_routing override map, or null
 */
export function readRoutingOverrides(planningDir) {
  const configPath = join(planningDir, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    return config.bgsd_routing ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Write the model posture (model_profile) into .planning/config.json.
 * Only sets the `model_profile` key and preserves all other keys.
 * If the file does not exist, creates a minimal config with just model_profile.
 * Zero edits to vendored GSD (NFR-03/04): only touches .planning/config.json.
 *
 * @param {string} planningDir   path to the .planning/ directory
 * @param {string} modelProfile  the model profile string (e.g. "balanced")
 * @returns {string}  the path written
 */
export function writeModelPosture(planningDir, modelProfile) {
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

  config.model_profile = modelProfile;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

// ---------------------------------------------------------------------------
// Public API — routeItem
// ---------------------------------------------------------------------------

/**
 * Route a classified queue item to a concrete /gsd-* quick path.
 *
 * Steps:
 *   1. Validate item is in `classified` state (not needs_input or other).
 *   2. Look up the route class in the ROUTING_TABLE (or config override).
 *   3. Compute a difficulty score and map it to an effort hint.
 *   4. Write the model posture to .planning/config.json (ROUTE-04).
 *   5. Record the routing decision on the item.
 *   6. Advance item state: classified -> routed.
 *
 * @param {object}   item            — queue item (mutated in place)
 * @param {Function} transitionFn    — transition() from queue.mjs
 * @param {object}   [opts]
 * @param {string}   [opts.planningDir]     — path to .planning/ (defaults to repo root .planning/)
 * @param {boolean}  [opts.skipConfigWrite] — if true, skip writing config.json (for tests)
 * @returns {{ command: string, chain: string[], model_profile: string, effort: string }}
 */
export function routeItem(item, transitionFn, opts = {}) {
  const { planningDir = DEFAULT_PLANNING_DIR, skipConfigWrite = false } = opts;

  if (item.state !== "classified") {
    throw new Error(
      `routeItem: item "${item.id}" is in state "${item.state}", expected "classified"`
    );
  }

  const routeClass = item.route_class;
  if (!routeClass) {
    throw new Error(
      `routeItem: item "${item.id}" has no route_class — classify it first`
    );
  }

  // Read config overrides (seam #3: config.json). Never edits GSD (NFR-03).
  const overrides = readRoutingOverrides(planningDir);

  // Resolve the routing entry: config override takes precedence over the default table
  let routeEntry = ROUTING_TABLE[routeClass];
  if (overrides && overrides[routeClass]) {
    // Merge override into the default entry (override fields win)
    routeEntry = { ...routeEntry, ...overrides[routeClass] };
  }

  if (!routeEntry) {
    // Unknown or unmapped route class: park in needs_input (safe default, ROUTE-03 spirit)
    const question = `Unknown route class "${routeClass}": no entry in ROUTING_TABLE. ` +
      `Valid classes: ${Object.keys(ROUTING_TABLE).join(", ")}`;
    item.clarification_question = question;
    transitionFn(item, "needs_input", {
      phase: "2-route",
      reason: "unknown_route_class",
      route_class: routeClass,
    });
    return { command: null, chain: [], model_profile: DEFAULT_MODEL_PROFILE, effort: "unknown" };
  }

  // Compute difficulty score for effort-hint selection (ROUTE-04 cheap difficulty score)
  const score = difficultyScore(item);

  // Determine effective model_profile: use routing table value, but bump if score is high
  // and the item has had prior failed attempts (escalation-ladder prep for LOOP-05).
  // Threshold: 0.7 (reachable with long body + 2+ attempts; a 100-char title is just
  // one token, so body length + attempts dominate the score).
  let modelProfile = routeEntry.model_profile;
  if (score >= 0.7 && (item.attempts ?? 0) > 1) {
    // Soft escalation: bump from fast->balanced, balanced->quality
    const ESCALATION = { fast: "balanced", balanced: "quality", quality: "quality" };
    modelProfile = ESCALATION[modelProfile] ?? modelProfile;
  }

  // Write model posture to .planning/config.json (ROUTE-04, config seam only)
  if (!skipConfigWrite) {
    try {
      writeModelPosture(planningDir, modelProfile);
    } catch (err) {
      // Non-fatal: log to stderr but do not block routing
      process.stderr.write(
        `routeItem: warning — could not write model posture to config.json: ${err.message}\n`
      );
    }
  }

  // Record the routing decision on the item
  item.gsd_command = routeEntry.command;
  item.gsd_chain = routeEntry.chain;
  item.route_model_profile = modelProfile;
  item.route_effort = routeEntry.effort;
  item.route_difficulty_score = score;
  item.route_notes = routeEntry.notes;

  // Advance: classified -> routed
  transitionFn(item, "routed", {
    phase: "2-route",
    route_class: routeClass,
    command: routeEntry.command,
    chain: routeEntry.chain,
    model_profile: modelProfile,
    effort: routeEntry.effort,
    difficulty_score: score,
  });

  return {
    command: routeEntry.command,
    chain: routeEntry.chain,
    model_profile: modelProfile,
    effort: routeEntry.effort,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (for manual inspection/testing)
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
  const routeClass = typeof flags.class === "string" ? flags.class : "";

  if (!routeClass) {
    process.stderr.write(
      "Usage: route-item.mjs --class <trivial-fix|scoped-fix|feature|needs-clarification>\n"
    );
    process.exit(1);
  }

  const entry = ROUTING_TABLE[routeClass];
  if (!entry) {
    process.stderr.write(
      `Unknown route class: "${routeClass}". Valid: ${Object.keys(ROUTING_TABLE).join(", ")}\n`
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ route_class: routeClass, ...entry }, null, 2));
  process.stdout.write("\n");
}
