# /bgsd-user-eval

**Phase 3 (v3) — User Review Gate**
*INTERACTIVE human gate — NEVER auto-passes (NFR-11)*

---

## Overview

`/bgsd-user-eval` is the one mandatory human stop in every bgsd v3 run. When
Loop 2 returns a clean integration pass, the Conductor advances the run into a
`review` lifecycle state and opens the User Review Gate. This command:

1. Auto-boots the integrated `next` servers and prints the
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
  → Merge into next (integration assembly)
    → Loop 2 (integration verify→fix)   ← MUST return PASS
      → /bgsd-user-eval (User Review Gate)  ← YOU ARE HERE
        → /bgsd-feedback (if request-changes)
        → CHANGELOG + auto-open next → main landing PR (if approved; you merge)
```

---

## Boot + localhost URL (REVIEW-02)

`/bgsd-user-eval` auto-boots the servers for `next` using the
v0/v2 `runtime-isolate.sh` convention (one integrated server, not per-worktree).
Once booted, it prints:

```
Integrated app (next): http://localhost:3099
(open in your browser to verify by hand)
```

**The live boot is human-gated (NFR-10):**

| Mode | Behavior |
|------|----------|
| `--dry-run` (default) | Prints the boot plan. No process is started. |
| `--live` | Boots the real integrated `next` app. Human-supervised only. Never in CI. |

> **Always a clickable URL, never a bare port.** Any time Kiwi mentions a
> running server (the review-gate boot, a still-running integration dev server,
> anything the user might open), it prints the full `http://localhost:<port>`
> form so the user can click it. A bare `:3137` is never acceptable. If the app
> binds a host other than localhost, print that host. This holds in free-form
> narration too, not just the gate output.

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
Your verdict on the integrated next branch — pick one:

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

## After approve — open the landing PR automatically (REVIEW-04)

On an `approve` verdict, Kiwi does **not** ask the user how to land. It just does
the safe, reversible part and hands over the rest:

1. **Files the per-unit GitHub issues** (one per work unit, plus the sesh epic)
   if they were not filed already, so the landing PR can close them.
2. **Opens one `next → main` pull request automatically** (`gh pr create --base
   main --head next`), with a body that lists the per-agent changelog and
   `Closes #<n>` for every unit issue. This is the human-handoff PR; opening it
   is safe (it writes nothing to `main`).
3. **Hands the user two links:** the **PR URL** to review and merge, and the
   **`http://localhost:<port>`** of the integrated app if it is still up.

```
Approved. Landing PR is open for your review:
  PR:   https://github.com/<owner>/<repo>/pull/<n>   (review + merge when you're happy)
  App:  http://localhost:3099                         (still up if you want another look)

I won't merge it — next → main is yours. Say the word and I'll take the dev server down.
```

**Kiwi never merges `next → main`.** It opens the PR and stops; the merge is the
user's, always (NFR-01). It does not offer an "I'll merge it" option, and it
does not ask whether to open the PR — opening the handoff PR is the default. The
only thing the user does is review and click merge.

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
  ⚠ NEEDS YOUR EVAL:  Run /bgsd-user-eval to boot the integrated next app and submit your verdict.
```

The constant `🔒 main-protected` indicator is always visible in the banner.

---

## Usage

```bash
# Dry-run (default): show the boot plan + checklist, do NOT boot
node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --run-id bgsd-0001-my-feature

# Live (human-supervised only): boot the real integrated next app
node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --live --run-id bgsd-0001-my-feature
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
