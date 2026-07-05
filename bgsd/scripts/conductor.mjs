#!/usr/bin/env node
/**
 * conductor.mjs — the harness-neutral Conductor entrypoint.
 *
 * bgsd's front door is `/bgsd-sesh`, a **Claude Code** plugin slash command. But
 * bgsd must be usable when Claude Code isn't an option at all — e.g. your Claude
 * usage is exhausted, so you can't even open a Claude session to start the
 * Conductor. This launcher lets you run the WHOLE Conductor from **Codex** (or
 * any shell): it resolves the plugin root without `CLAUDE_PLUGIN_ROOT`, loads the
 * exact same Conductor instructions (`commands/bgsd-sesh.md`), and hands them to
 * the active harness's CLI so that harness's model becomes Kiwi and drives the
 * session — running the same harness-agnostic node scripts underneath.
 *
 * The bridge that makes the existing instructions portable: we export
 * `CLAUDE_PLUGIN_ROOT` (+ `BGSD_PLUGIN_ROOT`) into the launched process's
 * environment, so every `node "${CLAUDE_PLUGIN_ROOT}/scripts/…"` snippet in the
 * instructions runs verbatim under Codex too.
 *
 * Usage:
 *   node conductor.mjs "<what to build>" [--project|--feature|--quick|--plan-only]
 *   node conductor.mjs "<request>" --exec          # non-interactive (codex exec)
 *   node conductor.mjs "<request>" --print-prompt  # print the prompt, launch nothing
 *   BGSD_HARNESS=codex node conductor.mjs "<request>"
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { activeHarness, resolveHarnessConfig } from "./harness.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
/** The bgsd plugin root = the dir that holds commands/ + scripts/ + agents/. */
export const PLUGIN_ROOT = resolve(__dir, "..");

/**
 * Resolve the plugin root WITHOUT requiring Claude Code's env var. Prefers an
 * explicit override (CLAUDE_PLUGIN_ROOT / BGSD_PLUGIN_ROOT) so a relocated
 * install still works, else derives it from this script's own location.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {string}
 */
export function resolvePluginRoot(env = process.env) {
  return env.CLAUDE_PLUGIN_ROOT || env.BGSD_PLUGIN_ROOT || PLUGIN_ROOT;
}

/**
 * Build the Conductor prompt fed to a non-Claude harness. Wraps the real
 * bgsd-sesh instructions with a short preamble that (a) tells the model it IS the
 * Conductor, (b) points it at the resolved plugin root, and (c) states the user's
 * request. Pure + testable.
 *
 * @param {object} opts
 * @param {string}   opts.instructions  contents of commands/bgsd-sesh.md
 * @param {string}   opts.request        the user's "what to build" prompt
 * @param {string[]} [opts.flags]        scope/mode flags (--project, --plan-only, …)
 * @param {string}   opts.pluginRoot     resolved plugin root
 * @returns {string}
 */
export function buildConductorPrompt({ instructions, request, flags = [], pluginRoot }) {
  const flagLine = flags.length ? ` ${flags.join(" ")}` : "";
  return [
    `You are Kiwi, the bgsd Conductor, running under Codex (not Claude Code).`,
    `bgsd is an autonomous, self-verifying orchestration layer on top of GSD. Drive`,
    `this session by FOLLOWING the Conductor instructions below exactly, end to end.`,
    ``,
    `Environment notes (important):`,
    `- The bgsd plugin root is: ${pluginRoot}`,
    `- Wherever the instructions say \${CLAUDE_PLUGIN_ROOT}, that variable is already`,
    `  exported to this path in your environment — run those \`node …\` commands as`,
    `  written; they are plain, harness-agnostic Node scripts.`,
    `- "/bgsd-sesh" and other /bgsd-* names are Claude Code shorthands. Here you ARE`,
    `  that Conductor: perform the steps the instructions describe directly.`,
    `- Spawned worker agents already resolve to Codex model equivalents via`,
    `  harness.mjs — you don't need to translate model names yourself.`,
    `- Ask the user questions when the instructions call for a selector/gate; this`,
    `  is an interactive session.`,
    ``,
    `Your task for this session:`,
    `  /bgsd-sesh "${request}"${flagLine}`,
    ``,
    `================ CONDUCTOR INSTRUCTIONS (bgsd-sesh) ================`,
    instructions,
  ].join("\n");
}

/**
 * Build the spawn for launching the Conductor on a harness.
 *   codex (interactive): `codex "<prompt>"`
 *   codex (--exec):      `codex exec "<prompt>" --sandbox workspace-write`
 * The env carries CLAUDE_PLUGIN_ROOT/BGSD_PLUGIN_ROOT so instruction snippets work.
 *
 * @returns {{ cmd: string, args: string[], env: object } | null}
 *   null for the claude harness (there you just use the /bgsd-sesh slash command).
 */
export function buildConductorSpawn({ harness, prompt, pluginRoot, exec = false, env = process.env }) {
  if (harness !== "codex") return null;
  const childEnv = { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot, BGSD_PLUGIN_ROOT: pluginRoot, AGENT: "codex" };
  const args = exec
    ? ["exec", prompt, "--sandbox", "workspace-write"]
    : [prompt];
  return { cmd: "codex", args, env: childEnv };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = [];
  const words = [];
  let exec = false;
  let printPrompt = false;
  for (const a of argv) {
    if (a === "--exec") { exec = true; continue; }
    if (a === "--print-prompt") { printPrompt = true; continue; }
    if (a.startsWith("--") || a.startsWith("-")) { flags.push(a); continue; }
    words.push(a);
  }
  return { request: words.join(" ").trim(), flags, exec, printPrompt };
}

function repoRoot() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return process.cwd();
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]conductor\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const out = (s) => process.stdout.write(s);
  const err = (s) => process.stderr.write(s);

  const { request, flags, exec, printPrompt } = parseArgs(process.argv.slice(2));
  if (!request) {
    err(
      'Usage: node conductor.mjs "<what to build>" [--project|--feature|--quick|--plan-only] [--exec] [--print-prompt]\n'
    );
    process.exit(1);
  }

  const pluginRoot = resolvePluginRoot();
  const root = repoRoot();
  const harness = activeHarness(root, { config: resolveHarnessConfig(root) });

  const seshPath = join(pluginRoot, "commands", "bgsd-sesh.md");
  if (!existsSync(seshPath)) {
    err(`conductor: could not find Conductor instructions at ${seshPath}\n`);
    process.exit(1);
  }
  const instructions = readFileSync(seshPath, "utf8");
  const prompt = buildConductorPrompt({ instructions, request, flags, pluginRoot });

  if (printPrompt) { out(prompt + "\n"); process.exit(0); }

  if (harness !== "codex") {
    // Inside Claude Code you already have the real slash command — use it.
    out(
      `\nbgsd Conductor — harness: ${harness}\n` +
      `  You're on the Claude Code harness. Just run the slash command:\n` +
      `    /bgsd-sesh "${request}"${flags.length ? " " + flags.join(" ") : ""}\n` +
      `  (This launcher is for running the Conductor from Codex when Claude Code\n` +
      `   isn't available. Force it with BGSD_HARNESS=codex.)\n\n`
    );
    process.exit(0);
  }

  const spawnSpec = buildConductorSpawn({ harness, prompt, pluginRoot, exec });
  out(
    `\nbgsd Conductor → launching on Codex${exec ? " (exec)" : " (interactive)"}\n` +
    `  plugin root: ${pluginRoot}\n` +
    `  request:     "${request}"${flags.length ? "  flags: " + flags.join(" ") : ""}\n\n`
  );
  const r = spawnSync(spawnSpec.cmd, spawnSpec.args, { cwd: root, stdio: "inherit", env: spawnSpec.env });
  if (r.error) {
    err(
      `\nconductor: failed to launch '${spawnSpec.cmd}': ${r.error.message}\n` +
      `  Is the Codex CLI installed and on your PATH? (https://developers.openai.com/codex/cli)\n\n`
    );
    process.exit(1);
  }
  process.exit(typeof r.status === "number" ? r.status : 0);
}
