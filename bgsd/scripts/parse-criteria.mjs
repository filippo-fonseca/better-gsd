#!/usr/bin/env node
/**
 * parse-criteria.mjs — VERIFY-01
 *
 * Parses acceptance criteria into a normalized JSON list from either:
 *   - a file path (GSD UI-SPEC.md or acceptance file — markdown checklist or
 *     bulleted "Success Criteria" items)
 *   - an inline string (split on newlines or semicolons)
 *
 * Output: JSON array of { id, description, source }
 *   - id: "CRIT-01", "CRIT-02", ... (stable sequential, 1-indexed)
 *     If the source already embeds an ID like "CRIT-03:" it is kept.
 *   - description: the text of the criterion (stripped of markdown syntax)
 *   - source: the file path or the string "inline"
 *
 * Usage:
 *   node bgsd/scripts/parse-criteria.mjs --file <path>
 *   node bgsd/scripts/parse-criteria.mjs --inline "criterion one; criterion two"
 *   node bgsd/scripts/parse-criteria.mjs --file <path> --pretty
 *   node bgsd/scripts/parse-criteria.mjs --inline "..." --pretty
 *
 * Exit codes:
 *   0 — success (JSON written to stdout)
 *   1 — bad arguments or file-read error
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

// Matches explicit criterion IDs embedded in text:
//   "CRIT-01: some text"
//   "CRIT-7: ..."
//   "AC-01: ..."  (alternate prefix)
const EMBEDDED_ID_RE = /^((?:CRIT|AC)-\d+)\s*:\s*/i;

// Markdown checklist item: "- [ ] ..." or "- [x] ..." or "* [ ] ..."
const CHECKLIST_ITEM_RE = /^[-*]\s*\[[ xX]\]\s*/;

// Plain markdown list item: "- ..." or "* ..."
const LIST_ITEM_RE = /^[-*]\s+/;

// Numbered list item: "1. ..." or "1) ..."
const NUMBERED_ITEM_RE = /^\d+[.)]\s+/;

// Success-criteria section header (case-insensitive)
const CRITERIA_SECTION_RE =
  /^#+\s*(success criteria|acceptance criteria|criteria|requirements)/i;

// Any heading (to detect section end)
const ANY_HEADING_RE = /^#+\s/;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Strip leading markdown list/checklist markers from a line.
 */
function stripMarkers(line) {
  return line
    .replace(CHECKLIST_ITEM_RE, "")
    .replace(LIST_ITEM_RE, "")
    .replace(NUMBERED_ITEM_RE, "")
    .trim();
}

/**
 * Extract an embedded ID from the start of a description string.
 * Returns { id: string|null, description: string }.
 */
function extractEmbeddedId(text) {
  const m = text.match(EMBEDDED_ID_RE);
  if (m) {
    return {
      id: m[1].toUpperCase(),
      description: text.slice(m[0].length).trim(),
    };
  }
  return { id: null, description: text };
}

/**
 * Assign stable sequential IDs to criteria that don't have one yet.
 * Respects any already-assigned IDs (from embedded source IDs).
 *
 * @param {Array<{id:string|null, description:string, source:string}>} items
 * @returns {Array<{id:string, description:string, source:string}>}
 */
function assignIds(items) {
  // Collect all already-assigned numeric suffixes to avoid collisions.
  const used = new Set();
  for (const item of items) {
    if (item.id) {
      const m = item.id.match(/\d+$/);
      if (m) used.add(parseInt(m[0], 10));
    }
  }

  let counter = 1;
  function nextId() {
    while (used.has(counter)) counter++;
    used.add(counter);
    return `CRIT-${String(counter).padStart(2, "0")}`;
  }

  return items.map((item) => ({
    ...item,
    id: item.id ?? nextId(),
  }));
}

// ---------------------------------------------------------------------------
// File parser
// ---------------------------------------------------------------------------

/**
 * Parse a markdown file into a criteria list.
 * Strategy:
 *   1. If the file has a "Success Criteria" / "Acceptance Criteria" heading,
 *      collect only the list items under that section (stops at next heading
 *      or end of file).
 *   2. Otherwise, collect ALL markdown checklist items (- [ ] / - [x])
 *      from the entire file.
 *   3. Fallback: collect all plain bullet / numbered list items.
 *
 * @param {string} filePath  absolute or relative path
 * @returns {Array<{id:string|null, description:string, source:string}>}
 */
export function parseFile(filePath) {
  const abs = resolve(process.cwd(), filePath);
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`Cannot read file "${filePath}": ${err.message}`);
  }

  const lines = content.split(/\r?\n/);
  const source = abs;

  // --- Pass 1: find a criteria section ---
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (!inSection && CRITERIA_SECTION_RE.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // A new heading (at same or higher level) ends the section.
      if (ANY_HEADING_RE.test(line.trim()) && line.trim() !== "") {
        break;
      }
      sectionLines.push(line);
    }
  }

  let candidates;

  if (sectionLines.length > 0) {
    // Collect list items from the section
    candidates = sectionLines
      .filter(
        (l) =>
          CHECKLIST_ITEM_RE.test(l.trim()) ||
          LIST_ITEM_RE.test(l.trim()) ||
          NUMBERED_ITEM_RE.test(l.trim())
      )
      .map((l) => l.trim());
  } else {
    // No criteria section: collect all checklist items in the file
    const checklistItems = lines
      .filter((l) => CHECKLIST_ITEM_RE.test(l.trim()))
      .map((l) => l.trim());

    if (checklistItems.length > 0) {
      candidates = checklistItems;
    } else {
      // Fallback: all plain bullet / numbered list items
      candidates = lines
        .filter(
          (l) =>
            LIST_ITEM_RE.test(l.trim()) || NUMBERED_ITEM_RE.test(l.trim())
        )
        .map((l) => l.trim());
    }
  }

  // Strip markers, extract embedded IDs, filter empties
  const raw = candidates
    .map((c) => {
      const stripped = stripMarkers(c);
      if (!stripped) return null;
      const { id, description } = extractEmbeddedId(stripped);
      return { id, description, source };
    })
    .filter(Boolean);

  return assignIds(raw);
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

/**
 * Parse an inline string into a criteria list.
 * Splits on newlines or semicolons, trims, filters empties.
 *
 * @param {string} inlineStr
 * @returns {Array<{id:string, description:string, source:string}>}
 */
export function parseInline(inlineStr) {
  const parts = inlineStr
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const raw = parts.map((part) => {
    const { id, description } = extractEmbeddedId(part);
    return { id, description, source: "inline" };
  });

  return assignIds(raw);
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
  const argv = process.argv.slice(2);

  const fileIdx = argv.indexOf("--file");
  const inlineIdx = argv.indexOf("--inline");
  const pretty = argv.includes("--pretty");

  if (fileIdx === -1 && inlineIdx === -1) {
    process.stderr.write(
      "Usage:\n" +
        "  parse-criteria.mjs --file <path> [--pretty]\n" +
        "  parse-criteria.mjs --inline \"criterion one; criterion two\" [--pretty]\n"
    );
    process.exit(1);
  }

  let criteria;
  try {
    if (fileIdx !== -1) {
      const filePath = argv[fileIdx + 1];
      if (!filePath || filePath.startsWith("--")) {
        process.stderr.write("Error: --file requires a path argument.\n");
        process.exit(1);
      }
      criteria = parseFile(filePath);
    } else {
      const inlineStr = argv[inlineIdx + 1];
      if (!inlineStr || inlineStr.startsWith("--")) {
        process.stderr.write(
          'Error: --inline requires a string argument (quote it).\n'
        );
        process.exit(1);
      }
      criteria = parseInline(inlineStr);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    pretty ? JSON.stringify(criteria, null, 2) : JSON.stringify(criteria)
  );
  process.stdout.write("\n");
}
