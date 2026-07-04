#!/usr/bin/env node
/**
 * recall.mjs — session recall: what happened before, especially recently.
 *
 * At the start of every /bgsd-sesh, Kiwi glances back at past sessions so the
 * new work is informed by what already happened. It always surfaces the MOST
 * RECENT session, plus any past sessions RELEVANT to the current prompt, and it
 * flags when the prompt explicitly references the last sesh ("based on the last
 * sesh, fix X"). Read-only and fully REPO-SPECIFIC — everything is read from
 * this repo's own .bgsd/ (ledger.md index + seshs/ corpus). Nothing is written.
 *
 * Pure parsing/ranking so it is unit-testable; the disk reads are the live seam
 * (recallLive). Any I/O error degrades to an empty recall — recall must never
 * block or break a session.
 *
 * Usage (CLI):
 *   node recall.mjs --prompt "based on the last sesh, fix the nav"
 *
 * Usage (library):
 *   import { recall, recallLive, parseLedger, referencesLastSession } from './recall.mjs';
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { queryLive } from "./kb.mjs";

// ---------------------------------------------------------------------------
// Ledger parsing — .bgsd/ledger.md rows
//   | Title | Run ID | State | Merged | Held | Created At | Prompt |
// ---------------------------------------------------------------------------

/**
 * Parse the ledger markdown table into structured rows, oldest-first (the
 * ledger is append-only, so the LAST row is the most recent session).
 *
 * @param {string} text  contents of .bgsd/ledger.md
 * @returns {Array<{title,runId,state,merged:number,held:number,createdAt,prompt}>}
 */
export function parseLedger(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 7) continue;
    const [title, runId, state, merged, held, createdAt, prompt] = cells;
    // Skip the header row and the |---|---| separator row.
    if (title === "Title" && runId === "Run ID") continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    if (!runId || runId === "Run ID") continue;
    rows.push({
      title,
      runId,
      state,
      merged: Number.parseInt(merged, 10) || 0,
      held: Number.parseInt(held, 10) || 0,
      createdAt,
      prompt,
    });
  }
  return rows;
}

/**
 * The most recent session = the last ledger row (append-only log).
 * @param {Array} rows  from parseLedger
 * @returns {object|null}
 */
export function mostRecentSession(rows) {
  return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
}

/**
 * Does the prompt explicitly point back at the previous session? Catches
 * phrasings like "based on the last sesh", "continue the previous run",
 * "from that session", "pick up where we left off".
 *
 * @param {string} prompt
 * @returns {boolean}
 */
export function referencesLastSession(prompt) {
  const p = String(prompt ?? "");
  if (/\b(last|previous|prior|recent|earlier)\s+(sesh|session|run)\b/i.test(p)) return true;
  if (/\b(that|the)\s+(sesh|session|run)\b/i.test(p)) return true;
  if (/\bpick(ing)?\s+up\s+where\s+(we|i|you)\s+left\s+off\b/i.test(p)) return true;
  if (/\b(continue|resume|finish|carry\s+on\s+with)\b.*\b(sesh|session|run|work)\b/i.test(p)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Recall — combine most-recent + prompt-relevant sessions
// ---------------------------------------------------------------------------

/**
 * Build a recall summary from the ledger rows and a prompt search over the
 * seshs corpus. Pure: I/O is injected via ledgerRows + searchHits.
 *
 * @param {object} opts
 * @param {string}   opts.prompt
 * @param {Array}    opts.ledgerRows   parsed ledger rows (parseLedger output)
 * @param {Array<{runId,score,snippet,path}>} [opts.searchHits]  kb.search hits
 * @param {number}   [opts.limit=3]    max relevant sessions to return
 * @returns {{
 *   mostRecent: object|null,
 *   relevant: Array<{runId,title,state,createdAt,score,snippet}>,
 *   referencesLast: boolean,
 * }}
 */
export function recall({ prompt, ledgerRows = [], searchHits = [], limit = 3 }) {
  const byRunId = new Map(ledgerRows.map((r) => [r.runId, r]));
  const mr = mostRecentSession(ledgerRows);

  // Fold per-doc search hits up to one entry per run (sum scores, keep the best
  // snippet). This turns "which files matched" into "which sessions matched".
  const runScores = new Map();
  for (const h of searchHits ?? []) {
    const cur = runScores.get(h.runId) ?? { runId: h.runId, score: 0, snippet: "" };
    cur.score += h.score ?? 0;
    if (!cur.snippet && h.snippet) cur.snippet = h.snippet;
    runScores.set(h.runId, cur);
  }

  const relevant = [...runScores.values()]
    .sort((a, b) => b.score - a.score || a.runId.localeCompare(b.runId))
    .slice(0, limit)
    .map((r) => {
      const meta = byRunId.get(r.runId);
      return {
        runId: r.runId,
        title: meta?.title ?? r.runId,
        state: meta?.state ?? null,
        createdAt: meta?.createdAt ?? null,
        score: r.score,
        snippet: r.snippet,
      };
    });

  return {
    mostRecent: mr,
    relevant,
    referencesLast: referencesLastSession(prompt),
  };
}

// ---------------------------------------------------------------------------
// Live seam — read this repo's .bgsd/ from disk
// ---------------------------------------------------------------------------

/**
 * Read the ledger + run the prompt search against the live .bgsd/ corpus.
 * Repo-specific: bgsdDir is this repo's .bgsd. Degrades to an empty recall on
 * any error so it can never break or block a session.
 *
 * @param {string} bgsdDir   absolute path to this repo's .bgsd
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.limit=3]
 * @param {Function} [opts.searchFn]  (bgsdDir, prompt, opts) => hits  (default kb.queryLive)
 * @returns {{ mostRecent, relevant, referencesLast }}
 */
export function recallLive(bgsdDir, prompt, { limit = 3, searchFn = queryLive } = {}) {
  let ledgerRows = [];
  try {
    const ledgerPath = join(bgsdDir, "ledger.md");
    if (existsSync(ledgerPath)) ledgerRows = parseLedger(readFileSync(ledgerPath, "utf8"));
  } catch (_) {
    ledgerRows = [];
  }

  let searchHits = [];
  try {
    searchHits = prompt && String(prompt).trim() ? searchFn(bgsdDir, prompt, { limit: 20 }) : [];
  } catch (_) {
    searchHits = [];
  }

  return recall({ prompt, ledgerRows, searchHits, limit });
}

/**
 * Render a compact, human-readable recall for the Conductor to narrate.
 * One-liner for the most recent session, a short list for relevant ones.
 *
 * @param {{mostRecent, relevant, referencesLast}} r
 * @returns {string}  "" when there is nothing to recall
 */
export function formatRecall(r) {
  if (!r) return "";
  const lines = [];
  if (r.mostRecent) {
    const m = r.mostRecent;
    lines.push(`last sesh: "${m.title}" [${m.state}] — ${truncate(m.prompt, 60)}`);
  }
  const others = (r.relevant ?? []).filter((x) => !r.mostRecent || x.runId !== r.mostRecent.runId);
  if (others.length) {
    lines.push(`relevant past seshs:`);
    for (const s of others) {
      lines.push(`  - "${s.title}"${s.state ? ` [${s.state}]` : ""}${s.snippet ? ` — ${s.snippet}` : ""}`);
    }
  }
  if (r.referencesLast && r.mostRecent) {
    lines.push(`(prompt references the last sesh — carrying its context forward)`);
  }
  return lines.join("\n");
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]recall\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const pIdx = args.indexOf("--prompt");
  const prompt = pIdx !== -1 ? args[pIdx + 1] : args.join(" ");
  const bgsdDir = join(process.cwd(), ".bgsd");
  const r = recallLive(bgsdDir, prompt);
  const text = formatRecall(r);
  process.stdout.write(text ? text + "\n" : "No past sessions to recall in this repo yet.\n");
}
