# Roadmap: better-gsd (bgsd) — Conductor Unification + Reframe

## Overview

This milestone ships the **front door and the scale router** that turn the
already-built engines (v0–v3 + intake E1–E6) into a single conversational
product. It adds **no new engines**. It adds `session.mjs` (a deterministic
scale classifier + depth-router + orchestrator), the `/bgsd-sesh` command, the
always-on conversational/status integration, and a documentation reframe that
makes **Kiwi the Conductor the only user interface** while demoting the old
`/bgsd-*` commands to **internal stages / advanced direct access**.

The build is de-risked the same way the rest of bgsd was: the **bulk is
deterministic and unit-testable under mocked/injected boundaries** (the scale
classifier, the depth-plan builder, the session state machine, the stage
sequencing — all run green with `verify`/`fix`/`spawn`/`merge`/`discuss`/`pr`
mocked), while **every real spawn / merge / integration boot / PR stays behind
the existing `*-live.mjs` `requireLiveFlag()` guards, `--dry-run` by default,
human-gated, never `next`**. Phase U1 stands up the load-bearing piece first:
the deterministic scale classifier + depth-plan builder, reusing
`classify-item.mjs`'s heuristic and `decompose.mjs`'s cheap signals, with a
marked Haiku refinement seam. U2 wires the depth router to the real engine
controllers under DI (the scaled-pipeline orchestration). U3 adds the
`/bgsd-sesh` command + the always-on conversational loop (oracle auto-answer,
`escalate` batching, `status.mjs` live view). U4 is the reframe: README, docs,
and PROJECT.md re-centered on the session. Every phase is additive under
`bgsd/`, reuses the existing engine contracts unchanged, never edits vendored
GSD, and never touches `next`.

## Phases

**Phase Numbering:**
- Integer phases (U1, U2, U3): planned milestone work.
- Decimal phases (U2.1): urgent insertions (marked INSERTED).

**Ordering note:** Phases run in numeric order. The load-bearing deterministic
core (the classifier + depth plan) is built first (U1); the orchestration wiring
(U2) depends on it; the command + always-on integration (U3) depends on the
wiring; the reframe (U4) is written last, against the shipped behavior, so docs
do not drift. No phase relaxes the existing `--live` / never-`next` discipline.

- [ ] **Phase U1: Scale Classifier + Depth-Plan Builder (deterministic core)** — `classifyScale({ prompt, mode })` + `buildDepthPlan(scale)` in `session.mjs`, reusing `classifyHeuristic` + cheap decompose signals, with the §3 rules/thresholds and a marked Haiku refinement seam; fully unit-tested offline.
- [ ] **Phase U2: Depth Router + Session Orchestrator (mocked boundaries)** — `startSession({ prompt, mode, planOnly, ...injected })` drives the scale→engine plan: quick (classify/route→Loop 1), feature (small decompose→scheduler→Loop 1→light merge→Loop 2-if-needed), project (discuss→decompose→full pipeline→Loop 2→review→CHANGELOG/PR), all under DI mocks; quick provably still verifies.
- [ ] **Phase U3: `/bgsd-sesh` Command + Always-On Conversational/Status Integration** *(some criteria `--live`/human-gated)* — the `/bgsd-sesh` command doc + entrypoint, the always-on conversational loop (oracle auto-answer + `escalate` batching + `status.mjs` live view + `context.mjs` hygiene), and the delegation to the human-gated `*-live.mjs` modules.
- [ ] **Phase U4: Reframe — README / Docs / PROJECT.md** — re-center the user-facing story on `/bgsd-sesh` (the session is THE interface); reposition the `/bgsd-*` pages as internal stages / advanced access; add the "How the Conductor scales" page; update PROJECT.md.

## Phase Details

### Phase U1: Scale Classifier + Depth-Plan Builder (deterministic core)
**Goal**: Build the load-bearing decision layer first — a deterministic
`classifyScale({ prompt, mode })` that maps a prompt + mode to `quick | feature
| project` using the §3 rules/thresholds (route class via `classifyHeuristic`,
cheap clause/surface/length signals, flag overrides), plus `buildDepthPlan(scale)`
that emits the ordered engine plan per scale. Zero required model calls; a marked
`refineScaleWithModel` Haiku seam may nudge a borderline case one step but the
deterministic result is always computed first and is the fallback.
**Mode:** mvp
**Depends on**: v1 `classify-item.mjs` (`classifyHeuristic`) + v2 `decompose.mjs`
(`difficultyScore`/cheap signals) — first unification phase.
**Requirements**: SESH-01 (scale classifier), SESH-02 (depth plan)
**Success Criteria** (what must be TRUE):
  1. `classifyScale` returns `quick` for a single trivial/scoped fix (≤ 2 est. units, ≤ 1 surface), `project` for ≥ 4 est. units OR ≥ 3 surfaces OR a long feature prompt, and `feature` for the classifiable middle — matching the §3 table — and `--quick`/`--project` force their scale unconditionally (SESH-01).
  2. A `needs-clarification` prompt returns `scale=null, action="clarify"` (one in-chat question) and is NEVER silently assigned a scale (NFR-06) (SESH-01).
  3. `buildDepthPlan(scale)` returns an ordered stage list with `discuss` true only for `project`, `verified:true` for ALL scales, and the correct engine sequence per §4 (quick: classify/route→Loop 1; feature: decompose-small→scheduler→Loop 1→merge→Loop 2-if->1-unit; project: discuss→decompose→full→Loop 2→review→PR) (SESH-02).
  4. The classifier + plan builder are fully unit-tested offline (no model, no spawns); the Haiku `refineScaleWithModel` seam is a clearly-marked stub that nudges at most one step and never overrides a flag or a clarify result (SESH-01).
**Risk flags**: Medium. A wrong scale either over-spends (quick routed as project) or under-verifies surface (project squeezed to quick). Mitigate: deterministic rules with explicit thresholds, `feature` as the safe default, in-session auto-escalation (asks the user, never silent), and the Haiku seam capped to one step with the heuristic as the floor.
**Plans**: TBD

### Phase U2: Depth Router + Session Orchestrator (mocked boundaries)
**Goal**: Wire the resolved scale to the **real engine controllers** under
dependency injection. `startSession({ prompt, mode, planOnly, ...injected })`
mints/loads a `.bgsd/sessions/<id>/session.json`, classifies scale (U1), builds
the depth plan (U1), and drives the matching engine sequence — quick via
`queue`+`route-item`+`runLoop1`; feature/project via `decompose`+`graph`+
`scheduler`+`runLifecycle`+`runLoop1`+`conflict`+`rehearsal`+`runLoop2`+
`review`+`changelog-pr`, with project gated by the `intake`/`brainstorm`/`oracle`
discussion first. ALL live boundaries (`spawnFn`, `mergeFn`, `verifyFn`,
`fixFn`, `discussFn`, `integrateFn`, `reviewFn`, `prFn`, `oracleFn`) are injected
so the whole orchestrator runs green under mocks. `--plan-only` returns the plan
without invoking any boundary.
**Mode:** mvp
**Depends on**: U1 + the v0–v3/intake engine controllers (`runLoop1`, `runLoop2`,
`runLifecycle`, `runScheduler`, `runBrainstorm`, `answerQuestion`,
`openReviewGate`, `aggregatePerAgentChangelog`) — all already DI-shaped.
**Requirements**: SESH-03 (orchestrator), SESH-04 (quick-verifies invariant)
**Success Criteria** (what must be TRUE):
  1. `startSession` for `quick` routes through `classifyItem`→`routeItem`→`runLoop1` and terminates `done` ONLY on a (mocked) Tester PASS; FAIL→fix→re-verify, BLOCKED/ERROR→blocked, no-progress→failed — proving quick still verifies and never reports done without a pass (SESH-04, NFR-06).
  2. `startSession` for `project` runs discussion FIRST (`generateIntentSpec`→`runBrainstorm`→seal→`buildOracle`) before `decompose`→`runLifecycle`→`runLoop1` each→`conflict`/`rehearsal`→`runLoop2`→`openReviewGate`→`assemblePrBody`, all under mocks, exactly the existing engine sequence with no rewrite (SESH-03).
  3. `startSession` for `feature` reuses the project engines at small N (1–3 units, low concurrency, Loop 2 only if > 1 unit merged) and SKIPS discussion and the mandatory review gate's blocking behavior where the plan says so — same engines, dialed depth (SESH-03).
  4. `--plan-only` returns `{ scale, stages, discuss, verified:true }` and invokes ZERO boundaries; the orchestrator stores pointers (not blobs) in `session.json` and the whole path is unit-tested under fully mocked injections (SESH-03, NFR-09).
**Risk flags**: Medium. The orchestrator could accidentally diverge from an engine's real contract or skip a guard. Mitigate: it ONLY calls existing exports (no reimplementation), every boundary is injected + mocked in tests, and it reuses `run.mjs`'s checkpoint/abort machinery unchanged; live wiring is deferred to U3 behind existing `*-live.mjs` guards.
**Plans**: TBD

### Phase U3: `/bgsd-sesh` Command + Always-On Conversational/Status Integration *(some criteria `--live`/human-gated)*
**Goal**: Ship the user-facing surface and the always-on behavior. Add the
`/bgsd-sesh "<prompt>" [--project|--quick]` command doc + the `session.mjs` CLI
entrypoint (mutually-exclusive flags, `--plan-only`/`--dry-run` default), wire
the **always-on conversational loop** (the Conductor answers downstream questions
via `oracle.answerQuestion`, batches the rare escalations via
`escalate.buildEscalationBatch`/`runEscalation`, keeps the `status.renderStatus`
live view current, and manages context via `context.estimatePressure`/
`pressureDecision`), and connect the orchestrator's live boundaries to the
existing human-gated `run-live.mjs`/`loop1-live.mjs`/`loop2-live.mjs`/
`review.mjs`/`changelog-pr.mjs` modules.
**Mode:** mvp
**Depends on**: U2 (the orchestrator + injected boundaries) + `status.mjs`,
`oracle.mjs`, `escalate.mjs`, `context.mjs`, and all `*-live.mjs` modules.
**Requirements**: SESH-05 (command + always-on), SESH-06 (live delegation)
**Success Criteria** (what must be TRUE):
  1. `/bgsd-sesh "<prompt>"` resolves mode from flags (`--quick`/`--project` mutually exclusive; default auto), runs the U1/U2 plan, and `--plan-only` (and the no-`--live` default) prints the resolved scale + depth plan and creates nothing — accidental live spawn impossible without `--live` (SESH-05, NFR-10).
  2. During a session the Conductor answers a downstream stage question via `oracle.answerQuestion` when `confidence ≥ threshold` (through the GSD seam, no vendored edits) and ABSTAINS→batches an escalation via `escalate` when below threshold; escalations are rare and never a silent guess (SESH-05, NFR-06).
  3. The always-on `status.renderStatus` view stays current (run state, agents, merge state, review-gate badge, budget/context telemetry, constant 🔒 main-protected footer) as a zero-model display the user can watch while chatting (SESH-05).
  4. **(`--live`/human-gated)** Real execution delegates to the existing `*-live.mjs` modules unchanged — real spawns (`run-live.mjs`), merges (`conflict`/`rehearsal`), integration boot (`loop2-live.mjs`), review-app boot (`review.mjs`), and `gh pr create` (`changelog-pr.mjs`) — each still behind `requireLiveFlag()`/`requireNotNextBranch`/`requireNotDefaultBranch`, `--dry-run` default, human-gated, never `next` (SESH-06, NFR-01/10).
**Risk flags**: Medium. Connecting the conversational loop to live modules is where a guard could be bypassed or an escalation silently auto-answered. Mitigate: the session NEVER relaxes a guard (it calls the same `*-live.mjs` entrypoints), the oracle's abstain-below-threshold is preserved, the review gate stays interactive-and-never-auto-passed, and `--dry-run`/`--plan-only` remain the defaults.
**Plans**: TBD

### Phase U4: Reframe — README / Docs / PROJECT.md
**Goal**: Re-center the entire user-facing story on the session. A reader learns
`/bgsd-sesh "<whatever I need>"` first; understands that Kiwi auto-detects scale
(quick/feature/project), runs the SAME verified pipeline scaled, and stays on to
converse; and finds the old `/bgsd-*` commands documented as **internal stages /
advanced direct access**, not the primary surface. Add a "How the Conductor
scales" page (the §3 classifier + §4 depth-routing tables, with the
quick-still-verifies invariant explicit). Update PROJECT.md's "What This Is" /
Future Milestones to record the unification layer.
**Mode:** mvp
**Depends on**: U1–U3 (write docs against shipped behavior so they do not drift).
**Requirements**: DOCS-09 (session reframe), DOCS-10 (scale page + PROJECT.md)
**Success Criteria** (what must be TRUE):
  1. README + the docs hero lead with `/bgsd-sesh` and the three flag forms (`--quick` / auto / `--project`), framing the always-on Conductor session as THE interface; the previous "toolbox of commands" framing is gone from the top-level surface (DOCS-09).
  2. Every `/bgsd-*` page is repositioned under an "Internal stages / advanced direct access / under the hood" section with a one-line "runs internally during a session" note, and still documents the working command (DOCS-09).
  3. A new "How the Conductor scales" page renders the scale-classifier rules/thresholds and the depth-routing table (scale → engines → depth), stating explicitly that **quick still verifies** and that the same pipeline is used throughout; PROJECT.md's "What This Is" + Future Milestones record the session orchestrator + scale router as the unifying layer over v0–v3 + intake (DOCS-10).
  4. All docs render in the GSD-Mintlify site without breaking navigation/build, preserve the never-touch-`next` and always-on-status guarantees, and contain no em-dash-spliced copy (DOCS-09/10).
**Risk flags**: Low. Docs-only; the main risk is drift from the shipped surface. Mitigate: write last, against U1–U3 behavior; reuse the existing v0–v3 docs pipeline and style.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: U1 → U2 → U3 → U4
(U1 builds the deterministic classifier + depth plan first; U2 wires the router
to the real engine controllers under mocks; U3 ships the command + always-on
conversational/status integration and connects the human-gated live modules; U4
reframes the docs last, against shipped behavior.)

**Human-gated criteria** (built + unit-tested in isolation behind mocked
boundaries; live wiring flagged off by default, `--dry-run`/`--plan-only` the
default, never CI, never `next`):
- **Phase U3, Criterion 4 — live delegation** (real spawns/merges/integration
  boot/review boot/`gh pr create` via the existing `*-live.mjs` modules; SESH-06).
  The session never relaxes the underlying `requireLiveFlag()` /
  `requireNotNextBranch` / `requireNotDefaultBranch` guards.

**Interactive-by-design (human gate, never auto-passed):**
- The in-session **User Review Gate** (`review.openReviewGate`, surfaced in-chat)
  remains interactive and never auto-passes for `feature`/`project` scale.
- **Escalations** (`escalate`) surface batched selector questions to the human
  when the oracle abstains; never a silent guess.

**Deterministic-buildable (the bulk, unit-testable with mocked boundaries):**
all of U1 (scale classifier + depth plan + the Haiku seam stub), all of U2 (the
orchestrator + injected boundaries + the quick-verifies proof + `--plan-only`),
the command parsing + always-on status/oracle/escalate/context wiring of U3
(criteria 1–3), and all of U4 (docs).

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| U1. Scale Classifier + Depth-Plan Builder | 0/1 | Not started | — |
| U2. Depth Router + Session Orchestrator (mocked) | 0/1 | Not started | — |
| U3. `/bgsd-sesh` Command + Always-On Integration (some HUMAN-GATED) | 0/1 | Not started | — |
| U4. Reframe — README / Docs / PROJECT.md | 0/1 | Not started | — |
