# /bgsd-status

> **Kiwi · bgsd Conductor — Live Status View**
> Always-on, read-only snapshot of every active run, worker, and merge boundary.
> Zero model calls in the view path. NO_COLOR / non-TTY safe.

---

## What you see

`/bgsd-status` renders the full Kiwi live view:

| Section | What it shows |
|---------|---------------|
| **Banner** | Mini 3-row Kiwi header + permanent 🔒 main-protected indicator |
| **Butler narration** | One-line Kiwi summary: active workers, wave progress, pending input |
| **Run overview** | Run ID, lifecycle state (color-coded), wave count, unit count, created-at |
| **Worker table** | Every active worktree: color-coded badge, GSD phase, Loop 1 iteration count, commits, branch, any blocker or escalation |
| **Merge history** | Per-wave checkpoint: merged / held counts, go/no-go status |
| **Budget & context** | Running token/$ vs per-run cap, parallelism × fan-out multiplier, context-pressure level, downshift state |
| **Footer** | 🔒 main-protected reminder + UTC timestamp |

### Worker state badges

| Badge | Meaning |
|-------|---------|
| `[⟳ RUNNING]` (bright yellow) | Worker is executing |
| `[⏸ BLOCKED]` (yellow) | Worker hit a hard blocker; Conductor is trying to answer from context |
| `[? NEEDS INPUT]` (bright cyan) | Unanswerable blocker — **your attention is required** |
| `[✓ DONE]` (bright green) | Worker finished and is ready to merge |
| `[✗ FAILED]` (bright red) | Worker failed; branch is held back |

Workers that need your input are sorted to the top of the table and highlighted in bright cyan with the question text visible — so "where input is needed" is never buried.

### 🔒 main-protected indicator

The indicator `🔒 main-protected` appears in both the banner and the footer at all times. It is a constant visual reminder that bgsd never writes to `next` or any production branch. All work lands on `rehearsal/<run-id>` and ephemeral worktree branches only. Only you merge `rehearsal/<run-id>` → `next`, by hand.

### Budget & context telemetry

The telemetry section shows:

- **Tokens:** running count vs per-run cap, with a color-coded progress bar (green → yellow → red as you approach the cap)
- **Cost:** estimated spend in USD vs the cap
- **Workers:** active parallelism count and the fan-out multiplier (parallelism × GSD's own sub-agent fan-out)
- **Context pressure:** NORMAL / ELEVATED / CRITICAL — derived from the Conductor's context monitoring
- **Downshift indicator:** when the Conductor has triggered a graceful downshift (reducing effort or model tier to stay within budget), the reason is surfaced here — never silent

---

## Usage

### One-shot status

```
/bgsd-status
```

Renders a single snapshot of the current run and exits. Reads `.bgsd/runs/<latest-run-id>/run.json` and `.bgsd/runs/<latest-run-id>/control/*.json`.

To target a specific run:

```
node bgsd/scripts/status.mjs --run-id bgsd-0001-my-feature
```

### Live watch mode (--watch)

```
node bgsd/scripts/status.mjs --watch
```

Refreshes every 3 seconds (default). Specify a custom interval in seconds:

```
node bgsd/scripts/status.mjs --watch 5
```

The watch loop re-reads run.json and all control files on every tick. It never spawns any process, never calls a model, and exits cleanly on `Ctrl-C` (SIGINT/SIGTERM).

In a color terminal, each refresh clears the screen and re-renders from the top. In non-TTY or `NO_COLOR` mode, each refresh appends a new snapshot to stdout.

---

## NO_COLOR and non-TTY environments

`/bgsd-status` respects:

- `NO_COLOR=1` — all ANSI sequences stripped; output is plain text with bracket-enclosed badge labels (e.g. `[? NEEDS INPUT]`)
- `CI=true` — same as `NO_COLOR`
- non-TTY stdout (piped or redirected) — color automatically disabled

The structured layout (section headers, indentation, separators) remains fully legible in plain mode. Every badge label, state name, and indicator is still present — just without color.

---

## Implementation notes

- **Renderer:** `bgsd/scripts/status.mjs` — pure `renderStatus({ run, agents, telemetry }) -> string`. Fully injectable inputs; tested under `NO_COLOR` for deterministic assertions.
- **State source:** reads `.bgsd/runs/<run-id>/run.json` (lifecycle state) and `.bgsd/runs/<run-id>/control/<agent-id>.json` (per-worker state) — the exact same files the Conductor writes. Single source of truth; the view never diverges.
- **No model calls:** the entire view path is deterministic scripts (NFR-05).
- **Watch loop:** a thin wrapper that calls `loadStatus()` + `renderStatus()` in a polling loop. The loop itself never spawns anything.

---

## Related commands

| Command | What it does |
|---------|--------------|
| `/bgsd-run "<prompt>"` | Start a new project orchestration run |
| `/bgsd-abort` | Stop an in-flight run cleanly, preserving all branches and control files |
| `/bgsd-clean-branches` | Prune `rehearsal/*` branches already merged into the base branch (never touches unmerged branches) |

---

*Phase 7 — Live Colorful Status View (Kiwi). Requirements: STATUS-01..04.*
