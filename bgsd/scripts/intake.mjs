#!/usr/bin/env node
/**
 * intake.mjs — Phase E1: NL/Voice Intake → Rich Intent Spec (INTAKE-01..04)
 *
 * Implements the front-door entrypoint for the v2 Conductor Intake extension.
 * A user's natural-language (or hyperpolymath voice-captured) project description
 * is expanded into a large, exhaustive Markdown intent spec (SPEC.md), which is
 * then chunked, indexed, and handed to gsd-new-project through the documented
 * seam.
 *
 * DESIGN PRINCIPLES
 * =================
 * - Deterministic core: all structural logic (record creation, spec scaffold
 *   assembly, validation, chunking, indexing, provenance writes, gsd feed) is
 *   pure script logic — zero model calls (NFR-05).
 * - MODEL SEAM (clearly marked): the single Haiku call that expands the terse NL
 *   input into a large detailed Markdown intent spec is injected as `expandFn`.
 *   In production the Conductor supplies a real Haiku call; in tests a mocked
 *   deterministic function is injected. The seam is the parameter `expandFn`
 *   in `generateIntentSpec()`. NO real model call exists in this file.
 * - Atomic writes: every file write is temp-then-rename (same pattern as
 *   run.mjs/queue.mjs) so the store survives interruption.
 * - Seams only: the gsd-new-project feed is written to the `.planning/` contract
 *   path that `gsd-new-project --auto` reads via `@`-reference. Zero edits to
 *   vendored GSD (NFR-03/04).
 *
 * INTAKE RECORD LAYOUT
 * ====================
 * .bgsd/intake/<intake-id>/
 *   SPEC.md          — the full Markdown intent spec (INTAKE-01/04)
 *   index.json       — the chunk index: { chunks: [{ id, heading, anchor,
 *                        startLine, endLine, summary }], generated_at, intake_id }
 *   provenance.json  — raw input, model, timestamp, intake_id (INTAKE-04)
 *
 * GSD SEAM OUTPUT (INTAKE-03)
 * ===========================
 * .bgsd/intake/<intake-id>/gsd-feed/
 *   INTENT.md        — the intent spec written in the format gsd-new-project
 *                       consumes via its --auto @-reference path
 *   seam.json        — describes the seam (how to invoke gsd-new-project)
 *
 * SPEC SECTIONS (the scaffold expandFn must produce)
 * ===================================================
 * The Haiku expandFn must return a Markdown spec containing ALL of these
 * level-2 headings (## ...) in any order. The validator checks for each:
 *   ## Goals
 *   ## Scope
 *   ## Surfaces
 *   ## Constraints
 *   ## Glossary       (optional but indexed if present)
 *   ## Open Questions  (REQUIRED non-empty — INTAKE-04)
 *
 * CHUNK + INDEX (INTAKE-02)
 * =========================
 * The spec is split at every ## heading into addressable sections. Each chunk
 * gets a stable id derived from the intake-id + heading slug. The index maps
 * chunk-id → { heading, anchor, startLine, endLine, summary (first sentence) }.
 * A later oracle (E4) can retrieve exactly one section by id without loading
 * the whole spec (NFR-09).
 *
 * Usage (library):
 *   import { generateIntentSpec } from './intake.mjs';
 *
 * Usage (CLI):
 *   node bgsd/scripts/intake.mjs --input "Build a Pomodoro timer app" [--dry-run]
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
import { randomBytes } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Required ## headings in the intent spec (INTAKE-04 validation) */
const REQUIRED_SECTIONS = ["Goals", "Scope", "Surfaces", "Constraints", "Open Questions"];

/** The section whose emptiness triggers a validation failure (INTAKE-04) */
const CRITICAL_SECTION = "Open Questions";

// ---------------------------------------------------------------------------
// Intake-ID generation (INTAKE-01)
// ---------------------------------------------------------------------------

/**
 * Generate a stable intake ID from a terse NL input slug + 4 random hex bytes.
 * Format: "intake-<slug>-<4hex>"
 *
 * @param {string} nlInput
 * @returns {string}
 */
export function generateIntakeId(nlInput) {
  const slug = (nlInput ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-")
    .slice(0, 24) || "project";
  const hex = randomBytes(2).toString("hex");
  return `intake-${slug}-${hex}`;
}

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors queue.mjs / run.mjs pattern)
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
// Spec validation (INTAKE-04)
// ---------------------------------------------------------------------------

/**
 * Validate that a Markdown spec string contains the required sections and that
 * the critical "Open Questions" section is non-empty.
 *
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * @param {string} specMarkdown
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateSpec(specMarkdown) {
  if (!specMarkdown || typeof specMarkdown !== "string" || !specMarkdown.trim()) {
    return { valid: false, reason: "Spec is empty or not a string" };
  }

  const lines = specMarkdown.split("\n");

  // Extract all ## headings present
  const headingsFound = new Set();
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) headingsFound.add(m[1].trim());
  }

  // Check all required sections exist
  for (const section of REQUIRED_SECTIONS) {
    if (!headingsFound.has(section)) {
      return { valid: false, reason: `Required section "## ${section}" is missing` };
    }
  }

  // Check that the critical section is non-empty (INTAKE-04 — NFR-06)
  const criticalIdx = lines.findIndex(
    (l) => l.match(new RegExp(`^##\\s+${CRITICAL_SECTION}\\s*$`))
  );
  if (criticalIdx === -1) {
    return { valid: false, reason: `"## ${CRITICAL_SECTION}" heading not found` };
  }

  // Find the content between this heading and the next ## (or EOF)
  let hasContent = false;
  for (let i = criticalIdx + 1; i < lines.length; i++) {
    if (lines[i].match(/^##\s+/)) break; // next section
    if (lines[i].trim()) {
      hasContent = true;
      break;
    }
  }

  if (!hasContent) {
    return {
      valid: false,
      reason: `"## ${CRITICAL_SECTION}" section is empty — the spec is degenerate (NFR-06). ` +
              `The brainstorm cannot close gaps if none are declared. ` +
              `Re-run intake with a more detailed description.`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Chunk + index (INTAKE-02)
// ---------------------------------------------------------------------------

/**
 * Derive a stable section-id from an intake-id and a heading string.
 * Format: "<intake-id>/<slug>"
 *
 * @param {string} intakeId
 * @param {string} heading
 * @returns {string}
 */
function sectionId(intakeId, heading) {
  const slug = heading
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${intakeId}/${slug}`;
}

/**
 * Extract the first non-empty sentence from a block of Markdown text.
 * Used as a one-line summary for the chunk index.
 *
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const clean = text.replace(/^#+\s+.*$/gm, "").trim(); // strip headings
  const m = clean.match(/[^.!?]+[.!?]/);
  if (m) return m[0].trim();
  const first = clean.split("\n").find((l) => l.trim());
  return first ? first.trim().slice(0, 120) : "";
}

/**
 * Split a Markdown spec into addressable chunks and build a chunk index.
 * Each chunk corresponds to one ## section.
 *
 * Returns:
 * {
 *   chunks: [
 *     {
 *       id:        string  — stable "<intake-id>/<heading-slug>"
 *       heading:   string  — original heading text
 *       anchor:    string  — "#" + heading-slug (Markdown anchor)
 *       startLine: number  — 1-indexed line of the ## heading
 *       endLine:   number  — 1-indexed last line of the section (inclusive)
 *       content:   string  — full section text (heading + body)
 *       summary:   string  — first sentence of the section body
 *     },
 *     ...
 *   ]
 * }
 *
 * @param {string} specMarkdown
 * @param {string} intakeId
 * @returns {{ chunks: Array }}
 */
export function chunkSpec(specMarkdown, intakeId) {
  const lines = specMarkdown.split("\n");
  const headingPositions = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      headingPositions.push({ lineIdx: i, heading: m[1].trim() });
    }
  }

  const chunks = headingPositions.map((hp, pos) => {
    const startLine = hp.lineIdx + 1; // 1-indexed
    const nextPos = headingPositions[pos + 1];
    const endLineIdx = nextPos ? nextPos.lineIdx - 1 : lines.length - 1;
    const endLine = endLineIdx + 1; // 1-indexed

    const sectionLines = lines.slice(hp.lineIdx, endLineIdx + 1);
    const content = sectionLines.join("\n");
    const bodyText = sectionLines.slice(1).join("\n");

    const slug = hp.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    return {
      id:        sectionId(intakeId, hp.heading),
      heading:   hp.heading,
      anchor:    `#${slug}`,
      startLine,
      endLine,
      content,
      summary:   firstSentence(bodyText),
    };
  });

  return { chunks };
}

/**
 * Build the serializable chunk index (excludes full content to keep the index
 * small — content is in SPEC.md itself, retrieved by line range).
 *
 * @param {Array}  chunks
 * @param {string} intakeId
 * @param {string} generatedAt  ISO timestamp
 * @returns {object}
 */
export function buildIndex(chunks, intakeId, generatedAt) {
  return {
    intake_id:    intakeId,
    generated_at: generatedAt,
    chunks: chunks.map(({ id, heading, anchor, startLine, endLine, summary }) => ({
      id, heading, anchor, startLine, endLine, summary,
    })),
  };
}

// ---------------------------------------------------------------------------
// GSD seam: feed gsd-new-project (INTAKE-03)
// ---------------------------------------------------------------------------

/**
 * Produce the gsd-new-project feed artifacts:
 *   INTENT.md  — the intent spec verbatim (the @-reference doc gsd-new-project reads)
 *   seam.json  — describes the invocation seam (how to call gsd-new-project)
 *
 * This is the ONLY place the intake layer touches the gsd boundary. No edits
 * to vendored GSD; the feed works through the documented --auto @-reference
 * path (NFR-03/04, INTAKE-03).
 *
 * @param {string} feedDir      path to the gsd-feed directory
 * @param {string} specMarkdown  the full intent spec
 * @param {string} intakeId
 * @param {string} intentPath   absolute path to INTENT.md (used in seam.json)
 */
export function writeGsdFeed(feedDir, specMarkdown, intakeId, intentPath) {
  mkdirSync(feedDir, { recursive: true });

  // INTENT.md — the document gsd-new-project --auto reads via @ reference
  writeAtomic(join(feedDir, "INTENT.md"), specMarkdown);

  // seam.json — documents the seam invocation (not executed here; documents
  // HOW to call gsd-new-project so the Conductor can invoke it as a skill)
  const seam = {
    intake_id:      intakeId,
    seam:           "gsd-new-project --auto",
    description:    "Invoke /gsd-new-project with --auto flag and supply INTENT.md via @ reference. " +
                    "GSD will generate .planning/PROJECT.md, REQUIREMENTS.md, and ROADMAP.md from this intent spec. " +
                    "Zero edits to vendored GSD — answers flow only through the .planning/ contract (NFR-03/04).",
    intent_doc:     intentPath,
    at_reference:   `@${intentPath}`,
    invocation_hint: `/gsd-new-project --auto\n(with INTENT.md loaded via @ reference before invoking)`,
    generated_at:   new Date().toISOString(),
  };
  writeAtomic(join(feedDir, "seam.json"), JSON.stringify(seam, null, 2));
}

// ---------------------------------------------------------------------------
// MODEL SEAM — expandFn contract
// *** THIS IS THE MODEL SEAM ***
// ---------------------------------------------------------------------------
//
// In production, `expandFn` is a closure that calls Haiku (Anthropic API,
// model posture: doc/summarize = Haiku/low per Plan Part 11) with a prompt
// such as:
//
//   "Expand the following terse project description into a large, exhaustive
//    Markdown intent spec covering goals, scope, surfaces (user-facing and
//    internal), constraints, glossary, and open questions. Use ## headings for
//    each section. Be explicit about assumptions and gaps.
//    Description: <nlInput>"
//
// The function signature is:
//   async (nlInput: string) => string  (returns Markdown)
//
// In tests, a deterministic mock is injected instead. The model itself
// NEVER runs in this file — it is called by the Conductor, not here.
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main entry point: generateIntentSpec (INTAKE-01..04)
// ---------------------------------------------------------------------------

/**
 * Generate a full intake record from a natural-language project description.
 *
 * This is the primary public API for Phase E1.
 *
 * Steps:
 *  1. Mint an intake-id and create the record directory (deterministic, NFR-05)
 *  2. Call expandFn (the MODEL SEAM) to expand nlInput into a Markdown spec
 *  3. Validate the spec (INTAKE-04): required sections + non-empty Open Questions
 *  4. Chunk + index the spec (INTAKE-02)
 *  5. Write SPEC.md, index.json, provenance.json atomically (INTAKE-01/04)
 *  6. Write the gsd-new-project feed artifacts (INTAKE-03)
 *
 * @param {object}   opts
 * @param {string}   opts.nlInput    the raw natural-language project description
 * @param {Function} opts.expandFn   MODEL SEAM — async (nlInput) => Markdown string
 *                                   In tests: a deterministic mock.
 *                                   In production: a Haiku call (injected by Conductor).
 * @param {string}   [opts.bgsdDir]  override the .bgsd base dir (default: <repo>/.bgsd)
 *
 * @returns {Promise<{
 *   intakeId:    string,
 *   intakeDir:   string,
 *   specPath:    string,
 *   indexPath:   string,
 *   provenancePath: string,
 *   feedDir:     string,
 *   index:       object,
 *   chunks:      Array,
 *   validation:  { valid: boolean, reason?: string },
 * }>}
 *
 * @throws {Error} if validation fails (empty/degenerate spec — NFR-06)
 */
export async function generateIntentSpec({ nlInput, expandFn, bgsdDir }) {
  if (!nlInput || typeof nlInput !== "string" || !nlInput.trim()) {
    throw new Error("generateIntentSpec: nlInput must be a non-empty string");
  }
  if (typeof expandFn !== "function") {
    throw new Error(
      "generateIntentSpec: expandFn must be a function (inject a Haiku call or a mock)"
    );
  }

  const baseDir = bgsdDir ?? join(REPO_ROOT, ".bgsd");
  const intakeId = generateIntakeId(nlInput);
  const intakeDir = join(baseDir, "intake", intakeId);
  mkdirSync(intakeDir, { recursive: true });

  // --- Step 2: MODEL SEAM — call expandFn to get the spec Markdown ---
  // *** MODEL SEAM: expandFn is the Haiku call injected by the Conductor ***
  // In tests this is always a deterministic mock — no real model call here.
  const specMarkdown = await expandFn(nlInput);

  if (typeof specMarkdown !== "string") {
    throw new Error(
      `generateIntentSpec: expandFn must return a string, got ${typeof specMarkdown}`
    );
  }

  // --- Step 3: Validate spec (INTAKE-04, NFR-06) ---
  const validation = validateSpec(specMarkdown);
  if (!validation.valid) {
    throw new Error(
      `generateIntentSpec: spec validation failed — ${validation.reason}\n` +
      `The spec must contain non-empty ## Goals, Scope, Surfaces, Constraints, and Open Questions sections.`
    );
  }

  const generatedAt = new Date().toISOString();

  // --- Step 4: Chunk + index (INTAKE-02) ---
  const { chunks } = chunkSpec(specMarkdown, intakeId);
  const index = buildIndex(chunks, intakeId, generatedAt);

  // --- Step 5: Atomic writes ---

  // SPEC.md
  const specPath = join(intakeDir, "SPEC.md");
  writeAtomic(specPath, specMarkdown);

  // index.json (without content field to keep the index small — NFR-09)
  const indexPath = join(intakeDir, "index.json");
  writeAtomic(indexPath, JSON.stringify(index, null, 2));

  // provenance.json (INTAKE-04: record raw input, model, timestamp)
  const provenancePath = join(intakeDir, "provenance.json");
  const provenance = {
    intake_id:   intakeId,
    raw_input:   nlInput,
    model:       "haiku",                // the MODEL SEAM is always Haiku
    model_note:  "expandFn is the injected Haiku call (or a test mock); provenance records the intended live model",
    generated_at: generatedAt,
    spec_path:   specPath,
    index_path:  indexPath,
    chunk_count: chunks.length,
  };
  writeAtomic(provenancePath, JSON.stringify(provenance, null, 2));

  // --- Step 6: GSD seam feed (INTAKE-03) ---
  const feedDir = join(intakeDir, "gsd-feed");
  const intentPath = join(feedDir, "INTENT.md");
  writeGsdFeed(feedDir, specMarkdown, intakeId, intentPath);

  return {
    intakeId,
    intakeDir,
    specPath,
    indexPath,
    provenancePath,
    feedDir,
    index,
    chunks,
    validation,
  };
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

  if (!flags.input) {
    process.stderr.write(
      "Usage: node bgsd/scripts/intake.mjs --input \"<natural language description>\" [--dry-run]\n" +
      "\n" +
      "Note: In --dry-run mode a stub expandFn is used (no real Haiku call).\n" +
      "In a real Conductor session, the expandFn is injected by the Conductor.\n"
    );
    process.exit(1);
  }

  // Dry-run stub (no real model call)
  const stubExpandFn = async (nl) =>
    `## Goals\n\nBuild: ${nl}\n\n` +
    `## Scope\n\nMVP scope only.\n\n` +
    `## Surfaces\n\nWeb UI and CLI.\n\n` +
    `## Constraints\n\nNode 18+, no external deps.\n\n` +
    `## Glossary\n\nN/A\n\n` +
    `## Open Questions\n\n- What is the primary user persona?\n- What is the target deployment environment?\n`;

  const expandFn = flags["dry-run"] ? stubExpandFn : async (_nl) => {
    process.stderr.write(
      "ERROR: no --dry-run flag and no injected expandFn.\n" +
      "In production, the Conductor injects the real Haiku expandFn.\n" +
      "For local testing, add --dry-run to use the stub.\n"
    );
    process.exit(1);
  };

  try {
    const result = await generateIntentSpec({ nlInput: flags.input, expandFn });
    process.stdout.write(`Intake record created:\n`);
    process.stdout.write(`  ID:       ${result.intakeId}\n`);
    process.stdout.write(`  Dir:      ${result.intakeDir}\n`);
    process.stdout.write(`  Spec:     ${result.specPath}\n`);
    process.stdout.write(`  Index:    ${result.indexPath}\n`);
    process.stdout.write(`  GSD feed: ${result.feedDir}\n`);
    process.stdout.write(`  Chunks:   ${result.chunks.length}\n`);
  } catch (err) {
    process.stderr.write(`intake failed: ${err.message}\n`);
    process.exit(1);
  }
}
