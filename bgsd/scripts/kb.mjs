#!/usr/bin/env node
/**
 * kb.mjs — knowledge base over the persistent .bgsd/seshs/ corpus.
 *
 * Lets Kiwi answer questions about EVERYTHING that ever happened: any past
 * sesh, the subagents in it, the verification agents, blockers, decisions. The
 * corpus is the committed master folder written by archive.mjs
 * (.bgsd/seshs/<run-id>/<unit-id>/planning/*) plus the run-level RUN.md/AGENTS.md.
 *
 * Pure index + search so it is unit-testable; the disk loader is the live seam.
 *
 * Usage (CLI):
 *   node kb.mjs --query "auth middleware"
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Lowercased word/path tokens. */
export function tokenize(s) {
  return String(s).toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
}

/**
 * Build a flat index from sesh records.
 * @param {Array<{runId:string, docs:Array<{path:string, unitId?:string, text:string}>}>} seshs
 */
export function buildIndex(seshs = []) {
  const docs = [];
  for (const s of seshs) {
    for (const d of s.docs ?? []) {
      docs.push({ runId: s.runId, unitId: d.unitId ?? null, path: d.path, text: d.text ?? "" });
    }
  }
  return { docs };
}

function countOccurrences(haystackLower, term) {
  let idx = 0;
  let n = 0;
  while ((idx = haystackLower.indexOf(term, idx)) !== -1) {
    n++;
    idx += term.length;
  }
  return n;
}

function snippetFor(text, terms, radius = 60) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return "";
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

/**
 * Search the index. Ranks docs by total term frequency.
 * @returns {Array<{runId, unitId, path, score, snippet}>}
 */
export function search(index, query, { limit = 10 } = {}) {
  const terms = [...new Set(tokenize(query).filter((t) => t.length > 1))];
  if (terms.length === 0) return [];
  const scored = [];
  for (const d of index.docs) {
    const lower = d.text.toLowerCase();
    let score = 0;
    for (const t of terms) score += countOccurrences(lower, t);
    if (score > 0) {
      scored.push({ runId: d.runId, unitId: d.unitId, path: d.path, score, snippet: snippetFor(d.text, terms) });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Live disk loader
// ---------------------------------------------------------------------------

function walk(dir, onFile) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

/** Load the sesh corpus from .bgsd/seshs/. */
export function loadSeshs(bgsdDir) {
  const seshsDir = join(bgsdDir, "seshs");
  if (!existsSync(seshsDir)) return [];
  const seshs = [];
  for (const runId of readdirSync(seshsDir)) {
    const runDir = join(seshsDir, runId);
    if (!statSync(runDir).isDirectory()) continue;
    const docs = [];
    walk(runDir, (file) => {
      if (!/\.(md|mdx|json|txt)$/i.test(file)) return;
      const rel = relative(runDir, file);
      const first = rel.split(sep)[0];
      const unitId = rel.includes(sep) && first !== "planning" ? first : null;
      docs.push({ path: relative(bgsdDir, file), unitId, text: readFileSync(file, "utf8") });
    });
    seshs.push({ runId, docs });
  }
  return seshs;
}

/** Query the live corpus on disk. */
export function queryLive(bgsdDir, query, opts) {
  return search(buildIndex(loadSeshs(bgsdDir)), query, opts);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]kb\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const qIdx = args.indexOf("--query");
  const query = qIdx !== -1 ? args[qIdx + 1] : args.join(" ");
  const bgsdDir = join(process.cwd(), ".bgsd");
  if (!query) {
    process.stderr.write('Usage: kb.mjs --query "<terms>"\n');
    process.exit(1);
  }
  const hits = queryLive(bgsdDir, query);
  if (hits.length === 0) {
    process.stdout.write(`No matches for "${query}" in ${bgsdDir}/seshs.\n`);
  } else {
    for (const h of hits) {
      process.stdout.write(
        `  [${h.runId}${h.unitId ? "/" + h.unitId : ""}] ${h.path} (score ${h.score})\n    ${h.snippet}\n`
      );
    }
  }
}
