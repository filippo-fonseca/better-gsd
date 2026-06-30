# /bgsd-resume — pick up an interrupted session

> **Kiwi · bgsd Conductor — resume where we left off**
> If a session is cut short (the Claude Code instance is lost, the terminal is
> closed, the machine sleeps), the work is not gone. Every unit's progress is
> recorded in `.bgsd/runs/<run-id>/`. `/bgsd-resume` finds the most recent
> session that is still in flight and picks it back up, from each unit's last
> recorded phase. `main` stays protected throughout, exactly as in a fresh sesh.

You do not need to remember the run id. With no argument, Kiwi auto-selects the
latest interrupted session. Pass a run id to target a specific one.

---

## Usage

```
/bgsd-resume               # resume the latest interrupted session (auto-pick)
/bgsd-resume <run-id>      # resume a specific run
/bgsd-resume --plan-only   # preview the recovered state without re-entering
```

```sh
# Resume the latest interrupted session:
node "${CLAUDE_PLUGIN_ROOT}/scripts/resume-live.mjs"

# Resume a specific run:
node "${CLAUDE_PLUGIN_ROOT}/scripts/resume-live.mjs" <run-id>

# Preview only (read-only; shows the recovered state, re-enters nothing):
node "${CLAUDE_PLUGIN_ROOT}/scripts/resume-live.mjs" --plan-only
```

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is the bgsd plugin's installed
> directory (the engine lives there). The run records are read from your current
> repo, resolved from cwd via `git rev-parse --show-toplevel`. Run it from any
> bgsd repo; it targets the repo you are in.

---

## How it picks the session

bgsd records one control file per work unit at
`.bgsd/runs/<run-id>/control/<agent-id>.json`, each carrying that unit's
`status`, `phase`, and last `heartbeat_at`. Kiwi scans every run and reads those
control files:

- A unit is **finished** when its status is `done` or `failed`.
- A unit is **in flight** when its status is `running`, `stalled`, `blocked`, or
  `needs_input`.
- A **run is resumable** when at least one of its units is still in flight. A run
  whose every unit is finished is complete, not resumable, and is skipped.

Among the resumable runs, Kiwi picks the **most recently active** one (newest
`updated_at` / `heartbeat_at` across its control files) and resumes it. With a
run id given, Kiwi resumes exactly that run if it is still resumable.

---

## What resuming does

Kiwi reports the recovered state first: the run id, each unit, its last status
and phase. Then it re-enters Loop 1 for the in-flight unit(s) from where they
stopped, reusing the existing worktrees and the standing `next` branch. Finished
units are not redone. Verification is never skipped on resume, and `next → main`
remains a manual, human-only merge.

---

## Safety

- **`main` is never written.** Resume reuses the same `requireLiveFlag` /
  `requireNotProductionBranch` guards as a normal sesh.
- **Read-only preview.** `--plan-only` (and a no-resumable-run case) only prints
  the recovered state; nothing is re-spawned.
- **No silent green.** A resumed unit still has to pass verification to reach
  `done`; resuming never marks anything passed that was not.

---

## BLOCKED behavior (no silent fallback)

If resume cannot run, **STOP** and emit a loud blocked message. Do not guess a
run or hand-edit state.

```
BLOCKED: <reason>
Remedy: <what the user must do>
```

| Condition | BLOCKED message |
|-----------|-----------------|
| `node` not found / node error on `resume-live.mjs` | `BLOCKED: Cannot invoke resume harness — node error: <error>. Remedy: ensure Node 18+ is on PATH and the bgsd plugin is installed.` |
| `${CLAUDE_PLUGIN_ROOT}` unset | `BLOCKED: CLAUDE_PLUGIN_ROOT is not set. Remedy: ensure bgsd is installed as a Claude Code plugin and run from Claude Code.` |
| Not inside a git repo | `BLOCKED: not a git repository. Remedy: run /bgsd-resume from inside your project repo.` |
| No resumable session | Not blocked: report "no interrupted session found" and suggest `/bgsd-sesh` or `/bgsd-status`. |
