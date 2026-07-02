#!/usr/bin/env node
/**
 * oracle.mjs — Phase E4: Decision-Oracle + Confidence Scoring +
 *              discuss-phase Auto-Answer Seam (ORACLE-01..04)
 *
 * THE CENTRAL KNOT of the bgsd intake/proxy extension.  From the sealed
 * baseline (spec chunks + decision record + preference profile) this module
 * builds a deterministic queryable store, scores confidence, and — when
 * confidence ≥ threshold — answers a discuss-phase question as the user's
 * proxy by injecting the answer through GSD's seam only.
 *
 * DESIGN PRINCIPLES
 * =================
 * - Pure / deterministic core: all store assembly, question matching,
 *   confidence scoring, threshold routing, and seam-payload assembly are
 *   deterministic scripts — ZERO model calls (NFR-05).
 * - No silent green (NFR-06): when confidence < threshold the oracle
 *   abstains and returns { action:"escalate" }; it never fabricates an
 *   answer to clear a blocker.
 * - Seams only (NFR-03/04): auto-answers are injected by writing the
 *   resolved decision to the worktree's `.planning/CONTEXT.md` (the file
 *   the discuss step consumes) and by selecting the correct non-interactive
 *   `/gsd-discuss-phase` mode (`--assumptions` / `--auto` / `--text`). No
 *   vendored GSD file is ever modified.
 * - Live-guarded (NFR-08): the real GSD invocation is behind `requireLiveFlag()`
 *   — it refuses to run without an explicit `--live` flag.  All logic is
 *   unit-testable without any live invocation.
 * - Atomic writes: all oracle store writes are temp-then-rename (NFR-05).
 * - Pointer store (NFR-09): the manifest stores pointers to source files,
 *   never blobs.
 *
 * ORACLE STORE LAYOUT (ORACLE-01)
 * ================================
 * .bgsd/oracle/<run-id>/
 *   manifest.json      — pointers to spec index, decision record, profile
 *   auto-answers.jsonl — append-only audit log of every auto-answer (ORACLE-04)
 *
 * CONFIDENCE FORMULA (ORACLE-02)
 * ================================
 * score = authority_weight
 *           × match_strength        ∈ [0,1]
 *           × specificity           ∈ [0,1]
 *           − conflict_penalty      ∈ [0,1]
 *
 * Where:
 *   authority_weight:
 *     "decision" → DECISION_WEIGHT  (0.75)  — sealed locked choice
 *     "spec"     → SPEC_WEIGHT      (0.50)  — spec-section context
 *     "profile"  → PROFILE_WEIGHT   (0.25)  — user leaning
 *
 *   match_strength  — how well the question text overlaps the record entry:
 *     3+ matching keyword tokens shared → 1.0
 *     2  matching keyword tokens shared → 0.75
 *     1  matching keyword token  shared → 0.50
 *     0  (topic slug exact/substring hit only) → 0.40
 *
 *   specificity — how narrowly the record entry answers THIS question:
 *     decision entry has spec_section matching phase context → 1.0
 *     decision entry exists (no context mismatch)           → 0.80
 *     spec section (broader context)                        → 0.60
 *     profile leaning (general trend)                       → 0.50
 *
 *   conflict_penalty — applied when ≥2 sources give contradictory answers:
 *     0.25 per conflicting source pair (capped at 0.50)
 *
 * Final score is clamped to [0,1].
 *
 * A profile-only hit: 0.25 × match_strength(≤1) × 0.50 ≤ 0.125
 * — always below any practical threshold, biasing toward escalation (PROFILE-02).
 *
 * AUTO-ANSWER SEAM (ORACLE-03)
 * ================================
 * The seam payload returned by `buildDiscussPhaseSeam()` describes:
 *   1. What to write to `.planning/` (a CONTEXT.md patch entry in the
 *      `<decisions>` section — the file the discuss step consumes).
 *   2. The exact non-interactive `/gsd-discuss-phase` invocation:
 *        /gsd-discuss-phase <phase> --assumptions
 *      (or --auto for fully automated chains; --text for non-TTY).
 *   3. For a mid-run control-file blocker: the v2 `resolveBlocker` +
 *      `<agent-id>.inbox.md` path the Conductor writes before re-launching.
 *
 * The live invocation is `--live`-guarded via `requireLiveFlag()`.
 *
 * THRESHOLD + CAP (ORACLE-04)
 * ================================
 * Read from config.json's `conductor` block:
 *   conductor.oracle_threshold    (default 0.60)
 *   conductor.auto_answer_cap     (default 10)
 *
 * threshold == 1.0 → escalate everything (safety floor).
 * Every auto-answer appends to `auto-answers.jsonl`.
 *
 * KEY EXPORTS
 * ===========
 *   buildOracle({ intakeId, intakeDir, bgsdDir? })
 *     Assemble the oracle store manifest for a run.  Reads from the three
 *     sealed source files; writes manifest.json atomically.
 *     Returns { oracleDir, manifest }.
 *
 *   loadOracle({ runId, bgsdDir? })
 *     Load a previously assembled oracle manifest.
 *     Returns { manifest }.
 *
 *   answerQuestion(oracle, question, { threshold, phase?, writeFn? })
 *     The core oracle function.
 *     Returns:
 *       { action:"auto_answer", answer, source, confidence, breakdown }
 *     or
 *       { action:"escalate", reason, confidence }
 *
 *   buildDiscussPhaseSeam(autoAnswer, { phase, agentId, worktreeDir, inboxDir? })
 *     Pure.  Returns the seam payload (no side effects):
 *       {
 *         contextMdPatch: string,         — what to write/append to CONTEXT.md
 *         contextMdPath:  string,         — absolute path to the CONTEXT.md to write
 *         invocation:     string,         — the /gsd-discuss-phase command line
 *         resolveBlockerArgs: object,     — args for control.mjs resolveBlocker
 *         inboxPath:      string|null,    — path for <agent-id>.inbox.md
 *         live: false,                    — always false (--live-guarded)
 *       }
 *
 *   requireLiveFlag(args)
 *     Throws if "--live" is not in args.  Guards real GSD invocations.
 *
 *   loadOracleConfig(configPath?)
 *     Read oracle threshold + auto-answer cap from config.json conductor block.
 *     Returns { threshold, autoAnswerCap }.
 *
 *   appendAutoAnswerLog({ oracleDir, entry, writeFn? })
 *     Append one auto-answer audit entry to auto-answers.jsonl.
 *
 * Usage (library):
 *   import { buildOracle, answerQuestion, buildDiscussPhaseSeam,
 *            requireLiveFlag } from './oracle.mjs';
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Weight constants (imported semantics — mirrors profile.mjs ordering)
// ---------------------------------------------------------------------------

/** Weight of a sealed decision-record hit. */
export const DECISION_WEIGHT = 0.75;

/** Weight of a spec-section match. */
export const SPEC_WEIGHT = 0.50;

/** Weight of a profile-preference signal (lowest). */
export const PROFILE_WEIGHT = 0.25;

// Compile-time ordering assertion
if (!(PROFILE_WEIGHT < SPEC_WEIGHT && SPEC_WEIGHT < DECISION_WEIGHT)) {
  throw new Error(
    `oracle.mjs: weight ordering violated — PROFILE(${PROFILE_WEIGHT}) ` +
    `< SPEC(${SPEC_WEIGHT}) < DECISION(${DECISION_WEIGHT}) must hold`
  );
}

// ---------------------------------------------------------------------------
// Default config values (ORACLE-04)
// ---------------------------------------------------------------------------

/** Default confidence threshold for auto-answer (read from config.json). */
export const DEFAULT_THRESHOLD = 0.60;

/** Default per-run cap on consecutive auto-answers (read from config.json). */
export const DEFAULT_AUTO_ANSWER_CAP = 10;

// ---------------------------------------------------------------------------
// Atomic write helpers
// ---------------------------------------------------------------------------

function writeAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// requireLiveFlag — guards real GSD invocations (ORACLE-03, NFR-08)
// ---------------------------------------------------------------------------

/**
 * Throws if "--live" is not present in the given args array/string.
 * This gate ensures the live GSD discuss-phase invocation never runs in
 * unit tests or dry-run mode (mirrors the v2 control.mjs DI pattern).
 *
 * @param {string[]|string} args
 * @throws {Error} if "--live" is absent
 */
export function requireLiveFlag(args) {
  const argStr = Array.isArray(args) ? args.join(" ") : String(args ?? "");
  if (!argStr.includes("--live")) {
    throw new Error(
      "requireLiveFlag: the real /gsd-discuss-phase invocation requires the " +
      "--live flag.  In unit tests, call buildDiscussPhaseSeam() to inspect " +
      "the seam payload without triggering a live GSD run (NFR-08, ORACLE-03)."
    );
  }
}

// ---------------------------------------------------------------------------
// loadOracleConfig — read threshold + cap from config.json (ORACLE-04)
// ---------------------------------------------------------------------------

/**
 * Read oracle configuration from the project's config.json.
 *
 * Reads the `conductor` block which bgsd extends (ORACLE-04).
 * Falls back to defaults if the block or keys are absent.
 *
 * @param {string} [configPath]  Absolute path to config.json.  Defaults to
 *                               `.planning/config.json` in the repo root.
 * @returns {{ threshold: number, autoAnswerCap: number }}
 */
export function loadOracleConfig(configPath) {
  const path = configPath ?? join(REPO_ROOT, ".planning", "config.json");
  if (!existsSync(path)) {
    return { threshold: DEFAULT_THRESHOLD, autoAnswerCap: DEFAULT_AUTO_ANSWER_CAP };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (_err) {
    return { threshold: DEFAULT_THRESHOLD, autoAnswerCap: DEFAULT_AUTO_ANSWER_CAP };
  }
  const conductor = raw?.conductor ?? {};
  const threshold = typeof conductor.oracle_threshold === "number"
    ? conductor.oracle_threshold
    : DEFAULT_THRESHOLD;
  const autoAnswerCap = typeof conductor.auto_answer_cap === "number"
    ? conductor.auto_answer_cap
    : DEFAULT_AUTO_ANSWER_CAP;
  return { threshold, autoAnswerCap };
}

// ---------------------------------------------------------------------------
// buildOracle — assemble the oracle store manifest (ORACLE-01)
// ---------------------------------------------------------------------------

/**
 * Assemble the oracle store manifest for a run from the three sealed sources.
 *
 * The manifest stores pointers to source files — never blobs (NFR-09).
 * The oracle directory is created under `.bgsd/oracle/<intake-id>/`.
 *
 * The three sources (in priority order for retrieval):
 *   1. Decision record  (decisions.json)   — authority: "decision", weight 0.75
 *   2. Spec chunk index (index.json)       — authority: "spec",     weight 0.50
 *   3. Preference profile (profile.json)  — authority: "profile",  weight 0.25
 *
 * @param {object} opts
 * @param {string}  opts.intakeId    The intake record id (e.g. "intake-build-a-timer-ab12")
 * @param {string}  opts.intakeDir   Absolute path to .bgsd/intake/<intake-id>/
 * @param {string}  [opts.bgsdDir]   Override for .bgsd base dir
 * @param {Function} [opts.writeFn]  Injectable writer (filePath, content) for tests
 *
 * @returns {{ oracleDir: string, manifest: object }}
 */
export function buildOracle({ intakeId, intakeDir, bgsdDir, writeFn }) {
  if (!intakeId || typeof intakeId !== "string") {
    throw new Error("buildOracle: intakeId must be a non-empty string");
  }
  if (!intakeDir || typeof intakeDir !== "string") {
    throw new Error("buildOracle: intakeDir must be a non-empty string (absolute path)");
  }

  const baseDir = bgsdDir ?? join(REPO_ROOT, ".bgsd");
  const oracleDir = join(baseDir, "oracle", intakeId);
  mkdirSync(oracleDir, { recursive: true });

  // Pointer paths for the three source files
  const decisionsPath = join(intakeDir, "decisions.json");
  const indexPath     = join(intakeDir, "index.json");
  const profilePath   = join(intakeDir, "profile.json");

  // Validate that all source files exist (fail fast — NFR-06)
  const missing = [];
  if (!existsSync(decisionsPath)) missing.push("decisions.json");
  if (!existsSync(indexPath))     missing.push("index.json");
  if (!existsSync(profilePath))   missing.push("profile.json");
  if (missing.length > 0) {
    throw new Error(
      `buildOracle: missing required source files in ${intakeDir}: ${missing.join(", ")}. ` +
      `Run Phases E1, E2, E3 first to produce the sealed baseline.`
    );
  }

  const manifest = {
    intake_id:      intakeId,
    intake_dir:     intakeDir,
    oracle_dir:     oracleDir,
    built_at:       new Date().toISOString(),
    sources: {
      decisions: {
        path:      decisionsPath,
        authority: "decision",
        weight:    DECISION_WEIGHT,
      },
      spec_index: {
        path:      indexPath,
        authority: "spec",
        weight:    SPEC_WEIGHT,
      },
      profile: {
        path:      profilePath,
        authority: "profile",
        weight:    PROFILE_WEIGHT,
      },
    },
    // Retrieval priority order (decision-first, then spec, then profile)
    retrieval_order: ["decisions", "spec_index", "profile"],
  };

  const writer = typeof writeFn === "function" ? writeFn : writeAtomic;
  const manifestPath = join(oracleDir, "manifest.json");
  writer(manifestPath, JSON.stringify(manifest, null, 2));

  return { oracleDir, manifest };
}

// ---------------------------------------------------------------------------
// loadOracle — load an assembled oracle manifest (ORACLE-01)
// ---------------------------------------------------------------------------

/**
 * Load a previously assembled oracle manifest from disk.
 *
 * @param {object} opts
 * @param {string}  opts.intakeId  The intake record id
 * @param {string}  [opts.bgsdDir] Override for .bgsd base dir
 *
 * @returns {{ manifest: object }}
 * @throws {Error} if the manifest does not exist
 */
export function loadOracle({ intakeId, bgsdDir }) {
  if (!intakeId || typeof intakeId !== "string") {
    throw new Error("loadOracle: intakeId must be a non-empty string");
  }
  const baseDir = bgsdDir ?? join(REPO_ROOT, ".bgsd");
  const oracleDir = join(baseDir, "oracle", intakeId);
  const manifestPath = join(oracleDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(
      `loadOracle: manifest not found at ${manifestPath}. ` +
      `Call buildOracle() first.`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`loadOracle: manifest.json is not valid JSON: ${err.message}`);
  }

  return { manifest };
}

// ---------------------------------------------------------------------------
// Keyword extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract meaningful keyword tokens from a question string.
 * Strips stop words, lowercases, and splits on whitespace/punctuation.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  const STOP_WORDS = new Set([
    "a","an","the","is","in","on","for","of","to","with","that","this",
    "what","where","which","how","should","would","could","do","be","are",
    "we","i","you","it","as","at","by","or","and","from","have","has",
    "was","were","will","can","not","if","then","but","so","get","use",
    "does","did","any","all","its","into","also","just","than","my","your",
  ]);
  return String(text ?? "")
    .toLowerCase()
    .split(/[\s,.:;!?()\[\]{}"'\/\\-]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Count the number of keyword tokens shared between two texts.
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {number}
 */
function sharedKeywordCount(textA, textB) {
  const setA = new Set(extractKeywords(textA));
  const setB = new Set(extractKeywords(textB));
  let count = 0;
  for (const k of setA) {
    if (setB.has(k)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// matchStrength — how well a question overlaps a record entry
// ---------------------------------------------------------------------------

/**
 * Compute match_strength ∈ [0,1] for a question against a record entry text.
 *
 * Scale:
 *   ≥3 shared keyword tokens → 1.00
 *    2 shared keyword tokens → 0.75
 *    1 shared keyword token  → 0.50
 *    0 (topic slug match only)→ 0.40
 *
 * @param {string} question     The discuss-phase question text
 * @param {string} entryText    The candidate record entry text to match against
 * @returns {number}            match_strength ∈ [0,1]
 */
function computeMatchStrength(question, entryText) {
  const shared = sharedKeywordCount(question, entryText);
  if (shared >= 3) return 1.00;
  if (shared === 2) return 0.75;
  if (shared === 1) return 0.50;
  return 0.40; // topic slug match only (caller guarantees some match exists)
}

// ---------------------------------------------------------------------------
// specificity — how narrowly the entry answers THIS question
// ---------------------------------------------------------------------------

/**
 * Compute specificity ∈ [0,1] for a candidate based on its authority tier
 * and whether it has a matching spec_section / phase context.
 *
 * Scale:
 *   decision entry with spec_section matching phase → 1.00
 *   decision entry (no context mismatch)            → 0.80
 *   spec section (broader context)                  → 0.60
 *   profile leaning                                  → 0.50
 *
 * @param {object} candidate  A candidate object with { authority, spec_section? }
 * @param {string} [phase]    The current phase name/slug (optional context)
 * @returns {number}          specificity ∈ [0,1]
 */
function computeSpecificity(candidate, phase) {
  if (candidate.authority === "decision") {
    // If we have both a spec_section and a phase, check for a match
    if (phase && candidate.spec_section) {
      const phaseNeedle = phase.toLowerCase().trim();
      const sectionSlug = candidate.spec_section.toLowerCase().trim();
      if (sectionSlug.includes(phaseNeedle) || phaseNeedle.includes(sectionSlug)) {
        return 1.00;
      }
    }
    return 0.80;
  }
  if (candidate.authority === "spec") {
    return 0.60;
  }
  // "profile"
  return 0.50;
}

// ---------------------------------------------------------------------------
// conflictPenalty — penalize when sources disagree (ORACLE-02)
// ---------------------------------------------------------------------------

/**
 * Compute conflict_penalty ∈ [0,0.5] when multiple candidates give
 * contradictory answers to the SAME topic.
 *
 * A conflict only exists when two candidates SHARE THE SAME TOPIC SLUG
 * (same area, same decision category) but give DIFFERENT answers.
 * Candidates from different topics that both happen to match a question are
 * not conflicts — they are different aspects; the highest-scoring one wins.
 *
 * Detection:
 *   - Group candidates by their topic slug (_topic field)
 *   - Within each topic group: if any two candidates have different
 *     normalised answer strings → conflict → 0.25 penalty per conflicting pair
 *   - Capped at 0.50 total.
 *
 * @param {Array} candidates  Array of { answer: string, authority: string, _topic?: string }
 * @returns {number}          conflict_penalty ∈ [0,0.50]
 */
function computeConflictPenalty(candidates) {
  if (candidates.length < 2) return 0;

  function normalise(s) {
    return String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  }

  // Group by topic (only candidates that carry a _topic slug participate)
  const byTopic = new Map();
  for (const c of candidates) {
    const topic = c._topic ?? c.spec_section ?? null;
    if (!topic) continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(c);
  }

  let totalPenalty = 0;

  for (const [, group] of byTopic) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const ansA = normalise(group[i].answer);
        const ansB = normalise(group[j].answer);
        if (!ansA || !ansB || ansA === ansB) continue;
        // Different answers for the same topic → conflict
        totalPenalty += 0.25;
      }
    }
  }

  // Cap at 0.50
  return Math.min(totalPenalty, 0.50);
}

// ---------------------------------------------------------------------------
// retrieveCandidates — query the three sources (ORACLE-01)
// ---------------------------------------------------------------------------

/**
 * Retrieve candidate answers from the three oracle sources in priority order:
 *   1. Decision record entries (authority: "decision")
 *   2. Spec section chunks  (authority: "spec")
 *   3. Profile signals      (authority: "profile")
 *
 * Each candidate carries its authority, source pointer, and match metadata.
 * The full source data is read from disk on each call (pointer-sliced, NFR-09).
 *
 * @param {string} question       The discuss-phase question text
 * @param {object} manifest       Oracle manifest (from buildOracle / loadOracle)
 * @param {object} [opts]
 * @param {string} [opts.phase]   Current phase name/slug (optional context)
 * @returns {Array<{
 *   authority: "decision"|"spec"|"profile",
 *   answer:    string,
 *   matchText: string,
 *   source:    string,        // pointer / source descriptor
 *   spec_section: string|null,
 * }>}
 */
function retrieveCandidates(question, manifest, { phase } = {}) {
  const candidates = [];
  const needle = question.toLowerCase().trim();

  // ---- Source 1: Decision record ----
  const decisionsSrc = manifest.sources?.decisions;
  if (decisionsSrc && existsSync(decisionsSrc.path)) {
    let record;
    try {
      record = JSON.parse(readFileSync(decisionsSrc.path, "utf8"));
    } catch (_err) {
      record = null;
    }
    if (record && record.sealed_at && Array.isArray(record.decisions)) {
      for (const d of record.decisions) {
        if (d.source === "unanswered") continue;
        // Match on topic slug, question prompt, or spec_section
        const topicStr   = String(d.topic ?? "").toLowerCase();
        const questionStr= String(d.question ?? "").toLowerCase();
        const sectionStr = String(d.spec_section ?? "").toLowerCase();
        const matchText  = `${topicStr} ${questionStr} ${sectionStr}`;

        const topicHit   = topicStr.includes(needle) || needle.includes(topicStr);
        const promptHit  = questionStr.includes(needle);
        const keywordHit = sharedKeywordCount(question, matchText) > 0;

        if (topicHit || promptHit || keywordHit) {
          candidates.push({
            authority:    "decision",
            answer:       String(d.answer ?? ""),
            matchText,
            source:       `decisions.json#${d.id}`,
            spec_section: d.spec_section ?? null,
            // Extra for audit
            _decisionId:  d.id,
            _topic:       d.topic,
          });
        }
      }
    }
  }

  // ---- Source 2: Spec chunk index ----
  const specSrc = manifest.sources?.spec_index;
  if (specSrc && existsSync(specSrc.path)) {
    let index;
    try {
      index = JSON.parse(readFileSync(specSrc.path, "utf8"));
    } catch (_err) {
      index = null;
    }
    if (index && Array.isArray(index.chunks)) {
      for (const chunk of index.chunks) {
        const headingStr = String(chunk.heading ?? "").toLowerCase();
        const summaryStr = String(chunk.summary ?? "").toLowerCase();
        const matchText  = `${headingStr} ${summaryStr}`;

        const headingHit = headingStr.includes(needle) || needle.includes(headingStr);
        const keywordHit = sharedKeywordCount(question, matchText) > 0;

        if (headingHit || keywordHit) {
          candidates.push({
            authority:    "spec",
            answer:       chunk.summary ?? chunk.heading,
            matchText,
            source:       `index.json#${chunk.id}`,
            spec_section: chunk.heading ?? null,
          });
        }
      }
    }
  }

  // ---- Source 3: Profile signals ----
  const profileSrc = manifest.sources?.profile;
  if (profileSrc && existsSync(profileSrc.path)) {
    let profile;
    try {
      profile = JSON.parse(readFileSync(profileSrc.path, "utf8"));
    } catch (_err) {
      profile = null;
    }
    if (profile && Array.isArray(profile.signals)) {
      for (const sig of profile.signals) {
        const topicStr = String(sig.topic ?? "").toLowerCase();
        const labelStr = String(sig.label  ?? "").toLowerCase();
        const matchText = `${topicStr} ${labelStr}`;

        const topicHit  = topicStr.includes(needle) || needle.includes(topicStr);
        const labelHit  = labelStr.includes(needle);
        const keyHit    = sharedKeywordCount(question, matchText) > 0;

        if (topicHit || labelHit || keyHit) {
          candidates.push({
            authority:    "profile",
            answer:       String(sig.leaning ?? sig.label ?? ""),
            matchText,
            source:       `profile.json#${sig.id}`,
            spec_section: sig.spec_section ?? null,
            // Extra for audit
            _signalId:    sig.id,
            _topic:       sig.topic,
          });
        }
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// answerQuestion — the core oracle function (ORACLE-02)
// ---------------------------------------------------------------------------

/**
 * Answer a discuss-phase question from the oracle, with deterministic
 * confidence scoring (ORACLE-02).
 *
 * Retrieval order: decision entries → spec sections → profile leanings.
 * Scoring: authority_weight × match_strength × specificity − conflict_penalty
 * Routing: confidence ≥ threshold → auto_answer; else → escalate.
 *
 * Special cases:
 *   - threshold == 1.0 → escalate everything (safety floor, ORACLE-04)
 *   - No candidates found → escalate with reason "insufficient_spec" (NFR-06)
 *   - Profile-only hit always scores ≤ PROFILE_WEIGHT × 1 × 0.50 = 0.125
 *     → always below any practical threshold (PROFILE-02)
 *
 * @param {object} oracle      Oracle manifest (from buildOracle or loadOracle)
 * @param {string} question    The discuss-phase question text
 * @param {object} [opts]
 * @param {number}  [opts.threshold] Confidence threshold (default DEFAULT_THRESHOLD)
 * @param {string}  [opts.phase]     Current phase name/slug for specificity
 * @param {Function}[opts.writeFn]   Injectable writer (tests)
 *
 * @returns {{
 *   action:     "auto_answer" | "escalate",
 *   answer?:    string,
 *   source?:    string,
 *   confidence: number,
 *   breakdown?: { authority_weight, match_strength, specificity, conflict_penalty },
 *   reason?:    string,
 * }}
 */
export function answerQuestion(oracle, question, { threshold, phase, writeFn } = {}) {
  if (!oracle || typeof oracle !== "object") {
    throw new Error("answerQuestion: oracle must be an object (manifest from buildOracle/loadOracle)");
  }
  if (!question || typeof question !== "string" || !question.trim()) {
    throw new Error("answerQuestion: question must be a non-empty string");
  }

  // Use the manifest directly (oracle IS the manifest here)
  const manifest = oracle.sources ? oracle : oracle.manifest;
  if (!manifest || !manifest.sources) {
    throw new Error(
      "answerQuestion: oracle must be a manifest with .sources (from buildOracle) " +
      "or a loadOracle result with .manifest"
    );
  }

  const resolvedThreshold = typeof threshold === "number" ? threshold : DEFAULT_THRESHOLD;

  // Safety floor: threshold 1.0 → escalate everything (ORACLE-04)
  if (resolvedThreshold >= 1.0) {
    return {
      action:     "escalate",
      confidence: 0,
      reason:     "threshold is 1.0 — escalate-everything safety floor active (ORACLE-04)",
    };
  }

  // Retrieve candidates from the three sources
  const candidates = retrieveCandidates(question, manifest, { phase });

  // No candidates → insufficient_spec (NFR-06)
  if (candidates.length === 0) {
    return {
      action:     "escalate",
      confidence: 0,
      reason:     "insufficient_spec — no matching entry found in decisions, spec, or profile",
    };
  }

  // Score each candidate
  const scored = candidates.map((c) => {
    const authority_weight  = c.authority === "decision" ? DECISION_WEIGHT
                            : c.authority === "spec"     ? SPEC_WEIGHT
                            : PROFILE_WEIGHT;
    const match_strength    = computeMatchStrength(question, c.matchText);
    const specificity       = computeSpecificity(c, phase);
    const raw               = authority_weight * match_strength * specificity;
    return { ...c, authority_weight, match_strength, specificity, raw };
  });

  // Apply conflict penalty across all candidates
  const conflict_penalty = computeConflictPenalty(candidates);

  // Find the best-scoring candidate
  const best = scored.reduce((a, b) => (b.raw > a.raw ? b : a));
  const confidence = Math.max(0, Math.min(1, best.raw - conflict_penalty));

  const breakdown = {
    authority_weight:  best.authority_weight,
    match_strength:    best.match_strength,
    specificity:       best.specificity,
    conflict_penalty,
  };

  // Route: confidence ≥ threshold → auto_answer; else → escalate
  if (confidence >= resolvedThreshold) {
    return {
      action:     "auto_answer",
      answer:     best.answer,
      source:     best.authority,          // "decision", "spec", or "profile"
      confidence,
      breakdown,
    };
  }

  // Below threshold → escalate (never auto-answer below threshold, NFR-11).
  // The oracle store/matching/scoring above is deterministic (zero model calls);
  // only when it cannot answer deterministically does the escalation hand off to
  // the proxy-Q&A layer, which reasons on Fable/high (high-leverage, low-volume).
  const sourceRanking = scored
    .sort((a, b) => b.raw - a.raw)
    .map((c) => `${c.authority}(${(c.raw).toFixed(3)})`);

  return {
    action:     "escalate",
    confidence,
    reason:
      `confidence ${confidence.toFixed(3)} < threshold ${resolvedThreshold} ` +
      `(best source: ${best.authority}; candidates ranked: ${sourceRanking.join(", ")})`,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// buildDiscussPhaseSeam — pure seam-payload builder (ORACLE-03)
// ---------------------------------------------------------------------------

/**
 * Build the auto-answer seam payload for injecting a resolved answer into the
 * worktree's discuss-phase flow — WITHOUT executing anything (ORACLE-03).
 *
 * The payload describes:
 *   1. What to write to `.planning/` (a CONTEXT.md entry in `<decisions>`).
 *   2. The exact non-interactive `/gsd-discuss-phase` invocation
 *      (`--assumptions` is the primary non-interactive mode; caller may
 *       also use `--auto` for fully automated chains or `--text` for non-TTY).
 *   3. The v2 `resolveBlocker` arguments for mid-run control-file blockers,
 *      plus the `<agent-id>.inbox.md` path the Conductor writes.
 *   4. `live: false` — the real invocation requires `requireLiveFlag()`.
 *
 * Pure function: no side effects, no file writes.
 *
 * @param {object} autoAnswer
 *   The auto_answer result from answerQuestion()
 *   { action:"auto_answer", answer, source, confidence, breakdown }
 *
 * @param {object} opts
 * @param {string}  opts.phase          Phase number/slug (e.g. "1" or "phase-1-setup")
 * @param {string}  opts.agentId        The agent id (e.g. "agent-abc123")
 * @param {string}  opts.worktreeDir    Absolute path to the agent's worktree
 * @param {string}  [opts.blockerId]    The blocker id to resolve (for control-file path)
 * @param {string}  [opts.inboxDir]     Override directory for the inbox file
 * @param {string}  [opts.question]     The original question (for CONTEXT.md)
 *
 * @returns {{
 *   contextMdPatch:   string,      — the text to write into CONTEXT.md <decisions>
 *   contextMdPath:    string,      — absolute path to the CONTEXT.md to write
 *   invocation:       string,      — the /gsd-discuss-phase command line
 *   resolveBlockerArgs: object,    — args for control.mjs resolveBlocker
 *   inboxPath:        string|null, — path for <agent-id>.inbox.md
 *   live:             false,       — always false (--live-guarded)
 * }}
 * @throws {Error} if autoAnswer.action is not "auto_answer"
 */
export function buildDiscussPhaseSeam(autoAnswer, {
  phase,
  agentId,
  worktreeDir,
  blockerId,
  inboxDir,
  question,
} = {}) {
  if (!autoAnswer || autoAnswer.action !== "auto_answer") {
    throw new Error(
      "buildDiscussPhaseSeam: autoAnswer.action must be 'auto_answer'. " +
      "Only call this function when the oracle has decided to auto-answer."
    );
  }
  if (!phase || typeof phase !== "string") {
    throw new Error("buildDiscussPhaseSeam: phase must be a non-empty string");
  }
  if (!agentId || typeof agentId !== "string") {
    throw new Error("buildDiscussPhaseSeam: agentId must be a non-empty string");
  }
  if (!worktreeDir || typeof worktreeDir !== "string") {
    throw new Error("buildDiscussPhaseSeam: worktreeDir must be a non-empty string (absolute path)");
  }

  // 1. What to write to .planning/CONTEXT.md (the file discuss-phase reads)
  //    We append a decision entry in GSD's standard CONTEXT.md <decisions> format.
  const phasePadded = String(phase).padStart(2, "0");
  const contextMdPath = join(worktreeDir, ".planning", "phases",
    `${phasePadded}-${phase}`, `${phasePadded}-CONTEXT.md`);
  const contextMdPatch = [
    ``,
    `<!-- bgsd oracle auto-answer (confidence: ${autoAnswer.confidence.toFixed(3)}, source: ${autoAnswer.source}) -->`,
    ``,
    `## Auto-Answered Decision`,
    ``,
    question ? `**Question:** ${question}` : ``,
    `**Answer:** ${autoAnswer.answer}`,
    `**Source:** ${autoAnswer.source}`,
    `**Confidence:** ${autoAnswer.confidence.toFixed(3)}`,
    ``,
  ].filter((l) => l !== undefined).join("\n");

  // 2. The exact non-interactive /gsd-discuss-phase invocation
  //    Primary mode: --assumptions (codebase-first, minimal user interaction)
  //    Alternative:  --auto (fully automated chain), --text (non-TTY plain list)
  const invocation = `/gsd-discuss-phase ${phase} --assumptions`;

  // 3. resolveBlocker arguments for mid-run control-file blockers (ORACLE-03)
  //    The Conductor calls control.mjs resolveBlocker(controlPath, blockerId, resolution)
  //    and writes the answer to <agent-id>.inbox.md before re-launching the agent.
  const resolvedInboxDir = inboxDir ?? join(worktreeDir, ".bgsd", "inbox");
  const inboxPath = blockerId
    ? join(resolvedInboxDir, `${agentId}.inbox.md`)
    : null;

  const inboxContent = blockerId ? [
    `# Oracle Answer — ${agentId}`,
    ``,
    `**Blocker resolved:** ${blockerId}`,
    `**Answer:** ${autoAnswer.answer}`,
    `**Source:** ${autoAnswer.source}`,
    `**Confidence:** ${autoAnswer.confidence.toFixed(3)}`,
    ``,
    `Proceed with the above answer.  This file was written by the bgsd oracle (ORACLE-03).`,
  ].join("\n") : null;

  const resolveBlockerArgs = blockerId
    ? {
        blockerId,
        resolution: {
          answer:    autoAnswer.answer,
          inboxPath: inboxPath,
        },
        inboxContent,  // the Conductor writes this to inboxPath before re-launch
      }
    : null;

  return {
    contextMdPatch,
    contextMdPath,
    invocation,
    resolveBlockerArgs,
    inboxPath,
    live: false,   // always false — requireLiveFlag() guards the real invocation
    // Documentation note: the live guard
    _liveGuardNote:
      "Call requireLiveFlag(['--live']) before executing `invocation`. " +
      "Without --live the real /gsd-discuss-phase is never invoked (NFR-08).",
  };
}

// ---------------------------------------------------------------------------
// appendAutoAnswerLog — audit log (ORACLE-04)
// ---------------------------------------------------------------------------

/**
 * Append one auto-answer audit entry to `auto-answers.jsonl` under the oracle
 * directory.  Each line is a complete JSON object (one per line, JSONL format).
 *
 * This provides the auditable, append-only log required by ORACLE-04 and NFR-08.
 *
 * @param {object} opts
 * @param {string}  opts.oracleDir  Absolute path to .bgsd/oracle/<run-id>/
 * @param {object}  opts.entry      The audit entry to append
 * @param {Function}[opts.writeFn]  Injectable appender for tests:
 *                                  (filePath, line) => void
 *                                  Defaults to appendFileSync.
 */
export function appendAutoAnswerLog({ oracleDir, entry, writeFn }) {
  if (!oracleDir || typeof oracleDir !== "string") {
    throw new Error("appendAutoAnswerLog: oracleDir must be a non-empty string");
  }
  if (!entry || typeof entry !== "object") {
    throw new Error("appendAutoAnswerLog: entry must be an object");
  }

  mkdirSync(oracleDir, { recursive: true });
  const logPath = join(oracleDir, "auto-answers.jsonl");
  const line = JSON.stringify({ ...entry, logged_at: new Date().toISOString() }) + "\n";

  if (typeof writeFn === "function") {
    writeFn(logPath, line);
  } else {
    appendFileSync(logPath, line, "utf8");
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint — `--answer --run-id <id> --phase <phase> --question "<text>"
//                  [--bgsd-dir <path>] [--threshold <n>]`
//
// Called by bgsd-run-agent (Step 3B-oracle) to answer a GSD discuss-phase
// question as the user's proxy.  Prints a single JSON object to stdout
// (the caller parses it); all other output goes to stderr.
//
// Exit codes:
//   0  always (callers treat both auto_answer and escalate as normal outcomes)
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
        const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
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

  if (flags.help) {
    process.stderr.write(
      "Usage: node bgsd/scripts/oracle.mjs --answer \\\n" +
      "         --run-id <id> --phase <phase> --question \"<text>\" \\\n" +
      "         [--bgsd-dir <path>] [--threshold <n>]\n" +
      "\n" +
      "  Answers a GSD discuss-phase question from the sealed intake oracle store.\n" +
      "  Prints a single JSON object to stdout:\n" +
      "    { action: 'auto_answer', answer, source, confidence, breakdown }   — if confident\n" +
      "    { action: 'escalate',    reason, confidence }                       — otherwise\n" +
      "\n" +
      "  When no oracle store exists for the run (e.g. a feature-scale run that\n" +
      "  skipped the intake phase) the command still exits 0 and returns:\n" +
      "    { action: 'escalate', reason: 'no oracle store for run', confidence: 0 }\n" +
      "\n" +
      "  Flags:\n" +
      "    --answer            Required. Selects this sub-command.\n" +
      "    --run-id <id>       Required. The bgsd run/intake id.\n" +
      "    --phase <phase>     Required. Current GSD phase (e.g. '1' or 'setup').\n" +
      "    --question \"<text>\" Required. The discuss-phase question to answer.\n" +
      "    --bgsd-dir <path>   Optional. Override for the .bgsd base directory.\n" +
      "    --threshold <n>     Optional. Confidence threshold (0–1). Falls back to\n" +
      "                        config.json conductor.oracle_threshold, then 0.60.\n"
    );
    process.exit(0);
  }

  if (!flags.answer) {
    process.stderr.write(
      "oracle.mjs: use --answer to invoke the answer sub-command, or --help for usage.\n"
    );
    process.exit(1);
  }

  const missingFlags = [];
  if (!flags.runId)    missingFlags.push("--run-id");
  if (!flags.phase)    missingFlags.push("--phase");
  if (!flags.question || typeof flags.question !== "string" || !flags.question.trim()) {
    missingFlags.push("--question");
  }
  if (missingFlags.length > 0) {
    process.stderr.write(
      `oracle.mjs --answer: missing required flags: ${missingFlags.join(", ")}\n` +
      "Run with --help for usage.\n"
    );
    process.exit(1);
  }

  // --bgsd-dir override (default: .bgsd relative to repo root, handled inside loadOracle)
  const bgsdDir = typeof flags.bgsdDir === "string"
    ? resolve(process.cwd(), flags.bgsdDir)
    : undefined;

  // Load the oracle store — may not exist for feature-scale runs
  let oracle;
  try {
    oracle = loadOracle({ intakeId: flags.runId, bgsdDir });
  } catch (_err) {
    // No oracle store — not an error, just escalate so the caller can fall back
    process.stdout.write(
      JSON.stringify({ action: "escalate", reason: "no oracle store for run", confidence: 0 }) + "\n"
    );
    process.exit(0);
  }

  // Resolve threshold: flag > config file > default
  let threshold;
  if (typeof flags.threshold === "string" && flags.threshold.trim() !== "") {
    const parsed = parseFloat(flags.threshold);
    threshold = Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
  } else {
    // Try to read from config.json adjacent to the bgsd dir (one level up = repo root)
    const repoRoot = bgsdDir ? resolve(bgsdDir, "..") : REPO_ROOT;
    const configPath = join(repoRoot, ".planning", "config.json");
    threshold = loadOracleConfig(configPath).threshold;
  }

  // Run the oracle
  const result = answerQuestion(oracle.manifest, flags.question.trim(), {
    threshold,
    phase: flags.phase,
  });

  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}
