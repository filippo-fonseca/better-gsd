#!/usr/bin/env node
/**
 * context.mjs — Phase 8: Conductor Context Management (CTX-01..03)
 *
 * Guarantees context never overflows. Three responsibilities:
 *
 *   1. CONTEXT-PRESSURE MONITOR (CTX-02)
 *      A deterministic estimator that maps accumulated message + tool-output
 *      size (byte proxies for token counts) to a pressure level:
 *        normal   — well within the window
 *        elevated — approaching the limit; consider proactive compaction
 *        critical — at or above the limit; must compact/clear/re-launch NOW
 *      Thresholds are configurable per model context size so large/1M-context
 *      models get proportionally higher limits (NFR-09, DEF-10). A companion
 *      decision function maps pressure → action:
 *        normal   → "continue"
 *        elevated → "compact"
 *        critical → "clear+relaunch"
 *
 *   2. POINTERS-NOT-BLOBS HANDOFF (CTX-01)
 *      A handoff helper where an agent hands off by writing REFERENCES (file
 *      paths, run-dir artifacts, control-file pointers) to a small JSON
 *      pointer manifest, not inlining large content — so re-launched / compacted
 *      agents reload from disk, not from a bloated transcript. Reuses the
 *      control.mjs `inbox_path`-style pointer idiom (NFR-09).
 *
 *   3. SHARED RESEARCH / PROMPT CACHE (CTX-03)
 *      A content-addressed cache: SHA-256(key) → .bgsd/cache/<hash>.json
 *      Atomic writes (temp-then-rename, POSIX-atomic). Parallel worktrees
 *      that research the same stack question hit the cache on the second
 *      request and never pay twice (NFR-05/09).
 *
 *   4. GUARDED LIVE BOUNDARY (mirrors loop1-live.mjs / run-live.mjs)
 *      Functions that actually invoke CC compaction or re-spawn an agent
 *      process refuse without --live. The decision logic (what to do) is
 *      always available; only the execution (doing it) is gated.
 *
 * DESIGN PRINCIPLES
 * =================
 * - Pure / injectable: all functions accept injected clocks, sizes, fs
 *   helpers — no hidden globals so tests can drive every branch.
 * - No model calls, no process spawning in this module (NFR-05). The live
 *   compact/re-launch seam is the only exception and is gated behind --live.
 * - Atomic writes throughout: write-to-tmp then rename (NFR-06: no half-written).
 * - No external dependencies: Node 18+ built-ins only.
 *
 * Usage (library):
 *   import {
 *     // pressure monitor
 *     estimatePressure, pressureDecision,
 *     DEFAULT_CONTEXT_THRESHOLDS, makeThresholds, thresholdsFromConfig,
 *     // poll-loop decision dispatch (dependency-injected)
 *     decideContextAction, runContextTick,
 *     // pointers-not-blobs handoff
 *     writeHandoffManifest, readHandoffManifest,
 *     // shared cache
 *     cacheKey, cacheGet, cachePut, cacheHas,
 *     // live boundary (guarded)
 *     isLiveFlagSet, requireLiveFlag,
 *     liveCompact, liveRelaunch,
 *   } from './context.mjs';
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { activeLane, buildAgentSpawn } from "./harness.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (mirrors loop1-live.mjs / run-live.mjs exactly) — CTX-02
// ---------------------------------------------------------------------------

/**
 * Check whether --live was explicitly passed on the command line.
 * Returns true only if "--live" appears in process.argv.
 *
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to execute the live compaction / re-launch seam unless --live is set.
 * Called by every exported live function (liveCompact, liveRelaunch).
 *
 * @throws {Error} if --live is not in process.argv
 */
export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: context.mjs live boundary refused to run.\n" +
      "\n" +
      "The live compaction / agent re-launch path requires an explicit\n" +
      "--live flag to prevent accidental automation (NFR-08, CTX-02).\n" +
      "\n" +
      "To run this supervised:\n" +
      "  node bgsd/scripts/context.mjs --live [options]\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts.\n" +
      "  - Run this against the 'next' branch (NFR-01).\n" +
      "  - Run this without a human watching the terminal.\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Context-pressure monitor — CTX-02
// ---------------------------------------------------------------------------

/**
 * Pressure level values.
 * normal   — well within the window; continue work.
 * elevated — approaching the limit; compact proactively.
 * critical — at or above the limit; must compact/clear/re-launch NOW.
 */
export const PRESSURE_LEVELS = Object.freeze(["normal", "elevated", "critical"]);

/**
 * Actions the decision function maps pressure levels to.
 * continue       — no action needed (normal)
 * compact        — trigger CC compaction (elevated)
 * clear+relaunch — clear context, re-launch agent from committed state (critical)
 */
export const PRESSURE_ACTIONS = Object.freeze(["continue", "compact", "clear+relaunch"]);

/**
 * Default context-size thresholds (byte proxies for a ~200k-token window).
 *
 * The estimator uses accumulated byte size as a proxy for token count
 * (1 token ≈ 4 bytes in English prose; tool outputs can skew higher).
 * A conservative 3-byte-per-token assumption is used for the proxy so the
 * estimator errs on the side of early compaction rather than overflow.
 *
 * windowBytes: the full context window (200k tokens × 3 bytes = ~600 KB)
 * elevatedFraction: fraction of window that triggers "elevated"  (0.70 = 70%)
 * criticalFraction: fraction of window that triggers "critical"  (0.90 = 90%)
 *
 * These are overridden per model via makeThresholds() — a 1M-token model
 * gets a proportionally larger window (3 MB) with the same fractions.
 */
export const DEFAULT_CONTEXT_THRESHOLDS = Object.freeze({
  windowBytes:       200_000 * 3,   // ~600 KB proxy for a 200k-token window
  elevatedFraction:  0.70,          // 70% of window → elevated
  criticalFraction:  0.90,          // 90% of window → critical
});

/**
 * Build a thresholds object for a model with a given context-token count.
 * Use this to exploit large / 1M-token windows (NFR-09, DEF-10).
 *
 * @param {object} opts
 * @param {number} opts.contextTokens     — the model's context window in tokens
 * @param {number} [opts.bytesPerToken=3] — byte-proxy ratio (default: 3)
 * @param {number} [opts.elevatedFraction=0.70]
 * @param {number} [opts.criticalFraction=0.90]
 * @returns {{ windowBytes: number, elevatedFraction: number, criticalFraction: number }}
 */
export function makeThresholds({
  contextTokens,
  bytesPerToken      = 3,
  elevatedFraction   = 0.70,
  criticalFraction   = 0.90,
}) {
  if (typeof contextTokens !== "number" || contextTokens <= 0) {
    throw new Error("makeThresholds: contextTokens must be a positive number");
  }
  if (elevatedFraction <= 0 || elevatedFraction >= 1) {
    throw new Error("makeThresholds: elevatedFraction must be in (0, 1)");
  }
  if (criticalFraction <= 0 || criticalFraction >= 1 || criticalFraction <= elevatedFraction) {
    throw new Error(
      "makeThresholds: criticalFraction must be in (elevatedFraction, 1)"
    );
  }
  return Object.freeze({
    windowBytes: Math.round(contextTokens * bytesPerToken),
    elevatedFraction,
    criticalFraction,
  });
}

/**
 * Build thresholds from a bgsd config's `context` section (init.mjs
 * defaultBgsdConfig). This is the seam that makes the thresholds
 * config-driven: a user editing BGSD.md's `context` block changes when the
 * Conductor compacts/relaunches. Missing keys fall back to the defaults.
 *
 * @param {object} config  Resolved bgsd config (parseBgsdMd output)
 * @param {number} [bytesPerToken=3]
 * @returns {{ windowBytes: number, elevatedFraction: number, criticalFraction: number }}
 */
export function thresholdsFromConfig(config, bytesPerToken = 3) {
  const ctx = (config && config.context) || {};
  return makeThresholds({
    contextTokens:    ctx.max_window_tokens ?? 1_000_000,
    bytesPerToken,
    elevatedFraction: ctx.compact_at ?? 0.70,
    criticalFraction: ctx.relaunch_at ?? 0.90,
  });
}

/**
 * Estimate context pressure from accumulated byte size.
 *
 * Pure function — no I/O, no side effects. Accepts an injected size (bytes)
 * so tests can drive all three branches without touching the filesystem.
 *
 * @param {object} opts
 * @param {number} opts.accumulatedBytes  — total bytes in the agent's context so far
 * @param {object} [opts.thresholds]     — thresholds object (default: DEFAULT_CONTEXT_THRESHOLDS)
 * @returns {"normal" | "elevated" | "critical"}
 */
export function estimatePressure({
  accumulatedBytes,
  thresholds = DEFAULT_CONTEXT_THRESHOLDS,
}) {
  if (typeof accumulatedBytes !== "number" || accumulatedBytes < 0) {
    throw new Error("estimatePressure: accumulatedBytes must be a non-negative number");
  }
  const { windowBytes, elevatedFraction, criticalFraction } = thresholds;
  const fraction = accumulatedBytes / windowBytes;
  if (fraction >= criticalFraction) return "critical";
  if (fraction >= elevatedFraction) return "elevated";
  return "normal";
}

/**
 * Map a pressure level to a recommended action.
 *
 * Pure function — deterministic mapping, no I/O (NFR-05).
 *
 * @param {"normal" | "elevated" | "critical"} level
 * @returns {"continue" | "compact" | "clear+relaunch"}
 */
export function pressureDecision(level) {
  switch (level) {
    case "normal":   return "continue";
    case "elevated": return "compact";
    case "critical": return "clear+relaunch";
    default:
      throw new Error(`pressureDecision: unknown pressure level "${level}"`);
  }
}

// ---------------------------------------------------------------------------
// Poll-loop decision dispatch (CTX-02) — dependency-injected, unit-testable
// ---------------------------------------------------------------------------

/**
 * Decide the action for one agent from its recorded context_bytes.
 *
 * Pure: composes estimatePressure + pressureDecision so the Conductor poll
 * loop has a single call site. No I/O, no model, no process spawn.
 *
 * @param {object} opts
 * @param {number} opts.contextBytes        The agent's accumulated bytes (proxy)
 * @param {object} [opts.thresholds]        Thresholds (default DEFAULT_CONTEXT_THRESHOLDS)
 * @returns {{ pressure: "normal"|"elevated"|"critical", action: "continue"|"compact"|"clear+relaunch" }}
 */
export function decideContextAction({ contextBytes, thresholds = DEFAULT_CONTEXT_THRESHOLDS }) {
  const pressure = estimatePressure({ accumulatedBytes: contextBytes ?? 0, thresholds });
  const action = pressureDecision(pressure);
  return { pressure, action };
}

/**
 * Run one context-management tick across a set of agents.
 *
 * This is the decision logic the Conductor's poll loop runs each cycle: for
 * every agent, read its recorded context_bytes, classify pressure, and dispatch
 * the action (elevated → compactFn, critical → relaunchFn). EVERYTHING is
 * dependency-injected so this is unit-testable with mocks and NEVER requires a
 * real `claude -p` process:
 *
 *   - readBytesFn(agentId)        => number  — the agent's accumulated bytes.
 *                                   HONEST SCOPE: in a live run this byte signal
 *                                   comes from the real `claude -p` agent (which
 *                                   is itself partly stubbed); in tests it is a
 *                                   mock that feeds rising byte counts. The
 *                                   PLUMBING + DECISION + SEAMS are fully wired;
 *                                   only this byte source becomes real once the
 *                                   live spawn is wired.
 *   - recordFn(agentId, usage)    => void    — persist {context_bytes, context_pressure}
 *                                   (live: control.updateContextUsage; tests: mock).
 *   - compactFn(agentId)          => Promise — act on "compact"   (live: liveCompact).
 *   - relaunchFn(agentId)         => Promise — act on "clear+relaunch" (live: liveRelaunch).
 *
 * @param {object} opts
 * @param {string[]} opts.agentIds            Agent ids to evaluate this tick
 * @param {Function} opts.readBytesFn         (agentId) => number   — INJECTED
 * @param {Function} [opts.recordFn]          (agentId, {context_bytes, context_pressure}) => void
 * @param {Function} opts.compactFn           async (agentId) => void  — INJECTED
 * @param {Function} opts.relaunchFn          async (agentId) => void  — INJECTED
 * @param {object}   [opts.thresholds]        Thresholds (default DEFAULT_CONTEXT_THRESHOLDS)
 * @returns {Promise<Array<{ agent_id, context_bytes, pressure, action, dispatched }>>}
 */
export async function runContextTick({
  agentIds,
  readBytesFn,
  recordFn,
  compactFn,
  relaunchFn,
  thresholds = DEFAULT_CONTEXT_THRESHOLDS,
}) {
  if (typeof readBytesFn !== "function") {
    throw new Error("runContextTick: readBytesFn must be injected (use a mock in tests)");
  }
  if (typeof compactFn !== "function") {
    throw new Error("runContextTick: compactFn must be injected (use a mock in tests)");
  }
  if (typeof relaunchFn !== "function") {
    throw new Error("runContextTick: relaunchFn must be injected (use a mock in tests)");
  }

  const summary = [];

  for (const agentId of agentIds ?? []) {
    const contextBytes = await readBytesFn(agentId);
    const { pressure, action } = decideContextAction({ contextBytes, thresholds });

    if (typeof recordFn === "function") {
      recordFn(agentId, { context_bytes: contextBytes, context_pressure: pressure });
    }

    let dispatched = "continue";
    if (action === "compact") {
      await compactFn(agentId);
      dispatched = "compact";
    } else if (action === "clear+relaunch") {
      await relaunchFn(agentId);
      dispatched = "clear+relaunch";
    }

    summary.push({ agent_id: agentId, context_bytes: contextBytes, pressure, action, dispatched });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Pointers-not-blobs handoff — CTX-01
// ---------------------------------------------------------------------------

/**
 * Write a handoff manifest: a small JSON file containing REFERENCES (file
 * paths) — not inlined content. A re-launched or compacted agent reads this
 * manifest and reloads from disk, not from a bloated transcript.
 *
 * Writes atomically (write-to-tmp then rename). The manifest lives alongside
 * the run's control directory so the Conductor and agents share one source of
 * truth on disk.
 *
 * @param {string} manifestPath  Absolute path to write the manifest JSON
 * @param {object} pointers      Key-value map of { <name>: <absoluteFilePath> }
 *                               Values must be strings (file paths or git refs).
 *                               Example:
 *                                 {
 *                                   control:      "/…/.bgsd/runs/r1/control/agent-1.json",
 *                                   plan:         "/…/.bgsd/runs/r1/plan-unit-1.md",
 *                                   requirements: "/…/.planning/REQUIREMENTS.md",
 *                                   inbox:        "/…/.bgsd/runs/r1/control/agent-1.inbox.md",
 *                                 }
 * @param {object} [meta]        Optional metadata (agent_id, run_id, timestamp, etc.)
 * @returns {object}  The manifest object written to disk
 */
export function writeHandoffManifest(manifestPath, pointers, meta = {}) {
  if (!pointers || typeof pointers !== "object" || Array.isArray(pointers)) {
    throw new Error("writeHandoffManifest: pointers must be a plain object");
  }
  for (const [key, val] of Object.entries(pointers)) {
    if (typeof val !== "string") {
      throw new Error(
        `writeHandoffManifest: pointer "${key}" must be a string (file path or ref), got ${typeof val}`
      );
    }
  }

  const manifest = {
    schema_version: 1,
    written_at:     new Date().toISOString(),
    pointers,
    meta,
  };

  const dir = dirname(manifestPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = manifestPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmpPath, manifestPath);

  return manifest;
}

/**
 * Read and parse a handoff manifest.
 * Validates that the file exists and contains the expected shape.
 *
 * @param {string} manifestPath  Absolute path to the manifest JSON
 * @returns {object}  The parsed manifest { schema_version, written_at, pointers, meta }
 * @throws {Error} if the file does not exist, is invalid JSON, or is missing pointers
 */
export function readHandoffManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`handoff manifest not found: ${manifestPath}`);
  }
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`handoff manifest read error at ${manifestPath}: ${err.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`handoff manifest is not valid JSON at ${manifestPath}: ${err.message}`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`handoff manifest at ${manifestPath} is not a plain object`);
  }
  if (!obj.pointers || typeof obj.pointers !== "object" || Array.isArray(obj.pointers)) {
    throw new Error(`handoff manifest at ${manifestPath} is missing "pointers" object`);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Shared research / prompt cache — CTX-03
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 content-address key for a cache entry.
 * The key is a hex string derived from the cache lookup key string.
 * Identical keys produce identical hashes — guaranteeing dedup (CTX-03).
 *
 * @param {string} key  The research query or prompt string to address
 * @returns {string}    64-character lowercase hex SHA-256 hash
 */
export function cacheKey(key) {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("cacheKey: key must be a non-empty string");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Derive the absolute path for a cache entry given a root dir and hash.
 *
 * @param {string} cacheDir  Absolute path to the cache root (e.g. .bgsd/cache)
 * @param {string} hash      64-character hex SHA-256 hash
 * @returns {string}
 */
function cacheEntryPath(cacheDir, hash) {
  return join(cacheDir, `${hash}.json`);
}

/**
 * Check whether a cache entry exists for the given key.
 *
 * @param {string} cacheDir  Absolute path to the cache root
 * @param {string} key       The original research query / prompt string
 * @returns {boolean}
 */
export function cacheHas(cacheDir, key) {
  const hash = cacheKey(key);
  return existsSync(cacheEntryPath(cacheDir, hash));
}

/**
 * Retrieve a cached result for a key.
 * Returns null if no entry exists (cache miss).
 *
 * @param {string} cacheDir  Absolute path to the cache root
 * @param {string} key       The original research query / prompt string
 * @returns {{ key: string, hash: string, cached_at: string, result: unknown } | null}
 */
export function cacheGet(cacheDir, key) {
  const hash = cacheKey(key);
  const entryPath = cacheEntryPath(cacheDir, hash);
  if (!existsSync(entryPath)) return null;
  try {
    const raw = readFileSync(entryPath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    // Corrupt cache entry — treat as a miss (NFR-06: no silent green for
    // reads, but a corrupt cache entry should not crash the orchestrator;
    // it will simply be re-derived and re-written on next cachePut).
    return null;
  }
}

/**
 * Store a result in the cache, keyed by the SHA-256 of `key`.
 * Write is atomic (write-to-tmp then rename). If an entry already exists
 * for this key it is NOT overwritten — the first writer wins, guaranteeing
 * idempotent dedup across parallel worktrees (CTX-03).
 *
 * @param {string} cacheDir  Absolute path to the cache root
 * @param {string} key       The original research query / prompt string
 * @param {unknown} result   The result to cache (must be JSON-serializable)
 * @returns {{ written: boolean, hash: string, entryPath: string }}
 *   written: false if the entry already existed (no-op), true if newly written
 */
export function cachePut(cacheDir, key, result) {
  const hash = cacheKey(key);
  const entryPath = cacheEntryPath(cacheDir, hash);

  // First-writer-wins: if the entry exists, do NOT overwrite (dedup guarantee).
  if (existsSync(entryPath)) {
    return { written: false, hash, entryPath };
  }

  mkdirSync(cacheDir, { recursive: true });

  const entry = {
    key,
    hash,
    cached_at: new Date().toISOString(),
    result,
  };

  const tmpPath = entryPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(entry, null, 2), "utf8");
  renameSync(tmpPath, entryPath);

  return { written: true, hash, entryPath };
}

// ---------------------------------------------------------------------------
// Live boundary — guarded compaction / re-launch (CTX-02)
// ---------------------------------------------------------------------------

/**
 * Trigger CC compaction for the given agent.
 *
 * HUMAN-GATED: refuses without --live (mirrors requireLiveFlag() in loop1-live.mjs).
 * In the live path this would invoke the Claude Code compaction API/CLI command.
 * The decision to compact is made by the deterministic decision function above;
 * only the execution is gated here.
 *
 * @param {object} opts
 * @param {string}   opts.agentId       — the agent ID to compact
 * @param {string}   opts.controlPath   — absolute path to the agent's control file
 * @param {string}   [opts.manifestPath] — path to the pointers-not-blobs manifest
 *                                        (so the re-launched agent knows where to resume)
 * @returns {Promise<void>}
 * @throws {Error} if --live is not in process.argv
 */
export async function liveCompact({ agentId, controlPath, manifestPath, worktreePath, pointers, meta }) {
  requireLiveFlag();

  // Claude Code exposes no programmatic in-place context compaction for a
  // headless `claude -p` agent. So we implement "compact" AS a
  // relaunch-with-handoff: we write the pointers-not-blobs manifest (committed
  // state, not the fat transcript), then re-spawn `claude -p` seeded from that
  // manifest. The fresh window is small (CTX-01); this is the honest analogue
  // of compaction given the available surface.
  const resolvedManifest =
    manifestPath ?? join(dirname(controlPath), `${agentId}.handoff.json`);

  if (pointers) {
    writeHandoffManifest(resolvedManifest, pointers, { agent_id: agentId, reason: "compact", ...(meta ?? {}) });
  }

  process.stderr.write(
    `[context] liveCompact (= relaunch-with-handoff): agent ${agentId}\n` +
    `  controlPath:  ${controlPath}\n` +
    `  manifestPath: ${resolvedManifest}\n`
  );

  return liveRelaunch({ agentId, manifestPath: resolvedManifest, worktreePath });
}

/**
 * Re-launch an agent from committed state + an inbox pointer.
 *
 * HUMAN-GATED: refuses without --live. The decision to re-launch is made by
 * the deterministic decision function above (pressure → "clear+relaunch");
 * only the actual process spawn is gated here.
 *
 * The re-launch reads pointers from the handoff manifest (not the fat
 * transcript) so the new agent's context starts small (CTX-01, NFR-09).
 *
 * @param {object} opts
 * @param {string}   opts.agentId       — the agent ID to re-launch
 * @param {string}   opts.manifestPath  — path to the pointers-not-blobs manifest
 *                                        the new agent will read on startup
 * @param {string}   opts.worktreePath  — absolute path to the agent's worktree
 * @returns {Promise<void>}
 * @throws {Error} if --live is not in process.argv
 */
export async function liveRelaunch({ agentId, manifestPath, worktreePath }) {
  requireLiveFlag();

  // Read the handoff manifest (pointers, not the fat transcript) so the new
  // agent's window starts small (CTX-01, NFR-09). readHandoffManifest throws
  // loudly if the manifest is missing/corrupt (NFR-06: no silent green).
  const manifest = readHandoffManifest(manifestPath);
  const pointerCount = Object.keys(manifest.pointers ?? {}).length;

  process.stderr.write(
    `[context] liveRelaunch: re-launching agent ${agentId}\n` +
    `  manifestPath: ${manifestPath} (${pointerCount} pointers)\n` +
    `  worktreePath: ${worktreePath}\n`
  );

  // Re-spawn a fresh headless `claude -p` in the agent's worktree, seeded from
  // the manifest. This mirrors liveSpawnFn's spawn shape in run-live.mjs.
  //
  // HONEST SCOPE: this spawn is the same seam liveSpawnFn uses, which is itself
  // partly stubbed pending the finalized `/bgsd-run-agent` entrypoint + the
  // real per-token byte signal the agent reports back. The PLUMBING (manifest
  // read + spawn invocation) is fully wired here; it becomes a live process the
  // moment liveSpawnFn's spawn is uncommented. We invoke through spawnSync so
  // the seam is real and observable rather than a "would re-launch" no-op.
  // Re-launch on the active harness (claude: `claude -p /bgsd-run-agent …`;
  // codex: `codex exec …`). The relaunched pipeline agent runs on the opus-equiv.
  const relaunchRoot = worktreePath ?? process.cwd();
  const lane = activeLane("build");
  const harness = lane.harness;
  const relaunchSpawn = buildAgentSpawn({
    harness,
    command: "/bgsd-run-agent",
    model: lane.model,
    effort: lane.effort,
    extraArgs: [
      "--worktree", worktreePath ?? "",
      "--agent-id", agentId,
      "--resume-manifest", manifestPath,
    ],
  });
  const result = spawnSync(
    relaunchSpawn.cmd,
    relaunchSpawn.args,
    { cwd: worktreePath ?? process.cwd(), stdio: "inherit", env: relaunchSpawn.env }
  );

  // spawnSync sets result.error when the binary is missing (e.g. the harness CLI
  // not on PATH in a sandbox). Surface it rather than pretending the relaunch
  // succeeded (NFR-06).
  if (result.error) {
    throw new Error(
      `liveRelaunch: failed to spawn '${relaunchSpawn.cmd}' for agent ${agentId}: ${result.error.message}`
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `liveRelaunch: '${relaunchSpawn.cmd}' exited with status ${result.status} for agent ${agentId}`
    );
  }

  return { agentId, manifestPath, worktreePath, pointerCount };
}

// ---------------------------------------------------------------------------
// CLI (minimal — mainly for smoke-testing)
// ---------------------------------------------------------------------------

if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  process.stdout.write("context.mjs — Phase 8 Conductor Context Management (library module)\n");
  process.stdout.write("Import and use its exported functions from the Conductor or tests.\n");
  process.stdout.write("\nExported surface:\n");
  process.stdout.write("  Pressure monitor: estimatePressure, pressureDecision, makeThresholds, thresholdsFromConfig\n");
  process.stdout.write("  Poll dispatch:    decideContextAction, runContextTick (dependency-injected)\n");
  process.stdout.write("  Handoff:          writeHandoffManifest, readHandoffManifest\n");
  process.stdout.write("  Cache:            cacheKey, cacheGet, cachePut, cacheHas\n");
  process.stdout.write("  Live boundary:    liveCompact, liveRelaunch (require --live)\n");
  process.exit(0);
}
