#!/usr/bin/env node
/**
 * token-harvest.mjs — read REAL token usage off a harness's own transcript.
 *
 * Claude Code and Codex write disk transcripts; Cursor stream-json can be
 * parsed from captured output. Unknown harnesses return null — never fall
 * through to the Claude parser. Never fabricates usage.
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
  return {
    inputTokens: input + cacheCreation + cacheRead,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    source: "measured",
  };
}

function transcriptCwd(path) {
  for (const line of readLines(path).slice(0, 5)) {
    const obj = parseLine(line);
    if (obj?.cwd) return obj.cwd;
  }
  return null;
}

export function harvestClaudeUsage(cwd, sinceMs) {
  const root = join(homedir(), ".claude", "projects");
  const candidates = recentJsonl(root, sinceMs);
  if (!candidates.length) return null;
  const matched = cwd ? candidates.find((c) => transcriptCwd(c.path) === cwd) : null;
  const chosen = matched ?? candidates[0];
  return sumClaudeTranscript(chosen.path);
}

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
 * Parse Cursor Agent stream-json / JSONL usage events.
 * Only extracts token counts when the schema is known. Never fabricates.
 */
export function parseCursorStreamUsage(textOrLines) {
  const lines = Array.isArray(textOrLines)
    ? textOrLines
    : String(textOrLines ?? "").split("\n").filter(Boolean);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let saw = false;
  let model = null;
  let apiKeySource = null;

  for (const line of lines) {
    const obj = typeof line === "string" ? parseLine(line) : line;
    if (!obj || typeof obj !== "object") continue;

    if (obj.apiKeySource) apiKeySource = obj.apiKeySource;
    if (obj.model && typeof obj.model === "string") model = obj.model;

    const u =
      obj.usage ||
      obj.message?.usage ||
      obj.result?.usage ||
      null;
    if (!u || typeof u !== "object") continue;

    const it = Number(
      u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? 0
    );
    const ot = Number(
      u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? 0
    );
    const cr = Number(
      u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cache_read_tokens ?? 0
    );
    if (!it && !ot && !cr) continue;
    saw = true;
    input += it;
    output += ot;
    cacheRead += cr;
  }

  if (!saw) {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      source: "none",
      model,
      apiKeySource,
    };
  }
  return {
    inputTokens: input + cacheRead,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    source: "measured",
    model,
    apiKeySource,
  };
}

export function harvestCursorUsage(cwd, sinceMs, { streamText } = {}) {
  if (streamText != null) {
    const parsed = parseCursorStreamUsage(streamText);
    if (parsed.source === "measured") return parsed;
    return null;
  }
  const captureCandidates = [];
  if (cwd) {
    captureCandidates.push(join(cwd, ".bgsd", "cursor-stream.jsonl"));
    captureCandidates.push(join(cwd, ".cursor-agent-stream.jsonl"));
  }
  for (const path of captureCandidates) {
    if (existsSync(path)) {
      const parsed = parseCursorStreamUsage(readFileSync(path, "utf8"));
      if (parsed.source === "measured") return parsed;
    }
  }
  const root = join(homedir(), ".cursor", "projects");
  const candidates = recentJsonl(root, sinceMs);
  for (const c of candidates) {
    const parsed = parseCursorStreamUsage(readFileSync(c.path, "utf8"));
    if (parsed.source === "measured") return parsed;
  }
  return null;
}

/**
 * Dispatch by harness. Never throws. Unknown harness → null (not Claude).
 *
 * @param {"claude"|"codex"|"cursor"} harness
 * @param {string} cwd
 * @param {number} sinceMs
 */
export function harvestUsage(harness, cwd, sinceMs, opts = {}) {
  return safe(() => {
    if (harness === "cursor") return harvestCursorUsage(cwd, sinceMs, opts);
    if (harness === "codex") return harvestCodexUsage(cwd, sinceMs);
    if (harness === "claude") return harvestClaudeUsage(cwd, sinceMs);
    return null;
  }, null);
}
