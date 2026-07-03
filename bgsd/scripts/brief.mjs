#!/usr/bin/env node
/**
 * brief.mjs — pure core for /bgsd-generate-brief.
 *
 * Produces a comprehensive markdown brief of a PAST bgsd session so the user
 * can feed clean, interpretable context into the NEXT one ("based on the last
 * sesh, do X, Y, Z"). It reads the committed session corpus that archive.mjs
 * writes (`.bgsd/seshs/<run-id>/<unit-id>/planning/*` per unit, plus run-level
 * `RUN.md`/`AGENTS.md`), the ledger index (`.bgsd/ledger.md`), and the run
 * state file (`.bgsd/runs/<run-id>/run.json`) when present.
 *
 * The gather + build layer is PURE and dependency-injected so it is
 * unit-testable; loadSeshs (from kb.mjs) and the disk reads are the live seam.
 * Records are semi-structured (Conductor-authored prose), so every field is
 * parsed defensively — only runId is required.
 *
 * Usage (CLI):
 *   node brief.mjs [--run-id <id> | --last] [--bgsd-dir <dir>] [--out <path>] [--stdout]
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { loadSeshs } from "./kb.mjs";

// ---------------------------------------------------------------------------
// Pure: markdown assembly
// ---------------------------------------------------------------------------

/** Is a value a non-empty, printable string? */
function has(s) {
  return typeof s === "string" && s.trim() !== "";
}

/** Trim a possibly-long doc body to a readable reference length. */
function clip(text, max = 1200) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "\n\n…(truncated — see the full record for the rest)";
}

/**
 * Build a comprehensive markdown brief from an assembled record.
 *
 * Sections (each omitted when it has no data): header, What was requested,
 * What was done (per unit), Agents, Run notes, What changed, Outstanding /
 * deferred, How to continue (always present — the paste-ready next step).
 *
 * @param {object} record
 * @param {string}   record.runId                 REQUIRED. The run id.
 * @param {string}   [record.title]               Human title for the sesh.
 * @param {string}   [record.prompt]              The original request.
 * @param {string}   [record.scale]               quick | project | ...
 * @param {string}   [record.outcome]             Recorded outcome.
 * @param {string}   [record.at]                  When it ran (ISO / date str).
 * @param {Array<{id,title?,summary?,planningDocs?:Array<{name,text}>}>} [record.units]
 * @param {string}   [record.runMd]               Run-level RUN.md body.
 * @param {string}   [record.agentsMd]            Run-level AGENTS.md body.
 * @param {string[]} [record.branchesMerged]      Branches merged for the sesh.
 * @param {string}   [record.pr]                  PR link / reference.
 * @param {string[]} [record.outstanding]         Outstanding / deferred items.
 * @param {string[]} [record.nextSteps]           Suggested follow-ups.
 * @param {string}   [record.briefPath]           Where this brief will be saved
 *                                                (used in the paste line).
 * @returns {string} the markdown brief
 */
export function buildBrief(record = {}) {
  const r = record ?? {};
  if (!has(r.runId)) throw new Error("buildBrief: record.runId is required");
  const runId = r.runId;
  const out = [];

  // --- Header ---------------------------------------------------------------
  const title = has(r.title) ? r.title.trim() : runId;
  out.push(`# Session brief — ${title}`);
  const meta = [];
  meta.push(`**Run id:** \`${runId}\``);
  if (has(r.scale)) meta.push(`**Scale:** ${r.scale.trim()}`);
  if (has(r.at)) meta.push(`**When:** ${r.at.trim()}`);
  if (has(r.outcome)) meta.push(`**Outcome:** ${r.outcome.trim()}`);
  out.push(meta.join(" · "));

  // --- What was requested ---------------------------------------------------
  if (has(r.prompt)) {
    out.push("## What was requested");
    out.push(`> ${r.prompt.trim().replace(/\n/g, "\n> ")}`);
  }

  // --- What was done (per unit) --------------------------------------------
  const units = Array.isArray(r.units) ? r.units.filter((u) => u && has(u.id)) : [];
  if (units.length > 0) {
    out.push("## What was done");
    for (const u of units) {
      out.push(`### ${has(u.title) ? u.title.trim() : u.id} \`(${u.id})\``);
      if (has(u.summary)) out.push(u.summary.trim());
      const docs = Array.isArray(u.planningDocs) ? u.planningDocs.filter((d) => d && has(d.name)) : [];
      if (docs.length > 0) {
        out.push("**Key planning docs:**");
        for (const d of docs) {
          out.push(`- **${d.name.trim()}**` + (has(d.text) ? `\n\n  ${clip(d.text).replace(/\n/g, "\n  ")}` : ""));
        }
      }
    }
  }

  // --- Agents ---------------------------------------------------------------
  if (has(r.agentsMd)) {
    out.push("## Agents");
    out.push(clip(r.agentsMd, 4000));
  }

  // --- Run notes ------------------------------------------------------------
  if (has(r.runMd)) {
    out.push("## Run notes");
    out.push(clip(r.runMd, 4000));
  }

  // --- What changed ---------------------------------------------------------
  const branches = Array.isArray(r.branchesMerged) ? r.branchesMerged.filter(has) : [];
  if (branches.length > 0 || has(r.pr)) {
    out.push("## What changed");
    if (branches.length > 0) {
      out.push("**Branches merged:**");
      for (const b of branches) out.push(`- \`${b.trim()}\``);
    }
    if (has(r.pr)) out.push(`**PR:** ${r.pr.trim()}`);
  }

  // --- Outstanding / deferred ----------------------------------------------
  const outstanding = Array.isArray(r.outstanding) ? r.outstanding.filter(has) : [];
  if (outstanding.length > 0) {
    out.push("## Outstanding / deferred");
    for (const o of outstanding) out.push(`- ${o.trim()}`);
  }

  // --- How to continue (always present) ------------------------------------
  out.push("## How to continue");
  const nextSteps = Array.isArray(r.nextSteps) ? r.nextSteps.filter(has) : [];
  if (nextSteps.length > 0) {
    out.push("Suggested follow-ups:");
    for (const n of nextSteps) out.push(`- ${n.trim()}`);
  }
  const briefPath = has(r.briefPath) ? r.briefPath.trim() : `.bgsd/briefs/${runId}-brief.md`;
  out.push(
    "Hand this brief to the next session as clean context. Ready to paste:"
  );
  out.push(
    "```\n" +
      `/bgsd-sesh "based on the brief at ${briefPath}, do <next things>"\n` +
      "```"
  );

  return out.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Pure: gather a record from already-loaded inputs
// ---------------------------------------------------------------------------

/**
 * Split a sesh's docs (as returned by loadSeshs) into the run-level RUN.md /
 * AGENTS.md bodies and per-unit planning docs.
 *
 * loadSeshs paths are relative to the .bgsd dir, e.g.
 *   seshs/<run-id>/RUN.md
 *   seshs/<run-id>/AGENTS.md
 *   seshs/<run-id>/<unit-id>/planning/PLAN.md   (d.unitId === "<unit-id>")
 *
 * @param {{runId:string, docs:Array<{path:string,unitId?:string|null,text:string}>}} sesh
 */
function splitSeshDocs(sesh) {
  let runMd = "";
  let agentsMd = "";
  const unitMap = new Map(); // unitId -> [{name, text}]
  for (const d of sesh.docs ?? []) {
    const base = String(d.path).split(/[\\/]/).pop() ?? "";
    if (d.unitId) {
      if (!unitMap.has(d.unitId)) unitMap.set(d.unitId, []);
      unitMap.get(d.unitId).push({ name: base, text: d.text ?? "" });
      continue;
    }
    // Run-level (unitId === null): RUN.md / AGENTS.md, else ignore.
    if (/^RUN\.md$/i.test(base)) runMd = d.text ?? "";
    else if (/^AGENTS\.md$/i.test(base)) agentsMd = d.text ?? "";
  }
  const units = [...unitMap.entries()].map(([id, planningDocs]) => ({
    id,
    planningDocs,
  }));
  units.sort((a, b) => a.id.localeCompare(b.id));
  return { runMd, agentsMd, units };
}

/**
 * Assemble a brief `record` from already-loaded inputs. Pure + DI.
 *
 * @param {object} opts
 * @param {string}  opts.runId       The target run id.
 * @param {Array}   [opts.seshs]     From loadSeshs(bgsdDir).
 * @param {Array}   [opts.ledgerRows] From parseLedger(text).
 * @param {object}  [opts.runJson]   Parsed .bgsd/runs/<id>/run.json (optional).
 * @returns {object} a `record` for buildBrief
 */
export function gatherSeshRecord({ runId, seshs = [], ledgerRows = [], runJson = null } = {}) {
  if (!has(runId)) throw new Error("gatherSeshRecord: runId is required");
  const sesh = (seshs ?? []).find((s) => s.runId === runId) ?? { runId, docs: [] };
  const { runMd, agentsMd, units } = splitSeshDocs(sesh);
  const row = (ledgerRows ?? []).find((r) => r.runId === runId) ?? null;
  const rj = runJson ?? {};

  const record = {
    runId,
    title: rj.title ?? undefined,
    prompt: rj.prompt ?? row?.prompt ?? undefined,
    scale: rj.scale ?? row?.scale ?? undefined,
    outcome: rj.outcome ?? row?.outcome ?? rj.state ?? undefined,
    at: rj.created_at ?? rj.at ?? row?.at ?? undefined,
    units,
    runMd,
    agentsMd,
    branchesMerged: Array.isArray(rj.branches_merged)
      ? rj.branches_merged
      : Array.isArray(rj.branchesMerged)
        ? rj.branchesMerged
        : [],
    pr: rj.pr ?? rj.pr_url ?? undefined,
    outstanding: Array.isArray(rj.outstanding) ? rj.outstanding : [],
    nextSteps: Array.isArray(rj.next_steps) ? rj.next_steps : Array.isArray(rj.nextSteps) ? rj.nextSteps : [],
    briefPath: `.bgsd/briefs/${runId}-brief.md`,
  };
  return record;
}

// ---------------------------------------------------------------------------
// Pure: ledger parsing + latest-run selection
// ---------------------------------------------------------------------------

/**
 * Parse the ledger markdown table into rows. Columns:
 *   run_id | prompt | scale | outcome | at
 * Skips the header and the `---|---` separator; tolerant of blank lines and
 * missing cells (semi-structured, Conductor-authored).
 *
 * @param {string} text
 * @returns {Array<{runId:string, prompt:string, scale:string, outcome:string, at:string}>}
 */
export function parseLedger(text) {
  const rows = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const first = cells[0].toLowerCase();
    if (first === "run_id") continue; // header
    if (/^-+$/.test(cells[0].replace(/[-\s]/g, "-"))) continue; // separator row
    if (cells.every((c) => c === "" || /^-+$/.test(c))) continue;
    rows.push({
      runId: cells[0] ?? "",
      prompt: cells[1] ?? "",
      scale: cells[2] ?? "",
      outcome: cells[3] ?? "",
      at: cells[4] ?? "",
    });
  }
  return rows;
}

/**
 * Pick the most recent run id. Prefers ledger order (the ledger appends in
 * chronological order, newest last); falls back to the seshs list.
 *
 * @param {Array} seshs       From loadSeshs.
 * @param {Array} ledgerRows  From parseLedger.
 * @returns {string|null}
 */
export function latestRunId(seshs = [], ledgerRows = []) {
  const rows = (ledgerRows ?? []).filter((r) => has(r.runId));
  if (rows.length > 0) return rows[rows.length - 1].runId;
  const list = (seshs ?? []).filter((s) => has(s.runId));
  if (list.length === 0) return null;
  // Fall back to the lexically greatest run id (ids are zero-padded seq).
  return [...list].map((s) => s.runId).sort((a, b) => a.localeCompare(b)).pop();
}

// ---------------------------------------------------------------------------
// Live seam: read .bgsd/ from disk, gather, build
// ---------------------------------------------------------------------------

/** Read + parse .bgsd/runs/<runId>/run.json if it exists, else null. */
function readRunJson(bgsdDir, runId) {
  const p = join(bgsdDir, "runs", runId, "run.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Read the ledger rows from .bgsd/ledger.md, or [] if absent. */
function readLedgerRows(bgsdDir) {
  const p = join(bgsdDir, "ledger.md");
  if (!existsSync(p)) return [];
  return parseLedger(readFileSync(p, "utf8"));
}

/**
 * Build the brief string for a run against the real filesystem.
 *
 * @param {object} opts
 * @param {string}  opts.bgsdDir     absolute path to .bgsd
 * @param {string}  [opts.runId]     target run; when omitted, uses the latest.
 * @returns {{ runId:string, brief:string }}
 */
export function buildBriefLive({ bgsdDir, runId } = {}) {
  const seshs = loadSeshs(bgsdDir);
  const ledgerRows = readLedgerRows(bgsdDir);
  const targetId = has(runId) ? runId : latestRunId(seshs, ledgerRows);
  if (!targetId) {
    throw new Error(`No sessions found under ${join(bgsdDir, "seshs")} or ${join(bgsdDir, "ledger.md")}.`);
  }
  const runJson = readRunJson(bgsdDir, targetId);
  const record = gatherSeshRecord({ runId: targetId, seshs, ledgerRows, runJson });
  return { runId: targetId, brief: buildBrief(record) };
}

/** Write a brief to .bgsd/briefs/<runId>-brief.md (creating the dir). */
export function writeBrief(bgsdDir, runId, brief, outPath) {
  const dest = outPath ?? join(bgsdDir, "briefs", `${runId}-brief.md`);
  mkdirSync(join(dest, "..") + sep, { recursive: true });
  writeFileSync(dest, brief, "utf8");
  return dest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]brief\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const runIdArg = flag("--run-id");
  const bgsdDir = flag("--bgsd-dir") ?? join(process.cwd(), ".bgsd");
  const outArg = flag("--out");
  const toStdout = args.includes("--stdout");

  try {
    const { runId, brief } = buildBriefLive({ bgsdDir, runId: runIdArg });
    if (toStdout) {
      process.stdout.write(brief);
    } else {
      const dest = writeBrief(bgsdDir, runId, brief, outArg);
      process.stdout.write(`${dest}\n`);
    }
  } catch (err) {
    process.stderr.write(`brief.mjs: ${err.message}\n`);
    process.stderr.write(
      'Usage: brief.mjs [--run-id <id> | --last] [--bgsd-dir <dir>] [--out <path>] [--stdout]\n'
    );
    process.exit(1);
  }
}
