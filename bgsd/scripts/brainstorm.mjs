#!/usr/bin/env node
/**
 * brainstorm.mjs — Phase E2: Active Upfront Brainstorm + Decision Record
 *                  (BRAINSTORM-01..04)
 *
 * Implements the active upfront brainstorm that Kiwi runs before any
 * decomposition/spawn.  Every question is a GSD-style selector (2–4 concrete
 * pre-filled options PLUS an always-available "type your own" free-text
 * option — NFR-10).  Answers are captured into a durable, sealed decision
 * record.  An unanswered (or partially-answered) session leaves the record
 * UNSEALED — no fabricated decisions, no silent green (NFR-06).
 *
 * DESIGN PRINCIPLES
 * =================
 * - Pure / deterministic core: `buildBrainstormQuestions` derives questions
 *   from an intent spec object with zero model calls (NFR-05).  Only the
 *   *generation of question phrasing* is a marked MODEL SEAM (refineFn).
 * - Selector-Q&A always (NFR-10): every question produced by this module
 *   carries `options` (≥2 concrete choices) AND a `freeText` affordance
 *   with id:"other".  No free-form-only prompt is ever surfaced.
 * - No silent green (NFR-06): `sealDecisionRecord` throws if any decision
 *   is still "unanswered".  The record schema exposes `sealed_at: null`
 *   while unsealed so callers can detect the condition.
 * - Atomic writes: every file write uses write-temp-then-rename, mirroring
 *   queue.mjs / intake.mjs (NFR-05 deterministic I/O).
 * - Interactive by design (BRAINSTORM-01): the actual prompt-and-answer loop
 *   runs at runtime via dependency-injected `promptFn`.  This file provides
 *   the question structure + record machinery; the Conductor drives the loop.
 *
 * RECORD LAYOUT
 * =============
 * .bgsd/intake/<intake-id>/
 *   decisions.json   — machine-readable decision record (this module writes it)
 *   DECISIONS.md     — human-readable mirror (this module writes it)
 *
 * DECISION RECORD SCHEMA
 * ======================
 * {
 *   intake_id:   string,
 *   sealed_at:   string | null,   // ISO 8601 when sealed; null while open
 *   decisions: [
 *     {
 *       id:         string,        // stable decision id (e.g. "d-001")
 *       topic:      string,        // short topic slug (≤12 chars, GSD header rule)
 *       question:   string,        // full question prompt
 *       options: [                 // the concrete pre-filled selector options
 *         { id: string, label: string, description: string },
 *         ...                      // 2–4 entries
 *       ],
 *       freeText: {                // the always-available "type your own" affordance
 *         id:          "other",
 *         label:       "Type your own",
 *         placeholder: string,
 *       },
 *       answer:     string | "unanswered",  // chosen option id OR typed text
 *       source:     "selected" | "typed" | "unanswered",
 *       rationale:  string | null,          // optional context locked by this decision
 *       spec_section: string | null,        // chunk id this decision resolves
 *     },
 *     ...
 *   ],
 * }
 *
 * KEY EXPORTS
 * ===========
 *   buildBrainstormQuestions(intentSpec)
 *     Pure.  Derives a selector question sequence from the spec.
 *     Each question satisfies NFR-10 (≥2 options + freeText with id:"other").
 *
 *   recordDecision(record, decisionId, rawAnswer, { rationale? })
 *     Pure (mutates record in-place).  Captures an answer; tags source as
 *     "selected" (option id match) or "typed" (free-text / other).
 *
 *   sealDecisionRecord(record, { writeFn?, intakeDir? })
 *     Seals the record by setting sealed_at and writing decisions.json +
 *     DECISIONS.md atomically.  THROWS if any decision is "unanswered"
 *     (no auto-seal of unanswered sessions — NFR-06).
 *
 *   queryDecision(record, topic)
 *     Pure.  Retrieves the first decision entry matching the given topic
 *     (exact slug match, then substring match).  Returns null if not found.
 *     This is the seam E4's oracle will use.
 *
 *   runBrainstorm({ intentSpec, intakeId, intakeDir, promptFn, refineFn?,
 *                   bgsdDir? })
 *     Orchestrates the full interactive brainstorm session:
 *       1. buildBrainstormQuestions → question sequence
 *       2. For each question, call promptFn to get the human's answer
 *       3. recordDecision to capture each answer
 *       4. Decision gate: ask "Ready to seal?" (also a selector)
 *       5. sealDecisionRecord when the gate is confirmed
 *     Returns { record, sealed }.
 *     NEVER seals if promptFn returns null/undefined/"" (unanswered gate).
 *
 * Usage (library):
 *   import { buildBrainstormQuestions, recordDecision, sealDecisionRecord,
 *            queryDecision, runBrainstorm } from './brainstorm.mjs';
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of brainstorm questions generated (keeps sessions focused). */
const MAX_QUESTIONS = 8;

/** Minimum concrete pre-filled options per selector (NFR-10). */
const MIN_OPTIONS = 2;

/** Maximum concrete pre-filled options per selector (NFR-10). */
const MAX_OPTIONS = 4;

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors queue.mjs / intake.mjs)
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
// Question shape helpers (NFR-10)
// ---------------------------------------------------------------------------

/**
 * Assert that a question object satisfies the NFR-10 selector invariant:
 *   - question.options is an array of length [MIN_OPTIONS, MAX_OPTIONS]
 *   - question.freeText exists and has id "other"
 *
 * Throws if the invariant is violated so tests catch structural bugs early.
 *
 * @param {object} question
 */
export function assertSelectorInvariant(question) {
  if (!question || typeof question !== "object") {
    throw new Error("assertSelectorInvariant: question must be an object");
  }
  if (!Array.isArray(question.options) || question.options.length < MIN_OPTIONS) {
    throw new Error(
      `assertSelectorInvariant: question "${question.id}" must have at least ` +
      `${MIN_OPTIONS} options (NFR-10); got ${question.options?.length ?? 0}`
    );
  }
  if (question.options.length > MAX_OPTIONS) {
    throw new Error(
      `assertSelectorInvariant: question "${question.id}" must have at most ` +
      `${MAX_OPTIONS} options (NFR-10); got ${question.options.length}`
    );
  }
  if (!question.freeText || question.freeText.id !== "other") {
    throw new Error(
      `assertSelectorInvariant: question "${question.id}" must have a freeText ` +
      `affordance with id "other" (NFR-10)`
    );
  }
}

// ---------------------------------------------------------------------------
// Question catalogue — static concrete options per topic
// ---------------------------------------------------------------------------
//
// These are the concrete pre-filled options each brainstorm topic provides.
// They are deterministic: no model call here.  A MODEL SEAM (refineFn) is
// available to refine phrasing at runtime, but the structure + option count
// are always deterministic (NFR-05 / NFR-10).
//
// Each entry:
//   topic      — short slug (≤12 chars) used as question.topic + answer retrieval key
//   prompt     — full question prompt
//   options    — 2–4 concrete, non-generic choices (NFR-10)
//   placeholder — guidance for the "type your own" affordance
//   specSection — which spec section this question resolves (used for spec_section link)

const QUESTION_CATALOGUE = [
  {
    topic:     "scope-bound",
    prompt:    "How tightly should the scope be bounded for the first deliverable?",
    options: [
      {
        id:          "mvp-thin",
        label:       "Thin MVP",
        description: "One core user flow end-to-end; defer everything else to later phases.",
      },
      {
        id:          "mvp-full",
        label:       "Full MVP",
        description: "All listed surfaces and constraints in scope from day one.",
      },
      {
        id:          "spike-first",
        label:       "Spike first",
        description: "Build a disposable spike to validate the riskiest assumption before committing to scope.",
      },
    ],
    placeholder: "Describe the scope boundary in your own words...",
    specSection: "scope",
  },
  {
    topic:     "ux-model",
    prompt:    "What UX model should the primary surface follow?",
    options: [
      {
        id:          "zero-config",
        label:       "Zero-config",
        description: "Sensible defaults everywhere; user customises only when they want to.",
      },
      {
        id:          "power-user",
        label:       "Power-user",
        description: "Expose controls and config upfront for expert users.",
      },
      {
        id:          "progressive",
        label:       "Progressive",
        description: "Simple defaults with optional advanced controls revealed on demand.",
      },
    ],
    placeholder: "Describe the UX model you have in mind...",
    specSection: "surfaces",
  },
  {
    topic:     "data-persist",
    prompt:    "Where should application data be persisted?",
    options: [
      {
        id:          "local-only",
        label:       "Local only",
        description: "All state in the browser / local filesystem; no server-side store.",
      },
      {
        id:          "cloud-sync",
        label:       "Cloud sync",
        description: "User data synced to a hosted backend; requires auth.",
      },
      {
        id:          "hybrid",
        label:       "Hybrid",
        description: "Local-first with optional cloud sync as a later upgrade.",
      },
    ],
    placeholder: "Describe your data persistence model...",
    specSection: "constraints",
  },
  {
    topic:     "deploy-target",
    prompt:    "What is the primary deployment target?",
    options: [
      {
        id:          "static-host",
        label:       "Static host",
        description: "Deploy as a static site (Vercel, Netlify, GitHub Pages) with no server.",
      },
      {
        id:          "node-server",
        label:       "Node server",
        description: "A Node.js server process (Express, Fastify) deployed to a cloud VM or container.",
      },
      {
        id:          "edge",
        label:       "Edge runtime",
        description: "Edge functions (Cloudflare Workers, Vercel Edge) for low-latency global delivery.",
      },
      {
        id:          "cli-only",
        label:       "CLI only",
        description: "The deliverable is a command-line tool; no web deployment.",
      },
    ],
    placeholder: "Describe the deployment target...",
    specSection: "constraints",
  },
  {
    topic:     "persona",
    prompt:    "Who is the primary user persona?",
    options: [
      {
        id:          "developer",
        label:       "Developer",
        description: "A software engineer who values CLI ergonomics, API access, and configurability.",
      },
      {
        id:          "knowledge-worker",
        label:       "Knowledge worker",
        description: "A non-technical professional who values simplicity and GUI.",
      },
      {
        id:          "internal",
        label:       "Internal team",
        description: "An internal tooling user (the builder's own team) — rough edges are acceptable.",
      },
    ],
    placeholder: "Describe the primary user persona...",
    specSection: "goals",
  },
  {
    topic:     "quality-bar",
    prompt:    "What is the quality bar for the initial release?",
    options: [
      {
        id:          "prototype",
        label:       "Prototype",
        description: "Fast and rough — good enough to demo, not for production use.",
      },
      {
        id:          "beta",
        label:       "Beta",
        description: "Solid enough for real use with known rough edges documented.",
      },
      {
        id:          "prod-ready",
        label:       "Prod-ready",
        description: "Hardened, tested, and ready for external users on day one.",
      },
    ],
    placeholder: "Describe the quality bar you are targeting...",
    specSection: "constraints",
  },
  {
    topic:     "stack-choice",
    prompt:    "Which technology stack constraint applies?",
    options: [
      {
        id:          "follow-spec",
        label:       "Follow spec",
        description: "Use whatever the intent spec already lists under Constraints.",
      },
      {
        id:          "minimal-deps",
        label:       "Minimal deps",
        description: "Prefer built-ins and standard library; add dependencies only when essential.",
      },
      {
        id:          "ecosystem-std",
        label:       "Ecosystem std",
        description: "Use the most widely-adopted libraries for each concern (e.g. Express, Prisma, Tailwind).",
      },
    ],
    placeholder: "Describe your stack preference...",
    specSection: "constraints",
  },
  {
    topic:     "open-q-prio",
    prompt:    "Which open question from the spec should be resolved first?",
    options: [],             // populated dynamically from spec open-questions
    placeholder: "Paste or describe the open question you want to address first...",
    specSection: "open-questions",
  },
];

// ---------------------------------------------------------------------------
// buildBrainstormQuestions (BRAINSTORM-01 / 02)
// ---------------------------------------------------------------------------

/**
 * Derive a sequence of brainstorm selector questions from an intent spec.
 *
 * Pure / deterministic — zero model calls (NFR-05).
 * A MODEL SEAM (`refineFn`) is provided for the Conductor to optionally
 * refine option phrasing at runtime, but it does NOT run here.
 *
 * Each returned question is a valid GSD-style selector (NFR-10):
 *   { id, topic, prompt, options: [≥2 concrete], freeText: { id:"other", ... } }
 *
 * Special handling:
 * - The "open-q-prio" question is populated with concrete options derived
 *   from the spec's open-questions section (up to 3, falling back to
 *   generic choices if the spec has no parseable questions).
 * - Catalogue questions whose specSection maps to a section that is absent
 *   from the spec are still included (the spec is partial; the brainstorm
 *   closes gaps).
 * - Total questions capped at MAX_QUESTIONS.
 *
 * @param {object} intentSpec
 *   The intent spec object as returned by generateIntentSpec / loaded from
 *   index.json.  Expected shape:
 *     {
 *       intake_id: string,
 *       chunks: [{ id, heading, summary }],  // from the chunk index
 *       openQuestions?: string[],             // parsed open-question lines
 *       rawSpec?: string,                     // full SPEC.md text (optional)
 *     }
 *   Accepts either the full generateIntentSpec result object (which has
 *   index.chunks) or a pre-parsed shape.
 *
 * @returns {Array<{
 *   id:         string,
 *   topic:      string,
 *   prompt:     string,
 *   options:    Array<{ id: string, label: string, description: string }>,
 *   freeText:   { id: "other", label: string, placeholder: string },
 *   specSection: string | null,
 * }>}
 */
export function buildBrainstormQuestions(intentSpec) {
  if (!intentSpec || typeof intentSpec !== "object") {
    throw new Error("buildBrainstormQuestions: intentSpec must be an object");
  }

  // Extract open questions from the spec (for the "open-q-prio" question)
  const openQuestions = extractOpenQuestions(intentSpec);

  const questions = [];
  let qIndex = 0;

  for (const entry of QUESTION_CATALOGUE) {
    if (questions.length >= MAX_QUESTIONS) break;

    qIndex++;
    const id = `q-${String(qIndex).padStart(3, "0")}`;

    let options = entry.options.slice(); // shallow copy

    // Dynamic population for the "open-q-prio" question
    if (entry.topic === "open-q-prio") {
      const derived = openQuestions.slice(0, 3).map((oq, i) => ({
        id:          `oq-${i + 1}`,
        label:       oq.length > 60 ? oq.slice(0, 57) + "..." : oq,
        description: `Resolve this open question first: "${oq}"`,
      }));

      if (derived.length >= MIN_OPTIONS) {
        options = derived;
      } else {
        // Fallback to generic options so the invariant always holds
        options = [
          {
            id:          "oq-persona",
            label:       "Persona first",
            description: "Start with the primary user persona question.",
          },
          {
            id:          "oq-scope",
            label:       "Scope first",
            description: "Start with the scope boundary question.",
          },
          ...(derived.length === 1 ? derived : []),
        ];
      }
    }

    // Enforce MIN_OPTIONS (should never fire for catalogue entries, but defensive)
    if (options.length < MIN_OPTIONS) {
      continue; // skip rather than produce an invalid question
    }

    // Trim to MAX_OPTIONS
    if (options.length > MAX_OPTIONS) {
      options = options.slice(0, MAX_OPTIONS);
    }

    const question = {
      id,
      topic:      entry.topic,
      prompt:     entry.prompt,
      options,
      freeText: {
        id:          "other",
        label:       "Type your own",
        placeholder: entry.placeholder,
      },
      specSection: entry.specSection ?? null,
    };

    // Structural assertion — fail fast rather than produce broken questions
    assertSelectorInvariant(question);

    questions.push(question);
  }

  return questions;
}

// ---------------------------------------------------------------------------
// extractOpenQuestions — parse open-question lines from the spec
// ---------------------------------------------------------------------------

/**
 * Extract open-question lines from the intent spec.
 *
 * Accepts:
 *   - intentSpec.openQuestions (pre-parsed array, used by tests)
 *   - intentSpec.rawSpec (full SPEC.md text — parses the ## Open Questions section)
 *   - intentSpec.chunks (chunk index — finds the Open Questions chunk summary)
 *   - Falls back to an empty array.
 *
 * @param {object} intentSpec
 * @returns {string[]}
 */
function extractOpenQuestions(intentSpec) {
  // Pre-parsed array (highest priority — used in tests and by E1's result)
  if (Array.isArray(intentSpec.openQuestions) && intentSpec.openQuestions.length > 0) {
    return intentSpec.openQuestions;
  }

  // Parse from rawSpec if available
  if (typeof intentSpec.rawSpec === "string" && intentSpec.rawSpec.trim()) {
    return parseOpenQuestionsFromSpec(intentSpec.rawSpec);
  }

  // Fall back to scanning chunks for the Open Questions summary
  const chunks = intentSpec.chunks ?? intentSpec.index?.chunks ?? [];
  const oqChunk = chunks.find(
    (c) => c.heading && c.heading.toLowerCase().includes("open question")
  );
  if (oqChunk && oqChunk.summary) {
    // The summary is the first sentence; wrap it as a single question line
    return [oqChunk.summary];
  }

  return [];
}

/**
 * Parse bullet-point question lines from the ## Open Questions section of a
 * Markdown spec string.
 *
 * @param {string} specMarkdown
 * @returns {string[]}
 */
function parseOpenQuestionsFromSpec(specMarkdown) {
  const lines = specMarkdown.split("\n");
  let inSection = false;
  const questions = [];

  for (const line of lines) {
    if (/^##\s+Open Questions\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      break; // next section
    }
    if (inSection) {
      const m = line.match(/^[-*]\s+(.+)$/);
      if (m) {
        questions.push(m[1].trim());
      }
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// createDecisionRecord — initialise an empty record
// ---------------------------------------------------------------------------

/**
 * Create an empty (unsealed) decision record from a question sequence.
 *
 * @param {string} intakeId
 * @param {Array}  questions  — from buildBrainstormQuestions()
 * @returns {object}  The mutable decision record object
 */
export function createDecisionRecord(intakeId, questions) {
  if (!intakeId || typeof intakeId !== "string") {
    throw new Error("createDecisionRecord: intakeId must be a non-empty string");
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("createDecisionRecord: questions must be a non-empty array");
  }

  return {
    intake_id:  intakeId,
    sealed_at:  null, // null until sealDecisionRecord() is called
    decisions:  questions.map((q) => ({
      id:           q.id,
      topic:        q.topic,
      question:     q.prompt,
      options:      q.options,
      freeText:     q.freeText,
      answer:       "unanswered",
      source:       "unanswered",
      rationale:    null,
      spec_section: q.specSection ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// recordDecision (BRAINSTORM-03)
// ---------------------------------------------------------------------------

/**
 * Capture a human answer into a decision record entry (mutates the record
 * in-place).
 *
 * If `rawAnswer` matches a known option id from the decision's option set,
 * source is tagged "selected".  Otherwise it is treated as free-text input
 * (source: "typed") — even if the user picked the "other" option id.
 *
 * An empty / null / undefined answer records "unanswered" and does NOT seal
 * the record entry (NFR-06).
 *
 * @param {object}  record      The mutable decision record (from createDecisionRecord)
 * @param {string}  decisionId  The decision entry id to update (e.g. "q-001")
 * @param {string|null|undefined} rawAnswer  The human's raw answer
 * @param {object}  [opts]
 * @param {string}  [opts.rationale]  Optional rationale / note to attach
 * @returns {object}  The updated decision entry
 */
export function recordDecision(record, decisionId, rawAnswer, { rationale } = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("recordDecision: record must be an object");
  }

  const entry = record.decisions.find((d) => d.id === decisionId);
  if (!entry) {
    throw new Error(
      `recordDecision: no decision entry with id "${decisionId}" found in record`
    );
  }

  // Null / empty → unanswered (NFR-06)
  if (rawAnswer === null || rawAnswer === undefined || rawAnswer === "") {
    entry.answer   = "unanswered";
    entry.source   = "unanswered";
    entry.rationale = rationale ?? null;
    return entry;
  }

  const knownOptionIds = new Set(entry.options.map((o) => o.id));

  if (knownOptionIds.has(rawAnswer)) {
    // User selected a pre-filled option → "selected"
    entry.answer  = rawAnswer;
    entry.source  = "selected";
  } else {
    // User typed their own answer (free-text path, including "other") → "typed"
    entry.answer  = rawAnswer;
    entry.source  = "typed";
  }

  entry.rationale = rationale ?? null;
  return entry;
}

// ---------------------------------------------------------------------------
// sealDecisionRecord (BRAINSTORM-04)
// ---------------------------------------------------------------------------

/**
 * Seal the decision record:
 *   1. Validate that ALL decisions are answered (not "unanswered").
 *      Throws if any are unanswered — NO auto-seal of partial sessions (NFR-06).
 *   2. Set sealed_at to the current ISO timestamp.
 *   3. Write decisions.json + DECISIONS.md atomically to intakeDir.
 *
 * @param {object} record       The mutable decision record
 * @param {object} [opts]
 * @param {string} [opts.intakeDir]  Path to .bgsd/intake/<intake-id>/ for file writes.
 *                                   If omitted, files are NOT written (useful in tests
 *                                   that only check the return value).
 * @param {Function} [opts.writeFn]  Injectable writer for tests:
 *                                   (filePath: string, content: string) => void
 *                                   Defaults to writeAtomic.
 * @param {string}  [opts.sealedAt]  Override the seal timestamp (used in tests).
 * @returns {{ record: object, decisionsJsonPath: string|null, decisionsMdPath: string|null }}
 * @throws {Error} if any decision is "unanswered" (NFR-06 — no auto-seal)
 */
export function sealDecisionRecord(record, { intakeDir, writeFn, sealedAt } = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("sealDecisionRecord: record must be an object");
  }

  // NFR-06: reject any unanswered decisions
  const unanswered = record.decisions.filter((d) => d.source === "unanswered");
  if (unanswered.length > 0) {
    const ids = unanswered.map((d) => d.id).join(", ");
    throw new Error(
      `sealDecisionRecord: cannot seal — ${unanswered.length} decision(s) are still ` +
      `unanswered: [${ids}]. Every decision must be answered before sealing (NFR-06, ` +
      `BRAINSTORM-04). Use recordDecision() for each unanswered entry first.`
    );
  }

  record.sealed_at = sealedAt ?? new Date().toISOString();

  const writer = typeof writeFn === "function" ? writeFn : writeAtomic;

  let decisionsJsonPath = null;
  let decisionsMdPath   = null;

  if (intakeDir) {
    mkdirSync(intakeDir, { recursive: true });

    // decisions.json — machine-readable record
    decisionsJsonPath = join(intakeDir, "decisions.json");
    writer(decisionsJsonPath, JSON.stringify(record, null, 2));

    // DECISIONS.md — human-readable mirror
    decisionsMdPath = join(intakeDir, "DECISIONS.md");
    writer(decisionsMdPath, buildDecisionsMd(record));
  }

  return { record, decisionsJsonPath, decisionsMdPath };
}

// ---------------------------------------------------------------------------
// buildDecisionsMd — human-readable mirror of decisions.json
// ---------------------------------------------------------------------------

/**
 * Render a DECISIONS.md human-readable document from a (sealed) record.
 *
 * @param {object} record
 * @returns {string}
 */
function buildDecisionsMd(record) {
  const lines = [
    `# Decision Record — Brainstorm`,
    ``,
    `**Intake ID:** ${record.intake_id}`,
    `**Sealed at:** ${record.sealed_at ?? "(not yet sealed)"}`,
    ``,
    `---`,
    ``,
  ];

  for (const d of record.decisions) {
    lines.push(`## ${d.topic} (${d.id})`);
    lines.push(``);
    lines.push(`**Question:** ${d.question}`);
    lines.push(``);
    lines.push(`**Options presented:**`);
    for (const o of d.options) {
      lines.push(`  - \`${o.id}\`: ${o.label} — ${o.description}`);
    }
    lines.push(`  - \`other\`: ${d.freeText.label}`);
    lines.push(``);
    lines.push(`**Answer:** ${d.answer}`);
    lines.push(`**Source:** ${d.source}`);
    if (d.rationale) {
      lines.push(`**Rationale:** ${d.rationale}`);
    }
    if (d.spec_section) {
      lines.push(`**Spec section:** ${d.spec_section}`);
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// queryDecision (E4 oracle seam — BRAINSTORM-03)
// ---------------------------------------------------------------------------

/**
 * Retrieve the first decision entry matching the given topic string.
 *
 * Matching order (most-specific first):
 *   1. Exact topic slug match (case-insensitive)
 *   2. Topic contains the query string (substring, case-insensitive)
 *   3. Question prompt contains the query string (substring, case-insensitive)
 *
 * Returns null if the record is not sealed or no match is found.
 *
 * This is the primary seam E4's decision-oracle will use to answer a
 * discuss-phase question from the sealed decision record.
 *
 * @param {object}          record  A sealed decision record
 * @param {string}          topic   The topic / keyword to query
 * @returns {object|null}           The matching decision entry, or null
 */
export function queryDecision(record, topic) {
  if (!record || typeof record !== "object") return null;
  if (!record.sealed_at) return null; // unsealed records are not queryable
  if (!topic || typeof topic !== "string") return null;

  const needle = topic.toLowerCase().trim();
  const decisions = record.decisions ?? [];

  // 1. Exact topic slug match
  const exact = decisions.find((d) => d.topic.toLowerCase() === needle);
  if (exact) return exact;

  // 2. Topic contains the needle
  const partial = decisions.find((d) => d.topic.toLowerCase().includes(needle));
  if (partial) return partial;

  // 3. Question prompt contains the needle
  const promptMatch = decisions.find(
    (d) => d.question.toLowerCase().includes(needle)
  );
  if (promptMatch) return promptMatch;

  return null;
}

// ---------------------------------------------------------------------------
// buildReadyGateQuestion — the decision gate (BRAINSTORM-04)
// ---------------------------------------------------------------------------

/**
 * Build the "Ready to seal?" decision gate question.
 *
 * This is a GSD-style selector (NFR-10): 2 concrete options + freeText.
 * It is used to confirm that the user is satisfied with the brainstorm
 * before the record is sealed.
 *
 * @returns {object}  A selector question object
 */
export function buildReadyGateQuestion() {
  return {
    id:      "gate-ready",
    topic:   "ready-gate",
    prompt:  "Ready to seal the decision record and proceed to planning?",
    options: [
      {
        id:          "seal-now",
        label:       "Seal now",
        description: "I'm satisfied. Seal the record and proceed to decomposition.",
      },
      {
        id:          "keep-exploring",
        label:       "Keep exploring",
        description: "I want to revisit or add more answers before sealing.",
      },
    ],
    freeText: {
      id:          "other",
      label:       "Type your own",
      placeholder: "Describe what you still need to resolve...",
    },
    specSection: null,
  };
}

// ---------------------------------------------------------------------------
// runBrainstorm — orchestrates the full interactive session (BRAINSTORM-01..04)
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full upfront brainstorm session (BRAINSTORM-01..04).
 *
 * This function is INTERACTIVE BY DESIGN (BRAINSTORM-01): it calls
 * `promptFn` for each question and for the decision gate.  In tests, inject
 * a mocked promptFn that returns pre-determined answers.
 *
 * Gate logic (BRAINSTORM-04):
 *   - After all questions are answered, ask the "Ready to seal?" gate.
 *   - If the user picks "seal-now" → sealDecisionRecord.
 *   - If the user picks "keep-exploring" → loop back and re-prompt all
 *     unanswered questions (up to MAX_EXPLORE_ROUNDS extra rounds).
 *   - If promptFn returns null/undefined/"" for the gate → park unsealed
 *     (NFR-06 — no auto-seal).
 *
 * Scope-creep handling (BRAINSTORM-04):
 *   When a "typed" answer looks like a new scope suggestion (heuristic:
 *   starts with "also", "add", "include", "what about"), it is captured to
 *   `deferredIdeas` in the return value rather than mutating the decisions.
 *   The Conductor should surface these as a deferred-ideas list.
 *
 * MODEL SEAM (`refineFn`):
 *   An optional async `refineFn(question) => question` can be injected by
 *   the Conductor to refine question phrasing (e.g. tailor option labels to
 *   the specific project).  It is called AFTER structural generation so the
 *   structure is always deterministic; only phrasing may change.  In tests,
 *   refineFn is not provided (or is a no-op).
 *
 * @param {object}   opts
 * @param {object}   opts.intentSpec    The intent spec (as fed to buildBrainstormQuestions)
 * @param {string}   opts.intakeId      The intake record id
 * @param {string}   [opts.intakeDir]   Path to write decisions.json/DECISIONS.md
 * @param {Function} opts.promptFn
 *   async (question: object) => string|null
 *   Called for each selector question.  Returns the human's raw answer
 *   (option id or free text), or null/undefined if unanswered.
 * @param {Function} [opts.refineFn]
 *   MODEL SEAM — async (question: object) => object
 *   Optional.  Refines question phrasing without changing structure.
 *   In production: a Sonnet call; in tests: omitted.
 * @param {string}   [opts.bgsdDir]     Override for .bgsd base dir
 *
 * @returns {Promise<{
 *   record:        object,
 *   sealed:        boolean,
 *   deferredIdeas: string[],
 * }>}
 */
export async function runBrainstorm({
  intentSpec,
  intakeId,
  intakeDir,
  promptFn,
  refineFn,
  bgsdDir,
}) {
  if (!intakeId || typeof intakeId !== "string") {
    throw new Error("runBrainstorm: intakeId must be a non-empty string");
  }
  if (typeof promptFn !== "function") {
    throw new Error(
      "runBrainstorm: promptFn must be injected — " +
      "use a mocked function in tests; use the interactive selector in live runs"
    );
  }

  const resolvedIntakeDir =
    intakeDir ??
    (bgsdDir
      ? join(bgsdDir, "intake", intakeId)
      : join(REPO_ROOT, ".bgsd", "intake", intakeId));

  // Step 1: build question sequence (BRAINSTORM-01/02)
  let questions = buildBrainstormQuestions(intentSpec);

  // MODEL SEAM: optionally refine question phrasing (BRAINSTORM-02)
  // *** MODEL SEAM: refineFn is an optional Sonnet call injected by the Conductor ***
  // In tests, refineFn is omitted; the structure is always deterministic.
  if (typeof refineFn === "function") {
    const refined = [];
    for (const q of questions) {
      try {
        const r = await refineFn(q);
        // Validate the seam contract: structure must not change
        if (
          r &&
          typeof r === "object" &&
          r.id === q.id &&
          Array.isArray(r.options) &&
          r.options.length >= MIN_OPTIONS &&
          r.freeText?.id === "other"
        ) {
          refined.push(r);
        } else {
          refined.push(q); // revert to original if invariant is broken
        }
      } catch (_err) {
        refined.push(q); // revert to original on error
      }
    }
    questions = refined;
  }

  // Step 2: create the (unsealed) decision record
  const record = createDecisionRecord(intakeId, questions);

  const deferredIdeas = [];
  const MAX_EXPLORE_ROUNDS = 2;
  let sealed = false;
  let exploreRound = 0;

  // Step 3: interactive Q&A loop (BRAINSTORM-01)
  while (!sealed && exploreRound <= MAX_EXPLORE_ROUNDS) {
    // Ask all unanswered questions
    for (const decision of record.decisions) {
      if (decision.source !== "unanswered") continue;

      const question = questions.find((q) => q.id === decision.id);
      if (!question) continue;

      let rawAnswer;
      try {
        rawAnswer = await promptFn(question);
      } catch (_err) {
        rawAnswer = null; // promptFn threw → treat as unanswered (NFR-06)
      }

      // Scope-creep heuristic (BRAINSTORM-04)
      if (typeof rawAnswer === "string" && rawAnswer.trim()) {
        const lower = rawAnswer.trim().toLowerCase();
        if (
          lower.startsWith("also ") ||
          lower.startsWith("add ") ||
          lower.startsWith("include ") ||
          lower.startsWith("what about")
        ) {
          deferredIdeas.push(rawAnswer.trim());
          // Still record the answer (it is the user's intent even if off-topic)
        }
      }

      recordDecision(record, decision.id, rawAnswer ?? null);
    }

    // Step 4: decision gate — "Ready to seal?" (BRAINSTORM-04)
    const gateQuestion = buildReadyGateQuestion();
    let gateAnswer;
    try {
      gateAnswer = await promptFn(gateQuestion);
    } catch (_err) {
      gateAnswer = null;
    }

    if (!gateAnswer || gateAnswer === "" || gateAnswer === "keep-exploring") {
      if (exploreRound >= MAX_EXPLORE_ROUNDS) {
        // Exhausted explore rounds — park unsealed (NFR-06)
        break;
      }
      exploreRound++;
      continue; // loop back to re-ask unanswered questions
    }

    if (gateAnswer === "seal-now" || gateAnswer === "other") {
      // User confirmed — attempt to seal
      // sealDecisionRecord throws if any decision is still "unanswered"
      try {
        sealDecisionRecord(record, { intakeDir: resolvedIntakeDir });
        sealed = true;
      } catch (_err) {
        // Unanswered decisions remain — do NOT seal (NFR-06)
        if (exploreRound >= MAX_EXPLORE_ROUNDS) break;
        exploreRound++;
      }
    }
  }

  return { record, sealed, deferredIdeas };
}
