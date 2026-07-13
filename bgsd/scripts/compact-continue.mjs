#!/usr/bin/env node
/**
 * compact-continue.mjs — SessionStart(compact) hook: never lose the sesh.
 *
 * The Conductor cannot invoke /compact itself, and after the harness
 * auto-compacts (or the user compacts manually) a mid-sesh Conductor would
 * otherwise sit idle until told to "keep going". This hook closes that gap:
 * it fires right after any compaction, checks whether a bgsd run is in
 * flight in this repo, and if so injects a directive telling the Conductor
 * to resume from the compact-handoff / control files and continue
 * immediately, without waiting for the user.
 *
 * Input  (stdin): SessionStart hook JSON ({ source, cwd, ... }).
 * Output (stdout): the continuation directive (added to context), or nothing.
 * Always exits 0 — a hook must never block the session.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_AGENT_STATUSES } from "./resume.mjs";

/** run.json lifecycle states that mean the run is finished — never auto-resumed. */
const RUN_TERMINAL_STATES = ["done", "failed", "aborted", "completed"];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function repoRootFrom(cwd) {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Scan .bgsd/runs and return the most recently active in-flight run, or null.
 * In-flight means: an unconsumed compact-handoff.json, OR run.json state
 * "paused", OR any control file whose status is not terminal (done/failed).
 * @param {string} runsDir
 * @returns {{ runId: string, hasHandoff: boolean } | null}
 */
export function findInFlightRun(runsDir) {
  if (!existsSync(runsDir)) return null;
  let best = null;
  for (const runId of readdirSync(runsDir)) {
    const dir = join(runsDir, runId);
    let mtime;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    const handoffPath = join(dir, "compact-handoff.json");
    const hasHandoff = existsSync(handoffPath);
    // run.json's own state is authoritative and checked FIRST: a run that has
    // finished (done/failed/aborted/completed) is never resurrected, even if it
    // left a stale non-terminal control file or a leftover handoff. "paused" is
    // a deliberate stop, also not auto-continued.
    const run = readJson(join(dir, "run.json"));
    let inFlight;
    if (RUN_TERMINAL_STATES.includes(run?.state) || run?.state === "paused") {
      inFlight = false;
    } else if (hasHandoff) {
      inFlight = true;
    } else {
      inFlight = false;
      const controlDir = join(dir, "control");
      if (existsSync(controlDir)) {
        for (const f of readdirSync(controlDir)) {
          if (!f.endsWith(".json")) continue;
          const c = readJson(join(controlDir, f));
          if (c && !TERMINAL_AGENT_STATUSES.includes(c.status)) {
            inFlight = true;
            break;
          }
        }
      }
    }
    if (hasHandoff) {
      try {
        mtime = Math.max(mtime, statSync(handoffPath).mtimeMs);
      } catch {}
    }
    if (inFlight && (!best || mtime > best.mtime)) best = { runId, hasHandoff, mtime };
  }
  return best ? { runId: best.runId, hasHandoff: best.hasHandoff } : null;
}

/**
 * The directive injected into the freshly-compacted session.
 * @param {{ runId: string, hasHandoff: boolean }} hit
 * @returns {string}
 */
export function directive(hit) {
  const source = hit.hasHandoff
    ? `.bgsd/runs/${hit.runId}/compact-handoff.json (structured handoff) plus the run's control files`
    : `the run's control files, RUN.md, and run.json under .bgsd/runs/${hit.runId}/`;
  return [
    `[bgsd compact-continue] A bgsd sesh (run ${hit.runId}) is IN FLIGHT in this repo and this session was just compacted.`,
    `You are the bgsd Conductor. Do NOT wait for the user or ask permission: run /bgsd-resume now — it rehydrates from ${source} — and continue the pipeline exactly where it left off.`,
    `Announce it in one line under your pill ("Compacted and carrying on, sir.") and keep orchestrating.`,
  ].join("\n");
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {}
  if (input.source && input.source !== "compact") return;
  const root = repoRootFrom(input.cwd || process.cwd());
  const hit = findInFlightRun(join(root, ".bgsd", "runs"));
  if (hit) process.stdout.write(directive(hit) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch {}
  process.exit(0);
}
