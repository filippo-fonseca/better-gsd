#!/usr/bin/env node
/**
 * token-harvest.mjs — read REAL token usage off a harness's own transcript.
 *
 * bgsd spawns coding agents with `stdio: "inherit"` so the live colorful
 * terminal is untouched. To learn what a spawn actually cost WITHOUT spending
 * any tokens of our own, we read the transcript the harness already wrote to
 * disk after the subprocess exits and sum the usage numbers. Pure file parsing:
 * no model call, no re-reading, no extra spend.
 *
 * Claude Code writes one JSONL session file per `-p` run under
 *   ~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl
 * where each assistant line carries `message.usage` for that turn. Each turn is
 * a separately-billed API call, so summing per-turn tokens across turns is the
 * accurate total (cached input is genuinely re-billed at the cache rate each
 * turn). We locate the file by cwd + mtime rather than reconstructing the
 * sanitized folder name, which is more robust to Claude's path encoding.
 *
 * Codex harvesting is best-effort (rollout logs under ~/.codex/sessions); when
 * a transcript can't be found or parsed we return null and the caller records
 * model/effort with no token numbers (source "none") — never throws.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_) {
    return fallback;
  }
}

/** All *.jsonl files under a dir tree with mtimeMs >= sinceMs, newest first. */
function recentJsonl(root, sinceMs) {
  if (!existsSync(root)) return [];
  const hits = [];
  const walk = (dir) => {
    for (const d of safe(() => readdirSync(dir, { withFileTypes: true }), [])) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && d.name.endsWith(".jsonl")) {
        const m = safe(() => statSync(p).mtimeMs, 0);
        if (m >= sinceMs) hits.push({ path: p, mtime: m });
      }
    }
  };
  walk(root);
  return hits.sort((a, b) => b.mtime - a.mtime);
}

function readLines(path) {
  return safe(() => readFileSync(path, "utf8"), "").split("\n").filter(Boolean);
}

function parseLine(line) {
  return safe(() => JSON.parse(line), null);
}

/**
 * Sum usage across every assistant turn in a Claude Code JSONL transcript.
 * Returns null when the file has no usable usage rows.
 */
function sumClaudeTranscript(path) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let saw = false;
  for (const line of readLines(path)) {
    const obj = parseLine(line);
    const u = obj?.message?.usage ?? obj?.usage;
    if (!u) continue;
    saw = true;
    input += Number(u.input_tokens || 0);
    output += Number(u.output_tokens || 0);
    cacheRead += Number(u.cache_read_input_tokens || 0);
    cacheCreation += Number(u.cache_creation_input_tokens || 0);
  }
  if (!saw) return null;
  // tokens.mjs treats cacheReadTokens as a SUBSET of inputTokens (it nets it
  // out at the discounted rate), so fold every input bucket into inputTokens.
  return {
    inputTokens: input + cacheCreation + cacheRead,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    source: "measured",
  };
}

/** True when a transcript's first line reports the given cwd. */
function transcriptCwd(path) {
  for (const line of readLines(path).slice(0, 5)) {
    const obj = parseLine(line);
    if (obj?.cwd) return obj.cwd;
  }
  return null;
}

/**
 * Harvest Claude Code usage for a subprocess that ran in `cwd`, started at or
 * after `sinceMs`. Prefers the newest transcript whose recorded cwd matches;
 * falls back to the newest recent transcript. Returns null if none found.
 */
export function harvestClaudeUsage(cwd, sinceMs) {
  const root = join(homedir(), ".claude", "projects");
  const candidates = recentJsonl(root, sinceMs);
  if (!candidates.length) return null;
  const matched = cwd ? candidates.find((c) => transcriptCwd(c.path) === cwd) : null;
  const chosen = matched ?? candidates[0];
  return sumClaudeTranscript(chosen.path);
}

/**
 * Harvest Codex usage — best-effort. Codex rollout logs vary by version; we
 * look for token_count/usage-shaped fields and sum them, else return null.
 */
export function harvestCodexUsage(cwd, sinceMs) {
  const root = join(homedir(), ".codex", "sessions");
  const candidates = recentJsonl(root, sinceMs);
  if (!candidates.length) return null;
  const path = candidates[0].path;
  let input = 0;
  let output = 0;
  let saw = false;
  for (const line of readLines(path)) {
    const obj = parseLine(line);
    const u = obj?.usage ?? obj?.token_usage ?? obj?.info?.token_usage;
    if (!u) continue;
    const it = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
    const ot = Number(u.output_tokens ?? u.completion_tokens ?? 0);
    if (!it && !ot) continue;
    saw = true;
    input += it;
    output += ot;
  }
  if (!saw) return null;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, source: "measured" };
}

/**
 * Dispatch by harness. Never throws — returns null when nothing is harvestable
 * so the caller can still record model/effort (source "none").
 *
 * @param {"claude"|"codex"} harness
 * @param {string} cwd       the worktree the subprocess ran in
 * @param {number} sinceMs   Date.now() captured just before the spawn
 */
export function harvestUsage(harness, cwd, sinceMs) {
  return safe(
    () => (harness === "codex" ? harvestCodexUsage(cwd, sinceMs) : harvestClaudeUsage(cwd, sinceMs)),
    null
  );
}
