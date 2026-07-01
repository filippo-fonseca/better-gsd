# /bgsd-gui — open the live dashboard

> **Kiwi · bgsd Conductor — watch the whole pipeline**
> `/bgsd-gui` opens a local web dashboard that tracks every agent live: the
> parallel Loop 1 Pipeline Agents, the Verification lane, the Loop 2 Integrator,
> and the Review Gate, each card showing the agent's GSD substage (discuss → ui
> → plan → execute → verify → done), status, and progress. It reads the run's
> control files and refreshes on its own. Open it whenever you want, and tell
> Kiwi to close it any time.

The dashboard is **read-only observability**. It never touches git, never writes
to `main`; it just renders what the run's control files already record.

---

## Usage

```
/bgsd-gui                 # open the dashboard for the latest run, print the URL
/bgsd-gui open            # same as above
/bgsd-gui close           # stop the running dashboard
/bgsd-gui status          # is it up, and where?
```

You can also open it as part of a session:

```
/bgsd-sesh "…" --gui      # run the session AND open the dashboard
```

And just ask Kiwi in chat: "open the dashboard" / "close the gui". Kiwi runs the
same commands and hands you the URL.

```sh
# Open (auto-picks the latest run, an OS-assigned free port):
node "${CLAUDE_PLUGIN_ROOT}/scripts/gui-live.mjs" start [--run-id <id>] [--port <n>]

# Close it:
node "${CLAUDE_PLUGIN_ROOT}/scripts/gui-live.mjs" stop

# Where is it?
node "${CLAUDE_PLUGIN_ROOT}/scripts/gui-live.mjs" status

# Advance the pipeline stage (so the dashboard reflects discuss/decompose/etc.):
node "${CLAUDE_PLUGIN_ROOT}/scripts/gui-live.mjs" stage <discuss|decompose|loop1|merge|loop2|review|done> --note "what you're doing"

# Preview only (prints the plan, starts nothing):
node "${CLAUDE_PLUGIN_ROOT}/scripts/gui-live.mjs" start --plan-only
```

Kiwi always hands you the full `http://localhost:<port>` URL to click, never a
bare port.

---

## What it shows

| Lane | What lands here |
|------|-----------------|
| **Loop 1 · Pipeline Agents** | The parallel worktree agents, one card each, with their GSD substage and verify→fix iteration count. |
| **Verification** | The Tester / verifier agents driving the verify step. |
| **Loop 2 · Integration** | The Integrator assembling and integration-testing `next`. |
| **Review Gate** | The human review stage, when the run reaches it. |

Each card carries: the unit, an inferred role badge, a status pill
(running / done / blocked / needs-input), the GSD substage, a progress bar along
the GSD flow, the iteration `x/max`, a live note, and a context-pressure warning
if an agent's window is filling up. The header shows the run id, scale, state,
and running / done / blocked counts, with a heartbeat that goes amber then red
if the feed drops.

**The pipeline timeline shows the pre-fan-out phases.** Above the lanes is a
stepper for the whole pipeline: **Discuss → Decompose → Loop 1 → Merge → Loop 2
→ Review → Done**, with the current stage lit and a one-line note of what the
Conductor is doing. This is visible **before any agent exists**, so during
intake, discussion, and decomposition (when there are no control files yet) you
still see exactly where the run is and what Kiwi is working on. As the Conductor
moves through the pipeline it advances the stage with `gui-live.mjs stage <name>
--note "..."`, and the session harness seeds the opening stage automatically.

---

## How it stays live

The page polls `/api/state` every 1.5 seconds; the server rebuilds the model
from `.bgsd/runs/<run-id>/control/*.json` on each request, so it always reflects
the current control-file state. A pointer file `.bgsd/gui.json` records the pid,
port, URL, and run id so `close` / `status` can find the running server.

---

## Safety

- **Read-only.** The dashboard only reads control files. It never runs git, never
  writes `main`, and is not `--live` gated.
- **Local only.** It binds `127.0.0.1`; nothing is exposed off your machine.
- **Disposable.** Closing it removes the pointer file. A stale pointer (server
  already gone) is cleared automatically on the next `close`/`status`.

---

## BLOCKED behavior (no silent fallback)

```
BLOCKED: <reason>
Remedy: <what the user must do>
```

| Condition | BLOCKED message |
|-----------|-----------------|
| `node` not found / node error on `gui-live.mjs` | `BLOCKED: Cannot invoke gui harness — node error: <error>. Remedy: ensure Node 18+ is on PATH and the bgsd plugin is installed.` |
| `${CLAUDE_PLUGIN_ROOT}` unset | `BLOCKED: CLAUDE_PLUGIN_ROOT is not set. Remedy: ensure bgsd is installed as a Claude Code plugin and run from Claude Code.` |
| Not inside a git repo | `BLOCKED: not a git repository. Remedy: run /bgsd-gui from inside your project repo.` |
