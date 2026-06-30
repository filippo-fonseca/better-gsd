# /bgsd-feedback [--fast]

**Phase 4 (v3) — Feedback Mode**
*Ingest review findings and re-run the fix pipeline*

---

## Overview

`/bgsd-feedback "<what's wrong>"` feeds your findings back into the bgsd
pipeline after a User Review Gate returns `request_changes` (or after you
supply direct free-text). It:

1. **Ingests** your feedback (structured `review.json` change_items or
   free-text string) and parses it into discrete, id-tagged fix items stored
   under `.bgsd/runs/<run-id>/feedback/`.
2. **Routes** the items through one of two modes (full or fast, see below).
3. **Plans** the re-run as a pure, testable structure before executing
   anything. The plan is always printed first; execution only happens with
   `--live`.
4. **Returns** the run to the User Review Gate when fixes are applied, so the
   human always evaluates the result (no silent green).

---

## Lifecycle position

```
/bgsd-user-eval (User Review Gate)
  -> verdict: request_changes
    -> /bgsd-feedback [--fast]   ← YOU ARE HERE
      -> (full mode) Loop 1 per worktree -> re-merge -> Loop 2 -> Review Gate
      -> (fast mode) parallel fix agents (no loop) -> Review Gate
```

---

## Modes

### Full mode (default)

Re-runs the **entire two-loop machine** on the feedback items:

1. Route each item through the v1/v2 classify→route seam.
2. Fan items into worktrees off `rehearsal/<run-id>`.
3. Run Loop 1 (per-worktree verify→fix) on each worktree.
4. Re-merge into `rehearsal/<run-id>` (conflict pre-check + dependency-ordered merge).
5. Re-run Loop 2 (integration verify→fix) over the updated rehearsal branch.
6. Return to the User Review Gate.

The existing Loop 1 and Loop 2 controllers are **reused unchanged** — only the
work set changes. Full mode is bounded by `max_iterations` and the per-run
budget cap (NFR-08).

```bash
# Plan (dry-run, default):
node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs" --run-id bgsd-0001-my-feature "Login button crashes"

# Execute (human-supervised):
node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs" --live --run-id bgsd-0001-my-feature "Login button crashes"
```

### Fast mode (--fast)

**SKIPS the loops.** The Conductor spawns fix agents directly off the feedback
items with **no computer-use verification**:

- For a single trivial (low-severity) item: one agent (Haiku/low effort).
- For multiple or non-trivial items: parallel agents (Sonnet/medium effort).

Fixes are applied to `rehearsal/<run-id>`. The run then returns to the User
Review Gate — the human is the verification for `--fast`.

**Important: `--fast` results are always marked `UNVERIFIED`.** They can never
produce a clean `PASS` without a real Tester pass. This is enforced structurally
(the `result_status` field is always `"UNVERIFIED"` in `--fast` plans and
results). No silent green (NFR-06).

```bash
# Plan (dry-run, default):
node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs" --fast --run-id bgsd-0001-my-feature "Minor text typo"

# Execute (human-supervised):
node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs" --live --fast --run-id bgsd-0001-my-feature "Minor text typo"
```

---

## Feedback sources

Feedback can come from two sources:

### 1. Structured (from review.json change_items)

When the User Review Gate returns `request_changes`, the findings in
`review.json` under `change_items` are passed directly to `/bgsd-feedback`:

```json
{
  "verdict": "request_changes",
  "change_items": [
    { "id": "change-1", "description": "Login crashes on mobile" },
    { "id": "change-2", "description": "Dashboard 404 on /api/metrics" }
  ]
}
```

Each item is tagged to a file/feature where extractable and assigned a severity.

### 2. Free-text (direct /bgsd-feedback invocation)

You can supply feedback directly as a string argument:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs" "Login is broken; Dashboard loads slow"
```

Multi-line text and semicolon/numbered-list delimiters are split into discrete
items automatically.

---

## Fix item shape

Each parsed feedback item has:

```json
{
  "id":          "fb-run-001-1-abc123",
  "description": "Login button crashes on mobile",
  "source":      "review_json",
  "file":        null,
  "feature":     "login",
  "severity":    "high",
  "state":       "pending",
  "created_at":  "2026-06-29T14:00:00.000Z"
}
```

Items are written to `.bgsd/runs/<run-id>/feedback/feedback-<timestamp>.json`
for the audit trail (FEEDBACK-01, Part 6 ledger discipline).

---

## Plan shape (what you see before executing)

```json
{
  "run_id":    "bgsd-0001-my-feature",
  "mode":      "full",
  "items":     [ ... ],
  "re_run": {
    "mode":                  "full",
    "loops":                 ["loop1", "loop2"],
    "verified":              true,
    "verification_skipped":  false,
    "result_status":         "PENDING",
    "max_iterations":        5,
    "budget_cap":            "default",
    "item_count":            2
  },
  "planned_at": "2026-06-29T14:00:00.000Z"
}
```

For `--fast`:

```json
{
  "re_run": {
    "mode":                  "fast",
    "loops":                 ["fast_fix"],
    "agent_strategy":        "parallel",
    "model_hint":            "Sonnet/medium",
    "verified":              false,
    "verification_skipped":  true,
    "result_status":         "UNVERIFIED",
    "max_iterations":        1,
    "budget_cap":            "default"
  }
}
```

---

## UNVERIFIED flag on --fast (no silent green)

`--fast` deliberately has no Tester pass. The risk is an unverified fix
appearing to be complete. bgsd mitigates this by enforcing:

- `re_run.verified = false` — always, in all `--fast` plans.
- `re_run.result_status = "UNVERIFIED"` — always, in all `--fast` results.
- The run still returns to the User Review Gate — the human is the only
  verification path for `--fast` fixes.
- A `--fast` result can NEVER carry `result_status = "PASS"` without a real
  Tester pass from a full-mode run. This is a structural guarantee, not a
  convention (NFR-06).

---

## Live gate (--live) (NFR-10)

Executing a feedback re-run (spawning fix agents or loops) is HUMAN-GATED:

| Mode | Behavior |
|------|----------|
| Default (no `--live`) | Prints the plan. Nothing is spawned. |
| `--live` | Executes the plan (supervised, never in CI). |

The guard is in `executeFeedbackPlan()` and mirrors `requireLiveFlag()` from
`loop1-live.mjs` / `loop2-live.mjs`. Passing `--live` via an env var is NOT
sufficient — it must be in `process.argv`.

---

## Bounded autonomy (FEEDBACK-04, NFR-01/08)

- Full mode re-runs respect `max_iterations` (default: 5) and the per-run
  budget cap — the same bounds as Loop 1 and Loop 2.
- The multi/single/full/`--fast` decision is a **deterministic scored choice**
  (item count + severity) — never a model call (NFR-05).
- Feedback fixes land on `rehearsal/<run-id>` and worktree branches only.
  Feedback NEVER writes `next` (NFR-01). The guard hook rejects any write to
  the default branch.
- The feedback round is recorded in the run ledger + CHANGELOG so the next PR
  body reflects the feedback iterations (FEEDBACK-04, Part 6).

---

## /bgsd-status integration

When a feedback re-run is in progress, `/bgsd-status` shows the run in its
current lifecycle state (`integrating`, `review`, etc.) as the loops execute.
A `--fast` run in progress is labeled so the human can see it is unverified.

---

## Implementation

- **Core logic + ingestion:** `bgsd/scripts/feedback.mjs`
- **Tests:** `bgsd/scripts/test-feedback.mjs` (node:assert, no external deps)
- **Loops reused unchanged:** `bgsd/scripts/loop1.mjs`, `bgsd/scripts/loop2.mjs`
- **Review gate:** `bgsd/scripts/review.mjs` (the gate the run returns to)

---

*Spec: FEEDBACK-01..04, NFR-01, NFR-05, NFR-06, NFR-08, NFR-10 — Phase 4 (v3 Milestone 4)*
