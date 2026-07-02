#!/usr/bin/env node
/**
 * notify-live.mjs — macOS notification delivery for bgsd escalation events.
 *
 * Delivers notifications via osascript on darwin. No-op on other platforms.
 * NEVER throws: a failed notification must never break the pipeline.
 *
 * Export: deliverNotification({ title, body, platform? })
 *
 * CLI: node notify-live.mjs --title "..." --body "..."
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shouldNotify, composeNotification } from "./notify.mjs";
import { parseBgsdMd, defaultBgsdConfig } from "./init.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

/**
 * Escape a string for safe embedding inside an AppleScript double-quoted string
 * literal. Never interpolates raw user input into a shell command string.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeAppleScript(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Deliver a macOS notification via osascript -e 'display notification ...'.
 *
 * Uses spawnSync with an argv array (never shell-interpolation) so user text
 * cannot escape into the shell. Fails silently on error or non-darwin.
 *
 * @param {object} opts
 * @param {string}  opts.title     Notification title
 * @param {string}  opts.body      Notification body
 * @param {string}  [opts.platform] Override platform check (inject for tests)
 * @returns {boolean} true if delivery was attempted, false if no-op
 */
export function deliverNotification({ title, body, platform } = {}) {
  const plat = platform ?? process.platform;
  if (plat !== "darwin") return false;

  const safeTitle = escapeAppleScript(title);
  const safeBody  = escapeAppleScript(body);

  const script = `display notification "${safeBody}" with title "${safeTitle}"`;

  try {
    spawnSync("osascript", ["-e", script], { timeout: 5000 });
  } catch (_) {
    // Fail silent — a notification failure must never break the pipeline.
  }

  return true;
}

/**
 * Read the bgsd config from .bgsd/config.json (if present), falling back to
 * BGSD.md, then to defaults. Defensive: never throws.
 *
 * @param {string} [repoRoot]
 * @returns {object}
 */
function readBgsdConfig(repoRoot) {
  const root = repoRoot ?? REPO_ROOT;
  try {
    const configPath = join(root, ".bgsd", "config.json");
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf8"));
    }
    const bgsdMdPath = join(root, "BGSD.md");
    if (existsSync(bgsdMdPath)) {
      return parseBgsdMd(readFileSync(bgsdMdPath, "utf8"));
    }
  } catch (_) {
    // Fall through to defaults.
  }
  return defaultBgsdConfig();
}

/**
 * Read the Conductor's display identity from BGSD.md (mirrors gui-live.mjs).
 * Defaults to Kiwi/🥝.
 *
 * @param {string} [repoRoot]
 * @returns {{ name: string, emoji: string }}
 */
function readConductorIdentity(repoRoot) {
  const root = repoRoot ?? REPO_ROOT;
  try {
    const p = join(root, "BGSD.md");
    if (existsSync(p)) {
      const cfg = parseBgsdMd(readFileSync(p, "utf8"));
      return {
        name:  cfg?.conductor?.name  || "Kiwi",
        emoji: cfg?.conductor?.emoji || "🥝",
      };
    }
  } catch (_) { /* fall through */ }
  return { name: "Kiwi", emoji: "🥝" };
}

/**
 * Gate-and-deliver: check config, compose, and deliver a notification for an
 * escalation event. The primary wiring point used by control-live callers.
 *
 * @param {object} event          { type: "needs_input"|"escalation", agentId?, question? }
 * @param {object} [opts]
 * @param {string}   [opts.repoRoot]   Override repo root (default: auto-detected)
 * @param {object}   [opts.config]     Override bgsd config (avoids re-reading disk)
 * @param {object}   [opts.conductor]  Override conductor identity
 * @param {Function} [opts.deliverFn]  Override delivery fn (for tests)
 * @returns {boolean} true if notification was delivered
 */
export function notifyEscalation(event, {
  repoRoot,
  config,
  conductor,
  deliverFn,
} = {}) {
  try {
    const cfg  = config    ?? readBgsdConfig(repoRoot);
    const cond = conductor ?? readConductorIdentity(repoRoot);

    if (!shouldNotify(cfg, event?.type ?? "")) return false;

    const { title, body } = composeNotification(event, cond);
    const deliver = typeof deliverFn === "function" ? deliverFn : deliverNotification;
    return deliver({ title, body });
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI: node notify-live.mjs --title "..." --body "..."
// ---------------------------------------------------------------------------

const isCLI = import.meta.url === new URL(
  process.argv[1],
  import.meta.url.startsWith("file://") ? import.meta.url : `file://${process.cwd()}/`
).href;

if (isCLI) {
  const args  = process.argv.slice(2);
  function flag(name) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  }
  const title = flag("title");
  const body  = flag("body");
  if (!title && !body) {
    process.stderr.write("Usage: node notify-live.mjs --title \"...\" --body \"...\"\n");
    process.exit(1);
  }
  const delivered = deliverNotification({ title: title ?? "", body: body ?? "" });
  process.stdout.write(delivered ? "delivered\n" : "no-op (non-darwin)\n");
  process.exit(0);
}
