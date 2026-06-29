# Roadmap: better-gsd (bgsd) — Milestone 2 (v1)

## Overview

v1 ships **Fix-stream mode (`/bgsd-queue`) + Loop 1 + the Hyperpolymath capture→queue cron**: a persistent queue you keep feeding, where each item is classified, routed to a GSD quick path through the command seam, executed, verified with the v0 Tester (`/bgsd-verify`), and — on defects — run through a Ralph-style verify→fix loop in ONE worktree until it passes or a stop condition fires. This is the daily driver and the lowest-risk autonomy: it exercises one worktree + one loop end-to-end, deliberately NOT the multi-worktree Conductor (that is v2).

The roadmap is de-risked hardest-first. Phase 1 stands up the durable queue + state machine (the load-bearing data contract everything else writes to). Phase 2 wires classification/routing to GSD quick paths. Phase 3 is the riskiest piece — Loop 1's autonomous Ralph stop-hook with bounded iterations and a real process-spawning live run, which is **human-gated**. Phase 4 builds the Hyperpolymath capture seam against a mock and flags the **human-gated** live cron hookup. Phase 5 documents both surfaces. Every phase is additive under `bgsd/`, reuses the v0 Tester/isolation contract unchanged, never edits vendored GSD, and never touches the `next` branch.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**Ordering note:** Phases run in numeric order, but the riskiest work (Loop 1's bounded autonomous loop, Phase 3) is front-loaded right after its two hard dependencies (the queue contract and routing) are in place. The two human-gated phases (3's live run, 4's live cron) are built and tested in isolation with the live wiring flagged off by default.

- [x] **Phase 1: Fix-Stream Queue + State Machine** - Durable, resumable single-stream queue with `add|start|status` and an auditable per-item state machine
- [x] **Phase 2: Classification + GSD Quick-Path Routing** - Cheap classify each item and route it to a concrete `/gsd-*` quick path via the command + config seams
- [ ] **Phase 3: Loop 1 — Verify→Fix Ralph Loop** *(HUMAN-GATED live run)* - Bounded per-worktree verify→fix loop reusing the v0 Tester, until clean or a stop condition
- [ ] **Phase 4: Hyperpolymath Capture→Queue Cron** *(HUMAN-GATED live hookup)* - Capture seam + dry-run cron against a mock source; live external wiring flagged, not automated
- [ ] **Phase 5: Diagram-First Docs** - `/bgsd-queue` usage + Hyperpolymath capture pages, GSD-Mintlify style

## Phase Details

### Phase 1: Fix-Stream Queue + State Machine
**Goal**: A durable, human-readable, resumable single-stream queue is the data contract every later phase writes to — `add|start|status` work, and each item carries an auditable state machine.
**Mode:** mvp
**Depends on**: v0 (the `.bgsd/` ledger namespace + Tester contract) — first v1 phase
**Requirements**: QUEUE-01, QUEUE-02, QUEUE-03, QUEUE-04, QUEUE-05
**Success Criteria** (what must be TRUE):
  1. `/bgsd-queue add` appends an item and `/bgsd-queue status` prints a read-only view (per-state counts, current item, last verdict) with zero model calls in the I/O path (NFR-05).
  2. The queue file persists under `.bgsd/` with one auditable record per item (`id`, `title`, `body`, `source`, `state`, `created_at`, `attempts`), and every state transition is timestamped.
  3. The drainer pulls exactly ONE item at a time to a terminal state before advancing — no parallelism, no second worktree.
  4. Killing and re-running `start` resumes from persisted state: no `done` item re-executes, no in-flight item is lost, and duplicate items collapse by content key.
**Risk flags**: Queue schema is load-bearing for all of v1 — getting the state machine and resumability wrong here cascades. Mitigate by fixing the record shape + transitions first and treating it as a contract.
**Plans**: TBD

### Phase 2: Classification + GSD Quick-Path Routing
**Goal**: Each queued item is cheaply classified and routed to a concrete GSD quick-path invocation through the command + config seams only, with model posture set via `config.json` — never by editing GSD.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: ROUTE-01, ROUTE-02, ROUTE-03, ROUTE-04
**Success Criteria** (what must be TRUE):
  1. An item is classified into a route class by a Haiku/low-effort step fed only its title/body (Part 11 "queue classify" row), never the whole repo.
  2. The chosen class maps to a concrete `/gsd-*` invocation (`/gsd-quick` or `/gsd-fast` for trivial/scoped, the discuss→plan→execute chain for a feature) and is recorded on the item; bgsd calls `/gsd-*`, it does not reimplement execution.
  3. A `needs-clarification` item parks in `needs_input` with its question and the drainer advances to the next item rather than blocking the stream.
  4. Routing writes the worktree's `.planning/config.json` model posture (default `balanced` + an effort hint from a cheap difficulty score) with zero edits to vendored GSD (NFR-03/04).
**Risk flags**: GSD quick-path command names are an external dependency (command seam) — pin/verify them against the installed GSD so a rename does not silently misroute. Classification false-negatives could over-route trivial items to the heavy chain; bias the score conservative and let LOOP escalation absorb under-routing.
**Plans**: TBD

### Phase 3: Loop 1 — Verify→Fix Ralph Loop *(HUMAN-GATED live run)*
**Goal**: After GSD execution completes for an item, run a bounded per-worktree verify→fix loop — spawn the v0 Tester, on FAIL re-inject a fix and re-verify, repeat until clean or a stop condition — proving the lowest-risk autonomy end-to-end in ONE worktree.
**Mode:** mvp
**Depends on**: Phase 2 (and the v0 Tester/`runtime-isolate.sh`/report contract)
**Requirements**: LOOP-01, LOOP-02, LOOP-03, LOOP-04, LOOP-05
**Success Criteria** (what must be TRUE):
  1. On `execution complete`, the loop spawns `/bgsd-verify` against the worktree's isolated running instance and reuses the v0 `verification-report.json` contract unchanged (no Tester rewrite).
  2. On a Tester `FAIL`, the report's defects become a backlog, a Ralph-style stop-hook re-injects a fix agent, and the item is re-verified — verify→fix→re-verify, not one-shot.
  3. The loop terminates on `PASS` (item `done`, branch eligible for `rehearsal/<run-id>`) OR a recorded stop condition (`max_iterations`, no-progress, or `BLOCKED`/`ERROR`) marking the item `failed`/`blocked` with the report path — never a fabricated `done` (NFR-06/07).
  4. **(HUMAN-GATED live run)** A real end-to-end run that spawns servers/processes drives at least one seeded-defect item from `queued` to a clean `PASS` and one unfixable item to a bounded `failed`, with iteration counts recorded — executed manually by the human, never in automated CI, and `next` is never written.
**Risk flags**: **Highest-risk phase.** Tester reliability is the whole ballgame (Plan Part 9 §1) and autonomous re-injection risks unbounded loops/runaway spend. Mitigate: hard `max_iterations`, no-progress detection (recurring defect signature), the cheap-knob-first escalation ladder + per-run budget cap (LOOP-05), and the live process-spawning run is human-gated and built/tested in isolation behind deterministic-loop unit tests first.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Hyperpolymath Capture→Queue Cron *(HUMAN-GATED live hookup)*
**Goal**: Turn external Hyperpolymath items into `/bgsd-queue` entries via a documented capture seam — built and proven against a MOCK source with a default `--dry-run` cron — and flag the live external hookup as a human-gated integration that automation never touches.
**Mode:** mvp
**Depends on**: Phase 1 (the queue contract); independent of Phase 3
**Requirements**: CAPTURE-01, CAPTURE-02, CAPTURE-03, CAPTURE-04
**Success Criteria** (what must be TRUE):
  1. A documented capture seam (adapter, ACL-style per Plan Part 12) defines the Hyperpolymath input shape it consumes and the `source: hyperpolymath` queue record it emits, as a deterministic script (NFR-05).
  2. Against a MOCK/fixture source, items flow capture→classify→queue end-to-end with zero live external dependency, proven by automated tests (built-in-isolation).
  3. The cron wrapper defaults to `--dry-run`: it resolves, classifies, and previews would-be entries WITHOUT enqueuing or executing, and never fires the live path by default.
  4. **(HUMAN-GATED live hookup)** The real external hookup (credentials/endpoint + real cron registration that enqueues for real) is clearly marked off-by-default in the seam doc, requires explicit opt-in, and is NOT exercised by any automated test — only the mock path runs in CI.
**Risk flags**: The live external source is outside this repo's control and is human-gated. Mitigate: the entire phase is validated on the mock, the live wiring is a single clearly-flagged opt-in step, and the `--dry-run` default makes accidental live enqueue impossible.
**Plans**: TBD

### Phase 5: Diagram-First Docs
**Goal**: A user can drive the fix-stream queue and (optionally) enable the Hyperpolymath drop from the docs alone, including the exact human-gated steps for the live hookup.
**Mode:** mvp
**Depends on**: Phases 1–4
**Requirements**: DOCS-03, DOCS-04
**Success Criteria** (what must be TRUE):
  1. A diagram-first `/bgsd-queue` page (GSD-Mintlify style) documents `add|start|status`, the queue file/state-machine, the classify→route→execute→verify→loop flow, and the stop conditions.
  2. A Hyperpolymath capture→queue page documents the seam contract, the `--dry-run` cron, and the exact human-gated steps to enable (and the safety caveats of) the live hookup.
  3. Both pages render in the GSD-Mintlify docs site without breaking its existing navigation or build.
**Risk flags**: Low. Reuses the v0 docs pipeline; main risk is docs drifting from the shipped command surface — write them last, against the built behavior.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5
(Phase 4 depends only on Phase 1, so it may run in parallel with Phase 3 if desired; the riskiest work, Phase 3, is front-loaded after its dependencies.)

**Human-gated phases/criteria** (built + tested in isolation; live run flagged off by default):
- Phase 3, Criterion 4 — live process-spawning Loop 1 run.
- Phase 4, Criteria 3–4 — `--dry-run` cron default + the live external Hyperpolymath hookup.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Fix-Stream Queue + State Machine | 1/1 | Complete | 2026-06-29 |
| 2. Classification + GSD Quick-Path Routing | 1/1 | Complete | 2026-06-29 |
| 3. Loop 1 — Verify→Fix Ralph Loop (HUMAN-GATED) | 0/TBD | Not started | - |
| 4. Hyperpolymath Capture→Queue Cron (HUMAN-GATED) | 0/TBD | Not started | - |
| 5. Diagram-First Docs | 0/TBD | Not started | - |
