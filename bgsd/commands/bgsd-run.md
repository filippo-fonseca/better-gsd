# /bgsd-run — Project Orchestrator (Kiwi, the Conductor)

`/bgsd-run "<prompt>"` is bgsd's project-mode entrypoint. It takes one large
prompt, decomposes it into a dependency graph of whole-GSD-pipeline units,
spawns them in parallel across isolated git worktrees, runs Loop 1 per
worktree, conflict-checks and merges verified branches into the standing
`next` integration branch in dependency order, and checkpoints to you at
every merge boundary. It is powered by **Kiwi, the Conductor**.

**Default: `--dry-run`.** No worktrees, processes, or merges are created
unless you explicitly pass `--live` after reading the human-gated checklist.

---

## Lifecycle overview

```
created
  → decomposed     (Opus/xhigh decompose call; units + DAG written to RUN.md)
  → spawning       (worktrees planned; spawn plan printed in --dry-run)
  → executing      (scheduler dispatches units wave-by-wave)
  → verifying      (Loop 1 per worktree: verify→fix until PASS/blocked)
  → merging        (conflict pre-check + merge into next)
  → checkpoint     (Conductor pauses; you approve/reject before next wave)
  → (done | aborted | blocked | needs_input)
```

Every transition is timestamped and written atomically to
`.bgsd/runs/<run-id>/run.json`. An interrupted run resumes from persisted
state without re-spawning completed worktrees.

---

## Usage

```sh
# Dry-run (the default — prints the spawn plan, creates nothing):
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --prompt "Add user auth and rate limiting"

# Live run (human-gated — read the checklist below first):
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-live.mjs" --live --prompt "Add user auth and rate limiting"

# Abort an in-flight run:
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --abort <run-id>
```

---

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--prompt "<text>"` | Yes | The prompt to decompose into units. |
| `--dry-run` | No (default) | Resolve the graph and print the spawn plan without launching anything. |
| `--live` | **Human-gated** | Engage real multi-process orchestration. See checklist below. |
| `--max-concurrency <n>` | No (default: 4) | Maximum concurrent worktrees in a wave. |
| `--budget-cap <$>` | Recommended with `--live` | Per-run token/cost cap (also set via `BGSD_BUDGET_CAP`). |

---

## Run ID format

Each run mints a monotonic ID: `bgsd-<NNNN>-<slug>`.

- `NNNN` is a zero-padded sequence number from `.bgsd/run-counter`.
- `slug` is the first 5 words of your prompt, sanitized, 24 chars max.

Example: `bgsd-0042-add-user-auth-and-rate`

The run record lives at `.bgsd/runs/<run-id>/run.json`.

---

## Merge-boundary checkpoints

At every wave boundary, Kiwi **pauses** and shows you:

```
======================================================================
Kiwi: Merge-Boundary Checkpoint (Wave 0)  [ckpt-1234-abc]
======================================================================

  Merged cleanly (2): unit-user-auth-a1b2, unit-rate-limit-c3d4
  Held back     (1):  unit-api-surface-e5f6

  Kiwi is waiting for your go/no-go to proceed to the next wave.
  Type 'go' to continue or 'abort' to stop the run.

  >
```

- **Merged cleanly:** units whose Loop 1 passed and whose branch merged into
  `next` without conflicts.
- **Held back:** units that failed Loop 1, had merge conflicts the resolver
  was not confident about, or whose branch was not clean. These are never
  silently merged (NFR-06: no silent green).
- You type `go` to continue to the next wave, or `abort` to cleanly stop the
  run. All branches and the run ledger are preserved for inspection.

`next` is **never** merged into `main` automatically. Only you can do that, by hand.

---

## `--dry-run` (the default)

In `--dry-run` mode, bgsd:

1. Mints the run ID.
2. Resolves the dependency graph and topological waves.
3. Prints the spawn plan (would-be worktrees, branches, ports).
4. Exits without creating any worktrees, branches, or processes.

This is always safe to run and is the recommended first step before `--live`.

---

## `--live` — human-gated multi-process orchestration (SPAWN-04)

The live path spawns **real** headless `claude -p` Pipeline Agents across
real git worktrees. It is **off by default** and requires explicit opt-in.

### Before you run `--live`

Work through this checklist every time:

1. **Branch safety.** You are on a feature branch, NOT `main`.
   Verify: `git branch --show-current`
2. **Budget cap.** You have a per-run budget cap set (`--budget-cap` or
   `BGSD_BUDGET_CAP` env var) to limit model spend.
3. **Disk space.** `.bgsd/runs/<run-id>/worktrees/` has room for ≥ N
   worktree checkouts (one per unit).
4. **Stay awake.** `caffeinate -dimsu &` is running so the Mac does not
   sleep while agents are in flight.
5. **Watch the terminal.** This is NOT fire-and-forget. You must be present
   to approve merge-boundary checkpoints and respond to Kiwi.
6. **Understand the scope.** ≥2 concurrent `claude -p` processes will be
   spawned. Real git commits will be made on worktree branches.
7. **`next` is the integration branch.** Real branches are created and merged
   into the standing `next` branch. `main` is NEVER touched. Only you can merge
   `next` → `main` by hand.

### What happens during a live run

```
1. Worktrees created:  .bgsd/runs/<run-id>/worktrees/<unit-id>/
2. Branches created:   <run-id>/<unit-slug>
3. Agents launched:    claude -p /gsd-execute-phase --worktree <path>
4. Loop 1 runs:        verify→fix (max_iterations per unit)
5. Conflict pre-check: git dry-run merge (no model)
6. Merge:              clean branches → next  (dep order)
7. Checkpoint:         you approve/reject each wave
8. Cleanup:            merged worktrees removed; next branch retained
```

### To abort a live run

Either type `abort` at the next merge-boundary checkpoint, or open a second
terminal and run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" --abort <run-id>
```

All branches, control files, and the run ledger are preserved. No orphaned
processes (the abort signals all live workers to exit cleanly).

---

## Run state file

`.bgsd/runs/<run-id>/run.json` is the single source of truth for run state.
It is written atomically on every transition (write temp + rename). Fields:

| Field | Description |
|-------|-------------|
| `run_id` | The run identifier. |
| `prompt` | The original decomposition prompt. |
| `state` | Current lifecycle state (see states above). |
| `created_at` | ISO timestamp of run creation. |
| `updated_at` | ISO timestamp of last write. |
| `transitions` | Ordered list of `{ from, to, at, meta }` transitions. |
| `checkpoints` | List of merge-boundary checkpoint records. |
| `units` | List of unit IDs in this run. |
| `waves` | Wave grouping: `[{ wave: 0, units: [...] }, ...]`. |
| `scheduler_result` | Summary from the wave scheduler (dispatched/done/failed/blocked). |
| `abort_reason` | Set on abort; null otherwise. |

---

## Related commands

- `/bgsd-status` — live colorful status view of an in-flight run.
- `/bgsd-abort` — cleanly abort a run; see above.
- `/bgsd-clean-branches` — prune `<run-id>/*` worktree branches already merged
  into `next` (never deletes an unmerged branch).

---

## Safety guarantees

- **NFR-01 (branch safety):** bgsd never writes to `main`. All work lands
  on `<run-id>/<slug>` worktree branches, assembled into `next`.
  Only you merge `next` → `main`.
- **NFR-06 (no silent green):** Units that fail Loop 1 or whose branches
  have unresolved conflicts are held back from `next`; they are never
  silently merged. The checkpoint summary shows exactly what was held and why.
- **NFR-08 (bounded, reversible autonomy):** Every loop is bounded by
  `max_iterations`; every run is bounded by `--budget-cap`; every wave
  requires your go/no-go at the merge-boundary checkpoint.
- **`--dry-run` default:** Accidental live spawns are impossible without
  `--live`. The dry-run path is always safe.
