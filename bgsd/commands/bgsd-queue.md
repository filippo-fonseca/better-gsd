---
name: bgsd-queue
description: "Manage the bgsd fix-stream queue: add items, check status, and drain the queue through the classify→route→execute→verify→loop pipeline."
argument-hint: "add --title \"<title>\" [--body \"<desc>\"] [--source <provenance>] [--no-issue] | status | list | peek | closes <id...> | done <id> [--close-issue] | start [--dry-run]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
---

# /bgsd-queue

Manage the bgsd fix-stream queue. Items flow through an explicit per-item
state machine (`queued → classified → routed → executing → verifying → looping
→ done | failed | blocked | needs_input`) with every transition timestamped
and recorded in an append-only audit trail.

The queue is durable (atomic JSON writes), resumable (re-running `start` picks
up where it left off), and single-stream (exactly one item active at a time,
no parallelism, no second worktree).

**This queue is the ONE canonical bgsd backlog.** It is **per-repo** — it lives
under the invoking repo's `.bgsd/queue/queue.json`, so every project has its own.
Whenever you say "queue that", "leave it for the next sesh", "add it to the
backlog", or "remember this for later", that means **`queue.mjs add`** here — NOT
a `.planning/BACKLOG.md` file. `.planning/` belongs to GSD, not to bgsd; bgsd's
backlog is `.bgsd/queue`. The workflow it's built for: while a sesh runs you keep
banking next-sesh ideas with `/bgsd-queue "<idea>"`; they pile up in this repo's
queue; then a bare `/bgsd-sesh` shows the batch in a selector so you pick what to
pull in — no re-typing.

---

## Subcommands

| Subcommand | Description |
|---|---|
| `add` | Enqueue a fix or feature item. Returns the item's stable id. |
| `status` | Print a compact, read-only view of the queue (per-state counts, current item, last verdict). |
| `list` | Print **all** queued items — the whole next-sesh batch (`--json` for a machine payload). What the sesh-start selector reads so you can multi-pick. |
| `peek` | Print the next queued **backlog** item (read-only), or an empty marker. What the Conductor proposes on a no-prompt sesh and at sesh end. |
| `closes <id...>` | Print the `Closes #N` block for the GitHub issues linked to the given pulled items, so the sesh's PR closes them. |
| `done <id>` | Mark a Conductor-pulled backlog item resolved (`done`, or `--failed`/`--blocked`), out-of-band of the drainer. `--close-issue` also closes the linked GitHub issue. |
| `start` | Drain the queue through the pipeline. Resumes in-flight items; skips done items. |

> **Two ways to drain.** `start` is the **autonomous** drainer (runs each item
> through the quick pipeline, no confirmation). `peek` + `done` are the
> **Conductor-orchestrated** backlog: Kiwi peeks, proposes the item to you via a
> selector, runs a full properly-scaled `/bgsd-sesh`, then marks it `done`. The
> backlog is how deferred scope drains across sessions — see "Starting with no
> prompt" in `/bgsd-sesh`.

---

## add

Appends one fix or feature item to the queue. Returns the item's id on stdout.

Deduplicates by content key (SHA-256 of `title + body`): if a non-terminal item
with the same title and body already exists, the existing id is returned and no
duplicate is created.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" add \
  --title "Fix nav bug on mobile" \
  [--body "The top-nav collapses incorrectly below 768 px."] \
  [--source manual]            # "manual" (default) or "hyperpolymath"
  [--no-issue]                 # skip filing a GitHub issue for this idea
```

**Output (stdout):** the item id, e.g. `item-a3f2c1b0-1719600000000` (plus an
`issue #<n> <url>` line when a GitHub issue was filed).

**Files a GitHub issue by default.** When origin is a GitHub remote, `add`
files one issue for the idea (`gh issue create`) and links it to the item
(`github_issue: { number, url }`), mirroring the global "new bug → issue →
branch → PR (Closes #n)" workflow. This means a queued idea is tracked on the
repo the moment you bank it, and — because the item carries its issue number —
when the Conductor later pulls it into a `/bgsd-sesh`, the resulting PR closes
that same issue (see `closes` below). It degrades gracefully: no GitHub remote,
a duplicate submission, or a failing `gh` call just drops the link and the item
is still queued. Pass `--no-issue` to opt out for a single add.

**Required fields written to each queue record:**

| Field | Description |
|---|---|
| `id` | Stable, unique item identifier |
| `content_key` | SHA-256 of `title + body` — used for deduplication |
| `title` | Short human-readable title |
| `body` | Longer description (may be empty) |
| `source` | Provenance: `manual` or `hyperpolymath` |
| `state` | Always `queued` on creation |
| `attempts` | Drainer pass count (starts at 0) |
| `created_at` | ISO-8601 timestamp |
| `updated_at` | ISO-8601 timestamp (set on every transition) |
| `trail` | Append-only array of `{ from, to, at, meta? }` transition entries |
| `github_issue` | Optional `{ number, url }` — the linked GitHub issue, when one was filed |

---

## closes

Prints the `Closes #N` block for the GitHub issues linked to the given queued
item ids. The Conductor calls this when it pulls ideas out of the selector into
a session, so the resulting PR body auto-closes each idea's issue on merge.
Read-only; items without a linked issue are skipped.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" closes <item-id> [<item-id> ...]
# ->  Closes #42
#     Closes #57
```

---

## status

Prints a compact, human-readable queue summary. Zero model calls in the I/O
path (NFR-05). Full item JSON stays on disk at `.bgsd/queue/queue.json`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" status
```

**Output (stdout):**

```
bgsd queue status
  total        5
  queued       1
  classified   0
  routed       0
  executing    0
  verifying    0
  looping      0
  done         3
  failed       1
  blocked      0
  needs_input  0

  current      [queued] item-a3f2c1b0-…  "Fix nav bug on mobile"  age=2m
  last_verdict  done
```

**Fields:**
- `current` — the first non-terminal item (the one being worked on), or `(none)` if the queue is empty or all items are terminal.
- `last_verdict` — state of the most-recently-updated terminal item.

---

## peek

Prints the next queued **backlog** item — the oldest item still in `queued`
state — without transitioning anything. This is the cross-session backlog the
Conductor proposes when you run `/bgsd-sesh` with no prompt, and when a session
finishes. Read-only; zero model calls.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" peek
```

**Output (stdout):** the next item's `id`, `title`, `source`, `age`, and `body`,
or `(empty — no work waiting in the queue)` when nothing is queued.

---

## done

Marks a backlog item resolved after the Conductor has pulled it into a full
session and that session finished. Deliberately out-of-band of the strict
drainer state machine (the Conductor runs the work outside the drainer), so the
trail entry is tagged `manual: true`. Idempotent on already-terminal items.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" done <item-id> [--note "ran sesh <id>"]
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" done <item-id> --failed        # leave it failed, not done
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" done <item-id> --close-issue   # also close the linked GitHub issue
```

**Output (stdout):** `<item-id> -> done` (plus `closed issue #<n>` when
`--close-issue` is passed and the item has a linked issue).

> **Why `--close-issue`.** bgsd merges into the standing `next` branch, not the
> repo's default branch, so a PR's `Closes #N` won't auto-fire until `next`
> reaches the default branch. When a pulled idea's session is fully resolved,
> `--close-issue` closes its issue explicitly with a resolution comment.

---

## start

Drains the queue through the fix-stream pipeline. Honors resumability:

- Items already in a terminal state (`done`, `failed`, `blocked`, `needs_input`) are skipped.
- Items interrupted mid-pipeline are picked up from their last persisted state.
- Exactly ONE item is active at a time (single-stream, single-worktree).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" start [--dry-run]
```

`--dry-run` prints what would happen without mutating any state.

---

## State Machine

```
                    +---> needs_input (TERMINAL)
                    |
  queued ---------> classified ---------> routed ---------> executing
     |                  |                   |                    |
     +---> blocked      +---> blocked        +---> blocked       +---> verifying
     +---> needs_input  +---> needs_input    +---> needs_input   |         |
                                                                  +---> failed
                                                                  +---> blocked
                                                                  |
                                                             verifying <--+
                                                                  |       |
                                                                  +---> looping
                                                                  |       |
                                                                  +---> done (TERMINAL)
                                                                  +---> failed (TERMINAL)
                                                                  +---> blocked (TERMINAL)
```

**States:**

| State | Description |
|---|---|
| `queued` | Item added; not yet classified |
| `classified` | [Phase 2] Route class assigned (e.g. `trivial-fix`, `feature`) |
| `routed` | [Phase 2] Concrete GSD quick path selected and recorded |
| `executing` | [Phase 3] GSD execution running in the worktree |
| `verifying` | [Phase 3] `/bgsd-verify` running against the worktree |
| `looping` | [Phase 3] Verify→fix loop iterating |
| `done` | TERMINAL: clean Tester PASS |
| `failed` | TERMINAL: stop condition hit without clean PASS |
| `blocked` | TERMINAL: verification blocked (BLOCKED/ERROR verdict from Tester) |
| `needs_input` | TERMINAL (soft): item needs clarification; drainer advances to next item |

**Transition rules:** every state has an explicit allowed-next set in the
`TRANSITIONS` table in `bgsd/scripts/queue.mjs`. Any attempt to advance to a
state not in that set throws an error and the item's state is not changed.

---

## Pipeline (Phase 1 placeholder)

In Phase 1, `start` runs a placeholder pipeline that advances items through
every state to `done` using stub steps. Each stub is clearly marked in
`bgsd/scripts/queue.mjs` with a comment indicating where Phase 2 (classify/
route) and Phase 3 (Loop-1 verify→fix) plug in.

**Phase 2 hooks (Classification and Routing):**
- `queued → classified`: classifier assigns a route class from the item's title/body
- `classified → routed`: router maps the class to a `/gsd-quick` or `/gsd-fast` invocation

**Phase 3 hooks (Loop 1 — Verify→Fix):**
- `routed → executing`: GSD quick-path execution runs in the worktree
- `executing → verifying`: `/bgsd-verify` spawns against the running worktree
- `verifying → done | looping`: Tester PASS lands `done`; FAIL enters the Ralph loop
- `looping → verifying | done | failed | blocked`: loop iterates until PASS or stop condition

---

## Durability and Resumability

The queue store at `.bgsd/queue/queue.json` is written atomically (temp file +
rename) so it survives interruption. On every `start` run:

1. Items in terminal states are skipped.
2. Items in non-terminal states are picked up from their last persisted state.
3. The `attempts` counter increments each time `start` picks up an item, so
   drainer pass history is auditable.

Duplicate submissions (same title + body) collapse by content key before
they enter the queue. If a non-terminal item with the same content key already
exists, `add` returns its id without creating a second record.

---

## Queue Store

**Location:** `.bgsd/queue/queue.json` (created automatically on first `add`).
This directory is under `.bgsd/`, which is gitignored — runtime state is never committed.

**Format:** a single JSON object `{ "items": [ ... ] }` where each item carries
the fields listed in the `add` section above plus an append-only `trail` array.

---

## Stop Conditions (Phase 3)

Once Loop 1 is active (Phase 3), the drainer terminates an item's loop and
marks it `failed` or `blocked` on any of the following stop conditions:

- `max_iterations` reached without a clean PASS.
- No-progress detected: the same defect signature recurs across iterations.
- Tester returns a `BLOCKED` or `ERROR` verdict.

These stop conditions are recorded on the `trail` entry with a `reason` key.
An item is NEVER marked `done` without a verified Tester PASS (NFR-06).

---

## Hard Rules

- **No silent green (NFR-06).** An item reaches `done` only on a verified Tester PASS.
  Every non-clean stop produces a structured terminal state (`failed` or `blocked`).
- **No model calls in queue I/O (NFR-05).** `add`, `status`, and the queue
  store read/write path are deterministic scripts.
- **Single-stream, single-worktree (QUEUE-04).** Exactly one item is active at a time.
- **Branch safety (NFR-01).** bgsd writes only into `.bgsd/` and `bgsd/`.
  Nothing touches the `next` branch.
- **Additive only (NFR-02/03).** The queue is fully contained under `bgsd/`
  and `.bgsd/`. No GSD vendored files are modified.

---

## Quick Reference: Script Invocations

| Task | Command |
|---|---|
| Add item (files a GitHub issue) | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" add --title "..." [--body "..."] [--no-issue]` |
| Check status | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" status` |
| Peek next backlog item | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" peek` |
| `Closes #N` for pulled items | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" closes <id...>` |
| Resolve a pulled item | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" done <id> [--note "..."] [--close-issue]` |
| Drain queue | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" start` |
| Dry-run drain | `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" start --dry-run` |
| Run unit tests | `node "${CLAUDE_PLUGIN_ROOT}/scripts/test-queue.mjs"` |

---

## Related Files

| Path | Purpose |
|---|---|
| `bgsd/scripts/queue.mjs` | Core queue library + CLI (add/status/peek/done/start) |
| `bgsd/scripts/test-queue.mjs` | Unit tests for queue.mjs |
| `bgsd/commands/bgsd-verify.md` | Tester command (Phase 3 uses its contract) |
| `bgsd/agents/tester.md` | Tester runbook (Loop 1 output contract) |
| `.bgsd/queue/queue.json` | Runtime queue store (gitignored) |
