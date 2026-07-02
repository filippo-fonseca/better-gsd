#!/usr/bin/env node
/**
 * bgsdmd.mjs — Kiwi self-edits its own BGSD.md settings + preferences, and
 * maintains a bgsd memory store.
 *
 * Intuitive, like Claude Code with CLAUDE.md + auto-memory: tell Kiwi a setting
 * or preference in chat ("verifier should never be haiku", "always ask before
 * deleting files") and Kiwi persists it here and reports what it wrote. Settings
 * go into the BGSD.md json block; prose preferences go under "## Notes"; durable
 * facts go into .bgsd/memory/.
 *
 * Pure text transforms + DI fs (the live wrappers read/write the real files).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseBgsdMd } from "./init.mjs";

const SETTINGS_FENCE = /```json bgsd-settings\n([\s\S]*?)\n```/;

/** Deep-set a dotted path on a clone of `config`; returns { config, oldValue }. */
export function setConfigValue(config, dotPath, value) {
  const keys = String(dotPath).split(".");
  const out = structuredClone(config);
  let node = out;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== "object" || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  const oldValue = node[last];
  node[last] = value;
  return { config: out, oldValue };
}

/** Surgically update one setting in BGSD.md text, preserving ALL prose. */
export function applySetting(text, dotPath, value) {
  const config = parseBgsdMd(text);
  const { config: next, oldValue } = setConfigValue(config, dotPath, value);
  const block = "```json bgsd-settings\n" + JSON.stringify(next, null, 2) + "\n```";
  const text2 = SETTINGS_FENCE.test(text)
    ? text.replace(SETTINGS_FENCE, block)
    : `${text.replace(/\s*$/, "")}\n\n${block}\n`;
  return { text: text2, dotPath, oldValue, newValue: value };
}

/** Append a prose preference under "## Notes" (creating the section if absent). */
export function appendPreference(text, note) {
  const bullet = `- ${String(note).trim()}`;
  if (/##\s*Notes/.test(text)) {
    return text.replace(/(##\s*Notes[^\n]*\n)/, `$1\n${bullet}\n`);
  }
  return `${text.replace(/\s*$/, "")}\n\n## Notes\n\n${bullet}\n`;
}

export function slugifyName(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "note"
  );
}

// ---------------------------------------------------------------------------
// Live wrappers
// ---------------------------------------------------------------------------

function writeAtomic(p, s) {
  const t = p + ".tmp";
  writeFileSync(t, s, "utf8");
  renameSync(t, p);
}

/** Read BGSD.md, set a setting, write it back. Returns the change report. */
export function editSettingLive(repoRoot, dotPath, value) {
  const p = join(repoRoot, "BGSD.md");
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  const res = applySetting(text, dotPath, value);
  writeAtomic(p, res.text);
  return res;
}

/** Read BGSD.md, append a prose preference, write it back. */
export function addPreferenceLive(repoRoot, note) {
  const p = join(repoRoot, "BGSD.md");
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  writeAtomic(p, appendPreference(text, note));
  return { note: String(note).trim() };
}

/** Persist a durable memory note under .bgsd/memory/. */
export function rememberLive(bgsdDir, name, content) {
  const dir = join(bgsdDir, "memory");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slugifyName(name)}.md`);
  writeAtomic(file, content.endsWith("\n") ? content : content + "\n");
  return { file };
}

// ---------------------------------------------------------------------------
// CLI — the front door for /bgsd-modify-memory
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]bgsdmd\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const [sub, ...rest] = process.argv.slice(2);
  const out = (s) => process.stdout.write(s);

  const repoRoot = (() => {
    try {
      const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
      return r.status === 0 && r.stdout ? r.stdout.trim() : process.cwd();
    } catch (_) {
      return process.cwd();
    }
  })();

  try {
    if (sub === "set") {
      const dotPath = rest[0];
      const raw = rest.slice(1).join(" ");
      if (!dotPath || raw === "") {
        process.stderr.write('Usage: bgsdmd.mjs set <dot.path> <value>\n');
        process.exit(1);
      }
      let value;
      try { value = JSON.parse(raw); } catch (_) { value = raw; } // "true"->bool, "3"->num, else string
      const res = editSettingLive(repoRoot, dotPath, value);
      out(`\nBGSD.md: ${dotPath}  ${JSON.stringify(res.oldValue)} -> ${JSON.stringify(res.newValue)}\n\n`);
    } else if (sub === "remember") {
      const note = rest.join(" ").trim();
      if (!note) { process.stderr.write('Usage: bgsdmd.mjs remember "<preference>"\n'); process.exit(1); }
      addPreferenceLive(repoRoot, note);
      out(`\nBGSD.md Notes += "${note}"\n\n`);
    } else if (sub === "show") {
      const p = join(repoRoot, "BGSD.md");
      out(existsSync(p) ? readFileSync(p, "utf8") : "(no BGSD.md yet — run /bgsd-init)\n");
    } else {
      process.stderr.write('Usage:\n  bgsdmd.mjs set <dot.path> <value>\n  bgsdmd.mjs remember "<preference>"\n  bgsdmd.mjs show\n');
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`bgsdmd: ${err.message}\n`);
    process.exit(1);
  }
}
