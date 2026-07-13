#!/usr/bin/env node
/**
 * remote-events.mjs — Structured outbox events for the bgsd remote API v2.
 *
 * This is the STRUCTURED-EVENTS + AGENT-LOGS slice of the remote API v2
 * (GitHub issue #12). It is strictly ADDITIVE on top of remote.mjs: the outbox
 * envelope, file format, and every existing event type are preserved. New event
 * types carry a short human-readable `text` line plus a machine-readable `meta`
 * payload. Clients MUST ignore unknown event types (see remote-protocol.mdx).
 *
 * Design goals:
 *   - emitStructured() NEVER throws. A telemetry failure can never break a run.
 *     Errors are swallowed and logged to stderr. It no-ops when the run dir is
 *     absent (nothing to observe → nothing to write).
 *   - Perf: seq assignment does NOT re-parse the whole outbox on every append.
 *     It maintains a `remote-outbox.seq` sidecar and, on a cold start, reads
 *     only the LAST line of the jsonl to recover the high-water mark. The
 *     on-disk jsonl format is byte-for-byte identical to appendOutboxEvent's.
 *
 * The append path here is a self-contained re-implementation that shares the
 * exact same file format as remote.mjs's appendOutboxEvent (envelope
 * `{ seq, at, type, text, meta? }`, one JSON object per line, monotonic seq).
 * It is kept in this file (not remote.mjs) to avoid merge conflicts with the
 * parallel slice adding read endpoints there.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The run's directory under .bgsd/runs/<run-id>/. */
export function runDir(repoRoot, runId) {
  return join(repoRoot, ".bgsd", "runs", String(runId));
}

/** The append-only structured outbox (shared with remote.mjs). */
export function outboxPath(repoRoot, runId) {
  return join(runDir(repoRoot, runId), "remote-outbox.jsonl");
}

/** The seq high-water-mark sidecar (perf: avoids re-parsing the whole outbox). */
export function seqSidecarPath(repoRoot, runId) {
  return join(runDir(repoRoot, runId), "remote-outbox.seq");
}

/** The per-run logs directory holding one <unit-id>.log per pipeline agent. */
export function logsDir(repoRoot, runId) {
  return join(runDir(repoRoot, runId), "logs");
}

/** The append-target log file for one unit's pipeline agent. */
export function agentLogPath(repoRoot, runId, unitId) {
  return join(logsDir(repoRoot, runId), `${String(unitId)}.log`);
}

// ---------------------------------------------------------------------------
// Structured event catalog (documentation + a light validation surface)
// ---------------------------------------------------------------------------

/**
 * The structured event types this slice adds. Additive only; unknown types are
 * ignored by clients, so this list is advisory (never a hard gate on emit).
 */
export const STRUCTURED_EVENT_TYPES = Object.freeze([
  "run-state",
  "plan-ready",
  "wave-started",
  "wave-done",
  "agent-spawned",
  "agent-phase",
  "agent-escalation",
  "agent-done",
  "unit-merged",
  "verification",
  "issue-linked",
  "pr-opened",
  "pr-merged",
  "branch-created",
]);

// ---------------------------------------------------------------------------
// Pure core — event framing (mirrors remote.mjs buildOutboxEvent exactly)
// ---------------------------------------------------------------------------

/** Build one outbox event with a monotonic seq. Pure. Identical shape to remote.mjs. */
export function buildStructuredEvent({ seq, type = "narration", text = "", meta = null, at = new Date().toISOString() }) {
  const ev = { seq, at, type, text: String(text) };
  if (meta && typeof meta === "object") ev.meta = meta;
  return ev;
}

/**
 * Recover the highest seq already present in an outbox file WITHOUT parsing the
 * whole thing: read a trailing window and parse only the last non-empty line.
 * Returns 0 for an absent/empty/unparseable tail. Pure w.r.t. its fd input.
 */
export function lastSeqFromTail(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      const n = Number(JSON.parse(s).seq);
      return Number.isFinite(n) ? n : 0;
    } catch (_) {
      // A partial/torn final line — keep scanning upward for the last good one.
    }
  }
  return 0;
}

/** Read just the trailing `bytes` of a file (default 4 KiB). Never throws → "". */
function readTail(path, bytes = 4096) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const start = size - len;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch (_) {
    return "";
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch (_) { /* noop */ } }
  }
}

// ---------------------------------------------------------------------------
// Seq assignment — sidecar high-water-mark, cold-start recovery from the tail
// ---------------------------------------------------------------------------

/**
 * Compute the next seq for a run's outbox. Cheap path: read the integer sidecar.
 * Cold path (sidecar missing/corrupt but the outbox exists): recover from the
 * outbox's last line so we never collide with or rewind an existing seq.
 * Returns the next seq (>= 1). Never throws.
 */
export function nextSeq(repoRoot, runId) {
  const sidecar = seqSidecarPath(repoRoot, runId);
  try {
    if (existsSync(sidecar)) {
      const n = Number(readFileSync(sidecar, "utf8").trim());
      if (Number.isFinite(n) && n >= 0) return n + 1;
    }
  } catch (_) { /* fall through to tail recovery */ }

  const outbox = outboxPath(repoRoot, runId);
  if (existsSync(outbox)) {
    return lastSeqFromTail(readTail(outbox)) + 1;
  }
  return 1;
}

/** Persist the high-water seq to the sidecar. Best-effort; never throws. */
function writeSeqSidecar(repoRoot, runId, seq) {
  try {
    writeFileSync(seqSidecarPath(repoRoot, runId), String(seq), "utf8");
  } catch (_) { /* sidecar is an optimization; the tail path still recovers */ }
}

// ---------------------------------------------------------------------------
// emitStructured — the one entry point. Never throws; no-ops on a missing run.
// ---------------------------------------------------------------------------

/**
 * Append one structured event to a run's outbox.
 *
 * Contract:
 *   - NEVER throws. Any failure is swallowed and logged to stderr; the caller's
 *     run continues untouched. Wrap every call site so a telemetry failure can
 *     never break the pipeline.
 *   - No-ops (returns null) when the run directory does not exist — there is
 *     nothing to observe for a run that was never created.
 *   - Assigns a monotonic seq via the sidecar (cheap) with tail recovery.
 *   - Writes the SAME jsonl envelope as remote.mjs appendOutboxEvent.
 *
 * @param {string} repoRoot  Absolute repo root (the dir containing .bgsd/).
 * @param {string} runId     Run identifier.
 * @param {{type?:string, text?:string, meta?:object}} evt
 * @param {{ now?:()=>string }} [io]  Injectable clock for deterministic tests.
 * @returns {object|null}  The written event, or null on no-op / failure.
 */
export function emitStructured(repoRoot, runId, { type = "narration", text = "", meta = null } = {}, io = {}) {
  try {
    if (!repoRoot || !runId) return null;
    const dir = runDir(repoRoot, runId);
    // No-op when the run dir is absent (nothing to observe).
    if (!existsSync(dir)) return null;

    const now = typeof io.now === "function" ? io.now : () => new Date().toISOString();
    const seq = nextSeq(repoRoot, runId);
    const ev = buildStructuredEvent({ seq, type, text, meta, at: now() });

    const p = outboxPath(repoRoot, runId);
    // dir exists (checked above); the file may not yet — append creates it.
    appendFileSync(p, JSON.stringify(ev) + "\n", "utf8");
    writeSeqSidecar(repoRoot, runId, seq);
    return ev;
  } catch (err) {
    try { process.stderr.write(`[remote-events] emit failed (swallowed): ${err?.message ?? err}\n`); } catch (_) { /* noop */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent log files — open an append fd for a unit's pipeline-agent stdio.
// ---------------------------------------------------------------------------

/**
 * Ensure the per-run logs dir exists and open an append fd for a unit's log.
 * Mirrors the gui/remote daemon pattern (openSync(path, "a") → stdio [,fd,fd]).
 * Returns the fd and the absolute path. Never throws → returns null on failure,
 * so callers can fall back to inherit rather than crash a spawn.
 *
 * @returns {{ fd:number, path:string } | null}
 */
export function openAgentLog(repoRoot, runId, unitId) {
  try {
    const dir = logsDir(repoRoot, runId);
    mkdirSync(dir, { recursive: true });
    const path = agentLogPath(repoRoot, runId, unitId);
    const fd = openSync(path, "a");
    return { fd, path };
  } catch (err) {
    try { process.stderr.write(`[remote-events] openAgentLog failed (swallowed): ${err?.message ?? err}\n`); } catch (_) { /* noop */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Typed emit helpers — thin wrappers that shape text + meta per event type.
// Each is a pure shaper over emitStructured; all inherit the never-throw guard.
// ---------------------------------------------------------------------------

export function emitRunState(repoRoot, runId, { from, to }, io) {
  return emitStructured(repoRoot, runId, {
    type: "run-state",
    text: `run ${from ?? "?"} → ${to ?? "?"}`,
    meta: { from: from ?? null, to: to ?? null, run_id: runId },
  }, io);
}

export function emitPlanReady(repoRoot, runId, { units = [], waveCount = 0 } = {}, io) {
  const list = units.map((u) => ({
    id: u.id ?? null,
    title: u.title ?? u.id ?? null,
    wave: Number.isInteger(u.wave) ? u.wave : null,
  }));
  return emitStructured(repoRoot, runId, {
    type: "plan-ready",
    text: `plan ready: ${list.length} unit(s) across ${waveCount} wave(s)`,
    meta: { unit_count: list.length, wave_count: waveCount, units: list },
  }, io);
}

export function emitWaveStarted(repoRoot, runId, { wave, units = [] } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "wave-started",
    text: `wave ${wave} started (${units.length} unit(s))`,
    meta: { wave, units },
  }, io);
}

export function emitWaveDone(repoRoot, runId, { wave, units = [] } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "wave-done",
    text: `wave ${wave} done (${units.length} unit(s))`,
    meta: { wave, units },
  }, io);
}

export function emitAgentSpawned(repoRoot, runId, { agentId, unitId, model, harness, worktree, branch } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "agent-spawned",
    text: `agent ${agentId ?? unitId} spawned (${model ?? "?"} on ${harness ?? "?"})`,
    meta: {
      agent_id: agentId ?? unitId ?? null,
      unit_id: unitId ?? null,
      model: model ?? null,
      harness: harness ?? null,
      worktree: worktree ?? null,
      branch: branch ?? null,
    },
  }, io);
}

export function emitAgentPhase(repoRoot, runId, { agentId, phase, status, iteration, note } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "agent-phase",
    text: `agent ${agentId} → ${phase ?? "?"} (${status ?? "?"})`,
    meta: {
      agent_id: agentId ?? null,
      phase: phase ?? null,
      status: status ?? null,
      iteration: Number.isFinite(iteration) ? iteration : null,
      note: note ?? null,
    },
  }, io);
}

export function emitAgentEscalation(repoRoot, runId, { agentId, question, blockerId } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "agent-escalation",
    text: `agent ${agentId} needs input: ${question ?? ""}`,
    meta: { agent_id: agentId ?? null, question: question ?? null, blocker_id: blockerId ?? null },
  }, io);
}

export function emitAgentDone(repoRoot, runId, { agentId, status = "done", verified } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "agent-done",
    text: `agent ${agentId} ${status}${verified === true ? " (verified)" : ""}`,
    meta: { agent_id: agentId ?? null, status, verified: verified ?? null },
  }, io);
}

export function emitUnitMerged(repoRoot, runId, { unitId, branch, into } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "unit-merged",
    text: `unit ${unitId} merged into ${into ?? "?"}`,
    meta: { unit_id: unitId ?? null, branch: branch ?? null, into: into ?? null },
  }, io);
}

export function emitVerification(repoRoot, runId, { verdict, defectCount } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "verification",
    text: `verification: ${verdict ?? "?"} (${defectCount ?? 0} defect(s))`,
    meta: { verdict: verdict ?? null, defect_count: Number.isFinite(defectCount) ? defectCount : 0 },
  }, io);
}

export function emitIssueLinked(repoRoot, runId, { unitId, issueNumber, url } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "issue-linked",
    text: `unit ${unitId} linked to issue #${issueNumber ?? "?"}`,
    meta: { unit_id: unitId ?? null, issue_number: issueNumber ?? null, url: url ?? null },
  }, io);
}

export function emitPrOpened(repoRoot, runId, { prNumber, url, branch, into } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "pr-opened",
    text: `PR #${prNumber ?? "?"} opened (${branch ?? "?"} → ${into ?? "?"})`,
    meta: { pr_number: prNumber ?? null, url: url ?? null, branch: branch ?? null, into: into ?? null },
  }, io);
}

export function emitPrMerged(repoRoot, runId, { prNumber, url } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "pr-merged",
    text: `PR #${prNumber ?? "?"} merged`,
    meta: { pr_number: prNumber ?? null, url: url ?? null },
  }, io);
}

export function emitBranchCreated(repoRoot, runId, { branch, unitId } = {}, io) {
  return emitStructured(repoRoot, runId, {
    type: "branch-created",
    text: `branch ${branch ?? "?"} created for unit ${unitId ?? "?"}`,
    meta: { branch: branch ?? null, unit_id: unitId ?? null },
  }, io);
}

// ---------------------------------------------------------------------------
// CLI — `node remote-events.mjs emit --type <t> --meta '<json>' [--text <s>]`
//
// This lets Conductor markdown instructions (which have no in-process JS seam,
// e.g. git-artifact steps that run only in command markdown) record structured
// events from the shell. Reuses the same never-throw append.
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const THIS_SCRIPT = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  new URL(process.argv[1], "file://").pathname === THIS_SCRIPT
) {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const sub = positional[0];
  const repoRoot = typeof flags.repo === "string" ? flags.repo : process.cwd();

  if (sub === "emit") {
    const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : null;
    const type = typeof flags.type === "string" ? flags.type : "narration";
    if (!runId) { process.stderr.write("emit: --run-id is required\n"); process.exit(1); }

    let meta = null;
    if (typeof flags.meta === "string") {
      try { meta = JSON.parse(flags.meta); }
      catch (err) { process.stderr.write(`emit: --meta is not valid JSON: ${err.message}\n`); process.exit(1); }
    }
    const text = typeof flags.text === "string" ? flags.text : `${type}`;

    const ev = emitStructured(repoRoot, runId, { type, text, meta });
    if (!ev) {
      process.stderr.write("emit: no-op (run dir absent or emit failed) — see stderr above\n");
      process.exit(1);
    }
    process.stdout.write(`emitted #${ev.seq} [${ev.type}]\n`);
    process.exit(0);
  } else {
    process.stderr.write(
      [
        "Usage:",
        "  node remote-events.mjs emit --run-id <id> --type <t> [--meta '<json>'] [--text <s>] [--repo <root>]",
        "",
        "Records one structured outbox event (for Conductor markdown steps with no JS seam,",
        "e.g. issue-linked / pr-opened / pr-merged). Never throws; no-ops on a missing run.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
}
