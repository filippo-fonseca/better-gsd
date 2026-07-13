#!/usr/bin/env node
/**
 * harness.mjs — the coding-agent HARNESS abstraction (LLM/CLI agnostic).
 *
 * bgsd's Conductor + pipeline agents were wired for one harness: Claude Code
 * (`claude -p ...`, Claude models). This module makes bgsd harness-agnostic so a
 * sesh works identically whether it's driven from **Claude Code** or **Codex**
 * (OpenAI's CLI) — and, crucially, so you can SWITCH between them mid-project
 * (e.g. to dodge one provider's usage limits) with zero friction. All durable
 * state lives in `.bgsd/` files that are harness-independent, so switching back
 * and forth just works; this module supplies the only harness-specific bits:
 *
 *   1. DETECTION   — which harness is driving this sesh (env-based, override-able).
 *   2. MODELS      — the per-harness model EQUIVALENTS for each semantic tier
 *                    (opus/sonnet/haiku/fable), config-driven via BGSD.md.
 *   3. SPAWN       — how to launch a coding-agent subprocess on that harness
 *                    (`claude -p <cmd> --model …` vs `codex exec "<prompt>" …`).
 *
 * Pure functions + a live config reader so it is unit-testable.
 *
 * Usage (CLI):
 *   node harness.mjs detect [--json]
 *
 * Usage (library):
 *   import { activeHarness, resolveModel, buildAgentSpawn } from './harness.mjs';
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultBgsdConfig, parseBgsdMd } from "./init.mjs";
import { LATEST_OPUS } from "./decompose.mjs";
import { contractFromEnv, laneFor, scrubApiKeyEnv } from "./model-contract.mjs";

/** The harnesses bgsd knows how to drive. */
export const HARNESSES = Object.freeze(["claude", "codex"]);

/**
 * Default model EQUIVALENTS per harness, keyed by bgsd's semantic tiers. These
 * are DEFAULTS — every one is overridable in BGSD.md (`harness.models`), which
 * matters because provider model names churn; the user can retune without a code
 * change. Claude's opus tier reuses the single LATEST_OPUS source of truth.
 */
export const DEFAULT_HARNESS_MODELS = Object.freeze({
  claude: { opus: LATEST_OPUS, sonnet: "sonnet", haiku: "haiku", fable: "claude-fable-5" },
  // Codex equivalents (GPT-5 family, July 2026). Tier mapping by price + SWE-bench:
  //   fable/opus → gpt-5.5 ($5/MTok input, OpenAI's top tier; no higher model exists)
  //   sonnet     → gpt-5.4 ($2.50/MTok input, balanced speed+quality mid-tier)
  //   haiku      → gpt-5.4-mini ($0.75/MTok input, fast/cheap subagent tier)
  // Retune in BGSD.md (`harness.models.codex`) if names drift.
  codex: { opus: "gpt-5.5", sonnet: "gpt-5.4", haiku: "gpt-5.4-mini", fable: "gpt-5.5" },
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect which harness is driving the current process from the environment.
 * Order of truth:
 *   1. BGSD_HARNESS=claude|codex — explicit override always wins.
 *   2. AGENT=codex — the emerging cross-agent convention (Codex/Goose/Amp set
 *      AGENT=<name>); any CODEX_* marker also implies Codex.
 *   3. CLAUDECODE / CLAUDE_PLUGIN_ROOT — Claude Code.
 *   4. Default: claude (bgsd's original harness).
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {"claude"|"codex"}
 */
export function detectHarness(env = process.env) {
  const override = (env.BGSD_HARNESS || "").trim().toLowerCase();
  if (HARNESSES.includes(override)) return override;

  const agent = (env.AGENT || "").trim().toLowerCase();
  if (agent === "codex") return "codex";
  if (agent === "claude" || agent === "claude-code") return "claude";
  if (env.CODEX_HOME || env.CODEX_API_KEY || env.CODEX_SANDBOX) return "codex";
  if (env.CLAUDECODE || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_CODE) return "claude";

  return "claude";
}

// ---------------------------------------------------------------------------
// Config (BGSD.md harness block)
// ---------------------------------------------------------------------------

/**
 * Resolve the harness config for a repo from its BGSD.md, falling back to
 * defaults. Shape: { active: "auto"|"claude"|"codex", models: {claude,codex} }.
 *
 * @param {string} repoRoot
 * @param {(p:string)=>string}  [readFileFn]
 * @param {(p:string)=>boolean} [existsFn]
 * @returns {{ active: string, models: object }}
 */
export function resolveHarnessConfig(repoRoot, readFileFn, existsFn) {
  const _exists = existsFn ?? existsSync;
  const _read = readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const defaults = defaultBgsdConfig().harness ?? { active: "auto", models: DEFAULT_HARNESS_MODELS };
  const bgsdMdPath = join(repoRoot, "BGSD.md");
  let h = defaults;
  if (_exists(bgsdMdPath)) {
    try {
      h = parseBgsdMd(_read(bgsdMdPath)).harness ?? defaults;
    } catch (_) {
      h = defaults;
    }
  }
  return {
    active: h.active || "auto",
    models: {
      claude: { ...DEFAULT_HARNESS_MODELS.claude, ...(h.models?.claude ?? {}) },
      codex: { ...DEFAULT_HARNESS_MODELS.codex, ...(h.models?.codex ?? {}) },
    },
  };
}

/**
 * The harness that should drive THIS sesh: the config's pinned harness, or the
 * env-detected one when config.active is "auto" (the default). This is what
 * makes switching seamless — flip harnesses and the next spawn follows.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {object} [opts.config]  pre-resolved harness config (skips disk read)
 * @returns {"claude"|"codex"}
 */
export function activeHarness(repoRoot, { env = process.env, config } = {}) {
  const cfg = config ?? resolveHarnessConfig(repoRoot);
  const active = (cfg.active || "auto").toLowerCase();
  if (HARNESSES.includes(active)) return active;
  return detectHarness(env);
}

/** Resolve the frozen v2 runtime lane. Legacy config remains a fallback only. */
export function activeLane(role = "build", { env = process.env, contract } = {}) {
  return laneFor(contract ?? contractFromEnv(env), role);
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a bgsd tier (opus/sonnet/haiku/fable) to the concrete model id for a
 * harness. A value that is already a concrete id (contains a "-" and isn't a
 * bare tier) passes through unchanged, so callers can hand either a tier or an
 * explicit override.
 *
 * @param {string} tier      "opus"|"sonnet"|"haiku"|"fable" or a concrete id
 * @param {"claude"|"codex"} harness
 * @param {object} [models]  per-harness model map (default DEFAULT_HARNESS_MODELS)
 * @returns {string}
 */
export function resolveModel(tier, harness, models = DEFAULT_HARNESS_MODELS) {
  const table = models[harness] ?? DEFAULT_HARNESS_MODELS[harness] ?? {};
  if (tier && Object.prototype.hasOwnProperty.call(table, tier)) return table[tier];
  // Not a known tier — assume it's already a concrete model id; pass through.
  return tier || table.sonnet || "sonnet";
}

// ---------------------------------------------------------------------------
// Spawn construction
// ---------------------------------------------------------------------------

/**
 * Turn an ordered context object into `--key value` flag pairs, skipping
 * null/undefined values (so optional flags like --seed-plan drop cleanly).
 * Object insertion order is preserved, which keeps the argv stable.
 */
function flagPairs(context = {}) {
  const out = [];
  for (const [k, v] of Object.entries(context)) {
    if (v === null || v === undefined) continue;
    out.push(`--${k}`, String(v));
  }
  return out;
}

/**
 * Render the Codex prompt for a bgsd command. Codex has no slash commands or
 * bgsd flags, so the command name + its context are serialized into a prompt
 * preamble that a Codex run (with AGENTS.md guidance in the worktree) can act on.
 */
function codexPrompt({ command, context = {}, extraArgs = [], instructions }) {
  const lines = [];
  lines.push(`Run the bgsd "${command}" workflow for this worktree.`);
  const ctxEntries = Object.entries(context).filter(([, v]) => v !== null && v !== undefined);
  if (ctxEntries.length) {
    lines.push("", "Context:");
    for (const [k, v] of ctxEntries) lines.push(`- ${k}: ${v}`);
  }
  if (extraArgs && extraArgs.length) {
    lines.push("", `Args: ${extraArgs.join(" ")}`);
  }
  if (instructions) lines.push("", instructions);
  return lines.join("\n");
}

/**
 * Build the spawn command for a coding-agent subprocess on the active harness.
 *
 * Returns `{ cmd, args }` for spawnSync. The two harnesses diverge:
 *   claude: `claude -p <command> --model <model> --k v …`   (slash cmd + flags)
 *   codex:  `codex exec "<prompt>" --model <model> --sandbox workspace-write`
 *           (command + context folded into the prompt; Codex takes no bgsd flags)
 *
 * @param {object} opts
 * @param {"claude"|"codex"} opts.harness
 * @param {string} opts.command       the bgsd slash command, e.g. "/bgsd-run-agent"
 * @param {string} [opts.model]       concrete model id (from resolveModel)
 * @param {object} [opts.context]     ordered flag context → `--k v` on claude
 * @param {string[]} [opts.extraArgs] raw args appended verbatim on claude (positional
 *                                    args + boolean flags like --no-usage-verification)
 * @param {boolean} [opts.modelForClaude=true] whether to inject `--model` on the
 *                  claude path (some claude commands manage their own model, e.g.
 *                  /bgsd-verify, /gsd-quick — pass false to preserve that)
 * @param {string} [opts.instructions] extra prompt text for the Codex path
 * @param {string} [opts.sandbox="workspace-write"] Codex sandbox mode
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildAgentSpawn({
  harness,
  command,
  model,
  context = {},
  extraArgs = [],
  modelForClaude = true,
  instructions,
  sandbox = "workspace-write",
  effort = "high",
  env = process.env,
}) {
  const childEnv = scrubApiKeyEnv(env);
  if (harness === "codex") {
    return {
      cmd: "codex",
      args: [
        "exec",
        codexPrompt({ command, context, extraArgs, instructions }),
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--config", `model_reasoning_effort=\"${effort}\"`] : []),
        "--sandbox", sandbox,
      ],
      env: childEnv,
    };
  }
  // Default: Claude Code.
  return {
    cmd: "claude",
    args: [
      "-p", command,
      ...(model && modelForClaude ? ["--model", model] : []),
      ...flagPairs(context),
      ...extraArgs,
    ],
    env: {
      ...childEnv,
      ...(model ? { CLAUDE_CODE_SUBAGENT_MODEL: model } : {}),
      ...(effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort, CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1" } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI — harness preflight for the Conductor
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]harness\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const json = argv.includes("--json");
  const repoRoot = process.cwd();

  if (sub === "detect" || sub === "which") {
    const cfg = resolveHarnessConfig(repoRoot);
    const active = activeHarness(repoRoot, { config: cfg });
    const detected = detectHarness();
    if (json) {
      process.stdout.write(JSON.stringify({ active, detected, config_active: cfg.active, models: cfg.models[active] }) + "\n");
    } else {
      process.stdout.write(`\nbgsd harness — repo: ${repoRoot}\n`);
      process.stdout.write(`  active:    ${active}${cfg.active === "auto" ? " (auto-detected)" : " (pinned in BGSD.md)"}\n`);
      process.stdout.write(`  detected:  ${detected} (from env)\n`);
      process.stdout.write(`  models:    ${Object.entries(cfg.models[active]).map(([t, m]) => `${t}=${m}`).join(", ")}\n\n`);
    }
    process.exit(0);
  }

  process.stderr.write("Usage: node harness.mjs detect [--json]\n");
  process.exit(1);
}
