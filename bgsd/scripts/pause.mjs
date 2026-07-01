#!/usr/bin/env node
/**
 * pause.mjs — /bgsd-pause: cleanly park a running session and snapshot it so
 *             /bgsd-resume can pick it back up at EXACTLY the same stage.
 *
 * WHERE THIS SITS
 * ===============
 * A bgsd run tracks its macro lifecycle in `.bgsd/runs/<id>/run.json` (see
 * run.mjs) and each in-flight unit's fine-grained state in per-agent control
 * files under `.bgsd/runs/<id>/control/<agent>.json` (see control.mjs). Abort
 * (run.mjs:abortRun) is a TERMINAL stop. Pause is the opposite: a NON-terminal
 * hold that remembers where the run stood so it can continue later untouched.
 *
 * THE CONTRACT (PAUSE-01)
 * =======================
 *   pauseRun({ runId, bgsdDir, reason, note, now }) does four things:
 *     1. Reads run.json, records the pre-pause state as `resume_state` (the
 *        exact state to return to), plus `paused_at` / `pause_reason` / a
 *        `pause_note`, then sets `state: "paused"` — all in ONE atomic write via
 *        run.mjs's writeRunAtomic (no duplicated atomic-write logic).
 *     2. Writes a human-readable `PAUSE.md` snapshot: the title, the current
 *        stage, the resume_state, each in-flight agent (unit / phase / status /
 *        one-line note) from the control files, which units/waves are still
 *        pending, and the exact next step to resume. This is the "resume
 *        exactly" record a human (or a fresh Conductor) can read.
 *     3. Appends a ledger line ("PAUSED at <stage>").
 *     4. Returns a compact summary object.
 *
 * A paused run stays non-terminal on purpose: resume moves it straight back to
 * `resume_state` and continues. `resumePausedRun()` is the inverse — it clears
 * the pause marker and restores the recorded state.
 *
 * PURE-ISH / TESTABLE
 * ===================
 * The clock is injectable (`now`), all filesystem writes go through the shared
 * run.mjs atomic writer, and the control-file reads go through control.mjs. No
 * process is killed here (mirrors abortRun): the Conductor is responsible for
 * having let in-flight agents reach a safe point before calling pause.
 */

import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readRun, runJsonPath, writeRunAtomic } from "./run.mjs";
import { readAllControlFiles } from "./control.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Agent statuses that mean a unit is still in flight (mirrors resume.mjs). */
const IN_FLIGHT_AGENT_STATUSES = new Set([
  "running",
  "stalled",
  "blocked",
  "needs_input",
]);

/**
 * The macro stage of a run, for the snapshot header. Uses run.json's `stage`
 * (the dashboard pipeline stage the Conductor advances) when present, else
 * falls back to the lifecycle `state`.
 *
 * @param {object} run  parsed run.json
 * @returns {string}
 */
function stageOf(run) {
  return run?.stage ?? run?.state ?? "unknown";
}

/**
 * Read the run's per-agent control files and split them into in-flight vs
 * finished, projecting a compact per-agent view for the snapshot.
 *
 * @param {string} bgsdDir
 * @param {string} runId
 * @returns {{ inFlight: object[], finished: object[], all: object[] }}
 */
function readAgents(bgsdDir, runId) {
  const controlDir = join(bgsdDir, "runs", runId, "control");
  let files = [];
  try {
    files = existsSync(controlDir) ? readAllControlFiles(controlDir).files : [];
  } catch (_) {
    files = [];
  }
  const project = (c) => ({
    agent_id: c.agent_id ?? "unknown",
    unit_id: c.unit_id ?? null,
    phase: c.phase ?? null,
    status: c.status ?? "unknown",
    note: c?.progress?.note ?? "",
  });
  const all = files.map(project);
  const inFlight = all.filter((a) => IN_FLIGHT_AGENT_STATUSES.has(a.status));
  const finished = all.filter((a) => !IN_FLIGHT_AGENT_STATUSES.has(a.status));
  return { inFlight, finished, all };
}

/**
 * Which units are still pending: any unit declared on run.json.units that has
 * no finished (done/failed) control file. Best-effort — run.json only carries
 * unit ids, and a pre-fan-out pause may have no control files at all.
 *
 * @param {object} run  parsed run.json
 * @param {object[]} all  projected agents (from readAgents)
 * @returns {string[]}
 */
function pendingUnits(run, all) {
  const units = Array.isArray(run?.units) ? run.units : [];
  const finishedUnitIds = new Set(
    all.filter((a) => !IN_FLIGHT_AGENT_STATUSES.has(a.status)).map((a) => a.unit_id)
  );
  return units.filter((u) => !finishedUnitIds.has(u));
}

/**
 * Render the human-readable PAUSE.md snapshot.
 *
 * @param {object} opts
 * @param {object} opts.run          parsed run.json (already carrying resume_state)
 * @param {object[]} opts.inFlight   in-flight agents
 * @param {object[]} opts.finished   finished agents
 * @param {string[]} opts.pending    pending unit ids
 * @param {string} opts.pausedAt     ISO timestamp
 * @param {string} opts.resumeState  the state to return to
 * @returns {string}
 */
export function renderPauseSnapshot({ run, inFlight, finished, pending, pausedAt, resumeState }) {
  const title = run.title ?? run.run_id ?? "(untitled run)";
  const stage = stageOf(run);
  const note = run.pause_note ? `\n> ${run.pause_note}\n` : "";

  const lines = [];
  lines.push(`# PAUSED — ${title}`);
  lines.push("");
  lines.push(`> Session \`${run.run_id}\` was paused at stage **${stage}**.`);
  lines.push(`> \`/bgsd-resume\` continues from exactly here.`);
  if (note) lines.push(note.trimEnd());
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  lines.push(`- **Run:** \`${run.run_id}\``);
  lines.push(`- **Stage:** ${stage}`);
  lines.push(`- **Resume state:** \`${resumeState}\`  ← the run returns to this exact state`);
  lines.push(`- **Paused at:** ${pausedAt}`);
  if (run.pause_reason) lines.push(`- **Reason:** ${run.pause_reason}`);
  lines.push("");

  lines.push("## In-flight units (parked mid-work)");
  lines.push("");
  if (inFlight.length === 0) {
    lines.push("_None — no unit was mid-execution when the session paused._");
  } else {
    for (const a of inFlight) {
      const label = a.unit_id && a.unit_id !== a.agent_id ? `${a.agent_id} (${a.unit_id})` : a.agent_id;
      const oneLine = a.note ? ` — ${a.note.replace(/\s+/g, " ").trim()}` : "";
      lines.push(`- **${label}** · phase \`${a.phase ?? "?"}\` · status \`${a.status}\`${oneLine}`);
    }
  }
  lines.push("");

  if (finished.length > 0) {
    lines.push("## Finished units (not re-done on resume)");
    lines.push("");
    for (const a of finished) {
      const label = a.unit_id && a.unit_id !== a.agent_id ? `${a.agent_id} (${a.unit_id})` : a.agent_id;
      lines.push(`- ${label} · status \`${a.status}\``);
    }
    lines.push("");
  }

  lines.push("## Pending units / waves");
  lines.push("");
  if (pending.length === 0) {
    lines.push("_No pending units recorded (either all are accounted for, or the run paused before fan-out)._");
  } else {
    for (const u of pending) lines.push(`- ${u}`);
  }
  const waves = Array.isArray(run?.waves) ? run.waves : [];
  if (waves.length > 0) {
    lines.push("");
    lines.push("Waves:");
    for (const w of waves) {
      const units = Array.isArray(w?.units) ? w.units.join(", ") : "";
      lines.push(`- wave ${w?.wave ?? "?"}: ${units}`);
    }
  }
  lines.push("");

  lines.push("## To resume exactly here");
  lines.push("");
  lines.push("```");
  lines.push(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/resume-live.mjs" ${run.run_id}`);
  lines.push("```");
  lines.push("");
  lines.push(
    `On resume, the run is restored to \`${resumeState}\`, the paused marker is ` +
    `cleared, and the Conductor re-enters that stage: finished units are left ` +
    `alone, in-flight units continue from their last recorded phase, and pending ` +
    `units/waves are dispatched as they would have been. Verification is never ` +
    `skipped, and \`main\` stays protected throughout.`
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Return the path to a run's PAUSE.md snapshot.
 * @param {string} bgsdDir
 * @param {string} runId
 * @returns {string}
 */
export function pauseSnapshotPath(bgsdDir, runId) {
  return join(bgsdDir, "runs", runId, "PAUSE.md");
}

/**
 * Append a "PAUSED at <stage>" line to the global ledger. Mirrors
 * run.mjs:appendLedgerEntry's format so paused runs read consistently in the
 * ledger index. Creates the ledger with a header when missing.
 *
 * @param {string} bgsdDir
 * @param {object} run       parsed run.json (post-pause)
 * @param {string} stage
 */
export function appendPauseLedgerEntry(bgsdDir, run, stage) {
  const ledgerPath = join(bgsdDir, "ledger.md");
  const title = (run.title ?? run.run_id ?? "").replace(/\n/g, " ");
  const prompt = `PAUSED at ${stage}`;
  const line = `| ${title} | ${run.run_id} | paused | ${run.created_at ?? ""} | ${prompt} |\n`;

  if (!existsSync(ledgerPath)) {
    writeFileSync(
      ledgerPath,
      "# bgsd Run Ledger\n\n" +
      "| Title | Run ID | State | Created At | Prompt |\n" +
      "|-------|--------|-------|------------|--------|\n",
      "utf8"
    );
  }
  const existing = readFileSync(ledgerPath, "utf8");
  writeFileSync(ledgerPath, existing + line, "utf8");
}

/**
 * Pause a run: snapshot everything and park it in the non-terminal "paused"
 * state so /bgsd-resume can restore it to exactly the same stage.
 *
 * Idempotent-ish: pausing an already-paused run just refreshes the snapshot and
 * keeps the original `resume_state` (it does not overwrite it with "paused").
 * Refuses to pause a terminal run (done/aborted/blocked/needs_input) — there is
 * nothing to resume.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.bgsdDir            Absolute path to the .bgsd directory
 * @param {string} [opts.reason="manual_pause"]
 * @param {string} [opts.note]             A one-line human note carried into PAUSE.md
 * @param {Function|number} [opts.now]     Injectable clock: () => ms | ms value
 * @returns {{
 *   run_id: string, resume_state: string, stage: string, paused_at: string,
 *   in_flight: number, pending: number, snapshot_path: string
 * }}
 */
export function pauseRun({ runId, bgsdDir, reason = "manual_pause", note = null, now } = {}) {
  if (!runId) throw new Error("pauseRun: runId is required");
  if (!bgsdDir) throw new Error("pauseRun: bgsdDir is required");

  const runPath = runJsonPath(bgsdDir, runId);
  const run = readRun(runPath); // throws loudly if run.json is missing/corrupt (NFR-06)

  const TERMINAL = new Set(["done", "aborted", "blocked", "needs_input"]);
  if (TERMINAL.has(run.state)) {
    throw new Error(
      `pauseRun: run "${runId}" is in terminal state "${run.state}" — nothing to pause`
    );
  }

  const nowMs = typeof now === "function" ? now() : typeof now === "number" ? now : Date.now();
  const pausedAt = new Date(nowMs).toISOString();

  // The state to return to. If already paused, keep the original resume_state.
  const resumeState =
    run.state === "paused"
      ? run.resume_state ?? "executing"
      : run.state;

  const stage = stageOf(run);

  // 1. One atomic write flipping the run to "paused" + the resume marker.
  const paused = {
    ...run,
    state: "paused",
    resume_state: resumeState,
    resume_stage: run.stage ?? null,
    paused_at: pausedAt,
    pause_reason: reason,
    pause_note: note ?? run.pause_note ?? null,
    updated_at: pausedAt,
    transitions: [
      ...(run.transitions ?? []),
      { from: run.state, to: "paused", at: pausedAt, meta: { reason, resume_state: resumeState } },
    ],
  };
  writeRunAtomic(runPath, paused);

  // 2. Human-readable snapshot.
  const { inFlight, finished, all } = readAgents(bgsdDir, runId);
  const pending = pendingUnits(paused, all);
  const snapshot = renderPauseSnapshot({
    run: paused,
    inFlight,
    finished,
    pending,
    pausedAt,
    resumeState,
  });
  const snapshotPath = pauseSnapshotPath(bgsdDir, runId);
  writeFileSync(snapshotPath, snapshot, "utf8");

  // 3. Ledger line.
  appendPauseLedgerEntry(bgsdDir, paused, stage);

  // 4. Summary.
  return {
    run_id: runId,
    resume_state: resumeState,
    stage,
    paused_at: pausedAt,
    in_flight: inFlight.length,
    pending: pending.length,
    snapshot_path: snapshotPath,
  };
}

/**
 * Restore a paused run: move it back to its recorded `resume_state` and clear
 * the paused marker. The inverse of pauseRun. Used by the resume path so a
 * paused run continues from EXACTLY where it left off.
 *
 * Writes through the shared atomic writer. A run that is not paused is returned
 * unchanged (no-op) so resume can call this unconditionally.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.bgsdDir
 * @param {Function|number} [opts.now]  Injectable clock
 * @returns {object}  the restored run.json object
 */
export function resumePausedRun({ runId, bgsdDir, now } = {}) {
  if (!runId) throw new Error("resumePausedRun: runId is required");
  if (!bgsdDir) throw new Error("resumePausedRun: bgsdDir is required");

  const runPath = runJsonPath(bgsdDir, runId);
  const run = readRun(runPath);

  if (run.state !== "paused") return run; // not paused — nothing to restore

  const nowMs = typeof now === "function" ? now() : typeof now === "number" ? now : Date.now();
  const at = new Date(nowMs).toISOString();

  const target = run.resume_state ?? "executing";
  const restored = {
    ...run,
    state: target,
    stage: run.resume_stage ?? run.stage ?? null,
    updated_at: at,
    resumed_from_pause_at: at,
    // Clear the pause markers so the run reads clean once running again.
    resume_state: null,
    resume_stage: null,
    paused_at: null,
    pause_reason: null,
    pause_note: null,
    transitions: [
      ...(run.transitions ?? []),
      { from: "paused", to: target, at, meta: { resumed_from_pause: true } },
    ],
  };
  writeRunAtomic(runPath, restored);
  return restored;
}

// ---------------------------------------------------------------------------
// CLI — node pause.mjs --run-id <id> [--note "..."] [--reason "..."]
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]pause\.mjs$/.test(process.argv[1]);

if (invokedDirectly) {
  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = args[i + 1];
        if (next && !next.startsWith("--")) { flags[key] = next; i++; }
        else { flags[key] = true; }
      }
    }
    return flags;
  }

  const flags = parseFlags(process.argv.slice(2));
  const runId = flags.runId ?? flags.run ?? null;

  if (!runId) {
    process.stderr.write(
      "Usage: node pause.mjs --run-id <id> [--note \"...\"] [--reason \"...\"]\n"
    );
    process.exit(1);
  }

  // Resolve the target repo's .bgsd from cwd (bgsd runs in the USER's repo),
  // falling back to the plugin's own repo root for local smoke tests.
  let bgsdDir = flags.bgsdDir ?? null;
  if (!bgsdDir) {
    try {
      const { resolveRepoRoot } = await import(`file://${join(__dir, "init-live.mjs")}`);
      bgsdDir = join(resolveRepoRoot(), ".bgsd");
    } catch (_) {
      bgsdDir = join(__dir, "..", "..", ".bgsd");
    }
  }

  try {
    const summary = pauseRun({
      runId,
      bgsdDir,
      reason: typeof flags.reason === "string" ? flags.reason : "manual_pause",
      note: typeof flags.note === "string" ? flags.note : null,
    });
    process.stdout.write(
      `\nPaused ${summary.run_id} at stage "${summary.stage}".\n` +
      `  resume_state: ${summary.resume_state}\n` +
      `  in-flight units: ${summary.in_flight}, pending: ${summary.pending}\n` +
      `  snapshot: ${summary.snapshot_path}\n\n` +
      `Resume exactly here with: /bgsd-resume ${summary.run_id}\n\n`
    );
  } catch (err) {
    process.stderr.write(`pause.mjs: ${err.message}\n`);
    process.exit(1);
  }
}
