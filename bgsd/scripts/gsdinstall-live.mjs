#!/usr/bin/env node
/**
 * gsdinstall-live.mjs — real seam for ensuring gsd-core (the bgsd engine)
 *
 * bgsd is "gsd-agnostic": it does NOT vendor GSD. It drives the user's own
 * `gsd-core` install, and the Conductor ENSURES gsd-core is present + current at
 * the start of every sesh, out of the box, with no manual step. This file is the
 * real side-effect seam wired into the pure ensureGsd (gsdinstall.mjs).
 *
 * DISTRIBUTION (researched + verified against @opengsd/gsd-core v1.6.x, 2026-06)
 * ===========================================================================
 * gsd-core is NOT a Claude Code plugin (the open-gsd/gsd-core repo has no plugin
 * marketplace), so `claude plugin list` will never show it. It is the npm package
 * `@opengsd/gsd-core`, installed by its own CLI installer:
 *
 *   INSTALL/UPDATE (same command):
 *     npx -y @opengsd/gsd-core@latest --claude --global
 *
 *   `--claude` selects the Claude Code runtime and `--global` selects the global
 *   config directory, so the installer runs with NO prompts (fully
 *   non-interactive). Re-running the same command installs OR updates to latest:
 *   install and update are literally the same invocation.
 *
 *   DETECT: the installer writes the `/gsd-*` slash-commands into the user's
 *   global Claude Code config directory as skill folders (e.g.
 *   `skills/gsd-help/SKILL.md`, `skills/gsd-new-project/SKILL.md`) plus a
 *   `gsd-install-state.json` marker at the config-dir root. Detection is purely
 *   filesystem-based: we look for those known gsd command files under the config
 *   dir. This is dependency-injected so tests can point it at a temp dir.
 *
 * The global config directory is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`
 * (the same resolution Claude Code itself uses).
 *
 * NO --live GUARD ON MUTATIONS
 * ============================
 * Unlike init-live.mjs / run-live.mjs, install/update here are NOT gated behind
 * --live. The whole point is that they run automatically at sesh start. They are
 * safe, idempotent setup actions (an npm installer writing into the user's own
 * Claude config), not an irreversible repo mutation. They throw on a non-zero
 * exit so a failed install surfaces (no silent green).
 *
 * Usage (CLI):
 *   node gsdinstall-live.mjs                  # preview the plan (no changes)
 *   node gsdinstall-live.mjs --ensure         # ensure gsd-core (install/update)
 *   node gsdinstall-live.mjs --ensure --policy never   # install-if-missing only
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { ensureGsd, gsdEnsurePlan, DEFAULT_UPDATE_POLICY } from "./gsdinstall.mjs";

// ---------------------------------------------------------------------------
// gsd-core identity (the npm package + its install command)
// ---------------------------------------------------------------------------

/** The npm package that distributes gsd-core (installed via its CLI installer). */
export const GSD_NPM_PACKAGE = "@opengsd/gsd-core";

/** The versioned spec passed to npx so install/update always lands on latest. */
export const GSD_NPM_SPEC = `${GSD_NPM_PACKAGE}@latest`;

/**
 * The single non-interactive install/update command. `--claude` picks the Claude
 * Code runtime and `--global` picks the global config dir, so there are no
 * prompts. Re-running it updates to latest (install === update).
 */
export const GSD_RUNTIMES = Object.freeze(["claude", "codex", "cursor"]);
export function gsdInstallArgs(runtime = "claude") {
  if (!GSD_RUNTIMES.includes(runtime)) throw new Error(`unsupported GSD runtime: ${runtime}`);
  return ["-y", GSD_NPM_SPEC, `--${runtime}`, "--global"];
}
export const GSD_INSTALL_ARGS = gsdInstallArgs("claude");

/**
 * Known gsd command files the installer writes under the global config dir. We
 * only need ONE of these to exist to consider gsd-core installed. These are the
 * `/gsd-*` slash-commands, shipped as skill folders.
 */
export const GSD_COMMAND_MARKERS = [
  join("skills", "gsd-help", "SKILL.md"),
  join("skills", "gsd-new-project", "SKILL.md"),
  // Root-level state file the installer maintains; a useful secondary marker.
  "gsd-install-state.json",
];

// ---------------------------------------------------------------------------
// Config-dir resolution (matches Claude Code: $CLAUDE_CONFIG_DIR, else ~/.claude)
// ---------------------------------------------------------------------------

/**
 * Resolve the global Claude Code config directory that gsd-core `--global`
 * writes into: `$CLAUDE_CONFIG_DIR` when set and non-empty, otherwise
 * `~/.claude`. Injectable env/home keep this testable against a temp dir.
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env=process.env]
 * @param {()=>string} [opts.home=homedir]
 * @returns {string} absolute path to the global config dir
 */
export function resolveClaudeConfigDir({ env = process.env, home = homedir } = {}) {
  const fromEnv = env && env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join(home(), ".claude");
}

export function resolveCodexConfigDir({ env = process.env, home = homedir } = {}) {
  const fromEnv = env && env.CODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join(home(), ".codex");
}

export function resolveCursorConfigDir({ env = process.env, home = homedir } = {}) {
  const fromEnv = env && env.CURSOR_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join(home(), ".cursor");
}

export function resolveRuntimeConfigDir(runtime = "claude", opts = {}) {
  if (runtime === "codex") return resolveCodexConfigDir(opts);
  if (runtime === "cursor") return resolveCursorConfigDir(opts);
  return resolveClaudeConfigDir(opts);
}

// ---------------------------------------------------------------------------
// DETECT (read-only, filesystem-based — no guard needed)
// ---------------------------------------------------------------------------

/**
 * Detect whether gsd-core is installed by checking the filesystem for any known
 * gsd command file under the global Claude Code config dir. gsd-core is NOT a
 * Claude Code plugin, so we do NOT consult `claude plugin list`.
 *
 * Dependency-injected for tests: pass a `configDir` (e.g. a temp dir) and/or a
 * custom `exists` predicate. Never throws; returns false on any I/O hiccup so a
 * sesh degrades to "install" rather than crashing.
 *
 * @param {object} [opts]
 * @param {string} [opts.configDir]  override the resolved config dir (tests)
 * @param {(p:string)=>boolean} [opts.exists=existsSync]  fs probe (tests)
 * @param {Record<string,string|undefined>} [opts.env]   env for config-dir resolution
 * @param {()=>string} [opts.home]   home() for config-dir resolution
 * @returns {boolean}
 */
export function isGsdInstalled(opts = {}) {
  const exists = opts.exists ?? existsSync;
  const runtime = opts.runtime ?? "claude";
  const configDir =
    opts.configDir ?? resolveRuntimeConfigDir(runtime, { env: opts.env, home: opts.home });
  try {
    return GSD_COMMAND_MARKERS.some((rel) => {
      try {
        return exists(join(configDir, rel));
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// INSTALL / UPDATE (real side effects — safe, idempotent, NOT --live-gated)
// ---------------------------------------------------------------------------

/**
 * Run the gsd-core installer non-interactively. install and update are the same
 * command; `which` only changes the narration. Streams the installer's output
 * (stdio:"inherit") so the user sees real progress. Throws on a non-zero exit or
 * a spawn error so a failed setup is never silently swallowed.
 *
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]   narration sink
 * @param {(cmd:string,args:string[],o:object)=>{status:number|null,error?:Error}} [opts.spawn]
 *        injectable spawnSync (tests pass a stub so no real npx runs)
 * @param {"install"|"update"} [which="install"]
 */
function runGsdInstaller({ log, spawn, runtime = "claude" } = {}, which = "install") {
  const say = log ?? (() => {});
  const run = spawn ?? spawnSync;
  const args = gsdInstallArgs(runtime);
  say(
    which === "update"
      ? `updating ${GSD_NPM_PACKAGE} for ${runtime} (npx ${args.join(" ")})`
      : `installing ${GSD_NPM_PACKAGE} for ${runtime} (npx ${args.join(" ")})`
  );
  const r = run("npx", args, { stdio: "inherit", encoding: "utf8" });
  if (r && r.error) {
    throw new Error(`npx ${GSD_NPM_SPEC} failed to spawn: ${r.error.message}`);
  }
  const code = r ? r.status ?? 1 : 1;
  if (code !== 0) {
    throw new Error(
      `npx ${GSD_NPM_SPEC} --${runtime} --global ${which} failed (exit ${code})`
    );
  }
}

/**
 * Install gsd-core (out of the box, no prompts). Throws on failure.
 * @param {object} [opts] see runGsdInstaller
 */
export function installGsd(opts = {}) {
  runGsdInstaller(opts, "install");
}

/**
 * Update gsd-core to latest. Same command as install (re-running installs latest).
 * Throws on failure.
 * @param {object} [opts] see runGsdInstaller
 */
export function updateGsd(opts = {}) {
  runGsdInstaller(opts, "update");
}

// ---------------------------------------------------------------------------
// Deps builder + sesh entrypoint
// ---------------------------------------------------------------------------

/** Build the real deps for ensureGsd. Detection + mutations all use the real fs/npx. */
export function liveDeps({ log, updatePolicy, configDir, runtime = "claude" } = {}) {
  return {
    isInstalled: () => isGsdInstalled({ configDir, runtime }),
    install: () => installGsd({ log, runtime }),
    update: () => updateGsd({ log, runtime }),
    log: log ?? (() => {}),
    updatePolicy: updatePolicy ?? DEFAULT_UPDATE_POLICY,
  };
}

/**
 * Sesh preflight: ensure gsd-core is installed + (per policy) current using the
 * real npx installer. Called at the start of every /bgsd-sesh so the user's
 * gsd-core engine is never missing or stale, automatically.
 */
export function ensureGsdLive({ log, updatePolicy, configDir, runtime = "claude" } = {}) {
  return ensureGsd(liveDeps({ log, updatePolicy, configDir, runtime }));
}

export function ensureGsdRuntimesLive(runtimes, opts = {}) {
  const result = {};
  for (const runtime of [...new Set(runtimes)]) result[runtime] = ensureGsdLive({ ...opts, runtime });
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readPolicyArg() {
  const i = process.argv.indexOf("--policy");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return DEFAULT_UPDATE_POLICY;
}

function readRuntimeArg() {
  const i = process.argv.indexOf("--runtime");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "claude";
}

/** --ensure (or legacy --live) actually performs install/update; default previews. */
function isEnsureRequested() {
  return process.argv.includes("--ensure") || process.argv.includes("--live");
}

export function main() {
  const out = (s) => process.stdout.write(s);
  const updatePolicy = readPolicyArg();
  const runtime = readRuntimeArg();
  const configDir = resolveRuntimeConfigDir(runtime);

  if (!isEnsureRequested()) {
    const installed = isGsdInstalled({ configDir, runtime });
    const actions = gsdEnsurePlan({ installed, updatePolicy });
    out(`\nbgsd-gsdinstall preview — package: ${GSD_NPM_PACKAGE}\n`);
    out(`  runtime:             ${runtime}\n`);
    out(`  install command:     npx ${gsdInstallArgs(runtime).join(" ")}\n`);
    out(`  config dir:          ${configDir}\n`);
    out(`  currently installed: ${installed ? "yes" : "no"}\n`);
    out(`  update policy:       ${updatePolicy}\n`);
    out(`  planned actions:     ${actions.length ? actions.join(", ") : "(none)"}\n`);
    out(`\n  Re-run with --ensure to apply.\n`);
    return;
  }

  const res = ensureGsdLive({ log: (m) => out(`  ${m}\n`), updatePolicy, configDir, runtime });
  out(`\nbgsd-gsdinstall complete — package: ${GSD_NPM_PACKAGE}\n`);
  out(`  installed:      ${res.installed ? "yes" : "no"}\n`);
  out(`  performed:      ${res.performed.length ? res.performed.join(", ") : "(none)"}\n`);
  out(`  already current:${res.alreadyCurrent ? " yes" : " no"}\n`);
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  /[\\/]gsdinstall-live\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
