# bgsd-changelog — Per-Agent CHANGELOG Into the PR

**Phase 5 — CHANGELOG-01..03 (human-gated real PR creation)**

This command documents the CHANGELOG-to-PR flow: how bgsd aggregates per-agent changes across Loop 1, Loop 2, and feedback rounds into a complete PR description, and then (under an explicit human `--live` opt-in) opens a real `gh pr create` against the standing `next` integration branch.

---

## Overview

After Loop 2 returns a clean integration result and the human approves at the User Review Gate, bgsd aggregates every subagent's changes into a single, human-readable CHANGELOG (one section per agent), assembles it into a PR body, and surfaces it for review. Only then, with explicit `--live`, does it run `gh pr create`.

The PR ALWAYS targets the standing `next` integration branch (the canonical target). It NEVER targets the production branch `main` or `master` (NFR-01). This guard fires before the `--live` check and cannot be bypassed.

---

## Flow

```
aggregatePerAgentChangelog()   ← Loop 1 + Loop 2 + feedback round worktrees
          ↓
assemblePrBody()               ← pure Markdown string; surfaced at review gate
          ↓
liveCreatePr() [--dry-run]     ← default: prints body + command; no PR created
          ↓
liveCreatePr() [--live]        ← human opt-in: runs gh pr create (base: next)
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

**With `--live` + a non-production base (`next` or a feature branch):**
1. Calls `requireLiveFlag()`: refuses without `--live`.
2. Calls `requireNotDefaultBranch(base)`: refuses if `base` is the production branch `main` or `master`. The integration branch `next` is allowed.
3. Runs `gh pr create --base <base> --head <head> --title <title> --body <body>`.

**After the PR is opened (or later merged), record the git-artifact event** so a
remote client watching the outbox sees it flow. The PR steps run in command
markdown, which has no in-process JS seam, so record it from the shell with the
events CLI:

```sh
# just after gh pr create returns the PR number/url:
node "${CLAUDE_PLUGIN_ROOT}/scripts/remote-events.mjs" emit \
  --run-id <run-id> --type pr-opened \
  --meta '{"pr_number":<n>,"url":"<url>","branch":"<head>","into":"<base>"}'

# and when the human later merges that PR (next -> main is human-only):
node "${CLAUDE_PLUGIN_ROOT}/scripts/remote-events.mjs" emit \
  --run-id <run-id> --type pr-merged \
  --meta '{"pr_number":<n>,"url":"<url>"}'
```

`--meta` must be valid JSON. The command uses a never-throw append and no-ops
when the run directory is absent, so it is safe to call unconditionally; a
telemetry failure never blocks the PR flow.

---

## Guards

| Guard | Always active? | What it prevents |
|-------|---------------|-----------------|
| `requireLiveFlag()` | Only for live execution | Accidental automation without explicit human opt-in |
| `requireNotDefaultBranch(base)` | Always (even in dry-run) | PR targeting the production branch `main`/`master` (NFR-01); `next` is allowed |

---

## Dry-Run Default (no `--live`)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/changelog-pr.mjs"
```

Prints:
- The would-be PR body (title + body as assembled).
- The exact `gh pr create ...` command that WOULD run.
- A reminder that `--live` is required and that the production branch `main`/`master` is refused as base (`next` is the canonical target).

No PR is created. No GitHub I/O occurs.

---

## Live Run (human-supervised only)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/changelog-pr.mjs" --live
```

Conditions that must be true before using `--live`:

1. You are NOT on the production branch `main`/`master`; the guard enforces this.
2. The `base` branch is `next` (the canonical target) or another non-production branch.
3. The human has reviewed the PR body (surfaced at the User Review Gate).
4. You are watching the terminal; this is not fire-and-forget.

DO NOT add `--live` to CI/CD pipelines. Real PR creation is a human-supervised, manual step (NFR-10).

---

## PR Base Branch Rule (NFR-01)

bgsd NEVER opens a PR against the production branch `main` or `master`. The PR always targets the standing `next` integration branch (the canonical target). Only the human merges `next` → `main`, by hand. This guard cannot be bypassed; it fires before the `--live` check.

---

## Integration with the Review Gate

The same PR body assembled by `assemblePrBody()` is surfaced to the human at the User Review Gate (via `/bgsd-user-eval` + Kiwi terminal output) BEFORE `liveCreatePr()` is called. The human sees the exact PR body they are about to create, reviews it, and then triggers `--live` if approved.

---

## Tests

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/test-changelog-pr.mjs"
```

Tests cover:
- Per-agent CHANGELOG aggregation from a fixture (one section per agent asserted).
- PR body assembly is a pure string containing per-agent sections + test plan + `Closes #N` when an issue is given.
- `liveCreatePr` refuses without `--live`.
- `liveCreatePr` refuses the production branch `main`/`master` as base even without `--live`, and allows `next`.

---

## NFR Compliance

| NFR | How met |
|-----|---------|
| NFR-01 (branch safety) | `requireNotDefaultBranch()` always fires; the production branch `main`/`master` is refused unconditionally, while `next` is allowed |
| NFR-05 (scripts over models) | Aggregation + PR body assembly are deterministic string-building; no model calls |
| NFR-06 (no silent green) | Dry-run default; prints would-be command + body; never creates a PR silently |
| NFR-10 (human-gated live) | `requireLiveFlag()` on every live execution path; `--dry-run` is the default |
