#!/usr/bin/env node
/**
 * bgsd/scripts/status.mjs — Phase 7: Live Colorful Status View (STATUS-01..04)
 *
 * Pure `renderStatus({ run, agents, telemetry }) -> string` renderer.
 * Composes the Kiwi live view entirely from ui.mjs primitives.
 *
 * STATUS-01: Per-worktree badges, stage, Loop 1 iteration counts, merge state,
 *            where input is needed — zero model calls, reads control + ledger.
 * STATUS-02: Kiwi identity — mini 3-row banner variant, butler narration,
 *            constant 🔒 main-protected indicator.
 * STATUS-03: Live budget + context telemetry (tokens/$, parallelism multiplier,
 *            context-pressure / downshift state).
 * STATUS-04: NO_COLOR / non-TTY safe — degrades to plain text, no ANSI.
 *
 * Public API:
 *   renderStatus(input)  -> string   (pure, no process.stdout.write)
 *   printStatus(input)   -> void     (writes rendered string to stdout)
 *
 * Inputs:
 *   run       — run.json object (or null for an empty-run view)
 *   agents    — array of control-file objects (may be empty)
 *   telemetry — budget/context telemetry object (may be null)
 *
 * Watch loop (CLI):
 *   node bgsd/scripts/status.mjs [--run-id <id>] [--watch [N]] [--bgsd-dir <dir>]
 *
 * The watch loop re-reads run.json + control files every N seconds (default 3)
 * and re-renders. It never spawns anything — pure read + render.
 */

import process from "node:process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Re-export COLOR_OK so test-status.mjs can check plain degradation
// ---------------------------------------------------------------------------

/**
 * True when the terminal supports ANSI color.
 * Mirrors ui.mjs's COLOR_OK — replicated here so the renderer is self-contained.
 */
const COLOR_OK =
  !process.env["NO_COLOR"] &&
  !process.env["CI"]?.match(/^(true|1)$/i) &&
  (process.stdout.isTTY ?? false);

// ---------------------------------------------------------------------------
// Inline ANSI helpers (mirrors ui.mjs — no import needed for pure string build)
// ---------------------------------------------------------------------------

function ansi(text, open, close) {
  if (!COLOR_OK) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

const bold         = (t) => ansi(t, 1, 22);
const dim          = (t) => ansi(t, 2, 22);
const red          = (t) => ansi(t, 31, 39);
const green        = (t) => ansi(t, 32, 39);
const yellow       = (t) => ansi(t, 33, 39);
const blue         = (t) => ansi(t, 34, 39);
const magenta      = (t) => ansi(t, 35, 39);
const cyan         = (t) => ansi(t, 36, 39);
const white        = (t) => ansi(t, 37, 39);
const brightRed    = (t) => ansi(t, 91, 39);
const brightGreen  = (t) => ansi(t, 92, 39);
const brightYellow = (t) => ansi(t, 93, 39);
const brightCyan   = (t) => ansi(t, 96, 39);

// ---------------------------------------------------------------------------
// Badge definitions (mirrors ui.mjs BADGE_DEFS — reused via inline for purity)
// ---------------------------------------------------------------------------

const BADGE_DEFS = {
  "running":     { color: brightYellow, symbol: "⟳", label: "RUNNING"     },
  "blocked":     { color: yellow,       symbol: "⏸", label: "BLOCKED"     },
  "needs_input": { color: brightCyan,   symbol: "?", label: "NEEDS INPUT" },
  "needs-input": { color: brightCyan,   symbol: "?", label: "NEEDS INPUT" },
  "done":        { color: brightGreen,  symbol: "✓", label: "DONE"        },
  "failed":      { color: brightRed,    symbol: "✗", label: "FAILED"      },
  "stalled":     { color: yellow,       symbol: "⏸", label: "STALLED"     },
};

function badge(state) {
  const def = BADGE_DEFS[state];
  if (!def) return `[${state ?? "unknown"}]`;
  return def.color(`[${def.symbol} ${def.label}]`);
}

function hr(width = 52) {
  return dim("─".repeat(width));
}

// ---------------------------------------------------------------------------
// Run-state color map
// ---------------------------------------------------------------------------

const RUN_STATE_COLORS = {
  created:     dim,
  decomposed:  cyan,
  spawning:    brightYellow,
  executing:   brightYellow,
  verifying:   brightYellow,
  merging:     magenta,
  checkpoint:  brightCyan,
  done:        brightGreen,
  aborted:     brightRed,
  blocked:     yellow,
  needs_input: brightCyan,
};

function colorState(state) {
  const fn = RUN_STATE_COLORS[state] ?? white;
  return fn(state ?? "—");
}

// ---------------------------------------------------------------------------
// Mini Kiwi banner (3-row variant for /bgsd-status) — STATUS-02
// ---------------------------------------------------------------------------

function miniBanner() {
  const lines = [];
  lines.push(bold(cyan("╔══════════════════════════════════════════════════╗")));
  lines.push(
    bold(cyan("║")) +
    "  " + bold(brightCyan("Kiwi")) + dim(cyan("  ·  bgsd Conductor")) +
    "                          " +
    bold(cyan("║"))
  );
  lines.push(
    bold(cyan("║")) +
    "  " + dim(cyan("/bgsd-status")) +
    "  " + bold(brightGreen("🔒 main-protected")) +
    "                    " +
    bold(cyan("║"))
  );
  lines.push(bold(cyan("╚══════════════════════════════════════════════════╝")));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run overview section — STATUS-01/02
// ---------------------------------------------------------------------------

function renderRunOverview(run) {
  if (!run) {
    return [
      bold(blue("▶")) + "  " + bold(white("No active run")),
      dim("  Start one with: /bgsd-run \"<your prompt>\""),
    ].join("\n");
  }

  const stateStr  = colorState(run.state);
  const runId     = bold(run.run_id ?? "—");
  const waves     = run.waves?.length > 0
    ? `${run.waves.length} wave${run.waves.length !== 1 ? "s" : ""}`
    : "—";
  const unitCount = Array.isArray(run.units) ? run.units.length : 0;
  const created   = run.created_at ? dim(run.created_at.slice(0, 19).replace("T", " ")) : "";

  const lines = [];
  lines.push(bold(blue("▶")) + "  " + bold(white("Run:")) + "  " + runId + "  " + dim("|") + "  " + stateStr);
  lines.push("   " + dim("Created:") + "  " + created + "   " + dim("Units:") + " " + unitCount + "   " + dim("Waves:") + " " + waves);

  // Show wave-by-wave breakdown if available
  if (Array.isArray(run.waves) && run.waves.length > 0) {
    const waveStr = run.waves
      .map((w, i) => `${dim("wave")} ${i + 1}${dim(":")} ${Array.isArray(w.units) ? w.units.length : "?"}${dim(" units")}`)
      .join("  ");
    lines.push("   " + waveStr);
  }

  // Latest checkpoint
  const checkpoints = run.checkpoints ?? [];
  if (checkpoints.length > 0) {
    const last = checkpoints[checkpoints.length - 1];
    const pending = last.go === null;
    const label = pending
      ? brightCyan("⏳ Awaiting go/no-go at checkpoint " + last.checkpoint_id)
      : (last.go ? brightGreen("✓ Checkpoint approved") : brightRed("✗ Checkpoint rejected"));
    lines.push("   " + label);
    if (pending && Array.isArray(last.blockers) && last.blockers.length > 0) {
      lines.push("   " + brightCyan("  Open blockers: " + last.blockers.length));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Agent table — STATUS-01 (per-worktree: badge, phase, iteration, commits, blocker)
// ---------------------------------------------------------------------------

function renderAgentTable(agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return dim("  (No active workers)");
  }

  const lines = [];
  lines.push(hr(52));
  lines.push(bold(white("  Workers")) + "  " + dim(`(${agents.length} total)`));
  lines.push(hr(52));

  // Sort: needs_input first, then blocked, then running, then others
  const ORDER = { needs_input: 0, "needs-input": 0, blocked: 1, stalled: 2, running: 3, failed: 4, done: 5 };
  const sorted = [...agents].sort((a, b) => {
    const ao = ORDER[a.status] ?? 10;
    const bo = ORDER[b.status] ?? 10;
    return ao - bo;
  });

  for (const agent of sorted) {
    const b        = badge(agent.status ?? "running");
    const agentId  = bold(agent.agent_id ?? "?");
    const phase    = agent.phase ? dim(`[${agent.phase}]`) : "";
    const iter     = agent.progress
      ? cyan(`iter ${agent.progress.iteration ?? 0}/${agent.progress.max_iterations ?? "?"}`)
      : "";
    const commits  = Array.isArray(agent.commits) && agent.commits.length > 0
      ? dim(`${agent.commits.length} commit${agent.commits.length !== 1 ? "s" : ""}`)
      : "";
    const branch   = agent.branch ? dim(agent.branch.slice(0, 32)) : "";
    const restarts = (agent.restart_count ?? 0) > 0
      ? yellow(` [restarted×${agent.restart_count}]`)
      : "";

    // Main line
    lines.push(`  ${b}  ${agentId}  ${phase}  ${iter}  ${commits}${restarts}`);

    // Branch
    if (branch) {
      lines.push(`        ${dim("branch:")} ${branch}`);
    }

    // Blocker / escalation — unmissable highlight (STATUS-01 "where input is needed")
    const openBlockers = (agent.blockers ?? []).filter((bk) => !bk.resolved);
    const openEscalations = (agent.escalations ?? []).filter((e) => !e.resolved);

    if (openEscalations.length > 0) {
      for (const e of openEscalations) {
        lines.push(
          "        " +
          brightCyan("⚠ NEEDS YOUR INPUT: ") +
          bold(e.question ?? "unknown question") +
          " " + dim(`[${e.severity ?? "high"}]`)
        );
      }
    } else if (openBlockers.length > 0) {
      for (const bk of openBlockers) {
        const flag = bk.severity === "high" ? brightRed("⛔") : yellow("⚠");
        lines.push(
          "        " +
          flag + "  " +
          yellow("BLOCKED: ") + dim(bk.question ?? "unknown") +
          " " + dim(`[${bk.severity ?? "?"}]`)
        );
      }
    }

    // Note
    if (agent.progress?.note) {
      lines.push("        " + dim(agent.progress.note));
    }
  }

  lines.push(hr(52));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Merge state section — STATUS-01
// ---------------------------------------------------------------------------

function renderMergeState(run) {
  if (!run) return "";

  const checkpoints = run.checkpoints ?? [];
  if (checkpoints.length === 0) return "";

  const lines = [];
  lines.push(bold(white("  Merge History")) + "  " + dim(`(${checkpoints.length} checkpoint${checkpoints.length !== 1 ? "s" : ""})`));

  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    const merged = (cp.merged ?? []).length;
    const held   = (cp.held   ?? []).length;
    const status = cp.go === null
      ? brightCyan("⏳ pending")
      : cp.go ? brightGreen("✓ approved") : brightRed("✗ rejected");

    lines.push(
      `    wave ${cp.wave_index ?? i}: ` +
      brightGreen(`${merged} merged`) + "  " +
      (held > 0 ? brightRed(`${held} held`) : dim("0 held")) + "  " +
      status
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Budget + context telemetry — STATUS-03
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Telemetry
 * @property {number}  [tokensUsed]       Running token count
 * @property {number}  [tokenCap]         Per-run cap
 * @property {number}  [costUsdCents]     Estimated cost in cents
 * @property {number}  [costCapUsdCents]  Per-run $ cap in cents
 * @property {number}  [parallelism]      Workers currently spawned
 * @property {number}  [fanOutMultiplier] parallelism × per-worker GSD fan-out
 * @property {string}  [contextPressure]  "normal"|"elevated"|"critical"
 * @property {boolean} [downshiftActive]  true when effort downshift is in effect
 * @property {string}  [downshiftReason]  why downshift was triggered
 */

function renderTelemetry(telemetry) {
  if (!telemetry) {
    return dim("  Budget & context telemetry not yet available.");
  }

  const lines = [];

  // Token usage
  if (telemetry.tokensUsed != null) {
    const used   = telemetry.tokensUsed.toLocaleString();
    const cap    = telemetry.tokenCap != null ? telemetry.tokenCap.toLocaleString() : "—";
    const pct    = telemetry.tokenCap > 0
      ? Math.round((telemetry.tokensUsed / telemetry.tokenCap) * 100)
      : null;
    const bar    = pct != null ? ` ${renderBar(pct)}` : "";
    const pctStr = pct != null ? ` ${colorPct(pct)}% of cap` : "";
    lines.push(`  ${bold("Tokens:")} ${cyan(used)} / ${dim(cap)}${pctStr}${bar}`);
  }

  // Cost
  if (telemetry.costUsdCents != null) {
    const cost    = `$${(telemetry.costUsdCents / 100).toFixed(4)}`;
    const capStr  = telemetry.costCapUsdCents != null
      ? ` / $${(telemetry.costCapUsdCents / 100).toFixed(2)} cap`
      : "";
    lines.push(`  ${bold("Cost:")}   ${yellow(cost)}${dim(capStr)}`);
  }

  // Parallelism
  if (telemetry.parallelism != null) {
    const par  = bold(String(telemetry.parallelism));
    const mult = telemetry.fanOutMultiplier != null
      ? `  ${dim("fan-out:")} ${magenta("×" + telemetry.fanOutMultiplier)}`
      : "";
    lines.push(`  ${bold("Workers:")} ${par}${mult}`);
  }

  // Context pressure
  if (telemetry.contextPressure != null) {
    const pressure = telemetry.contextPressure;
    const color = pressure === "critical" ? brightRed
                : pressure === "elevated" ? yellow
                : brightGreen;
    lines.push(`  ${bold("Ctx pressure:")} ${color(pressure.toUpperCase())}`);
  }

  // Downshift indicator — visible, never silent (NFR-08/09)
  if (telemetry.downshiftActive) {
    lines.push(
      `  ${brightYellow("⬇ Downshift active:")} ${dim(telemetry.downshiftReason ?? "budget/context threshold reached")}`
    );
  }

  if (lines.length === 0) {
    return dim("  No telemetry data.");
  }

  return lines.join("\n");
}

function renderBar(pct) {
  const filled = Math.round(pct / 5);   // 20 chars wide
  const empty  = 20 - filled;
  const bar    = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
  const color  = pct >= 90 ? brightRed : pct >= 70 ? yellow : brightGreen;
  return dim("[") + color(bar) + dim("]");
}

function colorPct(pct) {
  if (pct >= 90) return brightRed(String(pct));
  if (pct >= 70) return yellow(String(pct));
  return brightGreen(String(pct));
}

// ---------------------------------------------------------------------------
// Butler narration line — STATUS-02 (Kiwi voice, human-facing)
// ---------------------------------------------------------------------------

function kiwiNarration(run, agents) {
  if (!run) {
    return dim("Awaiting a run, sir. Try /bgsd-run \"<your prompt>\" to get started.");
  }

  const state   = run.state;
  const total   = Array.isArray(agents) ? agents.length : 0;
  const running = Array.isArray(agents)
    ? agents.filter((a) => a.status === "running").length
    : 0;
  const blocked = Array.isArray(agents)
    ? agents.filter((a) => a.status === "blocked" || a.status === "needs_input").length
    : 0;
  const done    = Array.isArray(agents)
    ? agents.filter((a) => a.status === "done").length
    : 0;
  const waves   = Array.isArray(run.waves) ? run.waves.length : 0;
  const currentWave = (run.checkpoints ?? []).length + 1;

  // Map state to Kiwi narration
  if (state === "created" || state === "decomposed") {
    return dim("Kiwi is decomposing your prompt, sir — the dependency graph is being assembled.");
  }
  if (state === "spawning") {
    return dim(`Kiwi is fanning out the worktrees, sir — ${total} worker${total !== 1 ? "s" : ""} are being prepared.`);
  }
  if (state === "executing" || state === "verifying") {
    const runningStr = running > 0 ? `${running} worker${running !== 1 ? "s" : ""} underway` : "workers running";
    const waveStr    = waves > 0 ? `, sir — wave ${Math.min(currentWave, waves)} of ${waves}` : ", sir";
    if (blocked > 0) {
      return dim(`${runningStr}${waveStr}. ${blocked} worker${blocked !== 1 ? "s need" : " needs"} your attention.`);
    }
    return dim(`${runningStr}${waveStr}.`);
  }
  if (state === "merging") {
    return dim(`Kiwi is merging verified branches into the rehearsal branch, sir — ${done} of ${total} done.`);
  }
  if (state === "checkpoint") {
    return brightCyan("Kiwi needs your go/no-go at the merge boundary, sir. Please review and respond.");
  }
  if (state === "done") {
    return brightGreen(`Run complete, sir — ${done} unit${done !== 1 ? "s" : ""} merged successfully. Rehearsal branch is ready for inspection.`);
  }
  if (state === "aborted") {
    return brightRed("Run aborted, sir. All branches and control files have been preserved.");
  }
  if (state === "blocked" || state === "needs_input") {
    return brightCyan("Kiwi needs your input, sir — one or more workers are awaiting a decision.");
  }

  return dim(`Run is in state: ${state}`);
}

// ---------------------------------------------------------------------------
// Main renderer — pure function, returns a string (STATUS-01..04)
// ---------------------------------------------------------------------------

/**
 * Pure status renderer. Returns a complete, colored (or plain) string
 * representing the live status view. Never writes to stdout.
 *
 * @param {object} input
 * @param {object|null}  input.run        run.json object (or null)
 * @param {object[]}     input.agents     array of control-file objects
 * @param {Telemetry|null} input.telemetry budget/context telemetry object
 * @returns {string}
 */
export function renderStatus({ run, agents = [], telemetry = null }) {
  const parts = [];

  // 1. Mini Kiwi banner (3-row) with 🔒 main-protected (STATUS-02)
  parts.push("");
  parts.push(miniBanner());
  parts.push("");

  // 2. Butler narration (STATUS-02)
  parts.push("  " + kiwiNarration(run, agents));
  parts.push("");

  // 3. Run overview: state, wave, units (STATUS-01)
  parts.push(renderRunOverview(run));
  parts.push("");

  // 4. Agent/worktree table (STATUS-01)
  parts.push(renderAgentTable(agents));
  parts.push("");

  // 5. Merge state history (STATUS-01)
  const mergeSection = renderMergeState(run);
  if (mergeSection) {
    parts.push(hr(52));
    parts.push(bold(white("  Merge State")));
    parts.push(hr(52));
    parts.push(mergeSection);
    parts.push("");
  }

  // 6. Budget + context telemetry (STATUS-03)
  parts.push(hr(52));
  parts.push(bold(white("  Budget & Context")));
  parts.push(hr(52));
  parts.push(renderTelemetry(telemetry));
  parts.push("");

  // 7. Footer: 🔒 main-protected reminder (STATUS-02) + timestamp
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
  parts.push(hr(52));
  parts.push(
    "  " + bold(brightGreen("🔒 main-protected")) + "  " +
    dim("rehearsal/* only — next/main never written by bgsd") +
    "  " + dim(ts)
  );
  parts.push("");

  return parts.join("\n");
}

/**
 * Write the rendered status view to stdout.
 * Thin wrapper over renderStatus for CLI use.
 *
 * @param {object} input  Same shape as renderStatus input
 */
export function printStatus(input) {
  process.stdout.write(renderStatus(input));
}

// ---------------------------------------------------------------------------
// State loader — reads run.json + control files from .bgsd/
// ---------------------------------------------------------------------------

/**
 * Load the current run + agents from disk.
 * Tolerant: returns nulls on missing files, never throws.
 *
 * @param {object} [opts]
 * @param {string}  [opts.runId]    If provided, loads that specific run.
 *                                  If omitted, loads the most-recent run from ledger.
 * @param {string}  [opts.bgsdDir]  Absolute path to .bgsd directory.
 * @returns {{ run: object|null, agents: object[], telemetry: object|null }}
 */
export function loadStatus({ runId, bgsdDir } = {}) {
  const dir = bgsdDir ?? join(REPO_ROOT, ".bgsd");

  // Resolve run-id: explicit or fall back to most-recent entry in ledger
  let resolvedRunId = runId;
  if (!resolvedRunId) {
    resolvedRunId = findLatestRunId(dir);
  }

  let run = null;
  let agents = [];

  if (resolvedRunId) {
    const runJsonP = join(dir, "runs", resolvedRunId, "run.json");
    if (existsSync(runJsonP)) {
      try {
        run = JSON.parse(readFileSync(runJsonP, "utf8"));
      } catch {
        // ignore parse error — show no run
      }
    }

    const controlDir = join(dir, "runs", resolvedRunId, "control");
    if (existsSync(controlDir)) {
      try {
        agents = readdirSync(controlDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            try {
              return JSON.parse(readFileSync(join(controlDir, f), "utf8"));
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        // ignore read error
      }
    }
  }

  return { run, agents, telemetry: null };
}

/**
 * Scan .bgsd/runs/ for the most recently created run by reading run.json files.
 *
 * @param {string} dir  Absolute path to .bgsd directory
 * @returns {string|null}  run-id or null
 */
function findLatestRunId(dir) {
  const runsDir = join(dir, "runs");
  if (!existsSync(runsDir)) return null;

  let latestId   = null;
  let latestTime = "";

  try {
    const entries = readdirSync(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runJsonP = join(runsDir, entry.name, "run.json");
      if (!existsSync(runJsonP)) continue;
      try {
        const data = JSON.parse(readFileSync(runJsonP, "utf8"));
        const ts   = data.created_at ?? "";
        if (ts > latestTime) {
          latestTime = ts;
          latestId   = entry.name;
        }
      } catch {
        // skip corrupted run.json
      }
    }
  } catch {
    // ignore readdirSync failure
  }

  return latestId;
}

// ---------------------------------------------------------------------------
// Watch loop (CLI) — re-renders every N seconds (STATUS-01 --watch mode)
// ---------------------------------------------------------------------------

const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/**
 * Run a watch loop: re-read state and re-render every intervalSecs seconds.
 * Never spawns anything — read + render only (NFR-05).
 *
 * @param {object} opts
 * @param {string}  [opts.runId]
 * @param {string}  [opts.bgsdDir]
 * @param {number}  [opts.intervalSecs=3]
 */
async function watchLoop({ runId, bgsdDir, intervalSecs = 3 } = {}) {
  let iteration = 0;

  // SIGINT / SIGTERM handler — clean exit
  let running = true;
  const stop = () => { running = false; };
  process.on("SIGINT",  stop);
  process.on("SIGTERM", stop);

  while (running) {
    const state = loadStatus({ runId, bgsdDir });
    const rendered = renderStatus(state);

    if (iteration > 0 && COLOR_OK) {
      // Clear screen for subsequent renders when colors are on
      process.stdout.write(CLEAR_SCREEN);
    }

    process.stdout.write(rendered);
    iteration++;

    // Sleep between refreshes, checking for stop every 0.5s
    let slept = 0;
    const target = intervalSecs * 1000;
    while (running && slept < target) {
      await new Promise((res) => setTimeout(res, Math.min(500, target - slept)));
      slept += 500;
    }
  }

  process.stdout.write("\n" + dim("[bgsd-status] Watch stopped.") + "\n");
}

// ---------------------------------------------------------------------------
// CLI entrypoint
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
  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg.startsWith("--")) continue;
      const key  = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
    return flags;
  }

  const flags = parseFlags(process.argv.slice(2));

  const runId    = flags.runId   ?? flags.run    ?? undefined;
  const bgsdDir  = flags.bgsdDir ?? flags.bgsd   ?? undefined;
  const watchArg = flags.watch;
  const doWatch  = watchArg !== undefined;
  const intervalSecs = typeof watchArg === "string" ? parseInt(watchArg, 10) || 3
                     : 3;

  if (doWatch) {
    watchLoop({ runId, bgsdDir, intervalSecs }).catch((err) => {
      process.stderr.write("[bgsd-status] Watch loop error: " + err.message + "\n");
      process.exit(1);
    });
  } else {
    // One-shot render
    const state = loadStatus({ runId, bgsdDir });
    printStatus(state);
  }
}
