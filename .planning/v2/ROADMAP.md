# Roadmap: better-gsd (bgsd) — Milestone 3 (v2)

## Overview

v2 ships the **Project orchestrator (`/bgsd-run`) — Kiwi, the Conductor** as a *process* orchestrator: it decomposes one large prompt into a dependency graph of whole-GSD-pipeline units, spawns them in parallel across isolated git worktrees as headless `claude -p` processes, coordinates them through a control-file protocol (heartbeat/restart, assumption-and-continue, escalate-only-if-unknown), runs **Loop 1 per worktree** (reusing the v1 loop), conflict-pre-checks and merge-resolves verified branches into a single **`rehearsal/<run-id>`** integration branch in dependency order, aggregates each worktree's docs into a run ledger, cleans up merged branches, and **checkpoints to the user at every merge boundary** — all behind an **always-on, colorful live status view** (Kiwi) and with **context that never overflows**. It is the parallel evolution of v1's single-stream loop, and it deliberately stops at *assembling* `rehearsal/<run-id>` (Loop 2 / integration verify→fix is v3).

The roadmap is de-risked hardest-first, and is structured around one critical split: **the bulk is buildable + unit-testable deterministically with mocked process spawns** (the decomposition/dependency-graph data structures, the control-file protocol + heartbeat state machine, the worktree/scheduler logic, the conflict pre-check + merge-resolver policy, doc aggregation + branch cleanup, the status-view rendering, and context management), while **the live multi-process orchestration run is its own single HUMAN-GATED phase/criterion** (guarded behind `--live`, opt-in, human-supervised, never CI, never `next`) — mirroring exactly how v1 isolated Loop 1's live run. Phase 1 stands up decomposition + the dependency graph (the load-bearing structure everything downstream consumes; bad decomposition poisons all parallelism). Phase 2 builds the control-file protocol + heartbeat/restart (the coordination contract). Phase 3 builds deterministic worktree creation + the wave scheduler with mocked spawns. Phase 4 is the riskiest piece — the live `/bgsd-run` lifecycle and the real multi-process spawn, **human-gated**. Phases 5–8 build conflict/merge, rehearsal assembly + docs + cleanup, the live status view, and context management. Phase 9 documents the surface. Every phase is additive under `bgsd/`, reuses the v0 Tester + v1 Loop 1 / ui.mjs contracts unchanged, never edits vendored GSD, and never touches `next`.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**Ordering note:** Phases run in numeric order, but the riskiest live wiring (the real multi-process orchestration run, Phase 4) is front-loaded right after its three hard dependencies are in place (the graph contract, the control-file protocol, and the deterministic worktree/scheduler logic). The single human-gated live phase (Phase 4's `--live` criterion) is built and unit-tested in isolation behind **mocked spawns** with the live wiring flagged off by default; the real merge-resolver invocation (Phase 5) and real context-pressure restarts (Phase 8) are exercised only under that same `--live` gate.

- [x] **Phase 1: Decomposition + Dependency Graph** - Decompose a prompt into whole-pipeline units and a verified DAG with wave grouping — the load-bearing structure all parallelism consumes
- [x] **Phase 2: Control-File Protocol + Heartbeat/Restart** - The `<agent-id>.json` coordination contract + assumption/blocker/escalation protocol + deterministic heartbeat→restart state machine
- [x] **Phase 3: Worktree Fan-Out + Wave Scheduler (mocked spawns)** - Deterministic per-worktree isolation (port/DB fan-out) + the dependency-aware wave scheduler, with the spawn boundary dependency-injected and unit-tested under mocked spawns
- [x] **Phase 4: `/bgsd-run` Lifecycle + Live Multi-Process Orchestration** *(HUMAN-GATED live run)* - The full run lifecycle/state-machine, abort, merge-boundary checkpoints, and the real headless multi-process spawn guarded behind `--live` (human-supervised, not yet executed) — lifecycle + abort + checkpoints built & unit-tested; live spawn behind `--live`, not executed
- [x] **Phase 5: Conflict Pre-Check + Merge-Resolver** - Deterministic git dry-run conflict pre-check + dependency-ordered merges, with the merge-resolver agent injected behind a mocked boundary and a human-escalation path for low-confidence conflicts
- [x] **Phase 6: Rehearsal Assembly + Doc Aggregation + Cleanup** - Assemble `rehearsal/<run-id>`, aggregate each worktree's `.planning/` into the run ledger + CHANGELOG, and clean up merged branches reversibly
- [x] **Phase 7: Live Colorful Status View (Kiwi)** - Always-on `/bgsd-status` view on ui.mjs — per-worktree badges, stage, loop counts, merge state, budget/context telemetry, the 🔒 main-protected indicator
- [x] **Phase 8: Conductor Context Management** - Pointers-not-blobs handoff, deterministic context-pressure monitoring, compaction/clear/re-launch orchestration, and a shared research/prompt cache so context never overflows
- [x] **Phase 9: Diagram-First Docs** - `/bgsd-run` + Conductor and `/bgsd-status` + Kiwi pages, GSD-Mintlify style, including the exact human-gated `--live` steps

## Phase Details

### Phase 1: Decomposition + Dependency Graph
**Goal**: One large prompt becomes a set of whole-GSD-pipeline units arranged into a verified directed acyclic dependency graph with topological wave grouping — the load-bearing structure every later phase consumes. Bad decomposition poisons all parallelism, so this is the data contract built first.
**Mode:** mvp
**Depends on**: v1 (queue/route/classify engine + the `.bgsd/` ledger namespace) — first v2 phase
**Requirements**: GRAPH-01, GRAPH-02, GRAPH-03, GRAPH-04
**Success Criteria** (what must be TRUE):
  1. A prompt decomposes into units (each a whole-pipeline work item with id/title/scope/touched-surface estimate) via the single Opus/xhigh decompose call (Part 11 row), and the units serialize to `RUN.md`.
  2. Units arrange into a DAG with topological wave grouping (independent units in the same wave, dependents later), built as a deterministic structure with zero model calls in the graph-construction path (NFR-05).
  3. The graph passes a verification pass before any downstream use — cycle check + a false-independence/overlap heuristic on touched-surface estimates — and a graph that fails is re-decomposed or escalated, never marked ready (NFR-06).
  4. Per-unit GSD model posture (the per-worktree × per-role × per-phase matrix from a cheap difficulty score) is computed and written as the would-be `.planning/config.json` for each unit via the config seam only, with zero edits to vendored GSD (NFR-03/04).
**Risk flags**: Decomposition quality is load-bearing for all of v2 (Plan Part 9 §6) — false independence causes downstream merge conflicts. Mitigate: treat the graph as a verified contract (Criterion 3), bias the overlap heuristic toward declaring a dependency, and confine the expensive reasoning to the one decompose call with everything else scripted.
**Plans**: TBD

### Phase 2: Control-File Protocol + Heartbeat/Restart
**Goal**: Define and implement the `<agent-id>.json` control-file schema as the coordination contract (filesystem + git, never shared context), plus the assumption-and-continue → clean-exit-on-blocker → answer-from-context → re-launch protocol and the deterministic heartbeat→stall→restart state machine.
**Mode:** mvp
**Depends on**: Phase 1 (units/agent-ids come from the graph)
**Requirements**: CTRL-01, CTRL-02, CTRL-03, CTRL-04
**Success Criteria** (what must be TRUE):
  1. Each agent's `/.bgsd/control/<agent-id>.json` carries the full schema (`agent_id`, `worktree`, `branch`, `phase`, `status`, optional `blocker`, `heartbeat`, `commits`) and is read/written by deterministic scripts (NFR-05).
  2. A stale heartbeat (older than the configurable threshold) is detected by pure scripted logic and triggers a restart on the same worktree/branch resuming from committed state — the restart action injected so it is testable under a mocked spawn (CTRL-02).
  3. A hard blocker exits clean with `status: blocked`; the Conductor answers from context (REQUIREMENTS/PROJECT/codebase/prior runs), writes `<agent-id>.inbox.md`, and re-launches with that pointer appended (pass pointers, not blobs) — triage Haiku/low, answer Sonnet/medium (Part 11).
  4. Only an unanswerable high-severity blocker reaches the user as exactly one consolidated, deduplicated question through the Kiwi channel; its worktree parks `blocked`/`needs_input` while the rest of the run continues (NFR-06/07).
**Risk flags**: Headless block/resume ergonomics are an open question (Plan Part 9 §4) — the cleanest `claude -p` resume mechanism (context-append re-launch vs session resume) needs a spike. Mitigate: the protocol/state machine is built and unit-tested deterministically with mocked re-launch here; the real resume mechanism is validated only under Phase 4's `--live` gate.
**Plans**: TBD

### Phase 3: Worktree Fan-Out + Wave Scheduler (mocked spawns)
**Goal**: Deterministically create an isolated git worktree per unit (own branch + own port + ephemeral DB/seed via the v0 `runtime-isolate.sh` convention fanned out so testers never collide) and schedule which units spawn when — a pure function over the graph + control-file states — with the actual process launch dependency-injected so the whole thing is unit-testable under **mocked spawns**.
**Mode:** mvp
**Depends on**: Phase 1 (the graph) + Phase 2 (control files) + v0 `runtime-isolate.sh`
**Requirements**: SPAWN-01, SPAWN-02, SPAWN-03
**Success Criteria** (what must be TRUE):
  1. For a unit, a deterministic script creates `.bgsd/worktrees/<agent-id>/` on branch `<run-id>/<slug>` off the current `rehearsal/<run-id>` head (or base head for wave 1), with a unique port + ephemeral DB/seed per worktree (no collisions across ≥2 concurrent worktrees in test).
  2. The spawn boundary is dependency-injected: the controller decides *which* units to launch and *when*, and the actual `claude -p` launch is an injected function, so the controller runs green under fully **mocked spawns** with no real process (mirrors v1 loop1/loop1-live DI split).
  3. The wave scheduler launches only units whose graph dependencies are all `merged` and honors `max_parallel`, as a pure scripted function over the graph + control-file states (NFR-05).
  4. Caffeinate-keep-awake is wired as an opt-in setup helper for live runs (DEF-09), and a `--dry-run` prints the spawn plan + would-be worktrees/branches without launching anything.
**Risk flags**: Runtime isolation for parallel testers is load-bearing (Plan Part 9 §2) — port/DB collisions would corrupt parallel verification. Mitigate: deterministic per-worktree port hashing + ephemeral DB from v0, exercised with ≥2 concurrent mock worktrees here; the real concurrent boot is validated under Phase 4's `--live` gate.
**Plans**: TBD
**UI hint**: yes

### Phase 4: `/bgsd-run` Lifecycle + Live Multi-Process Orchestration *(HUMAN-GATED live run)*
**Goal**: Wire the full `/bgsd-run` lifecycle/state-machine (mint run-id → decompose → fan-out → Loop 1 per worktree → conflict-checked merge → merge-boundary checkpoint), `/bgsd-abort`, and the user checkpoints — then prove the riskiest thing in v2: a **real** end-to-end multi-process orchestration spawning ≥2 concurrent headless `claude -p` Pipeline Agents across real worktrees, **human-gated**.
**Mode:** mvp
**Depends on**: Phases 1–3 (graph + control files + worktree/scheduler) and v1 Loop 1
**Requirements**: RUN-01, RUN-02, RUN-03, RUN-04, SPAWN-04
**Success Criteria** (what must be TRUE):
  1. `/bgsd-run "<prompt>"` mints `bgsd-<NNNN>-<slug>`, opens the run record + ledger entry, and drives the lifecycle state machine (`created→decomposed→spawning→executing→verifying→merging→checkpoint→…`) as a deterministic script loop that never holds the whole run in context (NFR-05/09); an interrupted run resumes from persisted state without re-spawning completed worktrees, and `/bgsd-abort` exits all processes cleanly while preserving branches/control/ledger (RUN-04).
  2. At every merge boundary the Conductor checkpoints to the user (what merged, what is held back, the one consolidated blocker if any) and waits for go/no-go — never fire-and-forget; `rehearsal/<run-id>` is never merged to `next` (RUN-03, NFR-08).
  3. The entire lifecycle + spawn orchestration runs green under **mocked spawns** in unit tests before any live run — Loop 1 per worktree is the v1 controller reused unchanged (no rewrite).
  4. **(HUMAN-GATED live run)** A real `--live` run spawns ≥2 concurrent headless `claude -p` Pipeline Agents across real worktrees with real servers, drives each through Loop 1, and merges at least one verified branch into `rehearsal/<run-id>` with a merge-boundary checkpoint — executed manually by the human, never in automated CI, `next` never written, and a `--dry-run` default makes accidental live spawn impossible.
**Risk flags**: **Highest-risk phase.** Spawning real headless processes and running live parallel orchestration cannot be validated unsupervised (cost, runaway loops, partial merges, orphaned processes). Mitigate: the full lifecycle is built + unit-tested deterministically behind mocked spawns (Criterion 3); the live run is a single off-by-default `--live` opt-in, human-supervised, with `--dry-run` as the default; per-run budget cap + `max_iterations` + abort guarantee bounded/reversible autonomy (NFR-08); the guard hook makes a write to `next` impossible.
**Plans**: TBD
**UI hint**: yes

### Phase 5: Conflict Pre-Check + Merge-Resolver
**Goal**: Before each merge into `rehearsal/<run-id>`, run a deterministic git dry-run conflict pre-check; merge clean branches in dependency order; hand genuine conflicts to a dedicated merge-resolver agent with full context; and hold back low-confidence conflicts for human resolution — never a fabricated clean merge.
**Mode:** mvp
**Depends on**: Phase 4 (the lifecycle that drives merges) + Phase 1 (dependency order)
**Requirements**: CONFLICT-01, CONFLICT-02, CONFLICT-03, CONFLICT-04
**Success Criteria** (what must be TRUE):
  1. A deterministic git dry-run merge (no model) reports clean/not-clean + the exact conflicted paths/hunks for any worktree branch against the current `rehearsal/<run-id>` head (NFR-05).
  2. A clean pre-check merges the branch in dependency order (independent first) and marks the unit `merged`; merge order is a pure function of the graph + which units passed Loop 1.
  3. A non-clean pre-check invokes the merge-resolver agent (Opus/high, full requirements + both branch summaries) behind a dependency-injected boundary, so the orchestration runs green under a **mocked resolver** in unit tests (real resolver only under `--live`).
  4. A conflict the resolver is not confident about is held back from `rehearsal/<run-id>` in `needs_input` with the conflict + proposed resolution attached and surfaced at the merge-boundary checkpoint — never auto-resolved, never a fabricated clean merge (NFR-06/07).
**Risk flags**: Auto-resolving cross-worktree conflicts is genuinely hard (Plan Part 9 §5). Mitigate: the deterministic pre-check + dependency-ordered merge handle the common clean case with zero model spend; the resolver is confined to genuine conflicts with full context; the mandatory human-escalation path for low-confidence conflicts means correctness never depends on the resolver being right.
**Plans**: TBD

### Phase 6: Rehearsal Assembly + Doc Aggregation + Cleanup
**Goal**: Assemble the single `rehearsal/<run-id>` integration branch from all verified branches in dependency order, aggregate each worktree's `.planning/` into the run ledger (`RUN.md`/`AGENTS.md`/`ledger.md`) + a per-agent CHANGELOG, and clean up merged worktree branches reversibly — leaving a permanent, traceable record of every run and subagent.
**Mode:** mvp
**Depends on**: Phase 5 (conflict-checked merges) + Phase 1 (graph for `RUN.md`)
**Requirements**: REHEARSE-01, REHEARSE-02, REHEARSE-03, REHEARSE-04
**Success Criteria** (what must be TRUE):
  1. `rehearsal/<run-id>` assembles from all verified worktree branches in dependency order (never `dev`/`develop`/`next`); v2 stops at assembly + checkpoint and runs no Loop 2 over it.
  2. A deterministic doc-aggregation script pulls each worktree's `.planning/` summaries into `RUN.md` (prompt/decomposition/graph/timeline) + `AGENTS.md` (per-subagent asked/did/decided/committed) and updates `.bgsd/ledger.md` (NFR-05).
  3. After a successful merge, the worktree branch + checkout are removed by default while `rehearsal/*` is retained; `/bgsd-clean-branches` prunes only `rehearsal/*` already merged to base and never deletes an unmerged branch (NFR-01).
  4. A per-agent human-readable CHANGELOG is generated into the run record by a cheap summarizer (Haiku/low) — the seed for v3's PR body, built now but NOT wired into a PR at this milestone.
**Risk flags**: Low–medium. Cleanup is destructive (branch deletion) — mitigate by deleting only branches confirmed merged into `rehearsal/<run-id>` (and `/bgsd-clean-branches` only prunes `rehearsal/*` already merged to base), never an unmerged branch, with the worktree's work fully documented before deletion.
**Plans**: TBD

### Phase 7: Live Colorful Status View (Kiwi)
**Goal**: An always-on, colorful, read-only `/bgsd-status` view built on `bgsd/scripts/ui.mjs` that shows the whole run at a glance — current stage, every active worktree/subagent with a color-coded badge, Loop 1 iteration counts, per-worktree GSD phase, merge state, where input is needed, and live budget/context telemetry — with the Kiwi identity and a constant 🔒 main-protected indicator. First-class UX, not a nicety.
**Mode:** mvp
**Depends on**: Phases 2 (control files) + 4 (lifecycle) + 5–6 (merge/ledger state to render); reuses v1 ui.mjs
**Requirements**: STATUS-01, STATUS-02, STATUS-03, STATUS-04
**Success Criteria** (what must be TRUE):
  1. `/bgsd-status` renders the live run from control + ledger files with color-coded per-worktree badges (running/blocked/needs-input/done/failed), the current stage, Loop 1 iteration counts, per-worktree GSD phase, merge state, and where input is needed — zero model calls in the view path (NFR-05).
  2. The Kiwi identity is consistent — the terracotta pixel-block sprite + info column on launch, a mini 3-row variant heading `/bgsd-status`, "Kiwi" in every orchestrator string, and a constant 🔒 main-protected indicator (Part 16).
  3. Live budget + context telemetry is visible (running token/$ vs cap, parallelism × fan-out multiplier, context-pressure / downshift state) so spend, context health, and graceful-downshift are surfaced, never silent (NFR-08/09).
  4. The view degrades correctly in non-TTY/`NO_COLOR`/CI (plain output) and updates incrementally without corrupting the terminal during a long live run, reusing ui.mjs's COLOR_OK discipline.
**Risk flags**: Low. Reuses the proven v1 ui.mjs primitives; main risk is the view drifting from real run state — mitigate by rendering strictly from the same control/ledger files the Conductor writes (single source of truth), never a separate state.
**Plans**: TBD
**UI hint**: yes

### Phase 8: Conductor Context Management
**Goal**: Guarantee context never overflows — the Conductor passes pointers not blobs, monitors context pressure deterministically per agent and for its own supervisor persona, orchestrates compaction/clear/fresh-context re-launch when an agent nears its limit, exploits large/1M windows where available, and caches shared research + prompt-caches stable docs across the wide fan-out.
**Mode:** mvp
**Depends on**: Phases 2 (control/re-launch) + 4 (lifecycle) + 1 (research cache seeded from decomposition)
**Requirements**: CTX-01, CTX-02, CTX-03
**Success Criteria** (what must be TRUE):
  1. The Conductor loop reads/writes only small control + ledger files and hands every spawned agent pointers (file paths) + only its slice (its plan + the relevant requirements excerpt) — minimal-context handoff enforced at the spawn boundary (NFR-09).
  2. Context pressure is monitored deterministically (token/usage signals captured by script) per agent and for the supervisor persona; nearing a window limit triggers compaction/clear or a fresh-context re-launch (resume from committed state + inbox pointer), and a large/1M window is preferred where the run config makes one available.
  3. A run-level research/decision cache (+ GSD learnings) lets worktrees reuse prior research instead of re-deriving it, and stable system prompts + requirements/spec docs are prompt-cached across the fan-out — never paying twice for context, logs, or research (NFR-05/09).
**Risk flags**: Medium. The real compaction/re-launch path can only be fully validated live (it shares Phase 4's `--live` gate). Mitigate: the monitoring + decision logic is built + unit-tested deterministically here against simulated usage signals; the actual mid-run compaction/re-launch is exercised only under the human-gated live run.
**Plans**: TBD

### Phase 9: Diagram-First Docs
**Goal**: A user can drive a `/bgsd-run` project orchestration, read `/bgsd-status`, and (carefully) execute a real `--live` run from the docs alone, including every human-gated step and the never-touch-`next` rule.
**Mode:** mvp
**Depends on**: Phases 1–8
**Requirements**: DOCS-05, DOCS-06
**Success Criteria** (what must be TRUE):
  1. A diagram-first `/bgsd-run` + Conductor page (GSD-Mintlify style) documents decompose → dependency graph → parallel worktrees → Loop 1 → conflict-checked merge into `rehearsal/<run-id>` → merge-boundary checkpoint, with the two-loop/branch-model diagrams, the control-file protocol, the routing matrix, and the exact human-gated `--live` steps (and the `--dry-run` default).
  2. A `/bgsd-status` + Kiwi page documents the live view (badges, stage, budget/context telemetry, 🔒 main-protected), `/bgsd-clean-branches`, and `/bgsd-abort`.
  3. Both pages render in the GSD-Mintlify docs site without breaking its existing navigation or build.
**Risk flags**: Low. Reuses the v0/v1 docs pipeline; main risk is docs drifting from the shipped surface — write them last, against the built behavior.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9
(Phase 4 is front-loaded as the riskiest live work right after its dependencies — the graph (1), control files (2), and worktree/scheduler (3) — are in place. Phase 7 (status view) depends on enough merge/ledger state to render and so follows 5–6; Phase 8 (context) can proceed in parallel with 5–7 once 4 lands, since it shares Phase 4's `--live` gate for its live portion.)

**Human-gated phases/criteria** (built + unit-tested in isolation behind mocked spawns; live wiring flagged off by default, `--dry-run` is the default, never CI, never `next`):
- **Phase 4, Criterion 4 — the live multi-process orchestration run** (≥2 concurrent headless `claude -p` Pipeline Agents across real worktrees; SPAWN-04). This is the single primary human-gated criterion.
- Phase 2, Criterion 2 — real heartbeat-triggered restart / `claude -p` resume mechanism (validated only under the Phase 4 `--live` gate).
- Phase 5, Criterion 3 — real merge-resolver agent invocation (mocked resolver in tests; real resolver only under `--live`).
- Phase 8, Criterion 2 — real mid-run compaction / fresh-context re-launch (logic unit-tested; real path only under `--live`).

**Deterministic-buildable (the bulk, unit-testable with mocked spawns/resolver):** all of Phases 1, 3, 5 (pre-check + dependency-ordered merge), 6, 7, 9, plus the lifecycle/state-machine + abort of Phase 4 (Criterion 3), the protocol/state-machine of Phase 2, and the monitoring/decision logic of Phase 8.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Decomposition + Dependency Graph | 1/1 | Complete | 2026-06-29 |
| 2. Control-File Protocol + Heartbeat/Restart | 1/1 | Complete | 2026-06-29 |
| 3. Worktree Fan-Out + Wave Scheduler (mocked spawns) | 1/1 | Complete | 2026-06-29 |
| 4. `/bgsd-run` Lifecycle + Live Multi-Process Orchestration (HUMAN-GATED) | 1/1 | Built (live run human-gated) | 2026-06-29 |
| 5. Conflict Pre-Check + Merge-Resolver | 1/1 | Complete | 2026-06-29 |
| 6. Rehearsal Assembly + Doc Aggregation + Cleanup | 1/1 | Complete | 2026-06-29 |
| 7. Live Colorful Status View (Kiwi) | 1/1 | Complete | 2026-06-29 |
| 8. Conductor Context Management | 1/1 | Complete | 2026-06-29 |
| 9. Diagram-First Docs | 1/1 | Complete | 2026-06-29 |
