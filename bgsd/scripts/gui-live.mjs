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
import { buildDashboardModel } from "./gui.mjs";
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
      run = { run_id: runId, scale: r.scale ?? null, state: r.state ?? null };
    }
  } catch (_) { /* keep minimal run */ }
  return buildDashboardModel({ run, agents });
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
      if (req.url && req.url.startsWith("/api/state")) {
        const model = modelForRun(repoRoot, runId ?? latestRunId(repoRoot));
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
