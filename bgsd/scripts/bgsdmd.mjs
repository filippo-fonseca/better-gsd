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
