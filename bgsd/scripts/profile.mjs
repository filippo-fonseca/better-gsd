#!/usr/bin/env node
/**
 * profile.mjs — Phase E3: Preference Profile (PROFILE-01..02)
 *
 * Derives a structured preference profile from a sealed decision record.
 * The profile is the oracle's SECONDARY, LOWER-WEIGHT source: a leaning,
 * not a locked decision.  Every preference is tagged by its source decision
 * id(s) and carries an explicit weight that is LOWER than a direct
 * decision-record hit (PROFILE_WEIGHT < DECISION_WEIGHT < SPEC_WEIGHT).
 *
 * DESIGN PRINCIPLES
 * =================
 * - Pure / deterministic core: `buildPreferenceProfile` is a zero-model-call
 *   roll-up over the sealed decision record (NFR-05).  An optional Haiku
 *   summarise pass (summarizeFn) is injectable but never called internally.
 * - No fabricated preferences (NFR-06): every profile signal is grounded in
 *   at least one answered decision-record entry.  An empty / unsealed record
 *   yields an empty profile — no invented leanings.
 * - Authority is explicit: every signal carries `authority: "preference"` to
 *   distinguish it from `authority: "decision"` (direct hit) or
 *   `authority: "spec"` (spec section hit) used by the E4 oracle.
 * - Weighting: PROFILE_WEIGHT (0.25) < DECISION_WEIGHT (0.75) < SPEC_WEIGHT
 *   (0.5 — between them, as a spec-section match is stronger than a leaning
 *   but weaker than a direct locked decision).
 *
 * WEIGHT ORDERING
 * ===============
 *   PROFILE_WEIGHT  = 0.25   — a leaning derived from answers; biases toward
 *                               escalation when it is the only signal (below
 *                               the oracle's auto-answer threshold)
 *   SPEC_WEIGHT     = 0.50   — a spec-section match (context, not a decision)
 *   DECISION_WEIGHT = 0.75   — a direct decision-record hit (locked choice)
 *
 *   A profile-only match (confidence ≤ PROFILE_WEIGHT) will almost certainly
 *   fall below the oracle's auto-answer threshold (ORACLE-02 / NFR-11), so it
 *   biases toward escalating to the human rather than auto-answering.
 *
 * PROFILE SCHEMA
 * ==============
 * {
 *   intake_id:   string,
 *   built_at:    string,          // ISO 8601
 *   authority:   "preference",    // always; never "decision" or "spec"
 *   signals: [
 *     {
 *       id:          string,      // stable signal id, e.g. "pref-001"
 *       topic:       string,      // short slug that matches decision.topic
 *       category:    string,      // derived category: one of CATEGORIES
 *       leaning:     string,      // the chosen option id or a typed-text summary
 *       label:       string,      // human-readable label from the chosen option
 *       weight:      number,      // PROFILE_WEIGHT (always 0.25)
 *       authority:   "preference",
 *       source_ids:  string[],    // decision ids that ground this signal
 *       rationale:   string|null, // the rationale captured with the decision
 *       spec_section: string|null, // spec section this maps to
 *     },
 *     ...
 *   ],
 * }
 *
 * KEY EXPORTS
 * ===========
 *   PROFILE_WEIGHT   — 0.25 (use in oracle to compare against DECISION_WEIGHT)
 *   DECISION_WEIGHT  — 0.75 (the weight a direct decision-record hit carries)
 *   SPEC_WEIGHT      — 0.50 (the weight a spec-section match carries)
 *
 *   buildPreferenceProfile(decisionRecord, { summarizeFn?, builtAt? })
 *     Pure roll-up.  Returns a profile object.  Writes profile.json atomically
 *     when opts.intakeDir is provided.
 *
 *   queryProfile(profile, topic)
 *     Pure retrieval helper.  Returns the first matching signal (leaning +
 *     weight) or null if not found.  Used by E4 to consult the profile as the
 *     third-priority oracle source.
 *
 * Usage (library):
 *   import { buildPreferenceProfile, queryProfile,
 *            PROFILE_WEIGHT, DECISION_WEIGHT, SPEC_WEIGHT } from './profile.mjs';
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Weight constants (PROFILE-02 — the core ordering invariant)
// ---------------------------------------------------------------------------

/**
 * Weight of a preference-profile signal.
 * PROFILE_WEIGHT < SPEC_WEIGHT < DECISION_WEIGHT — always.
 * A profile-only confidence score falls at (or below) PROFILE_WEIGHT,
 * biasing toward escalation rather than auto-answer (NFR-11).
 */
export const PROFILE_WEIGHT = 0.25;

/**
 * Weight of a spec-section match (stronger than a leaning, weaker than a
 * direct decision-record hit).  Exported so the E4 oracle can compare all
 * three tiers in one place.
 */
export const SPEC_WEIGHT = 0.50;

/**
 * Weight of a direct decision-record hit (a locked choice).
 * DECISION_WEIGHT > SPEC_WEIGHT > PROFILE_WEIGHT — always.
 */
export const DECISION_WEIGHT = 0.75;

// Compile-time assertion: the ordering must hold.
// This runs when the module is imported, catching accidental constant changes.
if (!(PROFILE_WEIGHT < SPEC_WEIGHT && SPEC_WEIGHT < DECISION_WEIGHT)) {
  throw new Error(
    `profile.mjs: weight ordering violated — expected ` +
    `PROFILE_WEIGHT(${PROFILE_WEIGHT}) < SPEC_WEIGHT(${SPEC_WEIGHT}) < DECISION_WEIGHT(${DECISION_WEIGHT})`
  );
}

// ---------------------------------------------------------------------------
// Category taxonomy
// ---------------------------------------------------------------------------
//
// Topics from the brainstorm catalogue are mapped to one of these categories
// so the profile can express recurring leanings at the category level (e.g.
// "this user consistently prefers minimal deps and local-only persistence →
// category: architecture").  E4 can query by category for weaker cross-topic
// inferences.

const TOPIC_TO_CATEGORY = {
  "scope-bound":  "scope",
  "ux-model":     "ux",
  "data-persist": "architecture",
  "deploy-target":"architecture",
  "persona":      "audience",
  "quality-bar":  "quality",
  "stack-choice": "architecture",
  "open-q-prio":  "scope",
};

/** All known category slugs. */
export const CATEGORIES = Object.freeze([
  "scope",
  "ux",
  "architecture",
  "audience",
  "quality",
  "other",
]);

/**
 * Map a topic slug to a category.
 * Falls back to "other" for unknown topics.
 *
 * @param {string} topic
 * @returns {string}
 */
function topicToCategory(topic) {
  return TOPIC_TO_CATEGORY[topic] ?? "other";
}

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors brainstorm.mjs / queue.mjs)
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to a .tmp sibling, then rename.
 * @param {string} filePath
 * @param {string} content
 */
function writeAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// buildPreferenceProfile (PROFILE-01)
// ---------------------------------------------------------------------------

/**
 * Roll up a sealed decision record into a preference profile.
 *
 * Pure / deterministic — zero model calls (NFR-05).
 * An optional `summarizeFn` (MODEL SEAM — Haiku/low) may be injected by the
 * Conductor for a prose summary, but it is NEVER called here; it is passed
 * through to the caller if needed.
 *
 * Rules:
 * - Only ANSWERED decisions (source !== "unanswered") become signals.
 * - An unsealed record yields an empty profile (NFR-06 — no fabricated signals).
 * - Every signal carries authority: "preference" and weight: PROFILE_WEIGHT.
 * - For "selected" answers the label comes from the matching option in the
 *   decision.  For "typed" answers the label is a truncated version of the
 *   typed text.
 * - The signal id is "pref-NNN" (1-indexed, zero-padded to 3 digits).
 *
 * @param {object} decisionRecord
 *   A sealed decision record (from brainstorm.mjs `sealDecisionRecord`).
 *   Expected shape: { intake_id, sealed_at, decisions: [...] }
 *
 * @param {object} [opts]
 * @param {string} [opts.intakeDir]
 *   If provided, profile.json is written atomically to this directory.
 * @param {Function} [opts.writeFn]
 *   Injectable writer for tests: (filePath, content) => void.
 *   Defaults to writeAtomic.
 * @param {string} [opts.builtAt]
 *   Override the built_at timestamp (used in tests).
 *
 * @returns {{ profile: object, profileJsonPath: string|null }}
 */
export function buildPreferenceProfile(decisionRecord, {
  intakeDir,
  writeFn,
  builtAt,
} = {}) {
  // Validate input
  if (!decisionRecord || typeof decisionRecord !== "object") {
    throw new Error(
      "buildPreferenceProfile: decisionRecord must be an object"
    );
  }

  // Empty profile for unsealed records — no fabricated signals (NFR-06)
  const profile = {
    intake_id: decisionRecord.intake_id ?? null,
    built_at:  builtAt ?? new Date().toISOString(),
    authority: "preference",
    signals:   [],
  };

  // Only process sealed records
  if (!decisionRecord.sealed_at) {
    // Persist even the empty profile if requested
    const profileJsonPath = persistProfile(profile, intakeDir, writeFn);
    return { profile, profileJsonPath };
  }

  const decisions = decisionRecord.decisions ?? [];
  let signalIndex = 0;

  for (const decision of decisions) {
    // Skip unanswered decisions — no fabrication (NFR-06)
    if (decision.source === "unanswered" || decision.answer === "unanswered") {
      continue;
    }

    signalIndex++;
    const signalId = `pref-${String(signalIndex).padStart(3, "0")}`;
    const category = topicToCategory(decision.topic);

    // Derive a human-readable label for the leaning
    let label;
    if (decision.source === "selected") {
      // Find the chosen option's label
      const chosenOption = (decision.options ?? []).find(
        (o) => o.id === decision.answer
      );
      label = chosenOption ? chosenOption.label : decision.answer;
    } else {
      // Typed answer — truncate to 80 chars for the label
      const typed = String(decision.answer);
      label = typed.length > 80 ? typed.slice(0, 77) + "..." : typed;
    }

    const signal = {
      id:          signalId,
      topic:       decision.topic,
      category,
      leaning:     decision.answer,
      label,
      weight:      PROFILE_WEIGHT,   // explicitly lower than DECISION_WEIGHT
      authority:   "preference",     // not "decision", not "spec"
      source_ids:  [decision.id],    // grounded in this specific decision entry
      rationale:   decision.rationale ?? null,
      spec_section: decision.spec_section ?? null,
    };

    profile.signals.push(signal);
  }

  const profileJsonPath = persistProfile(profile, intakeDir, writeFn);
  return { profile, profileJsonPath };
}

/**
 * Persist profile.json atomically if intakeDir is given.
 *
 * @param {object}   profile
 * @param {string|undefined} intakeDir
 * @param {Function|undefined} writeFn
 * @returns {string|null}  Path written, or null if no intakeDir.
 */
function persistProfile(profile, intakeDir, writeFn) {
  if (!intakeDir) return null;

  mkdirSync(intakeDir, { recursive: true });
  const writer = typeof writeFn === "function" ? writeFn : writeAtomic;
  const profileJsonPath = join(intakeDir, "profile.json");
  writer(profileJsonPath, JSON.stringify(profile, null, 2));
  return profileJsonPath;
}

// ---------------------------------------------------------------------------
// queryProfile (PROFILE-01 retrieval helper — for E4 to consult)
// ---------------------------------------------------------------------------

/**
 * Retrieve the first profile signal matching a topic string.
 *
 * Used by E4's decision-oracle as the THIRD-PRIORITY source (after a direct
 * decision-record hit and a spec-section hit).
 *
 * Matching order (most-specific first):
 *   1. Exact topic slug match (case-insensitive)
 *   2. Topic contains the query string (substring, case-insensitive)
 *   3. Signal label contains the query string (substring, case-insensitive)
 *
 * Returns null if the profile has no signals or no match is found.
 * The returned object includes the signal's weight (always PROFILE_WEIGHT)
 * so the caller can directly compare it against DECISION_WEIGHT without
 * needing to know the constant.
 *
 * @param {object}          profile   A profile object (from buildPreferenceProfile)
 * @param {string}          topic     The topic / keyword to query
 * @returns {object|null}             The matching signal, or null
 */
export function queryProfile(profile, topic) {
  if (!profile || typeof profile !== "object") return null;
  if (!topic || typeof topic !== "string") return null;

  const signals = profile.signals ?? [];
  if (signals.length === 0) return null;

  const needle = topic.toLowerCase().trim();

  // 1. Exact topic slug match
  const exact = signals.find((s) => s.topic.toLowerCase() === needle);
  if (exact) return exact;

  // 2. Topic contains the needle
  const partial = signals.find((s) => s.topic.toLowerCase().includes(needle));
  if (partial) return partial;

  // 3. Label contains the needle
  const labelMatch = signals.find((s) =>
    (s.label ?? "").toLowerCase().includes(needle)
  );
  if (labelMatch) return labelMatch;

  return null;
}
