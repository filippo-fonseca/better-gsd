#!/usr/bin/env node
/**
 * gui-live.mjs — live seam for /bgsd-gui (the dashboard HTTP server).
 *
 * A dependency-free Node HTTP server that serves the dashboard page
 * (gui-dashboard.html) and a live `/api/state` endpoint built from the run's
 * per-agent control files via the pure model (gui.mjs). Read-only observability:
 * it never touches git and never writes to `main`, so it is not --live gated.
 *
 * The Conductor can open it (`start`), point the user at the URL, and close it
 * (`stop`) at any time. A small pointer file `.bgsd/gui.json` records the pid,
 * port, url, and run id so `stop`/`status` can find the running server.
 *
 * Usage (CLI):
 *   node gui-live.mjs start [--run-id <id>] [--port <n>]   # start the dashboard
 *   node gui-live.mjs stop                                 # stop the running one
 *   node gui-live.mjs status                               # is it up? where?
 *   node gui-live.mjs start --plan-only                    # print the plan only
 */

import { createServer } from "node:http";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readAllControlFiles } from "./control.mjs";
import { buildDashboardModel, summarizeSessions } from "./gui.mjs";
import { resolveRepoRoot } from "./init-live.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dir, "gui-dashboard.html");

function runsDir(repoRoot) { return join(repoRoot, ".bgsd", "runs"); }
function pointerPath(repoRoot) { return join(repoRoot, ".bgsd", "gui.json"); }

/** Most recently modified run id under .bgsd/runs, or null. */
export function latestRunId(repoRoot) {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, mtime: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return runs.length ? runs[0].id : null;
}

/** Build the dashboard model for a run by reading its control files live. */
export function modelForRun(repoRoot, runId) {
  if (!runId) return buildDashboardModel({ run: { run_id: null, state: "no run" }, agents: [] });
  const controlDir = join(runsDir(repoRoot), runId, "control");
  let agents = [];
  try {
    agents = existsSync(controlDir) ? readAllControlFiles(controlDir).files : [];
  } catch (_) {
    agents = [];
  }
  let run = { run_id: runId };
  const runJson = join(runsDir(repoRoot), runId, "run.json");
  try {
    if (existsSync(runJson)) {
      const r = JSON.parse(readFileSync(runJson, "utf8"));
      run = {
        run_id: runId,
        scale: r.scale ?? null,
        state: r.state ?? null,
        stage: r.stage ?? null,
        note: r.note ?? null,
      };
    }
  } catch (_) { /* keep minimal run */ }
  return buildDashboardModel({ run, agents });
}

/**
 * Scan every run under .bgsd/runs and read its metadata + control files into the
 * shape summarizeSessions expects. Each entry carries an mtime computed as the
 * newest of its run.json / control files, falling back to the run dir's mtime,
 * so the "All sessions" list can sort newest-first. Read-only and defensive:
 * a malformed run.json or control dir never aborts the scan.
 *
 * @param {string} repoRoot
 * @returns {Array<{ runId: string, run: object|null, controls: object[], mtime: number }>}
 */
export function readAllRuns(repoRoot) {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) {
    return [];
  }

  return entries.map((e) => {
    const runId = e.name;
    const runDir = join(dir, runId);
    let mtime = 0;
    try { mtime = statSync(runDir).mtimeMs; } catch (_) { mtime = 0; }

    // run.json (optional).
    let run = null;
    const runJson = join(runDir, "run.json");
    try {
      if (existsSync(runJson)) {
        run = JSON.parse(readFileSync(runJson, "utf8"));
        try { mtime = Math.max(mtime, statSync(runJson).mtimeMs); } catch (_) { /* keep */ }
      }
    } catch (_) { run = null; }

    // control/*.json (optional).
    let controls = [];
    const controlDir = join(runDir, "control");
    try {
      if (existsSync(controlDir)) {
        controls = readAllControlFiles(controlDir).files;
        try {
          for (const f of readdirSync(controlDir).filter((n) => n.endsWith(".json"))) {
            mtime = Math.max(mtime, statSync(join(controlDir, f)).mtimeMs);
          }
        } catch (_) { /* keep */ }
      }
    } catch (_) { controls = []; }

    return { runId, run, controls, mtime };
  });
}

/** Session summaries for every run under .bgsd/runs, newest-first. */
export function sessionsList(repoRoot) {
  return summarizeSessions(readAllRuns(repoRoot));
}

/**
 * Update a run's pipeline stage / activity note so the dashboard reflects the
 * pre-fan-out phases (discuss, decompose) and what the Conductor is doing. The
 * Conductor calls this as it advances through the pipeline. Merges onto any
 * existing run.json.
 *
 * @param {string} repoRoot
 * @param {object} fields  { runId?, stage?, note?, scale?, state? }
 * @returns {object} the written run-state
 */
export function setStage(repoRoot, { runId, stage, note, scale, state } = {}) {
  const resolved = runId ?? latestRunId(repoRoot);
  if (!resolved) throw new Error("setStage: no run found under .bgsd/runs");
  const path = join(runsDir(repoRoot), resolved, "run.json");
  let cur = {};
  if (existsSync(path)) { try { cur = JSON.parse(readFileSync(path, "utf8")); } catch (_) { cur = {}; } }
  const next = { ...cur, run_id: resolved, updated_at: new Date().toISOString() };
  if (stage !== undefined) next.stage = stage;
  if (note !== undefined) next.note = note;
  if (scale !== undefined) next.scale = scale;
  if (state !== undefined) next.state = state;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function writePointer(repoRoot, data) {
  mkdirSync(dirname(pointerPath(repoRoot)), { recursive: true });
  writeFileSync(pointerPath(repoRoot), JSON.stringify(data, null, 2), "utf8");
}
function readPointer(repoRoot) {
  const p = pointerPath(repoRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (_) { return null; }
}
function clearPointer(repoRoot) {
  try { rmSync(pointerPath(repoRoot), { force: true }); } catch (_) { /* noop */ }
}

/**
 * Start the dashboard server. Resolves the run (explicit or latest), listens on
 * the given port (or an OS-assigned free port), and writes the pointer file.
 *
 * @returns {Promise<{ url: string, port: number, runId: string|null }>}
 */
export function startServer(repoRoot, { runId, port = 0 } = {}) {
  const resolvedRun = runId ?? latestRunId(repoRoot);
  const html = existsSync(HTML_PATH) ? readFileSync(HTML_PATH, "utf8") : "<h1>dashboard html missing</h1>";

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/api/sessions") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(sessionsList(repoRoot)));
        return;
      }
      if (url.pathname === "/api/state") {
        // ?run=<id> views a specific run; default stays the latest.
        const requested = url.searchParams.get("run");
        const target = (requested && requested.trim()) || runId || latestRunId(repoRoot);
        const model = modelForRun(repoRoot, target);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(model));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      // Never let a bad request take the dashboard down.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
  });
  server.on("error", (err) => process.stderr.write(`[bgsd-gui] server error: ${err.message}\n`));

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      const url = `http://localhost:${actualPort}`;
      writePointer(repoRoot, {
        pid: process.pid,
        port: actualPort,
        url,
        run_id: resolvedRun,
        started_at: new Date().toISOString(),
      });
      resolve({ url, port: actualPort, runId: resolvedRun, server });
    });
  });
}

/** Stop the running dashboard by pid from the pointer file. */
export function stopServer(repoRoot) {
  const ptr = readPointer(repoRoot);
  if (!ptr || !ptr.pid) return { stopped: false, reason: "no dashboard is running" };
  try {
    process.kill(ptr.pid, "SIGTERM");
  } catch (err) {
    clearPointer(repoRoot);
    return { stopped: false, reason: `process ${ptr.pid} not found (cleared stale pointer)` };
  }
  clearPointer(repoRoot);
  return { stopped: true, pid: ptr.pid, url: ptr.url };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return flags;
}

export async function main() {
  const out = (s) => process.stdout.write(s);
  const repoRoot = resolveRepoRoot();
  const argv = process.argv.slice(2);
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "start";
  const flags = parseFlags(argv);

  if (sub === "stop") {
    const r = stopServer(repoRoot);
    out(r.stopped ? `\nbgsd-gui stopped (pid ${r.pid}, was ${r.url}).\n\n` : `\nbgsd-gui: ${r.reason}.\n\n`);
    return;
  }

  if (sub === "status") {
    const ptr = readPointer(repoRoot);
    if (!ptr) { out(`\nbgsd-gui: not running.\n\n`); return; }
    out(`\nbgsd-gui: running at ${ptr.url}  (pid ${ptr.pid}, run ${ptr.run_id ?? "—"}, since ${ptr.started_at}).\n\n`);
    return;
  }

  if (sub === "stage") {
    const stage = argv[1] && !argv[1].startsWith("--") ? argv[1] : flags.stage;
    const r = setStage(repoRoot, {
      runId: typeof flags["run-id"] === "string" ? flags["run-id"] : undefined,
      stage: typeof stage === "string" ? stage : undefined,
      note: typeof flags.note === "string" ? flags.note : undefined,
      state: typeof flags.state === "string" ? flags.state : undefined,
    });
    out(`\nbgsd-gui: run ${r.run_id} → stage ${r.stage ?? "—"}${r.note ? ` (${r.note})` : ""}\n\n`);
    return;
  }

  // start
  const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : null;
  const port = typeof flags.port === "string" ? Number(flags.port) : 0;
  const resolvedRun = runId ?? latestRunId(repoRoot);

  if (flags["plan-only"] || flags["dry-run"]) {
    out(`\nbgsd-gui plan (--plan-only) — repo: ${repoRoot}\n`);
    out(`  would serve the live dashboard for run: ${resolvedRun ?? "(latest, none found)"}\n`);
    out(`  port: ${port === 0 ? "auto (free port)" : port}\n`);
    out(`  reads: .bgsd/runs/<run-id>/control/*.json  (read-only, never writes main)\n\n`);
    return;
  }

  const { url, runId: r } = await startServer(repoRoot, { runId, port });
  out(`\nbgsd-gui live at ${url}\n`);
  out(`  tracking run: ${r ?? "(none yet — will show agents as they start)"}\n`);
  out(`  open ${url} in your browser. Stop it with: node gui-live.mjs stop\n\n`);
  // Keep the process alive; the server holds the event loop open.
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]gui-live\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
