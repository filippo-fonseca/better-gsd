# bgsd-changelog — Per-Agent CHANGELOG Into the PR

**Phase 5 — CHANGELOG-01..03 (human-gated real PR creation)**

This command documents the CHANGELOG-to-PR flow: how bgsd aggregates per-agent changes across Loop 1, Loop 2, and feedback rounds into a complete PR description, and then (under an explicit human `--live` opt-in) opens a real `gh pr create` against a NON-default branch.

---

## Overview

After Loop 2 returns a clean integration result and the human approves at the User Review Gate, bgsd aggregates every subagent's changes into a single, human-readable CHANGELOG (one section per agent), assembles it into a PR body, and surfaces it for review. Only then — with explicit `--live` — does it run `gh pr create`.

The PR ALWAYS targets a non-default branch (`rehearsal/<run-id>` or another feature branch). It NEVER targets `next`, `main`, or `master` (NFR-01). This guard fires before the `--live` check and cannot be bypassed.

---

## Flow

```
aggregatePerAgentChangelog()   ← Loop 1 + Loop 2 + feedback round worktrees
          ↓
assemblePrBody()               ← pure Markdown string; surfaced at review gate
          ↓
liveCreatePr() [--dry-run]     ← default: prints body + command; no PR created
          ↓
liveCreatePr() [--live]        ← human opt-in: runs gh pr create (non-default base)
```

---

## Functions (library: `bgsd/scripts/changelog-pr.mjs`)

### `aggregatePerAgentChangelog({ runId, worktrees, integrationResult?, feedbackRounds?, generateChangelogFn? })`

Aggregates each agent's changes into a structured per-agent CHANGELOG.

- Reuses and enriches the v2 `generateChangelog()` seed from `rehearsal.mjs`.
- Groups agents by loop phase: Loop 1 worktree agents, Loop 2 integration fix agents, feedback round agents.
- Returns `{ entries: AgentEntry[], changelog: string }`.
- Pure function: no model calls, no I/O to git/GitHub (NFR-05).
- `generateChangelogFn` is injectable for tests (defaults to the real v2 implementation).

### `assemblePrBody({ runId, slug?, prompt?, entries, changelog, integrationResult?, ledgerPath?, issueNumber? })`

Renders the per-agent CHANGELOG into a complete Markdown PR body.

- Includes: a summary section (run ID, agent count, integration verdict, prompt excerpt, ledger link), the per-agent CHANGELOG, and a test plan checklist.
- Appends `Closes #N` only when `issueNumber` is provided.
- Returns `{ title: string, body: string }`.
- Pure function: deterministic string-building, no git/GitHub I/O. Unit-testable in isolation.

### `liveCreatePr({ base, head, title, body, dryRun? })`

Guarded real PR creation (CHANGELOG-03, human-gated).

**Without `--live` (default dry-run):**
Prints the assembled PR body and the `gh pr create` command it WOULD run, then exits without creating anything. No silent green.

**With `--live` + a non-default base:**
1. Calls `requireLiveFlag()` — refuses without `--live`.
2. Calls `requireNotDefaultBranch(base)` — refuses if `base` is `next`, `main`, or `master`.
3. Runs `gh pr create --base <base> --head <head> --title <title> --body <body>`.

---

## Guards

| Guard | Always active? | What it prevents |
|-------|---------------|-----------------|
| `requireLiveFlag()` | Only for live execution | Accidental automation without explicit human opt-in |
| `requireNotDefaultBranch(base)` | Always (even in dry-run) | PR targeting `next`/`main`/`master` (NFR-01) |

---

## Dry-Run Default (no `--live`)

```
node bgsd/scripts/changelog-pr.mjs
```

Prints:
- The would-be PR body (title + body as assembled).
- The exact `gh pr create ...` command that WOULD run.
- A reminder that `--live` is required and that `next`/`main`/`master` are refused as base.

No PR is created. No GitHub I/O occurs.

---

## Live Run (human-supervised only)

```
node bgsd/scripts/changelog-pr.mjs --live
```

Conditions that must be true before using `--live`:

1. You are NOT on `next`/`main`/`master` — the guard enforces this.
2. The `base` branch is `rehearsal/<run-id>` or another non-default branch.
3. The human has reviewed the PR body (surfaced at the User Review Gate).
4. You are watching the terminal — this is not fire-and-forget.

DO NOT add `--live` to CI/CD pipelines. Real PR creation is a human-supervised, manual step (NFR-10).

---

## PR Base Branch Rule (NFR-01)

bgsd NEVER opens a PR against `next`, `main`, or `master`. The PR always targets a non-default branch (`rehearsal/<run-id>` is the canonical target). Only the human merges `rehearsal/<run-id>` → `next`, by hand. This guard cannot be bypassed — it fires before the `--live` check.

---

## Integration with the Review Gate

The same PR body assembled by `assemblePrBody()` is surfaced to the human at the User Review Gate (via `/bgsd-user-eval` + Kiwi terminal output) BEFORE `liveCreatePr()` is called. The human sees the exact PR body they are about to create, reviews it, and then triggers `--live` if approved.

---

## Tests

```
node bgsd/scripts/test-changelog-pr.mjs
```

Tests cover:
- Per-agent CHANGELOG aggregation from a fixture (one section per agent asserted).
- PR body assembly is a pure string containing per-agent sections + test plan + `Closes #N` when an issue is given.
- `liveCreatePr` refuses without `--live`.
- `liveCreatePr` refuses `next`/`main`/`master` as base even without `--live`.

---

## NFR Compliance

| NFR | How met |
|-----|---------|
| NFR-01 (branch safety) | `requireNotDefaultBranch()` always fires; `next`/`main`/`master` are refused unconditionally |
| NFR-05 (scripts over models) | Aggregation + PR body assembly are deterministic string-building; no model calls |
| NFR-06 (no silent green) | Dry-run default; prints would-be command + body; never creates a PR silently |
| NFR-10 (human-gated live) | `requireLiveFlag()` on every live execution path; `--dry-run` is the default |
