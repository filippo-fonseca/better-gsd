# /bgsd-user-eval

**Phase 3 (v3) — User Review Gate**
*INTERACTIVE human gate — NEVER auto-passes (NFR-11)*

---

## Overview

`/bgsd-user-eval` is the one mandatory human stop in every bgsd v3 run. When
Loop 2 returns a clean integration pass, the Conductor advances the run into a
`review` lifecycle state and opens the User Review Gate. This command:

1. Auto-boots the integrated `rehearsal/<run-id>` servers and prints the
   localhost URL for you to click and verify by hand.
2. Displays a concrete, per-criterion test checklist derived from the run's
   acceptance criteria and the `integration-report.json`.
3. Captures your verdict via a **GSD-style selector Q&A** (pre-filled choices
   you pick, plus a type-your-own free-text option).
4. Writes the verdict, checklist state, and any free-text findings to
   `.bgsd/runs/<run-id>/review.json`.

The gate **NEVER auto-passes**. An unanswered gate parks the run in
`needs_input` (never `approved`). Only an explicit human "approve" selection
advances the run toward PR creation.

---

## Lifecycle position

```
Loop 1 (per-worktree verify→fix)
  → Rehearsal assembly (rehearsal/<run-id>)
    → Loop 2 (integration verify→fix)   ← MUST return PASS
      → /bgsd-user-eval (User Review Gate)  ← YOU ARE HERE
        → /bgsd-feedback (if request-changes)
        → CHANGELOG + PR creation (if approved)
```

---

## Boot + localhost URL (REVIEW-02)

`/bgsd-user-eval` auto-boots the servers for `rehearsal/<run-id>` using the
v0/v2 `runtime-isolate.sh` convention (one integrated server, not per-worktree).
Once booted, it prints:

```
Rehearsal app: http://localhost:3099
(open in your browser to verify by hand)
```

**The live boot is human-gated (NFR-10):**

| Mode | Behavior |
|------|----------|
| `--dry-run` (default) | Prints the boot plan. No process is started. |
| `--live` | Boots the real rehearsal app. Human-supervised only. Never in CI. |

---

## Test checklist (REVIEW-02)

A concrete checklist is generated from:
- The run's acceptance **criteria** (from `integration-report.json`).
- **Defects** that Loop 2 fixed (verify they're gone).
- Baseline items if no criteria/defects are available.

Example:

```
[ ] User login flow works end-to-end
[ ] Dashboard loads within 3 seconds
[ ] Verify defect fixed: API 401 on /profile (src/api/profile.ts)
[ ] The integrated app loads and responds on the localhost URL
```

You work through this checklist while the app is open in your browser.

---

## Verdict selector Q&A (REVIEW-03, NFR-11)

After reviewing, you are presented with a **GSD-style selector**:

```
Your verdict on the rehearsal branch — pick one:

  [approve]          Approve — integration looks good. Advance to PR creation.
  [request-changes]  Request changes — describe what's wrong → /bgsd-feedback.
  [abort]            Abort this run — stop here (branches preserved).
  [other]            Type your own: describe your verdict in free text...
```

Rules:
- You MUST pick one of the pre-filled options OR type your own response.
- Typing anything other than `approve`/`request-changes`/`abort` is treated as
  `request-changes` with your text captured as findings for `/bgsd-feedback`.
- Responding with nothing (empty, Ctrl-C, or closed stdin) parks the run in
  `needs_input` — it does **NOT** approve anything.

---

## review.json output (REVIEW-03)

The gate writes `.bgsd/runs/<run-id>/review.json`:

```json
{
  "run_id":          "bgsd-0001-my-feature",
  "reviewed_at":     "2026-06-29T14:32:00.000Z",
  "verdict":         "approved",
  "checklist_items": [
    { "id": "check-criteria-AC-01", "label": "...", "source": "criteria", "status": "pending" }
  ],
  "free_text":       null,
  "change_items":    []
}
```

`verdict` is always one of:

| Value | Meaning |
|-------|---------|
| `"approved"` | Human approved. Run advances to CHANGELOG/PR step. |
| `"request_changes"` | Human wants fixes. `change_items` is populated; run routes to `/bgsd-feedback`. |
| `"aborted"` | Human aborted. Run is parked; branches are preserved. |
| `"needs_input"` | Gate unanswered. Run parked until human re-runs `/bgsd-user-eval`. |

---

## Never-auto-pass rule (NFR-06/11)

The gate is **interactive by design**. The `promptFn` is dependency-injected
so the state machine is deterministically unit-testable with a mocked answer,
but the real human interaction is **never substituted for a pass**. Concretely:

- The test suite passes a mock answer (e.g. `"approve"`) and asserts the
  verdict is `"approved"`.
- The test suite also asserts that passing `null` / `""` / no answer resolves
  to `"needs_input"` — NEVER `"approved"`.
- In live runs, the real interactive prompt is called; only the human can
  produce an `"approved"` verdict by explicitly selecting it.

---

## /bgsd-status integration (REVIEW-04)

When a run is in `review` or `needs_input` state, `/bgsd-status` shows:

```
── 👁 User Review Gate  [👁 REVIEW]
  ⚠ NEEDS YOUR EVAL:  Run /bgsd-user-eval to boot the rehearsal app and submit your verdict.
```

The constant `🔒 main-protected` indicator is always visible in the banner.

---

## Usage

```bash
# Dry-run (default): show the boot plan + checklist, do NOT boot
node bgsd/scripts/review.mjs --run-id bgsd-0001-my-feature

# Live (human-supervised only): boot the real rehearsal app
node bgsd/scripts/review.mjs --live --run-id bgsd-0001-my-feature
```

Or invoke via the Claude Code slash command:

```
/bgsd-user-eval
```

---

## Implementation

- **Gate logic + schema:** `bgsd/scripts/review.mjs`
- **Tests:** `bgsd/scripts/test-review.mjs` (node:assert, no external deps)
- **Status integration:** `bgsd/scripts/status.mjs` (`review`/`needs-input` badge)
- **Run state machine:** `bgsd/scripts/run.mjs` (`review`, `integrating` states added)

---

*Spec: REVIEW-01..04, NFR-06, NFR-10, NFR-11 — Phase 3 (v3 Milestone 4)*
