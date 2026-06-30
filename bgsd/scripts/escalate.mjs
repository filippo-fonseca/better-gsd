#!/usr/bin/env node
/**
 * escalate.mjs — Phase E5: Confidence-Gated Human Escalation via Selectors
 *                (ESCALATE-01..04)
 *
 * When the decision-oracle (E4) returns { action:"escalate" } for one or more
 * discuss-phase questions, this module takes over:
 *
 *   1. CONSOLIDATE (ESCALATE-02):  N below-threshold questions are batched into
 *      ONE selector prompt.  Each item in the batch is a GSD-style selector:
 *      2–4 concrete pre-filled options (synthesised from the oracle's best
 *      low-confidence candidates) PLUS an always-available "type your own"
 *      free-text option (NFR-10).  Deduplication collapses the same gray-area
 *      raised by multiple worktrees into a single item (deterministic).
 *
 *   2. COLLECT (ESCALATE-01/02):  `runEscalation({ batch, promptFn })` calls
 *      the injected promptFn for each batch item.  An un-answered item stays
 *      open — no fabricated answer is ever generated (NFR-06).  The worktree
 *      parks in "needs_input" via the v2 control-file `addEscalation` seam.
 *
 *   3. ENRICH (ESCALATE-03):  `enrichOracleFromAnswers(answers, record)` writes
 *      each human answer back into the decision record as a new sealed entry
 *      (source:"escalation") so the same question now AUTO-ANSWERS on re-query
 *      instead of escalating again.  The feedback loop closes here.
 *
 *   4. TELEMETRY (ESCALATE-04):  An `EscalationCounter` tracks auto-answered
 *      vs. escalated questions per run.  `renderEscalationTelemetry(counter)`
 *      returns a one-line status string consumed by status.mjs.
 *
 * DESIGN PRINCIPLES
 * =================
 * - Selector-always (NFR-10): every escalation item is a valid GSD-style
 *   selector (≥2 options + freeText with id:"other"). Asserted on every item.
 * - No silent green (NFR-06): un-answered escalations remain open; the module
 *   never fabricates an answer to clear a blocker.
 * - Pure deterministic core (NFR-05): consolidation, deduplication, selector
 *   construction, telemetry accounting, and enrichment writes are all
 *   deterministic scripts — zero model calls.
 * - Seams only (NFR-03/04): enrichment writes into the decision record via
 *   `recordDecision`-style append (source:"escalation").  Control-file
 *   integration uses the v2 `addEscalation` seam from control.mjs.
 * - Atomic writes (NFR-05): all file writes are write-temp-then-rename.
 *
 * ESCALATION BATCH SCHEMA
 * =======================
 * A batch item (the unit surfaced to the human) mirrors the brainstorm selector
 * shape (NFR-10):
 * {
 *   id:        string,          // stable dedup key (topic slug hash)
 *   topic:     string,          // ≤12 chars (GSD header rule)
 *   question:  string,          // the full question text from the oracle
 *   options: [                  // 2–4 concrete pre-filled choices
 *     { id: string, label: string, description: string },
 *     ...
 *   ],
 *   freeText:  {                // always-available "type your own" (NFR-10)
 *     id:          "other",
 *     label:       "Type your own",
 *     placeholder: string,
 *   },
 *   source_worktrees: string[], // which agent worktrees raised this (for dedup)
 *   escalation_ids:  string[],  // control-file escalation entry ids
 *   confidence:      number,    // highest oracle confidence seen for this question
 *   reason:          string,    // why oracle escalated
 * }
 *
 * KEY EXPORTS
 * ===========
 *   buildEscalationBatch(escalations)
 *     Pure.  Deduplicates + consolidates an array of oracle escalation objects
 *     into ONE batch where every item is a valid GSD-style selector (NFR-10).
 *     Each escalation is:
 *       { question, reason, confidence, agentId?, topic?, candidates? }
 *     Returns: BatchItem[]
 *
 *   runEscalation({ batch, promptFn })
 *     Calls promptFn for each batch item.  Returns collected answers.
 *     Un-answered items have answer === null (no fabrication, NFR-06).
 *     Returns: { answers: Map<batchItemId, string|null>, answered: number, open: number }
 *
 *   enrichOracleFromAnswers(answers, record, { intakeDir?, writeFn? })
 *     Writes each collected human answer back into the decision record as a
 *     new sealed entry tagged source:"escalation".  Optionally re-seals and
 *     writes the record to disk.
 *     Returns: { enrichedCount: number }
 *
 *   buildEscalationItem(escalation, index)
 *     Pure.  Construct a single batch item from one oracle escalation result.
 *     Asserts the NFR-10 selector invariant before returning.
 *
 *   assertBatchItemInvariant(item)
 *     Pure assertion: item.options.length in [2,4] AND item.freeText.id === "other".
 *     Throws on violation (fail-fast, like brainstorm.mjs assertSelectorInvariant).
 *
 *   createEscalationCounter()
 *     Returns a mutable counter object: { autoAnswered: 0, escalated: 0 }.
 *
 *   incrementCounter(counter, type)
 *     Pure.  Increments counter.autoAnswered or counter.escalated by 1.
 *     type: "auto_answered" | "escalated"
 *
 *   renderEscalationTelemetry(counter, { threshold? })
 *     Pure.  Returns a one-line telemetry string for status.mjs:
 *       "auto-answered 18 / escalated 2  (threshold: 0.60)"
 *
 * Usage (library):
 *   import { buildEscalationBatch, runEscalation, enrichOracleFromAnswers,
 *            createEscalationCounter, incrementCounter,
 *            renderEscalationTelemetry } from './escalate.mjs';
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSelectorInvariant } from "./brainstorm.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum concrete pre-filled options per escalation selector (NFR-10). */
const MIN_OPTIONS = 2;

/** Maximum concrete pre-filled options per escalation selector (NFR-10). */
const MAX_OPTIONS = 4;

/** Maximum topic slug length to honour the GSD header rule. */
const MAX_TOPIC_LENGTH = 12;

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors brainstorm.mjs / control.mjs)
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to a .tmp sibling, then rename.
 * @param {string} filePath  destination path
 * @param {string} content   UTF-8 content
 */
function writeAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Dedup key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable deduplication key from a question string.
 * Strips stop-words, lowercases, takes the first 4 meaningful tokens,
 * and joins with "-".  Two questions covering the same gray-area should
 * produce the same key so they collapse into one batch item.
 *
 * @param {string} question
 * @returns {string}
 */
function dedupKey(question) {
  const STOP = new Set([
    "a","an","the","is","in","on","for","of","to","with","that","this",
    "what","where","which","how","should","would","could","do","be","are",
    "we","i","you","it","as","at","by","or","and","from","have","has",
    "was","were","will","can","not","if","then","but","so","get","use",
    "does","did","any","all","its","into","also","just","than","my","your",
  ]);
  const tokens = String(question ?? "")
    .toLowerCase()
    .split(/[\s,.:;!?()\[\]{}"'\/\\-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .slice(0, 4);
  return tokens.join("-") || "unknown";
}

/**
 * Derive a short topic slug (≤MAX_TOPIC_LENGTH chars) from a question string.
 * @param {string} question
 * @returns {string}
 */
function topicSlug(question) {
  const key = dedupKey(question);
  return key.length <= MAX_TOPIC_LENGTH ? key : key.slice(0, MAX_TOPIC_LENGTH);
}

// ---------------------------------------------------------------------------
// assertBatchItemInvariant (NFR-10)
// ---------------------------------------------------------------------------

/**
 * Assert that a batch item satisfies the NFR-10 selector invariant:
 *   - item.options is an array of length [MIN_OPTIONS, MAX_OPTIONS]
 *   - item.freeText exists and has id "other"
 *
 * Throws on violation (fail-fast — mirrors brainstorm.mjs assertSelectorInvariant).
 *
 * @param {object} item
 */
export function assertBatchItemInvariant(item) {
  if (!item || typeof item !== "object") {
    throw new Error("assertBatchItemInvariant: item must be an object");
  }
  if (!Array.isArray(item.options) || item.options.length < MIN_OPTIONS) {
    throw new Error(
      `assertBatchItemInvariant: batch item "${item.id}" must have at least ` +
      `${MIN_OPTIONS} options (NFR-10); got ${item.options?.length ?? 0}`
    );
  }
  if (item.options.length > MAX_OPTIONS) {
    throw new Error(
      `assertBatchItemInvariant: batch item "${item.id}" must have at most ` +
      `${MAX_OPTIONS} options (NFR-10); got ${item.options.length}`
    );
  }
  if (!item.freeText || item.freeText.id !== "other") {
    throw new Error(
      `assertBatchItemInvariant: batch item "${item.id}" must have a freeText ` +
      `affordance with id "other" (NFR-10)`
    );
  }
}

// ---------------------------------------------------------------------------
// buildEscalationItem — single-item constructor (ESCALATE-02)
// ---------------------------------------------------------------------------

/**
 * Synthesise options for a batch item from the oracle escalation's context.
 *
 * Tries to use the candidates that the oracle found (the best low-confidence
 * ones) as concrete options.  If the oracle provides no usable candidates,
 * falls back to generic but honest choices.
 *
 * @param {object} escalation  Oracle escalation result + context
 * @param {number} index       Sequential index (for stable ids)
 * @returns {object}  A batch item satisfying the NFR-10 selector invariant
 */
export function buildEscalationItem(escalation, index) {
  if (!escalation || typeof escalation !== "object") {
    throw new Error("buildEscalationItem: escalation must be an object");
  }
  if (escalation.action && escalation.action !== "escalate") {
    throw new Error(
      `buildEscalationItem: escalation.action must be "escalate", got "${escalation.action}"`
    );
  }

  const question  = String(escalation.question ?? "");
  const reason    = String(escalation.reason    ?? "");
  const topic     = topicSlug(question) || `esc-${String(index + 1).padStart(3, "0")}`;
  const itemId    = `esc-${String(index + 1).padStart(3, "0")}`;

  // Synthesise concrete options (ESCALATE-02: "synthesised from the best
  // low-confidence candidates the oracle did find")
  let options = synthesiseOptions(escalation, question);

  // Trim to MAX_OPTIONS
  if (options.length > MAX_OPTIONS) {
    options = options.slice(0, MAX_OPTIONS);
  }

  // Enforce MIN_OPTIONS — fall back to generic honest choices if needed
  if (options.length < MIN_OPTIONS) {
    options = buildFallbackOptions(question, options);
  }

  const item = {
    id:               itemId,
    topic:            topic.slice(0, MAX_TOPIC_LENGTH),
    question,
    options,
    freeText: {
      id:          "other",
      label:       "Type your own",
      placeholder: `Describe your decision for: "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}"`,
    },
    source_worktrees: escalation.agentId ? [escalation.agentId] : [],
    escalation_ids:   escalation.escalationId ? [escalation.escalationId] : [],
    confidence:       typeof escalation.confidence === "number" ? escalation.confidence : 0,
    reason,
  };

  // Structural assertion — fail fast (NFR-10, mirrors brainstorm.mjs)
  assertBatchItemInvariant(item);

  return item;
}

/**
 * Synthesise concrete selector options from an oracle escalation.
 *
 * Prefers oracle-provided candidates (the low-confidence ones it found).
 * Falls back to extracting domain-specific choices from the question text.
 *
 * @param {object} escalation
 * @param {string} question
 * @returns {Array<{ id, label, description }>}
 */
function synthesiseOptions(escalation, question) {
  const options = [];

  // Use oracle candidates if available (source: "decision"|"spec"|"profile")
  if (Array.isArray(escalation.candidates) && escalation.candidates.length > 0) {
    for (const c of escalation.candidates.slice(0, MAX_OPTIONS)) {
      const label = String(c.answer ?? c.label ?? "").slice(0, 60) || "Unknown";
      const desc  = String(c.source ?? c.matchText ?? "").slice(0, 120) || "From oracle candidate";
      options.push({
        id:          `cand-${options.length + 1}`,
        label,
        description: desc,
      });
    }
  }

  // Extract domain options from known question patterns
  if (options.length < MIN_OPTIONS) {
    const domainOptions = extractDomainOptions(question);
    for (const opt of domainOptions) {
      if (options.length >= MAX_OPTIONS) break;
      options.push(opt);
    }
  }

  return options;
}

/**
 * Extract concrete domain options from a question using pattern matching.
 * Covers common discuss-phase question types without model calls (NFR-05).
 *
 * @param {string} question
 * @returns {Array<{ id, label, description }>}
 */
function extractDomainOptions(question) {
  const q = question.toLowerCase();

  // Scope questions
  if (q.includes("scope") || q.includes("bounded") || q.includes("deliverable")) {
    return [
      { id: "thin-mvp",    label: "Thin MVP",    description: "One core user flow end-to-end; defer everything else." },
      { id: "full-scope",  label: "Full scope",  description: "All listed surfaces and constraints in scope from day one." },
      { id: "spike-first", label: "Spike first", description: "Build a disposable spike to validate the riskiest assumption first." },
    ];
  }

  // Deployment / infrastructure questions
  if (q.includes("deploy") || q.includes("host") || q.includes("infrastructure") || q.includes("server")) {
    return [
      { id: "static",     label: "Static host",  description: "Deploy as a static site (Vercel, Netlify) with no server." },
      { id: "node",       label: "Node server",  description: "A Node.js server deployed to a cloud VM or container." },
      { id: "edge",       label: "Edge runtime", description: "Edge functions for low-latency global delivery." },
    ];
  }

  // Quality / bar questions
  if (q.includes("quality") || q.includes("release") || q.includes("production") || q.includes("readiness")) {
    return [
      { id: "prototype",  label: "Prototype",   description: "Fast and rough — good enough to demo, not for production." },
      { id: "beta",       label: "Beta",         description: "Solid for real use with known rough edges documented." },
      { id: "prod-ready", label: "Prod-ready",  description: "Hardened, tested, ready for external users on day one." },
    ];
  }

  // UX / persona questions
  if (q.includes("user") || q.includes("persona") || q.includes("ux") || q.includes("interface")) {
    return [
      { id: "developer",    label: "Developer",       description: "Software engineers who value CLI ergonomics and API access." },
      { id: "knowledge",    label: "Knowledge worker", description: "Non-technical professionals who value simplicity." },
      { id: "internal",     label: "Internal team",    description: "Internal tooling users — rough edges are acceptable." },
    ];
  }

  // Data / persistence questions
  if (q.includes("data") || q.includes("persist") || q.includes("storage") || q.includes("database")) {
    return [
      { id: "local-only",  label: "Local only",  description: "All state in the browser / local filesystem; no server-side store." },
      { id: "cloud-sync",  label: "Cloud sync",  description: "User data synced to a hosted backend; requires auth." },
      { id: "hybrid",      label: "Hybrid",      description: "Local-first with optional cloud sync as a later upgrade." },
    ];
  }

  // Stack / technology questions
  if (q.includes("stack") || q.includes("technolog") || q.includes("framework") || q.includes("library")) {
    return [
      { id: "follow-spec",    label: "Follow spec",    description: "Use whatever the intent spec already lists under Constraints." },
      { id: "minimal-deps",   label: "Minimal deps",   description: "Prefer built-ins and standard library; add deps only when essential." },
      { id: "ecosystem-std",  label: "Ecosystem std",  description: "Use the most widely-adopted libraries for each concern." },
    ];
  }

  // Generic fallback for unrecognized question types
  return [
    { id: "proceed-default", label: "Use default",   description: "Proceed with the most common / safest default for this decision." },
    { id: "defer-later",     label: "Defer it",      description: "Defer this decision to a later phase; proceed without locking it now." },
    { id: "needs-more-info", label: "Need more info", description: "I need to investigate further before committing to an answer." },
  ];
}

/**
 * Build fallback options to guarantee MIN_OPTIONS are always available.
 *
 * @param {string} question
 * @param {Array} existingOptions  Options already collected
 * @returns {Array<{ id, label, description }>}
 */
function buildFallbackOptions(question, existingOptions) {
  const fallback = extractDomainOptions(question);
  const combined = [...existingOptions];
  for (const opt of fallback) {
    if (combined.length >= MIN_OPTIONS) break;
    // Don't duplicate ids
    if (!combined.some((o) => o.id === opt.id)) {
      combined.push(opt);
    }
  }
  // If still not enough, add ultra-generic options
  if (combined.length < MIN_OPTIONS) {
    combined.push({ id: "proceed-default", label: "Use default", description: "Proceed with the most common default for this decision." });
    combined.push({ id: "defer-later",     label: "Defer it",    description: "Defer this decision to a later phase." });
  }
  return combined.slice(0, MAX_OPTIONS);
}

// ---------------------------------------------------------------------------
// buildEscalationBatch — ESCALATE-01/02 (THE CONSOLIDATION FUNCTION)
// ---------------------------------------------------------------------------

/**
 * Consolidate N oracle escalations into ONE batched selector prompt.
 *
 * Each item in the batch is a valid GSD-style selector (NFR-10):
 *   - 2–4 concrete pre-filled options (synthesised from oracle candidates)
 *   - An always-available "type your own" free-text option
 *
 * Deduplication:
 *   Escalations that share the same dedup key (same gray-area question from
 *   multiple worktrees) are collapsed into a single batch item.  The
 *   source_worktrees and escalation_ids arrays accumulate all contributors.
 *   Dedup is deterministic (NFR-05) — based on question text, not IDs.
 *
 * ESCALATE-01: Escalations from below-threshold or abstain oracle outcomes
 * feed directly into this function.  The batch returned here is the "one
 * consolidated question" the Conductor surfaces to the human.
 *
 * @param {Array<{
 *   question:     string,
 *   reason:       string,
 *   confidence:   number,
 *   agentId?:     string,
 *   escalationId?: string,
 *   topic?:       string,
 *   candidates?:  Array<{ answer, source, matchText? }>,
 * }>} escalations
 *   Oracle escalation results (each from answerQuestion returning action:"escalate").
 *
 * @returns {Array<BatchItem>}  The consolidated batch.  Empty if escalations is empty.
 * @throws {Error} if any escalation is missing a question string
 */
export function buildEscalationBatch(escalations) {
  if (!Array.isArray(escalations)) {
    throw new Error("buildEscalationBatch: escalations must be an array");
  }

  if (escalations.length === 0) {
    return [];
  }

  // Validate input
  for (const esc of escalations) {
    if (!esc || typeof esc !== "object") {
      throw new Error("buildEscalationBatch: each escalation must be an object");
    }
    if (!esc.question || typeof esc.question !== "string" || !esc.question.trim()) {
      throw new Error(
        "buildEscalationBatch: each escalation must have a non-empty question string"
      );
    }
  }

  // Deduplication: group by dedup key, collapse same gray-area across worktrees
  const dedupMap = new Map(); // dedupKey -> merged escalation object

  for (const esc of escalations) {
    const key = dedupKey(esc.question);

    if (dedupMap.has(key)) {
      // Merge this escalation into the existing batch item
      const existing = dedupMap.get(key);
      if (esc.agentId && !existing.agentIds.includes(esc.agentId)) {
        existing.agentIds.push(esc.agentId);
      }
      if (esc.escalationId && !existing.escalationIds.includes(esc.escalationId)) {
        existing.escalationIds.push(esc.escalationId);
      }
      // Keep the highest confidence seen (for telemetry)
      if (typeof esc.confidence === "number" && esc.confidence > existing.confidence) {
        existing.confidence = esc.confidence;
      }
      // Merge candidates (deduplicated by answer text)
      if (Array.isArray(esc.candidates)) {
        for (const c of esc.candidates) {
          const isDup = existing.candidates.some(
            (ex) => String(ex.answer ?? "") === String(c.answer ?? "")
          );
          if (!isDup && existing.candidates.length < MAX_OPTIONS) {
            existing.candidates.push(c);
          }
        }
      }
    } else {
      dedupMap.set(key, {
        question:     esc.question,
        reason:       esc.reason       ?? "",
        confidence:   typeof esc.confidence === "number" ? esc.confidence : 0,
        agentIds:     esc.agentId      ? [esc.agentId]  : [],
        escalationIds:esc.escalationId ? [esc.escalationId] : [],
        topic:        esc.topic        ?? null,
        candidates:   Array.isArray(esc.candidates) ? [...esc.candidates] : [],
      });
    }
  }

  // Build batch items from deduplicated groups
  const batch = [];
  let index = 0;
  for (const [, merged] of dedupMap) {
    const item = buildEscalationItem(
      {
        question:     merged.question,
        reason:       merged.reason,
        confidence:   merged.confidence,
        agentId:      merged.agentIds[0] ?? null, // primary agent
        escalationId: merged.escalationIds[0] ?? null,
        candidates:   merged.candidates,
        action:       "escalate",
      },
      index
    );

    // Overwrite source_worktrees + escalation_ids with the full merged lists
    item.source_worktrees = merged.agentIds;
    item.escalation_ids   = merged.escalationIds;

    batch.push(item);
    index++;
  }

  return batch;
}

// ---------------------------------------------------------------------------
// runEscalation — collect human answers (ESCALATE-02)
// ---------------------------------------------------------------------------

/**
 * Run the consolidated escalation session: call promptFn for each batch item
 * and collect the human's selected/typed answers.
 *
 * Interactive-by-design (ESCALATE-02 / NFR-10):
 *   - promptFn is dependency-injected so tests can mock it.
 *   - An un-answered item (promptFn returns null/undefined/"") stays open:
 *     its answer in the returned map is null — no fabricated answer (NFR-06).
 *   - promptFn is called sequentially (one at a time, not batched to a model).
 *
 * @param {object} opts
 * @param {Array}    opts.batch     The escalation batch from buildEscalationBatch()
 * @param {Function} opts.promptFn  async (batchItem: object) => string|null
 *                                  Returns the human's raw answer (option id or
 *                                  free text), or null/undefined if unanswered.
 *
 * @returns {Promise<{
 *   answers:  Map<string, string|null>,  // batchItemId -> answer (null if open)
 *   answered: number,                    // count of items with a non-null answer
 *   open:     number,                    // count of items still without an answer
 * }>}
 */
export async function runEscalation({ batch, promptFn }) {
  if (!Array.isArray(batch)) {
    throw new Error("runEscalation: batch must be an array");
  }
  if (typeof promptFn !== "function") {
    throw new Error(
      "runEscalation: promptFn must be injected — " +
      "use a mocked function in tests; use the interactive selector in live runs"
    );
  }

  const answers = new Map();
  let answered  = 0;
  let open      = 0;

  for (const item of batch) {
    // Validate each item before prompting (fail-fast, NFR-06)
    assertBatchItemInvariant(item);

    let rawAnswer = null;
    try {
      rawAnswer = await promptFn(item);
    } catch (_err) {
      rawAnswer = null; // promptFn threw → treat as unanswered (NFR-06)
    }

    // Normalise: null / undefined / "" → open (no fabrication, NFR-06)
    const finalAnswer = (rawAnswer !== null && rawAnswer !== undefined && rawAnswer !== "")
      ? String(rawAnswer)
      : null;

    answers.set(item.id, finalAnswer);

    if (finalAnswer !== null) {
      answered++;
    } else {
      open++;
    }
  }

  return { answers, answered, open };
}

// ---------------------------------------------------------------------------
// enrichOracleFromAnswers — ESCALATE-03 (the feedback loop)
// ---------------------------------------------------------------------------

/**
 * Write each collected human escalation answer back into the decision record.
 *
 * This closes the feedback loop (ESCALATE-03): a question that required human
 * escalation now has a sealed decision-record entry tagged source:"escalation".
 * The next time the oracle sees the same (or a similar) question it will find
 * this entry and auto-answer at high confidence — without re-escalating.
 *
 * Each answer becomes a new decision entry:
 * {
 *   id:          "esc-<itemId>-enriched",
 *   topic:       item.topic,
 *   question:    item.question,
 *   options:     item.options,
 *   freeText:    item.freeText,
 *   answer:      <human's answer>,
 *   source:      "escalation",        ← tagged for auditability (ESCALATE-03)
 *   rationale:   "Human answer collected during escalation (E5)",
 *   spec_section: null,
 * }
 *
 * The record's `sealed_at` is reset to the current timestamp (re-sealed).
 * If intakeDir is provided, decisions.json is written atomically to disk so
 * the oracle can load the updated record on the next query.
 *
 * NOTE: Only answered items (answer !== null) are written back.  Un-answered
 * escalations leave the record unchanged — no fabricated decisions (NFR-06).
 *
 * @param {Map<string, string|null>} answers
 *   The answers map from runEscalation (batchItemId -> answer or null).
 * @param {object} record
 *   The mutable decision record (from brainstorm.mjs createDecisionRecord or a
 *   previously sealed record loaded from decisions.json).
 * @param {Array}  batch
 *   The escalation batch (needed to look up question/options by item id).
 * @param {object} [opts]
 * @param {string}  [opts.intakeDir]  If provided, decisions.json is written atomically.
 * @param {Function}[opts.writeFn]    Injectable writer for tests.
 * @param {string}  [opts.sealedAt]  Override the re-seal timestamp (used in tests).
 *
 * @returns {{ enrichedCount: number }}
 */
export function enrichOracleFromAnswers(answers, record, batch, {
  intakeDir,
  writeFn,
  sealedAt,
} = {}) {
  if (!(answers instanceof Map)) {
    throw new Error("enrichOracleFromAnswers: answers must be a Map");
  }
  if (!record || typeof record !== "object" || !Array.isArray(record.decisions)) {
    throw new Error("enrichOracleFromAnswers: record must be a decision record object with .decisions array");
  }
  if (!Array.isArray(batch)) {
    throw new Error("enrichOracleFromAnswers: batch must be an array");
  }

  let enrichedCount = 0;

  for (const item of batch) {
    const answer = answers.get(item.id) ?? null;

    // Only enrich from answered items (no fabrication — NFR-06)
    if (answer === null) continue;

    // Build the new decision entry (ESCALATE-03 / BRAINSTORM-03 shape)
    const newEntry = {
      id:          `${item.id}-enriched`,
      topic:       item.topic,
      question:    item.question,
      options:     item.options,
      freeText:    item.freeText,
      answer,
      source:      "escalation",      // tagged for auditability (ESCALATE-03)
      rationale:   "Human answer collected during escalation (E5 enrichment)",
      spec_section: null,
    };

    // Append to the record's decisions array
    record.decisions.push(newEntry);
    enrichedCount++;
  }

  // Re-seal the record (update sealed_at to now)
  if (enrichedCount > 0) {
    record.sealed_at = sealedAt ?? new Date().toISOString();
  }

  // Write decisions.json atomically if intakeDir is provided
  if (intakeDir && enrichedCount > 0) {
    const writer = typeof writeFn === "function" ? writeFn : writeAtomic;
    mkdirSync(intakeDir, { recursive: true });
    const decisionsPath = join(intakeDir, "decisions.json");
    writer(decisionsPath, JSON.stringify(record, null, 2));
  }

  return { enrichedCount };
}

// ---------------------------------------------------------------------------
// EscalationCounter — ESCALATE-04 (rarity telemetry)
// ---------------------------------------------------------------------------

/**
 * Create a mutable escalation counter for tracking rarity telemetry per run.
 *
 * Usage:
 *   const counter = createEscalationCounter();
 *   incrementCounter(counter, "auto_answered");   // oracle answered itself
 *   incrementCounter(counter, "escalated");        // below-threshold, sent to human
 *   const line = renderEscalationTelemetry(counter, { threshold: 0.60 });
 *   // "auto-answered 5 / escalated 1  (threshold: 0.60)"
 *
 * @returns {{ autoAnswered: number, escalated: number }}
 */
export function createEscalationCounter() {
  return { autoAnswered: 0, escalated: 0 };
}

/**
 * Increment the appropriate counter field (pure mutation).
 *
 * @param {{ autoAnswered: number, escalated: number }} counter
 * @param {"auto_answered" | "escalated"} type
 * @returns {void}
 */
export function incrementCounter(counter, type) {
  if (!counter || typeof counter !== "object") {
    throw new Error("incrementCounter: counter must be an object from createEscalationCounter");
  }
  if (type === "auto_answered") {
    counter.autoAnswered = (counter.autoAnswered ?? 0) + 1;
  } else if (type === "escalated") {
    counter.escalated = (counter.escalated ?? 0) + 1;
  } else {
    throw new Error(
      `incrementCounter: type must be "auto_answered" or "escalated"; got "${type}"`
    );
  }
}

/**
 * Render a one-line escalation rarity telemetry string for status.mjs.
 *
 * Format: "auto-answered 18 / escalated 2  (threshold: 0.60)"
 *
 * @param {{ autoAnswered: number, escalated: number }} counter
 * @param {object} [opts]
 * @param {number}  [opts.threshold]   The oracle confidence threshold (for display)
 * @param {object|null} [opts.pending] Pending batch if a human selector is awaiting
 *   { batchSize: number } — surfaces in the status view (ESCALATE-04)
 * @returns {string}
 */
export function renderEscalationTelemetry(counter, { threshold, pending } = {}) {
  if (!counter || typeof counter !== "object") {
    throw new Error("renderEscalationTelemetry: counter must be an object");
  }

  const autoAnswered  = counter.autoAnswered ?? 0;
  const escalated     = counter.escalated    ?? 0;
  const total         = autoAnswered + escalated;

  const thresholdStr  = typeof threshold === "number"
    ? `  (threshold: ${threshold.toFixed(2)})`
    : "";

  const rateStr = total > 0
    ? `  [${Math.round((autoAnswered / total) * 100)}% auto]`
    : "";

  const pendingStr = pending && typeof pending.batchSize === "number" && pending.batchSize > 0
    ? `  [${pending.batchSize} selector${pending.batchSize !== 1 ? "s" : ""} pending human input]`
    : "";

  return `auto-answered ${autoAnswered} / escalated ${escalated}${rateStr}${thresholdStr}${pendingStr}`;
}

// ---------------------------------------------------------------------------
// CLI (minimal — library module smoke-test)
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
  process.stdout.write("escalate.mjs — Phase E5 Confidence-Gated Human Escalation (library module)\n");
  process.stdout.write("Import and use its exported functions from the Conductor or tests.\n");

  // Quick smoke test
  const counter = createEscalationCounter();
  incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "escalated");
  process.stdout.write(renderEscalationTelemetry(counter, { threshold: 0.60 }) + "\n");

  process.exit(0);
}
