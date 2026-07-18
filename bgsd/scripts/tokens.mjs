#!/usr/bin/env node
/**
 * tokens.mjs — per-session token + cost accounting for bgsd.
 *
 * Every coding-agent spawn (planner, executor, researcher, verifier, the Fable
 * pre-planner, and the top-level Conductor) burns tokens on some model at some
 * effort level. This module is the durable ledger of that spend: it records one
 * row per agent call, computes a dollar cost from a built-in pricing table, and
 * rolls the rows up by model / role / agent so a human can see — at a glance —
 * how efficient the architecture is being and where the tokens actually go.
 *
 * Storage (per-repo, harness-independent, mirrors queue.mjs/kb.mjs):
 *   live:     .bgsd/runs/<run-id>/tokens.json     (append-only during a sesh)
 *   archived: .bgsd/seshs/<run-id>/tokens.json    (copied at ship/rehearsal time)
 * Writes are atomic (temp + rename) so the ledger survives interruption.
 *
 * Pure functions (pricing, estimation, summarize, render) are exported and
 * unit-testable; the disk read/write + CLI is the live seam.
 *
 * Usage (CLI):
 *   node tokens.mjs record --run-id <id> --agent <id> --role executor \
 *        --model claude-opus-4-8 --effort xhigh --harness claude \
 *        --input 42000 --output 9000 [--cache-read 15000] [--unit u-1] [--source measured]
 *   node tokens.mjs report [--run-id <id>] [--json]
 *   node tokens.mjs summary            # newest run, human table
 *
 * Usage (library):
 *   import { recordUsage, loadUsage, summarize, renderReport } from './tokens.mjs';
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pricing — USD per 1M tokens, by concrete model id. (July 2026.)
// ---------------------------------------------------------------------------

/**
 * Per-model pricing in USD per MILLION tokens. `cacheRead` is the discounted
 * rate for cache-read (hit) input tokens; when a model's cache rate is unknown
 * we fall back to input. These are DEFAULTS — provider prices churn, so the CLI
 * accepts a precomputed `--cost` to override, and BGSD.md can carry overrides.
 *
 * Sources: Anthropic + OpenAI public pricing (see bgsd docs / commit history).
 */
export const PRICING = Object.freeze({
  // Claude (Anthropic)
  "claude-fable-5":   { input: 10,   output: 50,   cacheRead: 1.0 },
  "claude-opus-4-8":  { input: 5,    output: 25,   cacheRead: 0.5 },
  "claude-opus-4-7":  { input: 5,    output: 25,   cacheRead: 0.5 },
  "claude-sonnet-5":  { input: 3,    output: 15,   cacheRead: 0.3 },
  "claude-sonnet-4-6":{ input: 3,    output: 15,   cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1,    output: 5,    cacheRead: 0.1 },
  // Codex (OpenAI, GPT-5 family)
  "gpt-5.5":          { input: 5,    output: 30,   cacheRead: 0.5 },
  "gpt-5.4":          { input: 2.5,  output: 15,   cacheRead: 0.25 },
  "gpt-5.4-mini":     { input: 0.75, output: 4.5,  cacheRead: 0.075 },
  "gpt-5.4-nano":     { input: 0.15, output: 1.2,  cacheRead: 0.015 },
  // Cursor subscription models (dated Jul 2026 — included usage rates vary by plan;
  // these are placeholders for ledger display only; override via --cost / BGSD.md).
  "composer-2.5":            { input: 0, output: 0, cacheRead: 0 },
  "cursor-grok-4.5-high":    { input: 0, output: 0, cacheRead: 0 },
  "cursor-grok-4.5-medium":  { input: 0, output: 0, cacheRead: 0 },
});

/**
 * Semantic tier aliases → concrete pricing key. bgsd passes semantic tiers
 * ("opus"/"sonnet"/"haiku"/"fable") around in some code paths; normalize them
 * to the concrete id so pricing always resolves.
 */
const TIER_ALIASES = Object.freeze({
  opus:   "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku:  "claude-haiku-4-5",
  fable:  "claude-fable-5",
});

/**
 * Resolve any model string (concrete id or semantic tier) to a pricing key.
 * Returns null when we have no pricing for it (cost then reported as null).
 */
export function pricingKey(model) {
  if (!model) return null;
  if (PRICING[model]) return model;
  if (TIER_ALIASES[model]) return TIER_ALIASES[model];
  return null;
}

/**
 * Compute USD cost for a usage row. Cache-read tokens (if given) are billed at
 * the discounted cacheRead rate and are assumed to be a SUBSET already counted
 * in inputTokens, so they are netted out of the full-price input bucket.
 *
 * @returns {number|null}  USD, or null when the model has no known pricing.
 */
export function estimateCost({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 } = {}) {
  const key = pricingKey(model);
  if (!key) return null;
  const p = PRICING[key];
  const fullInput = Math.max(0, (inputTokens || 0) - (cacheReadTokens || 0));
  const usd =
    (fullInput / 1e6) * p.input +
    ((cacheReadTokens || 0) / 1e6) * p.cacheRead +
    ((outputTokens || 0) / 1e6) * p.output;
  return Number(usd.toFixed(6));
}

// ---------------------------------------------------------------------------
// Repo / path resolution
// ---------------------------------------------------------------------------

function resolveRepoRoot() {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch (_) {
    /* fall through */
  }
  return process.cwd();
}

function bgsdDirFor(repoRoot) {
  return process.env.BGSD_DIR ? resolve(process.env.BGSD_DIR) : join(repoRoot, ".bgsd");
}

/**
 * The live tokens.json path for a run: .bgsd/runs/<run-id>/tokens.json.
 * Falls back to the archived seshs path when the live run dir is gone.
 */
function tokensPathFor(bgsdDir, runId, { archived = false } = {}) {
  const sub = archived ? "seshs" : "runs";
  return join(bgsdDir, sub, runId, "tokens.json");
}

/** Newest run-id by mtime under .bgsd/runs (else .bgsd/seshs). */
export function latestRunId(bgsdDir) {
  for (const sub of ["runs", "seshs"]) {
    const dir = join(bgsdDir, sub);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, mtime: safeMtime(join(dir, d.name)) }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length) return entries[0].id;
  }
  return null;
}

function safeMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Ledger I/O
// ---------------------------------------------------------------------------

function emptyLedger(runId) {
  return { run_id: runId, created_at: new Date().toISOString(), entries: [] };
}

/** Read a run's ledger from live path, else archived path, else empty. */
export function loadUsage(bgsdDir, runId) {
  for (const archived of [false, true]) {
    const p = tokensPathFor(bgsdDir, runId, { archived });
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        if (data && Array.isArray(data.entries)) return data;
      } catch (_) {
        /* corrupt — fall through to empty */
      }
    }
  }
  return emptyLedger(runId);
}

function writeLedgerAtomic(path, ledger) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * Append one usage row to a run's live ledger and return the stored entry.
 * Cost is computed from the pricing table when not supplied. Never throws on a
 * missing model/price — that just yields cost=null (still logs model/effort).
 *
 * @param {string} bgsdDir  absolute .bgsd path
 * @param {string} runId
 * @param {object} entry    { agentId, unitId?, role, harness, model, effort,
 *                            inputTokens?, outputTokens?, cacheReadTokens?,
 *                            cacheCreationTokens?, costUsd?, source? }
 */
export function recordUsage(bgsdDir, runId, entry) {
  if (!runId) throw new Error("recordUsage: runId is required");
  const path = tokensPathFor(bgsdDir, runId);
  const ledger = existsSync(path) ? loadUsage(bgsdDir, runId) : emptyLedger(runId);

  const inputTokens = num(entry.inputTokens);
  const outputTokens = num(entry.outputTokens);
  const cacheReadTokens = num(entry.cacheReadTokens);
  const costUsd =
    entry.costUsd != null
      ? Number(entry.costUsd)
      : estimateCost({ model: entry.model, inputTokens, outputTokens, cacheReadTokens });

  const row = {
    ts: entry.ts || new Date().toISOString(),
    agent_id: entry.agentId ?? entry.agent_id ?? "unknown",
    unit_id: entry.unitId ?? entry.unit_id ?? null,
    role: entry.role ?? "unknown",
    harness: entry.harness ?? null,
    model: entry.model ?? null,
    effort: entry.effort ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: num(entry.cacheCreationTokens),
    cost_usd: costUsd,
    // measured = read from a harness transcript; estimated = byte-proxy;
    // none = only model/effort known (no token numbers available).
    source: entry.source ?? (inputTokens || outputTokens ? "measured" : "none"),
  };

  ledger.entries.push(row);
  writeLedgerAtomic(path, ledger);
  return row;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------

function blankBucket() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costKnown: true };
}

function addRow(bucket, row) {
  bucket.calls += 1;
  bucket.input += num(row.input_tokens);
  bucket.output += num(row.output_tokens);
  bucket.cacheRead += num(row.cache_read_tokens);
  if (row.cost_usd == null) bucket.costKnown = false;
  else bucket.cost += Number(row.cost_usd);
}

/**
 * Roll a ledger up into totals + breakdowns by model, role, and agent.
 * @param {{entries:Array}} ledger
 */
export function summarize(ledger) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const totals = blankBucket();
  const byModel = {};
  const byRole = {};
  const byAgent = {};

  for (const row of entries) {
    addRow(totals, row);
    for (const [map, key] of [
      [byModel, row.model ?? "unknown"],
      [byRole, row.role ?? "unknown"],
      [byAgent, row.agent_id ?? "unknown"],
    ]) {
      map[key] = map[key] || blankBucket();
      addRow(map[key], row);
    }
  }

  return { run_id: ledger?.run_id ?? null, totals, byModel, byRole, byAgent };
}

// ---------------------------------------------------------------------------
// Render (human table)
// ---------------------------------------------------------------------------

const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
const fmtUsd = (bucket) =>
  bucket.costKnown ? `$${bucket.cost.toFixed(4)}` : `$${bucket.cost.toFixed(4)}+`;

function table(title, buckets) {
  const rows = Object.entries(buckets).sort((a, b) => b[1].cost - a[1].cost);
  if (!rows.length) return "";
  const nameW = Math.max(title.length, ...rows.map(([k]) => k.length), 12);
  const head = `  ${title.padEnd(nameW)}  ${"calls".padStart(6)}  ${"input".padStart(12)}  ${"output".padStart(12)}  ${"cost".padStart(11)}`;
  const lines = rows.map(
    ([k, b]) =>
      `  ${k.padEnd(nameW)}  ${String(b.calls).padStart(6)}  ${fmtInt(b.input).padStart(12)}  ${fmtInt(b.output).padStart(12)}  ${fmtUsd(b).padStart(11)}`
  );
  return [head, ...lines].join("\n");
}

/**
 * Render a full human-readable report for a summarized ledger.
 * @param {object} summary  from summarize()
 */
export function renderReport(summary) {
  const t = summary.totals;
  const out = [];
  out.push("");
  out.push(`  bgsd token usage — run ${summary.run_id ?? "(unknown)"}`);
  out.push("  " + "─".repeat(58));
  out.push(
    `  total: ${fmtInt(t.input)} in · ${fmtInt(t.output)} out · ${fmtInt(t.cacheRead)} cache-read · ${fmtUsd(t)} · ${t.calls} calls`
  );
  if (!t.costKnown) {
    out.push(`  (a "+" on cost means some calls had no known pricing — cost is a floor)`);
  }
  out.push("");
  out.push(table("by model", summary.byModel));
  out.push("");
  out.push(table("by role", summary.byRole));
  out.push("");
  out.push(table("by agent", summary.byAgent));
  out.push("");
  return out.filter((l) => l !== "").join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function usage() {
  process.stderr.write(
    [
      "tokens.mjs — bgsd token + cost accounting",
      "",
      "  record --run-id <id> --agent <id> --role <role> --model <id> [--effort <e>]",
      "         [--harness claude|codex] [--input N] [--output N] [--cache-read N]",
      "         [--unit <id>] [--cost <usd>] [--source measured|estimated|none]",
      "  report [--run-id <id>] [--json]      # defaults to newest run",
      "  summary [--run-id <id>]              # alias for report (human table)",
      "",
    ].join("\n")
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]tokens\.mjs$/.test(process.argv[1]);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const flags = parseFlags(argv.slice(1));
  const repoRoot = resolveRepoRoot();
  const bgsdDir = bgsdDirFor(repoRoot);

  if (sub === "record") {
    const runId = flags["run-id"];
    if (!runId) {
      process.stderr.write("record: --run-id is required\n");
      process.exit(1);
    }
    const row = recordUsage(bgsdDir, runId, {
      agentId: flags.agent,
      unitId: flags.unit ?? null,
      role: flags.role,
      harness: flags.harness ?? null,
      model: flags.model ?? null,
      effort: flags.effort ?? null,
      inputTokens: flags.input,
      outputTokens: flags.output,
      cacheReadTokens: flags["cache-read"],
      cacheCreationTokens: flags["cache-creation"],
      costUsd: flags.cost != null && flags.cost !== true ? Number(flags.cost) : undefined,
      source: typeof flags.source === "string" ? flags.source : undefined,
    });
    process.stdout.write(
      `recorded ${row.role}/${row.model ?? "?"} — ${fmtInt(row.input_tokens)} in / ${fmtInt(row.output_tokens)} out / ${row.cost_usd == null ? "$?" : `$${row.cost_usd.toFixed(4)}`}\n`
    );
    process.exit(0);
  }

  if (sub === "report" || sub === "summary" || sub === undefined) {
    const runId = flags["run-id"] || latestRunId(bgsdDir);
    if (!runId) {
      process.stdout.write("No bgsd runs found — no token usage recorded yet.\n");
      process.exit(0);
    }
    const ledger = loadUsage(bgsdDir, runId);
    const summary = summarize(ledger);
    if (flags.json === true) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      process.stdout.write(renderReport(summary));
    }
    process.exit(0);
  }

  process.stderr.write(`Unknown subcommand: "${sub}"\n`);
  usage();
  process.exit(1);
}
