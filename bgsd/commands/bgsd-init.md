# /bgsd-init — set this repo up for bgsd (first-time, idempotent)

> **Kiwi · bgsd Conductor — prepare the repo**
> Run `/bgsd-init` once per repo, before your first `/bgsd-sesh`. Kiwi sets up the
> standing integration branch, the `.bgsd/` master folder, your `BGSD.md` settings
> file, and bgsd-compatible GSD config. It is safe to run again any time: it only
> fills in what is missing and keeps the integration branch current with `main`.
> It never touches `main`, and never force-overwrites your work.

You do not normally need to run this by hand. Every `/bgsd-sesh` runs the same
setup as a preflight, so a fresh repo self-heals on first use. Run `/bgsd-init`
explicitly when you want to review the plan first, or set up the repo ahead of time.

**Show the init banner.** The VERY FIRST thing you do when `/bgsd-init` starts
(before any other output) is print the init splash:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/ui.mjs" init
```

This shells out to `oh-my-logo` with the `ocean` palette and falls back to the
kiwi-green block art automatically. It never blocks or errors. Run it unconditionally,
even in `--plan-only` mode.

---

## Usage

```
/bgsd-init               # set this repo up (RUNS BY DEFAULT, applies the setup)
/bgsd-init --plan-only   # preview without applying
```

Run it directly. It applies by default (it is idempotent and never touches `main`); do NOT ask for a `--live` confirmation. Only `--plan-only` / `--dry-run` previews.

```sh
# Set up the repo (runs by default, applies the setup):
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-live.mjs"

# Preview only (read-only; nothing written, no branch created):
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-live.mjs" --plan-only
```

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is the bgsd plugin's installed
> directory (the engine code lives there). The setup itself is written to your
> **current repo**, resolved from cwd via `git rev-parse --show-toplevel`. Run it
> from any repo; bgsd targets the repo you are in, not the plugin.

---

## What it sets up

| Thing | Detail |
|-------|--------|
| **Integration branch** | Creates `next` (configurable) off your base branch if it does not exist. `next` is the standing rehearsal/integration mirror of `main`: every worktree branch merges here, and `next → main` is always your manual call. |
| **Base branch** | Auto-detected from `origin/HEAD` (falling back to `main`, then `master`). Pin it in `BGSD.md` if you want. |
| **`.bgsd/` master folder** | The persistent home for every sesh's record (`seshs/`, `ledger.md`, `config.json`). Committed to git. The ephemeral runtime (`runs/`, counters, caches) is gitignored automatically. |
| **`BGSD.md`** | Your settings file. Every knob ships with a default: integration branch name, model + effort posture, env-file propagation, GitHub issue/PR behavior, and Kiwi's narration. Edit it; Kiwi reads it at the start of every sesh. |
| **GSD config** | Patches `.planning/config.json` to be bgsd-compatible (`branching_strategy: none`, `base_branch: next`) without clobbering your existing keys. |
| **`.gitignore`** | Appends an allowlist block: ignore all `.bgsd/` runtime, commit only the records. |

---

## Every-sesh preflight

Even after first-time setup, the start of every `/bgsd-sesh` re-runs the safe,
idempotent parts:

1. **Ensure `next` exists** (create it off base if somehow missing).
2. **Update `next` from `main`** when it is behind, by **fast-forward only**. If
   `next` has diverged (carries commits not in `main`), Kiwi does **not** force it.
   It leaves `next` as-is and merges during the session instead.

So your integration branch is always current with production before any work fans out.

---

## Safety

- **`main` is never written.** `/bgsd-init` only creates and fast-forwards `next`.
  Promoting `next → main` is always a manual command Kiwi suggests, never an action
  it takes.
- **No force-overwrite.** The integration-branch sync is fast-forward only. A
  diverged `next` is preserved, never reset.
- **Idempotent.** Re-running changes nothing already in place; it just reports.
- **Preview by default.** Without `--live`, nothing is written and no branch is
  created. The plan is printed for you to review.

---

## BLOCKED behavior (no silent fallback)

If setup cannot run, **STOP** and emit a loud blocked message. Do not hand-edit
files or skip the setup.

```
BLOCKED: <reason>
Remedy: <what the user must do>
```

| Condition | BLOCKED message |
|-----------|-----------------|
| `node` not found / node error on `init-live.mjs` | `BLOCKED: Cannot invoke init harness — node error: <error>. Remedy: ensure Node 18+ is on PATH and the bgsd plugin is installed.` |
| `${CLAUDE_PLUGIN_ROOT}` unset | `BLOCKED: CLAUDE_PLUGIN_ROOT is not set. Remedy: ensure bgsd is installed as a Claude Code plugin and run from Claude Code.` |
| Not inside a git repo | `BLOCKED: not a git repository. Remedy: run "git init" (and optionally add a remote) before /bgsd-init.` |
