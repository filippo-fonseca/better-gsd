# /bgsd-clean

> **Kiwi · bgsd Conductor — Branch and Worktree Pruner**
> Safely removes stale bgsd worktrees and merged branches that have accumulated
> across sessions. Never touches unmerged branches (unless you pass `--force`),
> and never touches `next`, `main`, `master`, or your current branch — ever.

---

## What it does

After many bgsd sessions, worktree directories and branches named like
`bgsd-<run-id>/<slug>` pile up under `.bgsd/runs/`. `/bgsd-clean` identifies
which ones are safe to remove (merged into the standing `next` integration
branch), presents the plan, asks you to confirm, and then executes. If you
want a preview without touching anything, pass `--dry-run`.

Only branches whose names start with `bgsd-` are ever considered. Generic user
branches are invisible to this command.

---

## Usage

```
/bgsd-clean              # dry-run preview + confirmation before executing
/bgsd-clean --dry-run    # print the plan; do nothing
/bgsd-clean --force      # include unmerged bgsd branches in the plan (still skips protected/current)
/bgsd-clean --yes        # skip the confirmation prompt and execute immediately
/bgsd-clean --json       # machine-readable plan (no confirmation, dry-run only unless --yes)
```

All flags can be combined:

```
/bgsd-clean --force --dry-run    # preview a force-clean without touching anything
/bgsd-clean --force --yes        # execute a force-clean with no prompt
```

---

## What Kiwi does when you run this

1. **Gather** the live git state: all local branches, all worktrees, which
   branches are merged into `next`, and the current branch.

2. **Plan** the cleanup with `clean.mjs --dry-run --json`. The plan contains:

   | Field | What it holds |
   |-------|---------------|
   | `removeWorktrees` | Worktree paths safe to remove |
   | `deleteBranches`  | Branch names safe to delete (merged into `next`) |
   | `skipped`         | Everything skipped and why (unmerged, protected, current) |

3. **Present** the plan in a table. Nothing has been touched yet.

4. **Ask for confirmation** (unless `--yes` was passed):

   > "Shall I remove N worktree(s) and delete M branch(es), sir?"

5. **Execute** on your say-so: `git worktree remove` each stale worktree, then
   `git worktree prune`, then `git branch -d` each merged branch (or `-D` under
   `--force`).

6. **Report** exactly what was removed, what was deleted, and any errors.

---

## Protection rules (hard invariants)

| Rule | What it means |
|------|---------------|
| Protected branches | `next`, `main`, `master` are **never** deleted, even under `--force` |
| Current branch | Whatever is currently checked out is **never** deleted |
| Non-bgsd branches | Only branches starting with `bgsd-` are ever considered |
| Unmerged branches | Skipped by default; included only with `--force` |

---

## Script invocation

```sh
# Dry run (print plan only):
node "${CLAUDE_PLUGIN_ROOT}/scripts/clean.mjs" --dry-run

# Dry run + machine-readable JSON:
node "${CLAUDE_PLUGIN_ROOT}/scripts/clean.mjs" --dry-run --json

# Execute (merged branches only):
node "${CLAUDE_PLUGIN_ROOT}/scripts/clean.mjs" --yes

# Force-clean unmerged bgsd branches:
node "${CLAUDE_PLUGIN_ROOT}/scripts/clean.mjs" --force --yes

# Override the integration branch (default: next):
node "${CLAUDE_PLUGIN_ROOT}/scripts/clean.mjs" --dry-run --integration-branch staging
```

---

## BLOCKED behavior (no silent fallback)

```
BLOCKED: <reason>
Remedy: <what you must do>
```

| Condition | Message |
|-----------|---------|
| `node` / `git` not found | `BLOCKED: required tool not found — ensure git and Node 18+ are on PATH.` |
| `${CLAUDE_PLUGIN_ROOT}` unset | `BLOCKED: CLAUDE_PLUGIN_ROOT is not set. Run /bgsd-clean from inside Claude Code with bgsd installed.` |
| Not inside a git repo | `BLOCKED: not a git repository. Run /bgsd-clean from your project root.` |
| `--force` + protected branch collision | Never reached — hard invariant in planner; protected branches are always skipped. |

---

## Related commands

| Command | What it does |
|---------|--------------|
| `/bgsd-status` | Live view of all active workers, merge history, and budget telemetry |
| `/bgsd-run "<prompt>"` | Start a new project orchestration run |
| `/bgsd-pause` | Gracefully pause an in-flight run |

---

*Implemented as `bgsd/scripts/clean.mjs` (pure planner + live CLI seam).*
*Protected branches: `next`, `main`, `master`. Integration branch default: `next`.*
