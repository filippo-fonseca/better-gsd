# Requirements: better-gsd (bgsd) — Milestone 2 (v1)

**Defined:** 2026-06-29
**Core Value (v1):** A persistent fix-stream queue you keep feeding that classifies/routes each item to a GSD quick path, executes it, verifies it with the v0 Tester (`/bgsd-verify`), and — on defects — runs a Ralph-style verify→fix loop in ONE worktree until the item passes or a stop condition is hit, all without touching production. Plus a scheduled Hyperpolymath capture→queue drop that feeds the queue automatically.
**Milestone:** Milestone 2 = v1 only (Fix-stream mode `/bgsd-queue` + Loop 1 + the Hyperpolymath capture→queue cron). Builds directly on the v0 Standalone Tester.
**Plan source:** `BETTER-GSD-DOCS/better-gsd-plan.md` — Part 8 (v1 build-sequence subsection), Part 5 (Loop 1 mechanics), Part 7 (command surface). Routing/triage policy from Part 11; engine constraints from Part 3.

## Non-Functional Constraints (Hard Rules — enforced, not aspirational)

These apply to every v1 requirement and must hold at all times. They are inherited unchanged from v0 (Part 2 of the plan); v1 adds NFR-07 for autonomy safety.

- [ ] **NFR-01 (Branch safety)**: bgsd never writes, commits, pushes, or opens a PR to the default/production branch (`next`). All work lands on `feat/bgsd-v0` (or a later feat branch). No automation targets `next`, ever. (Plan Part 1 §9, Part 2.)
- [ ] **NFR-02 (Additive code)**: All bgsd source lives under its own `bgsd/` namespace (plus its `bgsd/.claude-plugin/plugin.json` manifest and `.bgsd*` runtime dirs). bgsd never adds files into GSD's own directories in a way that changes GSD behavior. (Plan Part 1 §1.)
- [ ] **NFR-03 (Never edit vendored GSD)**: The forked GSD source (root `commands/`, `agents/`, `gsd-core/`, `skills/`, `hooks/`, `.claude-plugin/plugin.json`, root `.gitignore`, root `docs/`, `src/`) is read-only to bgsd. bgsd makes zero edits to it. (Plan Part 2.)
- [ ] **NFR-04 (Seams only)**: bgsd touches GSD only through three stable seams — (1) GSD's `/gsd-*` slash commands, (2) the documented `.planning/` file contract, (3) `config.json`. No reaching into GSD internals. (Plan Part 1 §1, Part 12.)
- [ ] **NFR-05 (Capture-then-summarize / scripts over models)**: Queue I/O, dedup, status reads, port assignment, server boot/teardown, the loop control-loop poll, and iteration accounting are deterministic scripts — never a model. Only the failing slice (defects, an item's classify signal) is handed to a model. Never pay a model to poll or babysit a queue, a browser, or a server. (Plan Part 11 "rule zero", Part 13 §1–2.)
- [ ] **NFR-06 (No silent green)**: When a queue item cannot be truly verified (Tester emits `BLOCKED`/`ERROR`/`UNRELIABLE`, MCP unavailable, server won't boot, or the loop exhausts `max_iterations` without a clean Tester pass), the item ends in a structured non-PASS terminal state (`BLOCKED`/`FAILED`/`NEEDS_INPUT`) — never a fabricated `DONE`/`PASS`. (Plan Part 5 §5, v0 NFR-06.)
- [ ] **NFR-07 (Bounded, reversible autonomy)**: Every loop is bounded by a configurable `max_iterations` and exits cleanly on any stop condition; the live Hyperpolymath cron and any process-spawning run are human-gated (off by default, explicit opt-in, dry-run path provided). No unbounded re-injection; no fire-and-forget at this milestone. (Plan Part 5 §5, Part 8 v2 caveat "don't promise fire-and-forget yet", Part 9 §3.)

## v1 Requirements (this milestone)

Requirements for the v1 release. Each maps to exactly one roadmap phase. Grouped by area: QUEUE, ROUTE, LOOP, CAPTURE, plus DOCS.

### Fix-Stream Queue (QUEUE)

- [ ] **QUEUE-01**: `/bgsd-queue` exposes the `add | start | status` subcommands from Part 7. `add` appends one fix/feature item; `start` begins draining the queue; `status` prints a live, read-only view (counts per state, current item, last verdict). (Plan Part 7.)
- [ ] **QUEUE-02**: The queue is a durable, human-readable file under the `.bgsd/` ledger namespace (e.g. `.bgsd/queue/queue.jsonl` or a `queue.md` table) with one record per item carrying `id`, `title`, `body`, `source` (manual|hyperpolymath), `state`, `created_at`, and `attempts`. Reads/writes are deterministic scripts (NFR-05), append-only where possible for traceability (Plan Part 6 ledger discipline, Part 1 §12).
- [ ] **QUEUE-03**: Each item moves through an explicit state machine — `queued → classified → routed → executing → verifying → looping → (done | blocked | failed | needs_input)` — and every transition is timestamped and recorded so the trail is auditable (Plan Part 6, Part 1 §4 traceability).
- [ ] **QUEUE-04**: The drainer is a single-stream, single-worktree control loop: it pulls exactly ONE item at a time, runs it to a terminal state, then advances to the next — no parallelism, no second worktree (that is v2). It is a script loop whose context never balloons (Plan Part 8 v1 "one worktree + one loop", Part 3, Part 13 §2).
- [ ] **QUEUE-05**: The drainer is idempotent and resumable: re-running `start` after an interruption resumes from the persisted state without re-executing already-`done` items or losing in-flight items, and de-duplicates items by a stable content key (Plan Part 1 §4, NFR-05).

### Classification & Routing (ROUTE)

- [ ] **ROUTE-01**: Each item is classified into a route class (e.g. `trivial-fix | scoped-fix | feature | needs-clarification`) by a cheap, low-stakes judgment step — Haiku/low effort per the Part 11 "blocker triage + queue classify" row — fed only the item's title/body, never the whole repo (NFR-05, Plan Part 11).
- [ ] **ROUTE-02**: The classifier maps each route class to a concrete GSD quick-path invocation through the command seam only — `/gsd-quick` or `/gsd-fast` for trivial/scoped items, the `discuss→plan→execute` chain for a feature item — and records the chosen route on the item. bgsd calls `/gsd-*`; it never reimplements GSD execution (Plan Part 8 v1 "classify/route to GSD quick path", Part 7, NFR-04).
- [ ] **ROUTE-03**: An item classified `needs-clarification` does NOT execute; it parks in `needs_input` with the specific question recorded, and the drainer continues to the next item rather than blocking the whole stream (Plan Part 3 §3 "assumption-and-continue / escalate only if unknown", NFR-06/07).
- [ ] **ROUTE-04**: Routing sets the GSD run's model posture via the config seam (writing the worktree's `.planning/config.json` model profile / `model_overrides`), defaulting to the `balanced` profile with an effort hint derived from a cheap difficulty score (files/scope/prior-attempt count) — never by editing GSD itself (Plan Part 11 two-level routing, NFR-04).

### Loop 1 — Per-Worktree Verify→Fix (LOOP)

- [ ] **LOOP-01**: After an item's GSD execution reports complete, the loop spawns the v0 Tester (`/bgsd-verify`) against that worktree's isolated running instance, reusing the v0 `runtime-isolate.sh` + driver ladder + `verification-report.json` contract unchanged (Plan Part 5 §2–4, builds on v0).
- [ ] **LOOP-02**: On a Tester `FAIL`, the defect list from `verification-report.json` becomes a fix backlog and a Ralph-style stop-hook re-injects a fix agent (Sonnet/medium per Part 11) to address the defects, after which the item is re-verified — fix→re-test, not a one-shot (Plan Part 5 §5, Part 11 fix-agent row).
- [ ] **LOOP-03**: The loop repeats verify→fix until the Tester returns `PASS` (clean) OR a stop condition fires: `max_iterations` reached, no-progress detected (same defect signature recurring), or a `BLOCKED`/`ERROR` Tester verdict. Each iteration count and stop reason is recorded (Plan Part 5 §5, Part 9 §3 `max_iterations`, NFR-07).
- [ ] **LOOP-04**: A clean `PASS` marks the item `done` and its branch eligible for merge into a single per-run integration branch named `rehearsal/<run-id>` (the v1 single-stream form). A non-clean stop marks the item `failed`/`blocked` with the report path attached. v1 never merges `rehearsal/<run-id>` into `next` — that stays human-only (Plan Part 5 §6, Part 1 §8–9, NFR-01/06).
- [ ] **LOOP-05**: The escalation ladder climbs the cheap knob first — on a repeated fix failure, retry one effort band higher on the same model, then escalate the model after `escalate_after_iters`; spend stays adaptive to demonstrated difficulty and the per-run budget cap downshifts only non-critical layers (Plan Part 11 escalation ladder + budget, NFR-05).

### Hyperpolymath Capture→Queue Cron (CAPTURE)

- [ ] **CAPTURE-01**: A documented capture seam defines the contract for turning an external Hyperpolymath item into a `/bgsd-queue` record (the input shape it consumes, the queue record it emits, and the `source: hyperpolymath` tag), implemented as a deterministic adapter script — not a model (Plan Part 8 v1 "Hyperpolymath capture → cron → queue drop", Part 12 ACL adapter pattern, NFR-04/05).
- [ ] **CAPTURE-02**: The capture adapter is built and fully tested against a MOCK/fixture Hyperpolymath source (a local fixture file or stub), proving items flow capture→classify→queue end-to-end with zero live external dependency (HUMAN-GATED isolation requirement; Plan Part 8 v1, task instruction "design the seam + a mock/dry-run").
- [ ] **CAPTURE-03**: A scheduling wrapper turns the capture adapter into a cron-style scheduled drop with a mandatory `--dry-run` mode that resolves, classifies, and previews would-be queue entries WITHOUT enqueuing or executing — the default, non-destructive path (NFR-07, Plan Part 13 §1 scripts-over-models).
- [ ] **CAPTURE-04**: The LIVE external Hyperpolymath hookup (real source credentials/endpoint, real cron registration that enqueues for real) is explicitly flagged as a human-gated integration: off by default, opt-in only, with the live wiring point clearly marked in the seam doc and NOT exercised by automated tests. The mock path (CAPTURE-02) is the only thing CI runs (HUMAN-GATED; task instruction "Treat the live external hookup as a human-gated integration … flag the live wiring", NFR-07).

### Docs (DOCS)

- [ ] **DOCS-03**: A `/bgsd-queue` usage page (GSD-Mintlify style, diagram-first) documents the `add|start|status` subcommands, the queue file/state-machine, the classify→route→execute→verify→loop flow, and the stop conditions (Plan Part 6, Part 14, mirrors v0 DOCS-02).
- [ ] **DOCS-04**: A Hyperpolymath capture→queue page documents the capture seam contract, how to run the `--dry-run` cron, and the exact human-gated steps to enable the live hookup (with the safety caveats), so the live integration is reproducible but never accidental (Plan Part 8 v1, NFR-07).

## Deferred (v2+) — Out of Scope for this Milestone

Tracked but explicitly NOT in the v1 roadmap. Promoted into Active scope only at a future milestone boundary. (v0 deferred items DEF-01..DEF-11 remain deferred except DEF-03/DEF-05-queue/DEF-09, which v1 now activates.)

### Orchestration & Parallelism (v2)

- **DEF-12 (v2)**: Conductor / Kiwi orchestrator — decomposition, dependency graph, headless `claude -p` process spawning across worktrees, control-file protocol (`<agent-id>.json` + inbox), heartbeat/restart. (Plan Part 3, Part 8 v2.) v1 is single-stream and single-worktree, so none of this is built.
- **DEF-13 (v2)**: `/bgsd-run` project mode — one massive prompt decomposed into parallel full-GSD worktrees. (Plan Part 7, Part 8 v2.)
- **DEF-14 (v2)**: Multi-worktree parallelism + per-worktree port/DB fan-out beyond the single v1 instance, conflict pre-check + merge-resolver agent, dependency-ordered merges. (Plan Part 4, Part 8 v2.)
- **DEF-15 (v2)**: Conductor→user checkpoints at merge boundaries; `/bgsd-status` as a multi-agent live view; `/bgsd-clean-branches`, `/bgsd-abort`. (Plan Part 7, Part 8 v2.)
- **DEF-16 (v2+)**: Full model+effort routing matrix across the parallel fan-out (per-worktree × per-role × per-phase), budget caps under parallel pressure, `CLAUDE_CODE_SUBAGENT_MODEL` global ceiling. v1 uses only the single-stream subset (ROUTE-04, LOOP-05). (Plan Part 11.)

### Integration & Feedback (v3)

- **DEF-17 (v3)**: Loop 2 — integration verify→fix on the assembled `rehearsal/<run-id>`, Integration Tester (whole-app UAT + code review + improvement scrutiny), parallel fix agents off the integration report. (Plan Part 5 Loop 2, Part 8 v3.) v1 only assembles a single-stream `rehearsal/<run-id>`; it does not run Loop 2 over it.
- **DEF-18 (v3)**: User Review Gate — `/bgsd-user-eval` (auto-boot + localhost URL + checklist) and the per-subagent CHANGELOG into the PR body. (Plan Part 7, Part 10, Part 8 v3.)
- **DEF-19 (v3)**: `/bgsd-feedback "<what's wrong>" [--fast]` — re-run both loops on user feedback, `--fast` parallel-fix shortcut. (Plan Part 7, Part 8 v3.)

### Infrastructure (carried)

- **DEF-20 (v1+/ongoing)**: Upgrade-resilient subtree vendoring (`vendor/gsd/`), `bgsd doctor`, seam contract tests, `gsd_contract_version` pin, self-updating cron with green-only interlock. v1 keeps the v0 marketplace-install path; full ACL hardening continues post-v1. (Plan Part 12.)
- **DEF-21 (v1 public)**: Landing page. (Plan Part 14.)
- **DEF-22 (v2+)**: Kiwi identity/mascot, always-on live Kiwi terminal view, Conductor context-window management. (Plan Part 16, Part 1 §14, v0 DEF-10/DEF-11.)

### Activated from v0's Deferred list at this milestone boundary

- **DEF-03 → LOOP-\*** (Loop 1 per-worktree verify→fix Ralph loop) is now Active.
- **DEF-05 (queue) → QUEUE-\* / ROUTE-\*** (`/bgsd-queue`) is now Active; the other commands in DEF-05 stay deferred.
- **DEF-09 → CAPTURE/LOOP NFR-07 context** (caffeinate during runs) is folded in as an opt-in setup helper for live runs only; not a standalone requirement this milestone.

## Out of Scope (this milestone)

| Feature | Reason |
|---------|--------|
| Conductor / Kiwi / multi-worktree parallelism / `/bgsd-run` | Orchestration is v2; v1 proves ONE worktree + ONE loop end-to-end first (Plan Part 8 v1) |
| Loop 2 (integration verify→fix) + Integration Tester | v3; v1 only runs Loop 1 per item, no whole-app integration pass |
| Control-file protocol, heartbeat/restart, merge-resolver, `rehearsal/<run-id>` multi-branch assembly | v2 process-orchestration machinery; v1 is a single-stream script loop |
| `/bgsd-user-eval`, `/bgsd-feedback`, per-agent CHANGELOG-into-PR | User Review Gate + feedback mode are v3 |
| Live Hyperpolymath external hookup running in CI/automation | Human-gated integration; only the mock/dry-run path is automated (CAPTURE-02/04) |
| Spawning real headless processes in automated tests | Process spawning is human-gated for v1; live loop runs flagged, built-and-tested in isolation (NFR-07) |

## Traceability

Each requirement maps to exactly one phase. NFRs are cross-cutting (apply to all phases). Phases are ordered hardest/riskiest-first (see ROADMAP.md).

| Requirement | Phase | Status |
|-------------|-------|--------|
| QUEUE-01 | Phase 1 | Pending |
| QUEUE-02 | Phase 1 | Pending |
| QUEUE-03 | Phase 1 | Pending |
| QUEUE-04 | Phase 1 | Pending |
| QUEUE-05 | Phase 1 | Pending |
| ROUTE-01 | Phase 2 | Pending |
| ROUTE-02 | Phase 2 | Pending |
| ROUTE-03 | Phase 2 | Pending |
| ROUTE-04 | Phase 2 | Pending |
| LOOP-01 | Phase 3 | Pending |
| LOOP-02 | Phase 3 | Pending |
| LOOP-03 | Phase 3 | Pending |
| LOOP-04 | Phase 3 | Pending |
| LOOP-05 | Phase 3 | Pending |
| CAPTURE-01 | Phase 4 | Pending |
| CAPTURE-02 | Phase 4 | Pending |
| CAPTURE-03 | Phase 4 | Pending |
| CAPTURE-04 | Phase 4 | Pending |
| DOCS-03 | Phase 5 | Pending |
| DOCS-04 | Phase 5 | Pending |
| NFR-01..07 | All phases (cross-cutting) | Pending |

**Coverage:**
- v1 functional requirements: 20 total (QUEUE 5, ROUTE 4, LOOP 5, CAPTURE 4, DOCS 2)
- Mapped to phases: 20
- Unmapped: 0 ✓
- Non-functional constraints: 7 (cross-cutting, enforced across all phases)
- Human-gated requirements (built + tested in isolation; live run flagged): CAPTURE-02, CAPTURE-03, CAPTURE-04 (live cron); LOOP-01..LOOP-04 live process-spawning runs (Phase 3 live-run criterion).

---
*Requirements defined: 2026-06-29*
*Last updated: 2026-06-29 after initial v1 definition*
