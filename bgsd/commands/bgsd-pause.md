# /bgsd-pause — park a running session cleanly (resume exactly later)

> **Kiwi · bgsd Conductor — hold this session, right where it stands**
> Sometimes you need to step away mid-run, sir: a meeting, the end of the day,
> or you simply want the machine idle for a while. `/bgsd-pause` stops the
> session cleanly and snapshots *everything* — the exact stage, every in-flight
> unit's phase, what is still pending — so `/bgsd-resume` later picks it back up
> at **precisely** the point it left off. Nothing is lost, nothing is rushed, and
> `main` stays protected throughout. This is a hold, not a stop: unlike an abort,
> a paused run is fully resumable.

You do not need to remember the run id. With no argument, Kiwi pauses the session
in progress. Add `--note "..."` to leave yourself (or a fresh Conductor) a
one-line reminder of where you were and why you stepped away.

---

## Usage

```
/bgsd-pause                       # pause the running session
/bgsd-pause --note "handing off — search-bar mid-execute, review Stripe wiring next"
```

```sh
# Snapshot the run and park it in the non-terminal "paused" state:
node "${CLAUDE_PLUGIN_ROOT}/scripts/pause.mjs" --run-id <id> [--note "..."]
```

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is the bgsd plugin's installed
> directory (the engine lives there). The run records are read from and written
> to your current repo, resolved from cwd via `git rev-parse --show-toplevel`.
> Run it from any bgsd repo; it targets the repo you are in.

---

## What Kiwi does when you pause

Pausing is a clean, orderly stand-down — never a hard kill mid-write. When you
call `/bgsd-pause`, the Conductor, in order:

1. **Stops dispatching NEW work.** No new waves, no new agents, no new merges.
   Whatever has not started yet simply stays pending.
2. **Lets in-flight agents reach a safe point** (a phase boundary, a finished
   write) or notes their current state in their control file. Kiwi does **not**
   interrupt an agent mid-write or mid-commit — that would corrupt the snapshot.
   It waits the beat needed for each in-flight unit to be safely recordable.
3. **Snapshots the run** by running the pause harness:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pause.mjs" --run-id <id> [--note "..."]
   ```

   This records the pre-pause state as the run's `resume_state` (the exact stage
   to return to), flips `run.json` to the non-terminal **`paused`** state, writes
   a human-readable **`PAUSE.md`** snapshot under `.bgsd/runs/<id>/`, and appends
   a `PAUSED at <stage>` line to the ledger.
4. **Tells you it is paused**, in the Conductor's voice, and points at
   `/bgsd-resume` to continue exactly where you left off.

---

## What the snapshot captures (`PAUSE.md`)

`PAUSE.md` is the "resume exactly" record — everything a human or a fresh
Conductor needs to pick the run back up with zero guesswork:

- the session **title** and current **stage**,
- the exact **`resume_state`** the run returns to on resume,
- every **in-flight unit** (agent id / unit / phase / status) with a one-line
  note on what it was doing,
- the **finished units** (which are *not* re-done on resume),
- which **units / waves are still pending**,
- and the **exact next step** to resume.

---

## Resuming exactly here

```
/bgsd-resume                # auto-picks the paused session and restores it
/bgsd-resume <run-id>       # resume this specific paused run
```

On resume, `run.json` is restored to its recorded `resume_state`, the paused
marker is cleared, and the Conductor re-enters that stage: finished units are
left alone, in-flight units continue from their last recorded phase, and pending
units/waves are dispatched as they would have been. Verification is never
skipped, and `next → main` remains a manual, human-only merge. See `/bgsd-resume`
for the full resume flow.

---

## Safety

- **A pause is non-terminal and fully reversible.** Unlike `/bgsd-abort` (a
  terminal stop), a paused run is preserved intact and resumable.
- **`main` is never written.** Pause only reads control files and writes the
  run's own `.bgsd/runs/<id>/` records.
- **No half-written state.** Kiwi lets in-flight agents reach a safe point before
  snapshotting — it never kills an agent mid-write.

---

## BLOCKED behavior (no silent fallback)

If pause cannot run, **STOP** and emit a loud blocked message. Do not guess a
run or hand-edit state.

```
BLOCKED: <reason>
Remedy: <what the user must do>
```

| Condition | BLOCKED message |
|-----------|-----------------|
| `node` not found / node error on `pause.mjs` | `BLOCKED: Cannot invoke pause harness — node error: <error>. Remedy: ensure Node 18+ is on PATH and the bgsd plugin is installed.` |
| `${CLAUDE_PLUGIN_ROOT}` unset | `BLOCKED: CLAUDE_PLUGIN_ROOT is not set. Remedy: ensure bgsd is installed as a Claude Code plugin and run from Claude Code.` |
| Not inside a git repo | `BLOCKED: not a git repository. Remedy: run /bgsd-pause from inside your project repo.` |
| Run is already terminal (done/aborted/blocked) | `BLOCKED: run <id> is already <state> — nothing to pause. Remedy: start a new session with /bgsd-sesh, or /bgsd-resume a different run.` |
