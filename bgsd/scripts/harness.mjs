#!/usr/bin/env node
/**
 * harness.mjs — the coding-agent HARNESS abstraction (LLM/CLI agnostic).
 *
 * Supports Claude Code, Codex, and Cursor Agent CLI. Cursor is a first-class
 * harness with direct transport (never CLIProxyAPI). Unknown harnesses throw
 * rather than falling through to Claude.
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
import { DEFAULT_MODELS, DEFAULT_CURSOR_MODELS } from "./model-contract.mjs";
import { proxyEnvForClaude } from "./proxy.mjs";
import { contractFromEnv, laneFor, scrubApiKeyEnv } from "./model-contract.mjs";

/** The harnesses bgsd knows how to drive. */
export const HARNESSES = Object.freeze(["claude", "codex", "cursor"]);

/**
 * Default model EQUIVALENTS per harness, keyed by bgsd's semantic tiers.
 * Cursor uses routine/hard selectors rather than opus/sonnet tiers.
 */
export const DEFAULT_HARNESS_MODELS = Object.freeze({
  claude: { opus: DEFAULT_MODELS.claude.model, sonnet: "sonnet", haiku: "haiku", fable: "claude-fable-5" },
  codex: { opus: "gpt-5.5", sonnet: "gpt-5.4", haiku: "gpt-5.4-mini", fable: "gpt-5.5" },
  cursor: {
    opus: DEFAULT_CURSOR_MODELS.hard,
    sonnet: DEFAULT_CURSOR_MODELS.routine,
    haiku: DEFAULT_CURSOR_MODELS.routine,
    fable: DEFAULT_CURSOR_MODELS.hard,
    routine: DEFAULT_CURSOR_MODELS.routine,
    hard: DEFAULT_CURSOR_MODELS.hard,
  },
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect which harness is driving the current process from the environment.
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {"claude"|"codex"|"cursor"}
 */
export function detectHarness(env = process.env) {
  const override = (env.BGSD_HARNESS || "").trim().toLowerCase();
  if (HARNESSES.includes(override)) return override;

  const agent = (env.AGENT || "").trim().toLowerCase();
  if (agent === "cursor") return "cursor";
  if (agent === "codex") return "codex";
  if (agent === "claude" || agent === "claude-code") return "claude";
  if (env.CURSOR_AGENT || env.CURSOR_HOME) return "cursor";
  if (env.CODEX_HOME || env.CODEX_API_KEY || env.CODEX_SANDBOX) return "codex";
  if (env.CLAUDECODE || env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_CODE) return "claude";

  return "claude";
}

// ---------------------------------------------------------------------------
// Config (BGSD.md harness + cursor blocks)
// ---------------------------------------------------------------------------

/**
 * Resolve the harness config for a repo from its BGSD.md, falling back to
 * defaults. Shape: { active, models: {claude,codex,cursor}, cursor }.
 */
export function resolveHarnessConfig(repoRoot, readFileFn, existsFn) {
  const _exists = existsFn ?? existsSync;
  const _read = readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const defaults = defaultBgsdConfig().harness ?? { active: "auto", models: DEFAULT_HARNESS_MODELS };
  const bgsdMdPath = join(repoRoot, "BGSD.md");
  let h = defaults;
  let cursorCfg = defaultBgsdConfig().cursor ?? {
    enabled: true,
    models: { ...DEFAULT_CURSOR_MODELS },
  };
  if (_exists(bgsdMdPath)) {
    try {
      const parsed = parseBgsdMd(_read(bgsdMdPath));
      h = parsed.harness ?? defaults;
      cursorCfg = parsed.cursor ?? cursorCfg;
    } catch (_) {
      h = defaults;
    }
  }
  return {
    active: h.active || "auto",
    models: {
      claude: { ...DEFAULT_HARNESS_MODELS.claude, ...(h.models?.claude ?? {}) },
      codex: { ...DEFAULT_HARNESS_MODELS.codex, ...(h.models?.codex ?? {}) },
      cursor: { ...DEFAULT_HARNESS_MODELS.cursor, ...(h.models?.cursor ?? {}) },
    },
    cursor: {
      enabled: cursorCfg.enabled !== false,
      models: {
        routine: cursorCfg.models?.routine || DEFAULT_CURSOR_MODELS.routine,
        hard: cursorCfg.models?.hard || DEFAULT_CURSOR_MODELS.hard,
      },
    },
  };
}

/**
 * The harness that should drive THIS sesh when not overridden by a lane.
 * @returns {"claude"|"codex"|"cursor"}
 */
export function activeHarness(repoRoot, { env = process.env, config } = {}) {
  const cfg = config ?? resolveHarnessConfig(repoRoot);
  const active = (cfg.active || "auto").toLowerCase();
  if (HARNESSES.includes(active)) return active;
  return detectHarness(env);
}

/** Resolve the frozen runtime lane from the session contract. */
export function activeLane(role = "build", { env = process.env, contract } = {}) {
  return laneFor(contract ?? contractFromEnv(env), role);
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a bgsd tier to the concrete model id for a harness.
 * @param {string} tier
 * @param {"claude"|"codex"|"cursor"} harness
 * @param {object} [models]
 * @returns {string}
 */
export function resolveModel(tier, harness, models = DEFAULT_HARNESS_MODELS) {
  const table = models[harness] ?? DEFAULT_HARNESS_MODELS[harness] ?? {};
  if (tier && Object.prototype.hasOwnProperty.call(table, tier)) return table[tier];
  return tier || table.sonnet || table.routine || "sonnet";
}

// ---------------------------------------------------------------------------
// Spawn construction
// ---------------------------------------------------------------------------

function flagPairs(context = {}) {
  const out = [];
  for (const [k, v] of Object.entries(context)) {
    if (v === null || v === undefined) continue;
    out.push(`--${k}`, String(v));
  }
  return out;
}

function codexPrompt({ command, context = {}, extraArgs = [], instructions }) {
  const lines = [];
  lines.push(`Run the bgsd "${command}" workflow for this worktree.`);
  lines.push("This is a Codex-native execution. Use the installed bgsd and gsd-* skills directly; Claude slash commands are labels for the workflow, not shell syntax.");
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
 * Render the Cursor Agent prompt. Cursor has no Claude slash commands; the
 * command name + context are folded into a prompt that AGENTS.md / Cursor
 * rules in the worktree can act on.
 */
export function cursorPrompt({ command, context = {}, extraArgs = [], instructions }) {
  const lines = [];
  lines.push(`Run the BGSD "${command}" workflow for this worktree.`);
  lines.push("This is a Cursor Agent CLI execution. Use installed Open GSD Cursor skills/instructions when the unit scale is feature or project. Quick units do direct scoped work and must not invoke GSD.");
  lines.push("Claude slash commands are labels for the workflow, not shell syntax.");
  lines.push("");
  lines.push("Safety contract:");
  lines.push("- Never edit the user's main checkout.");
  lines.push("- Never merge production branches (main/master).");
  lines.push("- Never open or merge a PR unless explicitly assigned at the human-gated stage.");
  lines.push("- Commit focused work.");
  lines.push("- Update the control file.");
  lines.push("- Read the latest advisor directive at every checkpoint.");
  lines.push("- Never claim success without verification evidence.");
  lines.push("- Do not choose your own model; use the model assigned by the parent session.");
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
 * Build the spawn command for a coding-agent subprocess.
 *
 *   claude: `claude -p <command> --model <model> --k v …`
 *   codex:  `codex exec "<prompt>" --model <model> --sandbox workspace-write`
 *   cursor: `cursor-agent -p --force --trust --output-format stream-json --model <id> "<prompt>"`
 *
 * Unknown harnesses throw. Proxy requires the Claude host harness.
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
  proxy = false,
  env = process.env,
}) {
  if (!HARNESSES.includes(harness)) {
    throw new Error(`Unknown harness "${harness}"; expected ${HARNESSES.join(", ")}`);
  }
  const cleanEnv = scrubApiKeyEnv(env);
  const childEnv = proxy ? proxyEnvForClaude(cleanEnv, model) : cleanEnv;
  if (proxy && harness !== "claude") {
    throw new Error("Proxy transport requires the Claude host harness");
  }

  if (harness === "cursor") {
    if (proxy) throw new Error("Cursor transport is direct; proxy is not supported");
    return {
      cmd: "cursor-agent",
      args: [
        "-p",
        "--force",
        "--trust",
        "--output-format", "stream-json",
        ...(model ? ["--model", model] : []),
        cursorPrompt({ command, context, extraArgs, instructions }),
      ],
      env: childEnv,
    };
  }

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

  // Claude Code.
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
      process.stdout.write(JSON.stringify({ active, detected, config_active: cfg.active, models: cfg.models[active], cursor: cfg.cursor }) + "\n");
    } else {
      process.stdout.write(`\nbgsd harness — repo: ${repoRoot}\n`);
      process.stdout.write(`  active:    ${active}${cfg.active === "auto" ? " (auto-detected)" : " (pinned in BGSD.md)"}\n`);
      process.stdout.write(`  detected:  ${detected} (from env)\n`);
      process.stdout.write(`  models:    ${Object.entries(cfg.models[active]).map(([t, m]) => `${t}=${m}`).join(", ")}\n`);
      process.stdout.write(`  cursor:    enabled=${cfg.cursor.enabled} routine=${cfg.cursor.models.routine} hard=${cfg.cursor.models.hard}\n\n`);
    }
    process.exit(0);
  }

  process.stderr.write("Usage: node harness.mjs detect [--json]\n");
  process.exit(1);
}
