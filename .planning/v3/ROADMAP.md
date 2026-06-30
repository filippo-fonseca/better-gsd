# Roadmap: better-gsd (bgsd) — Milestone 4 (v3)

## Overview

v3 ships the **second loop and the human handoff**: **Loop 2 (integration verify→fix)** over the assembled `rehearsal/<run-id>` branch, the **User Review Gate** + `/bgsd-user-eval`, **`/bgsd-feedback [--fast]`**, and the **per-agent CHANGELOG wired into a real PR**. Where v2 stopped at *assembling* `rehearsal/<run-id>` and checkpointing, v3 boots the whole integrated app, runs the v0 Tester end-to-end across feature boundaries (the Integration Tester), fixes integration defects with parallel fix agents and re-merges in a Ralph-style loop until clean, then hands the result to a human review gate, routes any "request changes" back through feedback mode, and opens a PR (against a non-default branch, never `next`) whose body is the aggregated per-agent CHANGELOG. It is the integration-level mirror of v1's per-worktree Loop 1, applied to the whole assembled system: same loop shape, applied twice (Plan Part 5 "Same loop shape, applied twice").

The roadmap is de-risked hardest-first, and is structured around the same critical split v1/v2 used: **the bulk is buildable + unit-testable deterministically with mocked boundaries** (the Loop 2 controller with injected verify/fix, the review-gate state machine with an injected prompt, feedback ingestion + routing, CHANGELOG aggregation + PR-body assembly), while **the live integration run** (real Tester on the real `rehearsal/<run-id>` app) and **real PR creation** (`gh pr create`) are isolated into their own HUMAN-GATED criteria (guarded behind `--live` via the same `requireLiveFlag()` pattern as `loop1-live.mjs`/`run-live.mjs`, opt-in, human-supervised, never CI, never `next`), and the **User Review Gate is interactive-by-design** (a human gate that never auto-passes). Phase 1 stands up the deterministic Loop 2 controller — the load-bearing piece, reusing the v1 `runLoop1` DI shape at integration scope — under mocked Tester/fix. Phase 2 is the riskiest piece: the real live integration run, **human-gated**. Phase 3 builds the User Review Gate + `/bgsd-user-eval` (interactive). Phase 4 builds feedback mode (full + `--fast`), reusing both loops. Phase 5 aggregates the CHANGELOG and wires it into a PR, with real PR creation **human-gated**. Phase 6 documents the surface. Every phase is additive under `bgsd/`, reuses the v0 Tester + v1 Loop 1 / `defectSignature` + v2 `rehearsal.mjs` / `run.mjs` / `conflict.mjs` / `status.mjs` contracts unchanged, never edits vendored GSD, and never touches `next`.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**Ordering note:** Phases run in numeric order, but the riskiest live wiring is front-loaded right after its one hard dependency is in place: Phase 1 builds the deterministic Loop 2 controller, then Phase 2 (the live integration run) is the single primary human-gated phase. Real PR creation (Phase 5) is exercised only under the same `--live` gate. The User Review Gate (Phase 3) is interactive-by-design — built with an injected prompt (mocked in tests), the real human interaction never simulated away as a pass.

- [ ] **Phase 1: Loop 2 — Integration Verify→Fix Controller (mocked Tester/fix)** - The deterministic integration-level Ralph loop over `rehearsal/<run-id>` — boot-the-integrated-app + Integration Tester (`integration-report.json`) + parallel fix agents + re-merge + re-verify + stop conditions, reusing the v1 `runLoop1` DI shape with verify/fix injected and unit-tested under mocked boundaries
- [ ] **Phase 2: Live Integration Run** *(HUMAN-GATED live run)* - The real end-to-end Loop 2 — actually booting the `rehearsal/<run-id>` app and driving real Integration-Tester→fix cycles to a clean integration — behind `loop2-live.mjs` + `requireLiveFlag()`, off by default, `--dry-run` default, human-supervised, never CI, never `next`
- [ ] **Phase 3: User Review Gate + `/bgsd-user-eval`** *(INTERACTIVE human gate)* - The mandatory human review stop abstracted to `rehearsal/<run-id>`: `/bgsd-user-eval` auto-boots servers + localhost URL + checklist, and a GSD-style selector Q&A captures approve/request-changes/abort into `review.json` — gate state machine deterministic with the prompt injected, never auto-passed
- [ ] **Phase 4: Feedback Mode — `/bgsd-feedback [--fast]`** - Ingest user feedback into traceable items and route it: full mode re-runs both loops on the items; `--fast` skips the loops for parallel/single fix agents with no computer-use verification — reusing the Loop 1 + Loop 2 controllers unchanged, bounded and recorded
- [ ] **Phase 5: Per-Agent CHANGELOG Into the PR** *(HUMAN-GATED real PR creation)* - Aggregate each agent's changes into a per-agent CHANGELOG (enriching the v2 `generateChangelog()` seed), assemble the exact PR description (pure string, unit-tested), surface it at the review gate, and wire it into a real `gh pr create` against a NON-default branch behind `changelog-pr-live.mjs` + `requireLiveFlag()`
- [ ] **Phase 6: Diagram-First Docs** - `/bgsd-user-eval` + Review Gate + Loop 2 page and `/bgsd-feedback` + CHANGELOG-into-PR page, GSD-Mintlify style, including the exact human-gated `--live` steps

## Phase Details

### Phase 1: Loop 2 — Integration Verify→Fix Controller (mocked Tester/fix)
**Goal**: Stand up the deterministic integration-level Ralph loop over the assembled `rehearsal/<run-id>` branch — boot the integrated app, run the Integration Tester (emitting `integration-report.json`), on a non-clean verdict spawn parallel fix agents and re-merge, re-verify, and terminate on PASS or a stop condition — as a controller that reuses the v1 `runLoop1` DI shape (verify/fix injected) so the whole thing is unit-testable under mocked Tester/fix. Loop 2 is the integration-level sibling of Loop 1; this is the load-bearing piece built first.
**Mode:** mvp
**Depends on**: v2 (`rehearsal/<run-id>` assembly via `rehearsal.mjs`, the `run.mjs` lifecycle state machine, `conflict.mjs` re-merge, v0 `runtime-isolate.sh` + `verification-report.json`/`computeVerdict` contract, v1 `loop1.mjs` `defectSignature` no-progress logic) — first v3 phase
**Requirements**: LOOP2-01, LOOP2-02, LOOP2-03, LOOP2-04
**Success Criteria** (what must be TRUE):
  1. After `rehearsal/<run-id>` is assembled, the Conductor advances the run into an `integrating` lifecycle state and the Loop 2 controller boots the WHOLE integrated app (one integrated server via the v0 isolation convention, not per-worktree) and invokes the Integration Tester against it — running on the integrated system, the integration-level sibling of Loop 1 (LOOP2-01).
  2. The Integration Tester emits an `integration-report.json` that reuses the v0 report contract (`verdict ∈ PASS|FAIL|ERROR` via `computeVerdict()` unchanged, `criteria_results`, tagged `defects`) plus integration scrutiny (cross-boundary UAT, integrated-diff code review, alignment check, improvement scrutiny), and the verdict drives the loop (LOOP2-02).
  3. On a non-clean verdict, parallel fix agents (Sonnet/medium) fix independent tagged items in worktrees off `rehearsal/<run-id>` and re-merge via the v2 conflict pre-check + dependency-ordered merge, then the Tester re-runs — verify→fix→re-verify — with the `verify`/`fix` boundaries dependency-injected so the controller runs green under fully mocked Tester/fix (mirrors the v1 `loop1.mjs` DI split) (LOOP2-03).
  4. The loop terminates on `PASS` (advance to the review gate) OR a recorded stop condition — `max_iterations`, no-progress (recurring integration-defect signature via reused `defectSignature()`), or `BLOCKED`/`ERROR` — parking the run in a structured non-PASS terminal state with the `integration-report.json` path + `integration.md` log; never a fabricated clean integration, and integration testing is scoped to the merged diff so spend stays bounded (NFR-06/08/09, Part 13 §9) (LOOP2-04).
**Risk flags**: Tester reliability is the whole ballgame at integration scale too (Plan Part 9 §1) — a whole-app boot is more fragile than a single worktree, and autonomous re-injection risks unbounded loops/spend. Mitigate: reuse the proven v0 Tester + report contract unchanged; hard `max_iterations` + reused no-progress detection + per-run budget cap bound the loop; scope each iteration to the merged diff (Part 13 §9) so cost doesn't grow with app size; the whole controller is unit-tested under mocked Tester/fix before any real boot (the real boot is Phase 2).
**Plans**: TBD
**UI hint**: yes

### Phase 2: Live Integration Run *(HUMAN-GATED live run)*
**Goal**: Prove the riskiest thing in v3 — a **real** end-to-end Loop 2: actually boot the `rehearsal/<run-id>` app with real servers, run the real Integration Tester end-to-end, drive real parallel-fix→re-merge→re-verify cycles to a clean integration (or a bounded non-PASS) — **human-gated**, behind `loop2-live.mjs` with the same `requireLiveFlag()` guard as `loop1-live.mjs`/`run-live.mjs`, off by default, `--dry-run` as the default.
**Mode:** mvp
**Depends on**: Phase 1 (the deterministic Loop 2 controller + injected verify/fix boundaries) and the v0 Tester / v2 `rehearsal.mjs` live-assembly seam
**Requirements**: LOOP2-05
**Success Criteria** (what must be TRUE):
  1. The Phase 1 controller runs green under **mocked Tester/fix** in unit tests before any live run, and the live `verify`/`fix` implementations live in `loop2-live.mjs` (the injected real boundaries), exactly mirroring the v1 `loop1`/`loop1-live` split — no rewrite of the controller (LOOP2-05).
  2. `loop2-live.mjs` refuses to run without an explicit `--live` flag (`requireLiveFlag()` throws a human-readable refusal), and a `--dry-run` default prints the integration plan (what would boot, the merged-diff scope, the would-be Tester invocation) without booting or fixing anything (NFR-10).
  3. **(HUMAN-GATED live run)** A real `--live` run boots the actual `rehearsal/<run-id>` app, runs the real Integration Tester end-to-end, drives at least one real integration-defect→fix→re-merge→re-verify cycle, and reaches either a clean integration `PASS` or a bounded non-PASS terminal state with iteration counts + `integration-report.json` recorded — executed manually by the human, never in automated CI, `next` never written, accidental live boot impossible (`--dry-run` default).
**Risk flags**: **Highest-risk phase.** Booting a real integrated app and running live integration-fix cycles cannot be validated unsupervised (cost, runaway loops, partial re-merges, a flaky whole-app boot). Mitigate: the full controller is built + unit-tested deterministically behind mocked Tester/fix (Phase 1); the live run is a single off-by-default `--live` opt-in with `--dry-run` as default; per-run budget cap + `max_iterations` + merged-diff scoping bound autonomy (NFR-08/09); the guard hook makes a write to `next` impossible.
**Plans**: TBD
**UI hint**: yes

### Phase 3: User Review Gate + `/bgsd-user-eval` *(INTERACTIVE human gate)*
**Goal**: Build the one mandatory human stop in v3 — when Loop 2 returns clean, advance the run into a `review` state and open the User Review Gate abstracted to `rehearsal/<run-id>`: `/bgsd-user-eval` auto-boots the integrated servers + prints the localhost URL + a checklist, and a GSD-style selector Q&A captures the human verdict (approve / request changes / abort) + free-text findings into `review.json`. The gate is interactive-by-design and never auto-passes; its state machine is deterministic with the interactive prompt dependency-injected (mocked in tests).
**Mode:** mvp
**Depends on**: Phase 1 (a clean Loop 2 result to gate on) + v0/v2 `runtime-isolate.sh` boot + v2 `status.mjs` renderer
**Requirements**: REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04
**Success Criteria** (what must be TRUE):
  1. On a clean Loop 2 result the Conductor advances to a `review` lifecycle state and surfaces, through the Kiwi channel, exactly one consolidated review prompt — the per-agent CHANGELOG summary, the localhost URL, and the integration checklist (REVIEW-01).
  2. `/bgsd-user-eval` auto-boots the `rehearsal/<run-id>` servers/backend (reusing the v0/v2 boot/readiness/teardown convention against the integrated instance) and prints the localhost URL + a concrete test checklist derived from the run's acceptance criteria + `integration-report.json`; boot/teardown is deterministic and the live boot of the real app is human-gated under the same `--live`/`--dry-run` discipline (REVIEW-02, NFR-10).
  3. The gate captures the verdict via GSD-style selector Q&A (`approve`/`request changes`/`abort` + type-your-own findings) into `.bgsd/runs/<run-id>/review.json`; the gate state machine is deterministic with the prompt injected (unit-tested with a mocked answer), `approve` advances toward the CHANGELOG/PR step, `request changes` routes findings into `/bgsd-feedback`, `abort` parks the run, and an un-answered gate parks in `needs_input` — never auto-passed (REVIEW-03, NFR-06/11).
  4. The review gate is surfaced in `/bgsd-status` with a distinct `review`/`needs-input` badge + a Kiwi "needs your eval" line (reusing the v2 renderer, zero-model view path) and the constant 🔒 main-protected indicator (REVIEW-04).
**Risk flags**: Medium. The gate is the one intentional human stop, so the risk is auto-passing it (silent green) or simulating the human away. Mitigate: NFR-11 makes the gate interactive-by-design and never auto-passable; the deterministic state machine is unit-tested with an injected/mocked prompt, but the real interaction is never substituted for a pass; an un-answered gate parks in `needs_input`, never `done`.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Feedback Mode — `/bgsd-feedback [--fast]`
**Goal**: Feed user feedback back into the system — `/bgsd-feedback "<what's wrong>"` ingests free-text (or the `request changes` findings) into discrete traceable items, then full mode re-runs the entire two-loop machine on those items (route → Loop 1 per worktree → re-merge → Loop 2) returning to the review gate, while `--fast` skips the loops and spawns parallel fix agents (or a single agent for a single trivial fix) with no computer-use verification. Reuse the Loop 1 + Loop 2 controllers unchanged; only the work set changes.
**Mode:** mvp
**Depends on**: Phase 1 (Loop 2 controller) + Phase 3 (the gate that produces `request changes` findings) + v1 Loop 1 + the v1/v2 classify→route seam
**Requirements**: FEEDBACK-01, FEEDBACK-02, FEEDBACK-03, FEEDBACK-04
**Success Criteria** (what must be TRUE):
  1. `/bgsd-feedback "<what's wrong>"` ingests the free-text (or structured review findings) and parses it into discrete, id-tagged feedback items under `.bgsd/runs/<run-id>/feedback/`, tagged to a file/feature where possible — a deterministic ingestion/parse step (FEEDBACK-01, NFR-05).
  2. Full (default) mode routes each item through the v1/v2 classify→route seam, fans them into worktree(s) off `rehearsal/<run-id>`, runs Loop 1 per worktree, re-merges, re-runs Loop 2 over the updated rehearsal branch, and returns to the User Review Gate — reusing the existing Loop 1 + Loop 2 controllers with no rewrite (FEEDBACK-02).
  3. `--fast` SKIPS the loops: the Conductor decides multi-agent vs single-agent from item count/complexity, spawns fix agents (Haiku/Sonnet low effort) with NO computer-use verification, applies fixes to `rehearsal/<run-id>`, and returns to the review gate — clearly marked as the un-verified path and still returning to the human gate (no silent green) (FEEDBACK-03, NFR-06).
  4. Every feedback path is bounded (`max_iterations` + per-run budget cap), the multi/single/full/`--fast` decision is a deterministic scored choice, and the feedback round is recorded into the run ledger + CHANGELOG so the next PR body reflects the iterations; feedback never writes `next` (FEEDBACK-04, NFR-01/08).
**Risk flags**: Medium. `--fast` deliberately has no Tester pass, so the risk is an un-verified fix masquerading as done. Mitigate: `--fast` is explicitly the un-verified path, still returns to the human review gate (the human is the verification for `--fast`), and never marks the run silently green; full mode reuses the bounded, verified two-loop machine unchanged.
**Plans**: TBD
**UI hint**: yes

### Phase 5: Per-Agent CHANGELOG Into the PR *(HUMAN-GATED real PR creation)*
**Goal**: Aggregate each agent's changes (across Loop 1, Loop 2, and any feedback rounds) into a single human-readable per-agent CHANGELOG — enriching the v2 `generateChangelog()` seed that was built into the ledger but never wired to a PR — assemble the exact PR description as a pure deterministic string (unit-tested without git/GitHub), surface it at the review gate (terminal AND would-be PR body), and wire it into a real `gh pr create` against a NON-default branch, **human-gated** behind `changelog-pr-live.mjs` + `requireLiveFlag()`.
**Mode:** mvp
**Depends on**: Phase 3 (the review gate surfaces the would-be PR body) + v2 `rehearsal.mjs` `generateChangelog()` seed + the v1/v2 guard-main discipline
**Requirements**: CHANGELOG-01, CHANGELOG-02, CHANGELOG-03
**Success Criteria** (what must be TRUE):
  1. The Conductor aggregates each agent's changes (Loop 1 + Loop 2 + feedback rounds) into one per-agent CHANGELOG traceable to commits/branches, reusing + enriching the v2 `generateChangelog()` seed; aggregation is deterministic file I/O and any prose enrichment is the Part 11 Haiku/low docs call fed only per-agent summaries (CHANGELOG-01).
  2. The CHANGELOG is assembled into a complete PR description (title from run id/slug + prompt; body = per-agent CHANGELOG + integration result + ledger link) as a pure, deterministic string-building step that is unit-testable without touching git/GitHub, and the same body is surfaced to the human at the review gate before any PR is opened (CHANGELOG-02).
  3. **(HUMAN-GATED real PR creation)** Real PR creation runs `gh pr create` with the assembled title/body behind `changelog-pr-live.mjs` + `requireLiveFlag()` (off by default, `--dry-run` prints the would-be PR — title + body + base + head — and exits), ALWAYS targets a NON-default branch (never `next`, enforced by the guard hook), and is executed manually by the human, never in CI (CHANGELOG-03, NFR-01/10).
**Risk flags**: Medium. Creating a real PR is an external, irreversible-ish side effect that must never target `next`. Mitigate: the deterministic PR-body string is fully unit-tested first; real `gh pr create` is human-gated behind `--live` with `--dry-run` as default; the PR always targets a non-default branch and the guard hook rejects any PR against the default branch; the human sees the exact body at the review gate before anything is opened.
**Plans**: TBD
**UI hint**: yes

### Phase 6: Diagram-First Docs
**Goal**: A user can run Loop 2 over a rehearsal branch, drive the User Review Gate / `/bgsd-user-eval`, give `/bgsd-feedback` (full or `--fast`), and open a real CHANGELOG PR — all from the docs alone, including every human-gated `--live` step and the never-touch-`next` rule.
**Mode:** mvp
**Depends on**: Phases 1–5
**Requirements**: DOCS-07, DOCS-08
**Success Criteria** (what must be TRUE):
  1. A diagram-first `/bgsd-user-eval` + Review Gate + Loop 2 page (GSD-Mintlify style) documents assemble `rehearsal/<run-id>` → Loop 2 (boot integrated app → Integration Tester → parallel fix agents → re-merge → re-verify) → User Review Gate (boot servers, localhost URL, checklist, selector verdict), with the two-loop (Loop 1 vs Loop 2) symmetry diagram and the exact human-gated `--live` steps (and `--dry-run` default).
  2. A `/bgsd-feedback` + CHANGELOG-into-PR page documents feedback mode (full re-run-both-loops vs `--fast` no-loop, when each is chosen + the un-verified caveat), the per-agent CHANGELOG → PR-description flow, and the exact human-gated `--live` steps to open a real PR against a non-default branch (and never `next`).
  3. Both pages render in the GSD-Mintlify docs site without breaking its existing navigation or build.
**Risk flags**: Low. Reuses the v0/v1/v2 docs pipeline; main risk is docs drifting from the shipped surface — write them last, against the built behavior.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6
(Phase 1 builds the deterministic Loop 2 controller first; Phase 2 — the live integration run — is front-loaded as the riskiest live work right after its one dependency is in place. Phase 4 (feedback) depends on Phase 3 (which produces the `request changes` findings) and reuses the Phase 1 Loop 2 controller. Phase 5 (CHANGELOG→PR) depends on Phase 3 surfacing the body. Phase 6 documents last.)

**Human-gated phases/criteria** (built + unit-tested in isolation behind mocked Tester/fix/git/gh; live wiring flagged off by default, `--dry-run` is the default, never CI, never `next`):
- **Phase 2, Criterion 3 — the live integration run** (real boot of `rehearsal/<run-id>` + real Integration-Tester→fix cycles; LOOP2-05). This is the single primary human-gated criterion, behind `loop2-live.mjs` + `requireLiveFlag()`.
- **Phase 5, Criterion 3 — real PR creation** (`gh pr create` against a non-default branch with the CHANGELOG body; CHANGELOG-03), behind `changelog-pr-live.mjs` + `requireLiveFlag()`.
- The live boot of the real rehearsal app in `/bgsd-user-eval` (Phase 3, Criterion 2) is exercised only under the same `--live`/`--dry-run` discipline.

**Interactive-by-design (human gate, never auto-passed):**
- **Phase 3 — the User Review Gate (REVIEW-01..03)** is interactive by design (NFR-11): the gate state machine is deterministic with the interactive prompt dependency-injected (mocked in tests), but the real human interaction is never simulated away as a pass; an un-answered gate parks in `needs_input`, never `done`.

**Deterministic-buildable (the bulk, unit-testable with mocked Tester/fix/git/gh):** all of Phase 1 (the Loop 2 controller + injected verify/fix), the gate state machine + selector logic of Phase 3 (injected prompt), all of Phase 4 (feedback ingestion + routing + the multi/single/full/`--fast` decision), the CHANGELOG aggregation + PR-body string of Phase 5 (CHANGELOG-01..02), and Phase 6 docs.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Loop 2 — Integration Verify→Fix Controller (mocked Tester/fix) | 0/1 | Pending | — |
| 2. Live Integration Run (HUMAN-GATED) | 0/1 | Pending | — |
| 3. User Review Gate + `/bgsd-user-eval` (INTERACTIVE) | 0/1 | Pending | — |
| 4. Feedback Mode — `/bgsd-feedback [--fast]` | 0/1 | Pending | — |
| 5. Per-Agent CHANGELOG Into the PR (HUMAN-GATED) | 0/1 | Pending | — |
| 6. Diagram-First Docs | 0/1 | Pending | — |
