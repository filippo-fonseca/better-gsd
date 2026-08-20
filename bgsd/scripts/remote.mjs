#!/usr/bin/env node
/**
 * remote.mjs — remote-control bridge for a running Conductor session.
 *
 * A dependency-free HTTP bridge that lets you observe and drive a live bgsd
 * session from OUTSIDE the terminal (e.g. a phone app):
 *
 *   - SEE its real-time output      GET  /api/events  (poll)  ·  GET /api/stream (SSE)
 *   - SEE the live pipeline state   GET  /api/state   ·  GET /api/sessions
 *   - SEND it a message             POST /api/message  { text }
 *   - ANSWER a pending question     POST /api/answer   { answersUnit, answer }
 *
 * Transport is two file-backed queues under the run dir, so nothing new is
 * invented and the existing session loop keeps working unchanged:
 *
 *   OUTBOX  .bgsd/runs/<run-id>/remote-outbox.jsonl   (Conductor → app)
 *           append-only event log; the Conductor mirrors each user-facing
 *           line here with `remote.mjs emit`, and `remote.mjs mirror` snapshots
 *           the current narrated stage. The server streams it.
 *
 *   INBOX   .bgsd/runs/<run-id>/session-inbox/*.json  (app → Conductor)
 *           the SAME inbox session.mjs already drains every tick. A POST just
 *           drops a message file here; a message with `answersUnit` answers a
 *           parked question, exactly like a local interjection.
 *
 * Because it is reachable off-box, the bridge is API-key gated. A token is
 * generated at `start` and REQUIRED whenever it binds a non-loopback host.
 * Read/observe and inject only — it never runs git and never writes to `main`.
 *
 * Usage (CLI):
 *   node remote.mjs start [--run-id <id>] [--port <n>] [--host <ip>|--lan] [--token <t>]
 *   node remote.mjs stop
 *   node remote.mjs status
 *   node remote.mjs emit "<text>" [--type narration|banner|question|note] [--run-id <id>]
 *   node remote.mjs mirror [--run-id <id>]        # snapshot current narrated stage into the outbox
 *   node remote.mjs tail [--since <seq>] [--run-id <id>] [--json]
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  openSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { latestRunId, modelForRun, readConductorIdentity, sessionsList } from "./gui-live.mjs";
import { readAllControlFiles, classifyHeartbeat } from "./control.mjs";
import { loadUsage, summarize } from "./tokens.mjs";
import { getStatus as queueStatus } from "./queue.mjs";
import { narrate } from "./narrate.mjs";
import { pauseRun, resumePausedRun } from "./pause.mjs";
import { abortRun, runJsonPath } from "./run.mjs";
import { emitStructured } from "./remote-events.mjs";

const THIS_SCRIPT = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function runsDir(repoRoot) { return join(repoRoot, ".bgsd", "runs"); }
function seshsDir(repoRoot) { return join(repoRoot, ".bgsd", "seshs"); }
function bgsdDir(repoRoot) { return join(repoRoot, ".bgsd"); }
function pointerPath(repoRoot) { return join(repoRoot, ".bgsd", "remote.json"); }
function logPath(repoRoot) { return join(repoRoot, ".bgsd", "remote.log"); }
export function outboxPath(repoRoot, runId) {
  return join(runsDir(repoRoot), String(runId), "remote-outbox.jsonl");
}
export function inboxDir(repoRoot, runId) {
  return join(runsDir(repoRoot), String(runId), "session-inbox");
}

/**
 * Resolve the on-disk directory for a run, preferring the live `runs/<id>` dir
 * and falling back to the archived `seshs/<id>` dir. Returns null when neither
 * exists. This is the v2 addressing rule: `?run=` may target a shipped session.
 */
export function resolveRunDir(repoRoot, runId) {
  if (!runId) return null;
  const live = join(runsDir(repoRoot), String(runId));
  if (existsSync(live)) return live;
  const archived = join(seshsDir(repoRoot), String(runId));
  if (existsSync(archived)) return archived;
  return null;
}

/** Directory names under `.bgsd/seshs/` (the archived, shipped sessions). */
export function archivedRunIds(repoRoot) {
  const dir = seshsDir(repoRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure core (no I/O — unit tested)
// ---------------------------------------------------------------------------

/** Generate a URL-safe API token. `rng` is injectable for deterministic tests. */
export function generateToken(rng = randomBytes) {
  return rng(24).toString("hex");
}

/** True when a host is a loopback address (safe to run tokenless). */
export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Whether a bind host must require a token (anything reachable off-box). */
export function tokenRequiredForHost(host) {
  return !isLoopbackHost(host);
}

/** Pull a bearer token from an Authorization header or a ?token= query param. */
export function extractToken(req, url) {
  const auth = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, "").trim();
  }
  const h = req?.headers?.["x-bgsd-token"];
  if (typeof h === "string" && h.trim()) return h.trim();
  const q = url?.searchParams?.get?.("token");
  return q && q.trim() ? q.trim() : null;
}

/**
 * Constant-time auth check. When `expected` is falsy the bridge is open
 * (loopback, tokenless). Otherwise `provided` must equal `expected`.
 */
export function checkAuth({ provided, expected }) {
  if (!expected) return true;
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

/**
 * Normalize a POST body into an inbox message. Two kinds:
 *   - answer:  { answersUnit, answer }  → answers a parked question
 *   - message: { text }                 → a free interjection
 * Throws on an empty/invalid payload so the caller returns 400.
 */
export function normalizeInbound(body, { now = () => new Date().toISOString(), rng = randomBytes } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const at = now();
  const id = `remote-${Date.now()}-${rng(4).toString("hex")}`;
  const answersUnit = typeof b.answersUnit === "string" && b.answersUnit.trim() ? b.answersUnit.trim() : null;
  if (answersUnit) {
    const answer = typeof b.answer === "string" ? b.answer : (typeof b.text === "string" ? b.text : "");
    if (!answer.trim()) throw new Error("answer is required when answersUnit is set");
    return { id, kind: "answer", source: "remote", answersUnit, answer: answer.trim(), at };
  }
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw new Error("text is required");
  return { id, kind: "message", source: "remote", text, at };
}

/** Build one outbox event with a monotonic seq. Pure. */
export function buildOutboxEvent({ seq, type = "narration", text = "", meta = null, at = new Date().toISOString() }) {
  const ev = { seq, at, type, text: String(text) };
  if (meta && typeof meta === "object") ev.meta = meta;
  return ev;
}

/** Filter parsed events to those strictly after `since`. Pure. */
export function eventsSince(events, since = 0) {
  const n = Number(since) || 0;
  return (events ?? []).filter((e) => Number(e.seq) > n);
}

/** Parse a jsonl outbox blob into events (skips malformed lines). Pure. */
export function parseOutbox(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

/**
 * Assemble the remote `/api/state` payload from the dashboard model + narration.
 * `pending` lists units awaiting a human answer, so the app can render answer UI.
 * Pure — callers pass the already-read model.
 */
export function remoteStatePayload({ runId, model, narration }) {
  const agents = model?.agents ?? [];
  const pending = agents
    .filter((a) => a?.status === "needs_input")
    .map((a) => ({
      answersUnit: a.unit ?? a.id ?? null,
      title: a.unit ?? a.id ?? null,
      question: a.note ?? null,
    }))
    .filter((p) => p.answersUnit);
  return {
    run_id: runId ?? model?.run?.run_id ?? null,
    run: model?.run ?? null,
    stage: narration?.stage ?? null,
    stage_label: narration?.stageLabel ?? null,
    counts: narration?.counts ?? null,
    gate_command: narration?.gateCommand ?? null,
    narration_lines: narration?.lines ?? [],
    agents,
    pending_questions: pending,
    conductor: model?.conductor ?? null,
  };
}

// ---------------------------------------------------------------------------
// v2: protocol version, capabilities, and derived read projections
// ---------------------------------------------------------------------------

/** The wire protocol version this bridge speaks. Clients gate on this + caps. */
export const PROTOCOL_VERSION = 2;

/**
 * Read the bgsd plugin version from the plugin manifest that ships beside this
 * script (`bgsd/.claude-plugin/plugin.json`). Returns null when unreadable so
 * `/api/health` never fails just because the manifest moved. Pure-ish (one read).
 */
export function pluginVersion(scriptPath = THIS_SCRIPT) {
  const manifest = join(dirname(scriptPath), "..", ".claude-plugin", "plugin.json");
  try {
    const j = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof j?.version === "string" ? j.version : null;
  } catch (_) {
    return null;
  }
}

/**
 * The capability map clients use to gate UI. A read slice implements everything
 * except `control` and `launch`, which later slices flip to true. Pure.
 */
export function capabilitiesMap({ control = false, launch = false } = {}) {
  return {
    sessions: true,
    plan: true,
    tokens: true,
    queue: true,
    agents: true,
    logs: true,
    control,
    launch,
  };
}

// ---------------------------------------------------------------------------
// v2 control: the allowlist + the inbox item a POST /api/control drops.
// ---------------------------------------------------------------------------

/** The control actions a remote client may drive. Anything else is a 400. */
export const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "abort"]);

/** True when `action` is a recognized control action. Pure. */
export function isControlAction(action) {
  return typeof action === "string" && CONTROL_ACTIONS.includes(action);
}

/**
 * Shape the `{kind:"control", ...}` inbox item that session.mjs drains. This is
 * the SAME session-inbox the interjection path uses, so the running session
 * loop reacts to it on its next tick with no new transport. Pure — `now` is
 * injectable. `reason`/`note` are carried through when present.
 *
 * @param {"pause"|"resume"|"abort"} action
 * @param {{ reason?:string, note?:string, now?:()=>string }} [opts]
 * @returns {{ id, kind:"control", action, source:"remote", reason?, note?, at }}
 */
export function buildControlInboxItem(action, { reason = null, note = null, now = () => new Date().toISOString() } = {}) {
  const at = now();
  const item = {
    id: `remote-control-${Date.now()}-${randomBytes(4).toString("hex")}`,
    kind: "control",
    action,
    source: "remote",
    at,
  };
  if (typeof reason === "string" && reason.trim()) item.reason = reason.trim();
  if (typeof note === "string" && note.trim()) item.note = note.trim();
  return item;
}

/**
 * Project one agent control-file object into the `/api/agents` shape, computing
 * a server-side heartbeat vitality. Pure — `nowFn` is injectable for tests.
 *
 * @param {object} cf     a validated control-file object (from readControlFile)
 * @param {object} [opts]
 * @param {Function} [opts.nowFn]  injected clock () => ms (default Date.now)
 * @returns {object} the agent projection
 */
export function projectAgent(cf, { nowFn = Date.now } = {}) {
  const heartbeat = classifyHeartbeat({ heartbeat_at: cf?.heartbeat_at, nowFn });
  return {
    agent_id: cf?.agent_id ?? null,
    unit_id: cf?.unit_id ?? null,
    phase: cf?.phase ?? null,
    status: cf?.status ?? null,
    heartbeat,
    heartbeat_at: cf?.heartbeat_at ?? null,
    model: cf?.model ?? null,
    model_assignment: cf?.model_assignment ?? null,
    worktree: cf?.worktree ?? null,
    branch: cf?.branch ?? null,
    progress: cf?.progress ?? null,
    context_bytes: cf?.context_bytes ?? null,
    context_pressure: cf?.context_pressure ?? null,
    restart_count: cf?.restart_count ?? 0,
    escalations: Array.isArray(cf?.escalations) ? cf.escalations : [],
    blockers: Array.isArray(cf?.blockers) ? cf.blockers : [],
    started_at: cf?.started_at ?? null,
    updated_at: cf?.updated_at ?? null,
  };
}

/**
 * Join a run's persisted plan (run.json + units/*.json + _meta.json) with the
 * live control files into the `/api/plan` projection. Pure — all inputs are
 * already-read objects, so the disk seam lives in the caller.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {object|null} args.run     parsed run.json (state, scale, waves, checkpoints)
 * @param {object[]} args.units      full unit objects (one per units/<id>.json)
 * @param {object|null} args.meta    parsed units/_meta.json ({ scale, unit_ids })
 * @param {object[]} args.controls   control-file objects for the run
 * @returns {object} the plan payload
 */
export function buildPlanPayload({ runId, run, units, meta, controls }) {
  const controlByUnit = new Map();
  for (const cf of controls ?? []) {
    if (cf && cf.unit_id) controlByUnit.set(cf.unit_id, cf);
  }
  const order = Array.isArray(meta?.unit_ids) && meta.unit_ids.length
    ? meta.unit_ids
    : (units ?? []).map((u) => u?.id).filter(Boolean);
  const byId = new Map((units ?? []).filter((u) => u && u.id).map((u) => [u.id, u]));

  const unitRows = order
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((u) => {
      const cf = controlByUnit.get(u.id) ?? null;
      return {
        id: u.id,
        title: u.title ?? null,
        scope: u.scope ?? null,
        criteria: u.criteria ?? null,
        touched: u.touched ?? null,
        difficulty: u.difficulty ?? null,
        model_assignment: u.model_assignment ?? null,
        // live join — null before the unit's agent has spawned a control file
        live: cf
          ? {
              agent_id: cf.agent_id ?? null,
              status: cf.status ?? null,
              phase: cf.phase ?? null,
              worktree: cf.worktree ?? null,
              branch: cf.branch ?? null,
            }
          : null,
      };
    });

  return {
    run_id: runId,
    state: run?.state ?? null,
    scale: run?.scale ?? meta?.scale ?? null,
    waves: Array.isArray(run?.waves) ? run.waves : [],
    checkpoints: Array.isArray(run?.checkpoints) ? run.checkpoints : [],
    units: unitRows,
  };
}

/**
 * Project the queue store status into the `/api/queue` payload: per-state counts
 * plus a lean item list (the fields a remote client needs to render a backlog).
 * Pure — `status` is the object returned by queue.mjs getStatus().
 */
export function buildQueuePayload(status) {
  const items = Array.isArray(status?.items) ? status.items : [];
  return {
    counts: status?.counts ?? {},
    current: status?.current ? status.current.id ?? null : null,
    last_verdict: status?.last_verdict ?? null,
    items: items.map((i) => ({
      id: i.id ?? null,
      title: i.title ?? null,
      state: i.state ?? null,
      source: i.source ?? null,
      created_at: i.created_at ?? null,
    })),
  };
}

/**
 * Sanitize an agent id from a URL path segment. Rejects anything with a
 * character outside [A-Za-z0-9._-] (defeats path traversal like `../`). Returns
 * the id when safe, else null. Pure.
 */
export function sanitizeAgentId(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 200) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

/** Max bytes a single /api/agents/<id>/log request will return. */
export const LOG_CHUNK_BYTES = 256 * 1024;

/**
 * Read a byte-offset window from a log file, capped at LOG_CHUNK_BYTES. Returns
 * a tail descriptor. When the file is absent, returns { exists: false }. The disk
 * seam lives here (a single read), so callers stay thin.
 *
 * @param {string} filePath  absolute path to the log file
 * @param {number} offset    starting byte offset (clamped to [0, size])
 * @returns {{ exists: boolean, offset?: number, next_offset?: number, eof?: boolean, data?: string }}
 */
export function readLogTail(filePath, offset = 0) {
  if (!existsSync(filePath)) return { exists: false };
  let size = 0;
  try { size = statSync(filePath).size; } catch (_) { return { exists: false }; }
  let start = Number(offset) || 0;
  if (start < 0) start = 0;
  if (start > size) start = size; // caller over-read past EOF: return empty at EOF
  const end = Math.min(size, start + LOG_CHUNK_BYTES);
  let data = "";
  try {
    const buf = readFileSync(filePath);
    data = buf.subarray(start, end).toString("utf8");
  } catch (_) {
    return { exists: false };
  }
  return { exists: true, offset: start, next_offset: end, eof: end >= size, data };
}

// ---------------------------------------------------------------------------
// File I/O — outbox (Conductor → app)
// ---------------------------------------------------------------------------

/** Read + parse the outbox event log for a run (empty when absent). */
export function readOutbox(repoRoot, runId, since = 0) {
  const p = outboxPath(repoRoot, runId);
  if (!existsSync(p)) return [];
  return eventsSince(parseOutbox(readFileSync(p, "utf8")), since);
}

/** Append one event to a run's outbox, assigning the next seq. Returns the event. */
export function appendOutboxEvent(repoRoot, runId, { type = "narration", text = "", meta = null } = {}) {
  const p = outboxPath(repoRoot, runId);
  mkdirSync(dirname(p), { recursive: true });
  const existing = existsSync(p) ? parseOutbox(readFileSync(p, "utf8")) : [];
  const seq = existing.length ? Math.max(...existing.map((e) => Number(e.seq) || 0)) + 1 : 1;
  const ev = buildOutboxEvent({ seq, type, text, meta, at: new Date().toISOString() });
  appendFileSync(p, JSON.stringify(ev) + "\n", "utf8");
  return ev;
}

/**
 * Snapshot the current narrated stage into the outbox (idempotent-ish: dedupes
 * against the last mirrored stage so repeated calls don't spam identical lines).
 */
export function mirrorNarration(repoRoot, runId) {
  const model = modelForRun(repoRoot, runId);
  const run = model?.run ?? {};
  const narration = narrate({
    integrationBranch: "next",
    state: run.state ?? null,
    units: model?.agents ?? [],
    prs: [],
  });
  const existing = readOutbox(repoRoot, runId, 0);
  const lastStage = [...existing].reverse().find((e) => e.type === "stage");
  if (lastStage && lastStage.meta && lastStage.meta.stage === narration.stage) {
    return null; // already mirrored this stage
  }
  return appendOutboxEvent(repoRoot, runId, {
    type: "stage",
    text: narration.stageLabel ?? String(narration.stage ?? ""),
    meta: { stage: narration.stage, counts: narration.counts, gate: narration.gateCommand },
  });
}

// ---------------------------------------------------------------------------
// File I/O — inbox (app → Conductor), reusing session.mjs's session-inbox
// ---------------------------------------------------------------------------

/** Drop a normalized inbound message into the run's session-inbox. Returns the path. */
export function writeInboxMessage(repoRoot, runId, msg) {
  const dir = inboxDir(repoRoot, runId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${msg.id}.json`);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(msg, null, 2), "utf8");
  // atomic-ish: session.mjs only reads *.json, never the *.tmp
  writeFileSync(p, readFileSync(tmp, "utf8"), "utf8");
  try { rmSync(tmp, { force: true }); } catch (_) { /* noop */ }
  return p;
}

// ---------------------------------------------------------------------------
// Pointer file (.bgsd/remote.json)
// ---------------------------------------------------------------------------

export function readPointer(repoRoot) {
  const p = pointerPath(repoRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (_) { return null; }
}
function writePointer(repoRoot, ptr) {
  const p = pointerPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ptr, null, 2), "utf8");
}
function clearPointer(repoRoot) {
  try { rmSync(pointerPath(repoRoot), { force: true }); } catch (_) { /* noop */ }
}

// ---------------------------------------------------------------------------
// v2: disk-seam readers for the derived reads (run.json, units, controls, logs)
// ---------------------------------------------------------------------------

/** Read + parse a run's run.json from its resolved dir (null when absent/bad). */
function readRunJson(runDir) {
  const p = join(runDir, "run.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (_) { return null; }
}

/** Read a run's units/*.json + _meta.json. Returns { present, units, meta }. */
function readRunUnits(runDir) {
  const dir = join(runDir, "units");
  if (!existsSync(dir)) return { present: false, units: [], meta: null };
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (_) { return { present: false, units: [], meta: null }; }
  let meta = null;
  const units = [];
  for (const name of names) {
    let obj = null;
    try { obj = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch (_) { continue; }
    if (name === "_meta.json") { meta = obj; continue; }
    if (obj && typeof obj === "object") units.push(obj);
  }
  return { present: true, units, meta };
}

/** Read all control files for a run from its resolved dir (empty when absent). */
function readRunControls(runDir) {
  const dir = join(runDir, "control");
  if (!existsSync(dir)) return [];
  try { return readAllControlFiles(dir).files; } catch (_) { return []; }
}

/** Absolute path to a per-agent log file under a resolved run dir. */
function agentLogPath(runDir, agentId) {
  return join(runDir, "logs", `${agentId}.log`);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/** CORS headers applied to every response (bearer-token auth, no cookies). */
export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-bgsd-token, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
});

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve({ __invalid: true }); }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * Start the bridge server. Binds `host:port`, gates every route behind the
 * token (when set), serves observe routes and ingest routes, writes the pointer.
 *
 * @returns {Promise<{ url, port, host, runId, token, server }>}
 */
export function startServer(repoRoot, { runId, port = 0, host = "127.0.0.1", token = null } = {}) {
  const resolvedRun = runId ?? latestRunId(repoRoot);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      // CORS preflight — answered BEFORE the auth gate (it carries no token and
      // must succeed so the browser will then send the real, authed request).
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }
      // Auth gate — every route (OPTIONS above is the only pre-auth response).
      if (!checkAuth({ provided: extractToken(req, url), expected: token })) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const target = (url.searchParams.get("run") || "").trim() || resolvedRun || latestRunId(repoRoot);

      // ---- observe ----
      if (req.method === "GET" && url.pathname === "/api/state") {
        const model = modelForRun(repoRoot, target);
        const run = model?.run ?? {};
        const narration = narrate({ integrationBranch: "next", state: run.state ?? null, units: model?.agents ?? [], prs: [] });
        return sendJson(res, 200, remoteStatePayload({ runId: target, model, narration }));
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        const since = Number(url.searchParams.get("since") || 0);
        return sendJson(res, 200, { run_id: target, events: readOutbox(repoRoot, target, since) });
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        return streamEvents(req, res, repoRoot, target, Number(url.searchParams.get("since") || 0));
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        // v1 fields preserved; v2 adds protocol / bgsd_version / capabilities.
        return sendJson(res, 200, {
          ok: true,
          run_id: target,
          conductor: readConductorIdentity(repoRoot),
          protocol: PROTOCOL_VERSION,
          bgsd_version: pluginVersion(),
          capabilities: capabilitiesMap({ control: true, launch: false }),
        });
      }

      // ---- v2 read endpoints ----
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return sendJson(res, 200, {
          sessions: sessionsList(repoRoot),
          latest_run_id: latestRunId(repoRoot),
          archived: archivedRunIds(repoRoot),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/plan") {
        if (!target) return sendJson(res, 404, { error: "unknown run" });
        const runDir = resolveRunDir(repoRoot, target);
        if (!runDir) return sendJson(res, 404, { error: "unknown run" });
        const { present, units, meta } = readRunUnits(runDir);
        if (!present) return sendJson(res, 409, { error: "not yet decomposed" });
        const run = readRunJson(runDir);
        const controls = readRunControls(runDir);
        return sendJson(res, 200, buildPlanPayload({ runId: target, run, units, meta, controls }));
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        if (!target) return sendJson(res, 404, { error: "unknown run" });
        const runDir = resolveRunDir(repoRoot, target);
        if (!runDir) return sendJson(res, 404, { error: "unknown run" });
        const controls = readRunControls(runDir);
        return sendJson(res, 200, {
          run_id: target,
          agents: controls.map((cf) => projectAgent(cf)),
        });
      }
      if (req.method === "GET" && /^\/api\/agents\/[^/]+\/log$/.test(url.pathname)) {
        if (!target) return sendJson(res, 404, { error: "unknown run" });
        const runDir = resolveRunDir(repoRoot, target);
        if (!runDir) return sendJson(res, 404, { error: "unknown run" });
        const rawId = decodeURIComponent(url.pathname.split("/")[3] || "");
        const agentId = sanitizeAgentId(rawId);
        if (!agentId) return sendJson(res, 400, { error: "invalid agent id" });
        const offset = Number(url.searchParams.get("offset") || 0);
        const tail = readLogTail(agentLogPath(runDir, agentId), offset);
        if (!tail.exists) return sendJson(res, 404, { error: "log not found" });
        return sendJson(res, 200, {
          agent_id: agentId,
          offset: tail.offset,
          next_offset: tail.next_offset,
          eof: tail.eof,
          data: tail.data,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/tokens") {
        if (!target) return sendJson(res, 404, { error: "unknown run" });
        const summary = summarize(loadUsage(bgsdDir(repoRoot), target));
        const raw = url.searchParams.get("raw") === "1";
        const payload = {
          run_id: target,
          totals: summary.totals,
          byModel: summary.byModel,
          byRole: summary.byRole,
          byAgent: summary.byAgent,
        };
        if (raw) payload.entries = loadUsage(bgsdDir(repoRoot), target).entries ?? [];
        return sendJson(res, 200, payload);
      }
      if (req.method === "GET" && url.pathname === "/api/queue") {
        return sendJson(res, 200, buildQueuePayload(queueStatus()));
      }

      // ---- ingest ----
      if (req.method === "POST" && (url.pathname === "/api/message" || url.pathname === "/api/answer")) {
        if (!target) return sendJson(res, 409, { error: "no active run to message" });
        const body = await readBody(req);
        if (body.__invalid) return sendJson(res, 400, { error: "invalid JSON body" });
        let msg;
        try { msg = normalizeInbound(body, {}); } catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
        const path = writeInboxMessage(repoRoot, target, msg);
        // Echo the inbound into the outbox so the app sees its own message in the stream.
        appendOutboxEvent(repoRoot, target, {
          type: msg.kind === "answer" ? "answer-in" : "message-in",
          text: msg.kind === "answer" ? `↩ ${msg.answersUnit}: ${msg.answer}` : msg.text,
          meta: { source: "remote", answersUnit: msg.answersUnit ?? null },
        });
        return sendJson(res, 202, { accepted: true, id: msg.id, kind: msg.kind, path });
      }

      // ---- v2 control (capability-gated: capabilities.control === true) ----
      if (req.method === "POST" && url.pathname === "/api/control") {
        if (!target) return sendJson(res, 409, { error: "no active run to control" });
        const body = await readBody(req);
        if (body.__invalid) return sendJson(res, 400, { error: "invalid JSON body" });
        const action = typeof body.action === "string" ? body.action.trim() : "";
        if (!isControlAction(action)) {
          return sendJson(res, 400, { error: `unknown control action; allowed: ${CONTROL_ACTIONS.join(", ")}` });
        }
        const reason = typeof body.reason === "string" ? body.reason : null;
        const note = typeof body.note === "string" ? body.note : null;
        const bd = bgsdDir(repoRoot);

        // Dual write for every control action: (1) drive the run's on-disk state
        // through the same core the local commands use, (2) drop a control item
        // into the SAME session-inbox the loop drains, and (3) mirror a
        // `control-in` structured event so remote observers see it in the stream.
        const dropControl = () => {
          const item = buildControlInboxItem(action, { reason, note });
          const path = writeInboxMessage(repoRoot, target, item);
          emitStructured(repoRoot, target, {
            type: "control-in",
            text: `remote control: ${action}${reason ? ` (${reason})` : ""}`,
            meta: { action, source: "remote", reason: reason ?? null, note: note ?? null, at: item.at },
          });
          return path;
        };

        try {
          if (action === "pause") {
            const summary = pauseRun({ runId: target, bgsdDir: bd, reason: reason ?? "remote_pause", note });
            const path = dropControl();
            return sendJson(res, 200, { ok: true, action, run_id: target, resume_state: summary.resume_state, inbox: path });
          }

          if (action === "abort") {
            // Idempotent: abortRun no-ops on an already-aborted run.
            const updated = abortRun(runJsonPath(bd, target), reason ?? "remote_abort");
            const path = dropControl();
            return sendJson(res, 200, { ok: true, action, run_id: target, state: updated.state, inbox: path });
          }

          // resume: restore the paused run, then check control-file liveness. If
          // any agent's heartbeat still classifies alive the running loop can pick
          // the resume item up cooperatively; otherwise the run needs a fresh
          // Conductor launched to re-enter the stage.
          resumePausedRun({ runId: target, bgsdDir: bd });
          const runDir = resolveRunDir(repoRoot, target);
          const controls = runDir ? readRunControls(runDir) : [];
          const anyAlive = controls.some(
            (cf) => classifyHeartbeat({ heartbeat_at: cf?.heartbeat_at, nowFn: Date.now }) === "alive"
          );
          if (anyAlive) {
            const path = dropControl();
            return sendJson(res, 200, { resumed: true, mode: "cooperative", run_id: target, inbox: path });
          }
          // No live Conductor to receive the inbox item — a human must launch one.
          emitStructured(repoRoot, target, {
            type: "control-in",
            text: `remote control: resume (needs-conductor)`,
            meta: { action, source: "remote", mode: "needs-conductor", reason: reason ?? null, at: new Date().toISOString() },
          });
          return sendJson(res, 202, {
            resumed: true,
            mode: "needs-conductor",
            run_id: target,
            hint: "launch a Conductor with /bgsd-resume",
          });
        } catch (err) {
          // pauseRun throws on a terminal run → map to 409 with its message.
          return sendJson(res, 409, { error: String((err && err.message) || err) });
        }
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  });
  server.on("error", (err) => process.stderr.write(`[bgsd-remote] server error: ${err.message}\n`));

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const shownHost = isLoopbackHost(host) ? "localhost" : host;
      const url = `http://${shownHost}:${actualPort}`;
      writePointer(repoRoot, {
        pid: process.pid, host, port: actualPort, url,
        run_id: resolvedRun, token: token || null, started_at: new Date().toISOString(),
      });
      resolve({ url, port: actualPort, host, runId: resolvedRun, token, server });
    });
  });
}

/** Server-Sent Events: replay events after `since`, then poll for new ones. */
function streamEvents(req, res, repoRoot, runId, since) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...CORS_HEADERS,
  });
  let cursor = since;
  const flush = () => {
    const evs = readOutbox(repoRoot, runId, cursor);
    for (const ev of evs) {
      res.write(`id: ${ev.seq}\n`);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
      cursor = ev.seq;
    }
  };
  flush();
  const timer = setInterval(flush, 1000);
  const keepalive = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(timer); clearInterval(keepalive); });
}

export async function startDaemon(
  repoRoot,
  { runId = null, port = 0, host = "127.0.0.1", token = null, spawnImpl = spawn, timeoutMs = 5000, intervalMs = 50 } = {}
) {
  const resolvedRun = runId ?? latestRunId(repoRoot);
  clearPointer(repoRoot);
  mkdirSync(dirname(logPath(repoRoot)), { recursive: true });
  const fd = openSync(logPath(repoRoot), "a");
  const argv = [
    THIS_SCRIPT, "__serve",
    "--run-id", String(resolvedRun ?? ""),
    "--port", String(port),
    "--host", String(host),
    "--token", String(token ?? ""),
  ];
  const child = spawnImpl(process.execPath, argv, { detached: true, stdio: ["ignore", fd, fd], cwd: repoRoot });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let ptr = null;
  while (Date.now() < deadline) {
    ptr = readPointer(repoRoot);
    if (ptr && ptr.port && ptr.url) break;
    ptr = null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    url: ptr ? ptr.url : null,
    port: ptr ? ptr.port : null,
    host: ptr ? ptr.host : host,
    runId: ptr ? (ptr.run_id ?? resolvedRun) : resolvedRun,
    token: ptr ? ptr.token : token,
    pid: ptr ? ptr.pid : (child && child.pid) ?? null,
  };
}

export function stopServer(repoRoot) {
  const ptr = readPointer(repoRoot);
  if (!ptr || !ptr.pid) return { stopped: false, reason: "no bridge is running" };
  try { process.kill(ptr.pid, "SIGTERM"); } catch (_) { /* already gone */ }
  clearPointer(repoRoot);
  return { stopped: true, pid: ptr.pid };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

const isMain =
  import.meta.url ===
  new URL(process.argv[1], import.meta.url.startsWith("file://") ? import.meta.url : `file://${process.cwd()}/`).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));
  const repoRoot = process.env.BGSD_REPO_ROOT || process.cwd();

  const resolveHost = () => {
    if (flags.lan === true) return "0.0.0.0";
    if (typeof flags.host === "string") return flags.host;
    return "127.0.0.1";
  };

  if (sub === "__serve") {
    // Internal: the detached daemon body. Holds the server open.
    const runId = flags["run-id"] && flags["run-id"] !== "" ? String(flags["run-id"]) : null;
    const token = flags.token && flags.token !== "" ? String(flags.token) : null;
    startServer(repoRoot, { runId, port: Number(flags.port || 0), host: resolveHost(), token })
      .then(() => { /* keep alive */ });
  } else if (sub === "start") {
    const host = resolveHost();
    // A token is generated by default; REQUIRED for any non-loopback bind.
    let token = typeof flags.token === "string" ? flags.token : null;
    if (!token && (flags.token === undefined)) token = tokenRequiredForHost(host) ? generateToken() : generateToken();
    startDaemon(repoRoot, { runId: flags["run-id"] ? String(flags["run-id"]) : null, port: Number(flags.port || 0), host, token })
      .then((info) => {
        if (!info.url) {
          process.stderr.write("remote: bridge failed to start (see .bgsd/remote.log)\n");
          process.exit(1);
        }
        process.stdout.write(`bgsd remote bridge up\n  url    ${info.url}\n  run    ${info.runId ?? "(none)"}\n`);
        if (info.token) process.stdout.write(`  token  ${info.token}\n  (send as: Authorization: Bearer <token>  or  ?token=<token>)\n`);
        if (host !== "127.0.0.1") process.stdout.write(`  host   ${host}  (reachable on your LAN; tunnel this for true remote)\n`);
        process.exit(0);
      });
  } else if (sub === "stop") {
    const r = stopServer(repoRoot);
    process.stdout.write(r.stopped ? `bridge stopped (pid ${r.pid})\n` : `${r.reason}\n`);
    process.exit(0);
  } else if (sub === "status") {
    const ptr = readPointer(repoRoot);
    if (!ptr) { process.stdout.write("bridge: not running\n"); process.exit(0); }
    process.stdout.write(`bridge: up\n  url    ${ptr.url}\n  run    ${ptr.run_id ?? "(none)"}\n  pid    ${ptr.pid}\n${ptr.token ? `  token  ${ptr.token}\n` : ""}`);
    process.exit(0);
  } else if (sub === "emit") {
    const text = positional.join(" ").trim();
    if (!text) { process.stderr.write("emit: text is required\n"); process.exit(1); }
    const runId = flags["run-id"] ? String(flags["run-id"]) : latestRunId(repoRoot);
    if (!runId) { process.stderr.write("emit: no run to emit into\n"); process.exit(1); }
    const ev = appendOutboxEvent(repoRoot, runId, { type: typeof flags.type === "string" ? flags.type : "narration", text });
    process.stdout.write(`emitted #${ev.seq}\n`);
    process.exit(0);
  } else if (sub === "mirror") {
    const runId = flags["run-id"] ? String(flags["run-id"]) : latestRunId(repoRoot);
    if (!runId) { process.stderr.write("mirror: no run to mirror\n"); process.exit(1); }
    const ev = mirrorNarration(repoRoot, runId);
    process.stdout.write(ev ? `mirrored stage #${ev.seq} (${ev.text})\n` : "stage unchanged — nothing to mirror\n");
    process.exit(0);
  } else if (sub === "tail") {
    const runId = flags["run-id"] ? String(flags["run-id"]) : latestRunId(repoRoot);
    const since = Number(flags.since || 0);
    const events = runId ? readOutbox(repoRoot, runId, since) : [];
    if (flags.json === true) {
      process.stdout.write(JSON.stringify(events, null, 2) + "\n");
    } else {
      for (const e of events) process.stdout.write(`#${e.seq} [${e.type}] ${e.text}\n`);
      if (!events.length) process.stdout.write("(no events)\n");
    }
    process.exit(0);
  } else {
    process.stderr.write(
      [
        "Usage:",
        "  node remote.mjs start [--run-id <id>] [--port <n>] [--host <ip>|--lan] [--token <t>]",
        "  node remote.mjs stop | status",
        "  node remote.mjs emit \"<text>\" [--type <t>] [--run-id <id>]",
        "  node remote.mjs mirror [--run-id <id>]",
        "  node remote.mjs tail [--since <seq>] [--run-id <id>] [--json]",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
}
