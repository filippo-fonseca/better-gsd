# better-gsd (bgsd)

## What This Is

`better-gsd` (bgsd, `/bgsd-*`) is an open-source Claude Code plugin that layers an autonomous, self-verifying orchestration system **on top of** GSD. It runs full GSD pipelines, then verifies their output with real computer-use testing and fixes defects in nested loops, all without touching the production branch.

This repository is a **fork of `@opengsd/gsd-core`** (currently at branch `next`, which is the fork's default/production branch — treated as "main" for safety rules). bgsd is built as an **additive layer**: GSD stays unmodified; bgsd lives in its own directories and touches GSD only through stable seams.

**This milestone (Milestone 1) = v0 only: the Standalone Tester + `/bgsd-verify`.** The Conductor, parallelism, and the two verify→fix loops are explicitly out of scope for this milestone (see Future Milestones).

## Core Value

The single hardest, most load-bearing capability — proven in isolation before anything is built on top of it:

> An agent that boots a running app and verifies it against acceptance criteria, returning a **reliable, structured defect list** — including catching **console-level errors a screenshot alone would miss** (the make-or-break test).

If this isn't reliable, nothing downstream (loops, orchestration) matters. v0 exists to learn that at the cheapest possible point.

## Hard Rules & Invariants (enforced, not aspirational)

| Invariant | Enforcement |
|-----------|-------------|
| **Never write or PR to `main`/production** (here: `next`) | All work lands on `feat/bgsd-v0` or other non-default branches. No automated push/PR to the default branch, ever. |
| **bgsd code is additive — its own dirs** | New top-level bgsd directories; never add files into GSD's own dirs in a way that edits GSD behavior. |
| **Never edit vendored GSD** | The forked GSD source (root `commands/`, `agents/`, `gsd-core/`, `skills/`, `hooks/`, etc.) is read-only to bgsd. |
| **GSD touched only through adapter seams** | Three seams only: (1) GSD's `/gsd-*` slash commands, (2) the documented `.planning/` file contract, (3) `config.json`. No reaching into GSD internals. |

## Requirements

### Validated

**Milestone 1 (v0) — COMPLETE & PROVEN (2026-06-29).** Core Value empirically validated: `/bgsd-verify` against a Next.js canary returned **FAIL** on a `<div>`-in-`<p>` defect (a real React console error invisible to a screenshot) and **PASS** on the clean route, reproducibly across reruns. The proof even caught a real bug in our own classifier (React 18/Next 14 emit a new nesting-warning string), which was fixed. Proven via a direct-Playwright harness running the real classifier; the `@playwright/mcp` transport is wired + manifest-validated, its live run pending a one-time Claude Code restart.

### Delivered (v0 — Milestone 1) ✅

- [x] A `/bgsd-verify` command: takes a running app URL (or `--boot`) + acceptance criteria (a GSD `UI-SPEC.md`/acceptance file, or `--inline`) and returns a verdict.
- [x] A tester agent that drives the app via `@playwright/mcp`, checking in priority order: **console messages → network errors → rendered DOM → screenshot/vision (fallback only)**.
- [x] Structured `verification-report.json` output: per-criterion pass/fail + defect list + screenshot paths + driver-ladder audit + environment + verdict.
- [x] A runtime-isolation helper (deterministic port + ephemeral SQLite + readiness detection + clean teardown) that boots one app cleanly.
- [x] Proof on a real Next.js page — **catching a console-level error** that a screenshot alone would miss. The make-or-break test (passed).
- [x] Plugin skeleton: `.claude-plugin/plugin.json`, `commands/bgsd-verify.md`, `agents/tester.md`, `scripts/runtime-isolate.sh` under bgsd's own additive namespace (loads as a second plugin via a local marketplace; zero edits to vendored GSD).
- [x] Diagram-first docs: a Quickstart page + a `/bgsd-verify` usage page.

### Out of Scope (this milestone — deferred to later milestones)

- Conductor / Kiwi orchestrator — v2
- Parallelism (whole-pipeline-per-worktree, headless process spawning, control-file protocol) — v2
- Loop 1 (per-worktree verify→fix Ralph loop) — v1/v2
- Loop 2 (integration verify→fix, `rehearsal/<run-id>`) — v3
- `/bgsd-run`, `/bgsd-queue`, `/bgsd-status`, `/bgsd-user-eval`, `/bgsd-feedback`, `/bgsd-clean-branches`, `/bgsd-abort` — v1–v3
- Model+effort routing matrix, budget caps, escalation ladder — built when orchestration is (v2+)
- Upgrade-resilient subtree vendoring (`vendor/gsd/`), `bgsd doctor`, contract tests — v1+
- Landing page — v1 public-release milestone

## Future Milestones (per Part 8 of the PRD + live addenda)

- **v1 — Fix-stream mode (`/bgsd-queue`) + Loop 1.** Queue → classify/route to GSD → execute → Tester → Ralph stop-hook. Lowest-risk autonomy; one worktree + one loop.
- **v2 — Project orchestrator (`/bgsd-run`) + parallelism + Loop 1 across worktrees.** Conductor (Kiwi): decomposition, dependency graph, headless spawning, control-file protocol, heartbeat/restart, conflict pre-check + merge-resolver, `rehearsal/<run-id>`, doc aggregation, branch cleanup, with Conductor→user checkpoints at merge boundaries.
- **v3 — Loop 2 (integration) + User Review Gate + feedback mode.** `/bgsd-user-eval`, `/bgsd-feedback [--fast]`, per-agent CHANGELOG into the PR.

**Live addenda captured (post-PRD clarifications — all land in v2+/Conductor scope unless noted):**
- **Caffeinate during runs:** after the user approves at plugin setup, bgsd keeps the Mac awake (`caffeinate`) so agents keep working through long autonomous runs. (Setup-time helper; primarily v1+.)
- **Conductor context management:** the Conductor and its parallel subagents must manage their context windows and never overflow; when compaction/clear is needed, the Conductor orchestrates it. It should also exploit large/1M context windows appropriately.
- **Always-on live terminal view:** even though bgsd is designed hands-off, the human should at all times have a live terminal view of what Kiwi/the Conductor is doing — active subagents, current stage, what's happening, and any point where user input is needed — so they can manually track. Extends `/bgsd-status` + the Kiwi status line (Part 16).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Build v0 first (Standalone Tester) | De-risk the hardest assumption (tester reliability) in isolation before orchestration | ✅ Validated — make-or-break proven (console error caught, no false positive) |
| Fork with GSD at repo root; bgsd in its own additive dirs | Current repo IS the GSD fork; honor "never edit vendored GSD" by namespacing bgsd | ✅ Done — `bgsd/` namespace; loads as a 2nd plugin via local marketplace, zero GSD edits |
| Sidecar vs git-subtree vendoring | PRD offers both; v0 doesn't require the full `vendor/gsd/` restructure | — Deferred (revisit v1) |
| Verification-driver ladder: console → network → DOM → vision | Cheapest checks first; most bugs (incl. `<script>`-in-JSX) die before a vision call | ✅ Validated — console rung caught the React-18 nesting warning a screenshot misses |
| All work on `feat/bgsd-v0`, never `next` | Hard rule: never write to main/production | — Active |

## Context

- **Repo:** `filippo-fonseca/better-gsd` (fork of `@opengsd/gsd-core` v1.6.0), default branch `next`.
- **Working branch:** `feat/bgsd-v0`.
- **PRD source:** `BETTER-GSD-DOCS/better-gsd-plan.md` (16 parts; v0 = Part 8).
- **GSD runtime:** installed at `~/.claude/gsd-core` (used for tooling); fork's own `gsd-core/` is the vendored source.

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`): re-check requirements (validated/invalidated/new), log decisions, confirm "What This Is" still accurate.

**After each milestone** (via `/gsd-complete-milestone`): full review; confirm Core Value priority; audit Out of Scope; promote next version (v1) into Active.

---
*Last updated: 2026-06-29 — Milestone 1 (v0) complete & proven. Next: promote v1 (fix-stream + Loop 1) to Active.*
