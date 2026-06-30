#!/usr/bin/env node
/**
 * gsdinstall-live.mjs — real seam for ensuring gsd-core (Claude Code plugin)
 *
 * Wires the actual Claude Code plugin CLI into the pure ensureGsd (gsdinstall.mjs)
 * and guards the mutating commands (install/update) behind --live, mirroring
 * init-live.mjs / run-live.mjs. Without --live it prints a read-only PLAN (what
 * it WOULD do); with --live it performs install/update.
 *
 * COMMANDS (researched against open-gsd/gsd-core + Claude Code 2.1.x, 2026-06)
 * ===========================================================================
 * gsd-core ships a `.claude-plugin/plugin.json` (commands `/gsd-core:*`), so the
 * PREFERRED path is the native Claude Code plugin system:
 *
 *   DETECT:  claude plugin list --json
 *            -> parse JSON; gsd-core is present iff some entry's `id` is
 *               "gsd-core" or starts with "gsd-core@<marketplace>".
 *            Fully non-interactive.
 *
 *   INSTALL: claude plugin marketplace add open-gsd/gsd-core   (idempotent: adds
 *               the repo as a marketplace; gsd-core ships its own plugin.json)
 *            claude plugin install gsd-core --scope user       (per gsd-core docs)
 *            Both non-interactive; `marketplace add` is a no-op if already added.
 *
 *   UPDATE:  claude plugin update gsd-core --scope user
 *            Non-interactive. (Claude Code notes a restart is needed to APPLY a
 *            plugin update; the command itself returns immediately.)
 *
 * FALLBACK (npx): the same system also publishes the npm package
 *   `@opengsd/gsd-core` (installer `npx @opengsd/gsd-core@latest`). We do NOT use
 *   it here because its installer is INTERACTIVE — it prompts for runtime
 *   (Claude Code / OpenCode / Gemini / ...) and global-vs-local — so it can hang
 *   a non-interactive sesh. The Claude Code plugin path above is preferred and
 *   non-interactive; the npx route is the documented manual fallback only.
 *   (Note: the deprecated `get-shit-done-cc` npm package under the old `gsd-build`
 *   org is unrelated to the current open-gsd/gsd-core plugin.)
 *
 * Usage (CLI):
 *   node gsdinstall-live.mjs                  # preview the plan (no changes)
 *   node gsdinstall-live.mjs --live           # ensure gsd-core (install/update)
 *   node gsdinstall-live.mjs --live --policy never   # install-if-missing only
 */

import { spawnSync } from "node:child_process";

import { ensureGsd, gsdEnsurePlan, DEFAULT_UPDATE_POLICY } from "./gsdinstall.mjs";

// ---------------------------------------------------------------------------
// gsd-core identity (the Claude Code plugin name + its marketplace source)
// ---------------------------------------------------------------------------

export const GSD_PLUGIN_NAME = "gsd-core";
/** The repo that ships `.claude-plugin/plugin.json`, added as a marketplace. */
export const GSD_MARKETPLACE_SOURCE = "open-gsd/gsd-core";

// ---------------------------------------------------------------------------
// Live-flag guard (mirrors init-live.mjs / run-live.mjs)
// ---------------------------------------------------------------------------

export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
        "======================================================================\n" +
        "  bgsd-gsdinstall: refusing to install/update gsd-core without --live.\n" +
        "  This runs `claude plugin install/update gsd-core` on your machine.\n" +
        "  Re-run with --live to apply, or omit it to preview the plan.\n" +
        "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/** Run `claude <args...>` non-interactively; return {code, stdout, stderr}. */
function claude(args) {
  const r = spawnSync("claude", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    error: r.error,
  };
}

/** True iff `id` names the gsd-core plugin ("gsd-core" or "gsd-core@<market>"). */
function idIsGsdCore(id) {
  if (typeof id !== "string") return false;
  return id === GSD_PLUGIN_NAME || id.startsWith(`${GSD_PLUGIN_NAME}@`);
}

// ---------------------------------------------------------------------------
// DETECT (read-only — no guard needed)
// ---------------------------------------------------------------------------

/**
 * Detect whether gsd-core is installed in the user's Claude Code, by parsing
 * `claude plugin list --json` and matching the plugin id. Read-only, fully
 * non-interactive. Returns false (and never throws) if the CLI is missing or
 * the output is unparseable, so a sesh degrades to "install" rather than crash.
 */
export function isGsdInstalled() {
  const r = claude(["plugin", "list", "--json"]);
  if (r.code !== 0 || !r.stdout) return false;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (_) {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((p) => p && idIsGsdCore(p.id ?? p.name));
}

// ---------------------------------------------------------------------------
// INSTALL / UPDATE (real side effects — guarded by --live)
// ---------------------------------------------------------------------------

/**
 * Install gsd-core via the Claude Code plugin system (preferred, non-interactive):
 *   1. `claude plugin marketplace add open-gsd/gsd-core`  (idempotent)
 *   2. `claude plugin install gsd-core --scope user`
 * Guarded by --live. Throws on failure so the sesh surfaces it (no silent green).
 */
export function installGsd({ log } = {}) {
  requireLiveFlag();
  const say = log ?? (() => {});

  say(`adding marketplace ${GSD_MARKETPLACE_SOURCE}`);
  const add = claude(["plugin", "marketplace", "add", GSD_MARKETPLACE_SOURCE]);
  // `marketplace add` is idempotent; only a hard CLI failure (not "already
  // added") should abort. We don't fail the whole step on a non-zero here
  // because re-adding an existing marketplace returns non-zero on some builds;
  // the install step below is the real gate.
  if (add.error) {
    throw new Error(`claude plugin marketplace add failed to spawn: ${add.error.message}`);
  }

  say(`installing ${GSD_PLUGIN_NAME}`);
  const inst = claude(["plugin", "install", GSD_PLUGIN_NAME, "--scope", "user"]);
  if (inst.code !== 0) {
    throw new Error(
      `claude plugin install ${GSD_PLUGIN_NAME} failed (exit ${inst.code}): ${
        inst.stderr || inst.stdout || "no output"
      }`
    );
  }
}

/**
 * Update gsd-core to latest via `claude plugin update gsd-core --scope user`.
 * Non-interactive (a restart is required to APPLY the update, but the command
 * returns immediately). Guarded by --live. Throws on failure.
 */
export function updateGsd({ log } = {}) {
  requireLiveFlag();
  const say = log ?? (() => {});
  say(`updating ${GSD_PLUGIN_NAME} to latest`);
  const upd = claude(["plugin", "update", GSD_PLUGIN_NAME, "--scope", "user"]);
  if (upd.code !== 0) {
    throw new Error(
      `claude plugin update ${GSD_PLUGIN_NAME} failed (exit ${upd.code}): ${
        upd.stderr || upd.stdout || "no output"
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Deps builder + sesh entrypoint
// ---------------------------------------------------------------------------

/** Build the real deps for ensureGsd (detection is always live; mutations guarded). */
export function liveDeps({ log, updatePolicy } = {}) {
  return {
    isInstalled: () => isGsdInstalled(),
    install: () => installGsd({ log }),
    update: () => updateGsd({ log }),
    log: log ?? (() => {}),
    updatePolicy: updatePolicy ?? DEFAULT_UPDATE_POLICY,
  };
}

/**
 * Sesh preflight: ensure gsd-core is installed + (per policy) current using the
 * real Claude Code plugin CLI. Called at the start of every /bgsd-sesh so the
 * user's gsd-core is never missing or stale. Mutations require --live.
 */
export function ensureGsdLive({ log, updatePolicy } = {}) {
  return ensureGsd(liveDeps({ log, updatePolicy }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readPolicyArg() {
  const i = process.argv.indexOf("--policy");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return DEFAULT_UPDATE_POLICY;
}

export function main() {
  const out = (s) => process.stdout.write(s);
  const updatePolicy = readPolicyArg();

  if (!isLiveFlagSet()) {
    const installed = isGsdInstalled();
    const actions = gsdEnsurePlan({ installed, updatePolicy });
    out(`\nbgsd-gsdinstall preview — plugin: ${GSD_PLUGIN_NAME}\n`);
    out(`  marketplace source:  ${GSD_MARKETPLACE_SOURCE}\n`);
    out(`  currently installed: ${installed ? "yes" : "no"}\n`);
    out(`  update policy:       ${updatePolicy}\n`);
    out(`  planned actions:     ${actions.length ? actions.join(", ") : "(none)"}\n`);
    out(`\n  Re-run with --live to apply.\n`);
    return;
  }

  requireLiveFlag();
  const res = ensureGsdLive({ log: (m) => out(`  ${m}\n`), updatePolicy });
  out(`\nbgsd-gsdinstall complete — plugin: ${GSD_PLUGIN_NAME}\n`);
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
