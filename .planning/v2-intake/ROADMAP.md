# Roadmap: better-gsd (bgsd) — v2 Extension (Conductor Intake + Autonomous Proxy-Q&A)

## Overview

This extension ships the **Conductor Intake + Autonomous Proxy-Q&A layer** — a front door on **Kiwi, the Conductor** for the user's hyperpolymath/JARVIS project. The user describes a project in natural language (voice, via hyperpolymath); a cheap **Haiku** model expands it into a large, exhaustive Markdown **intent spec**. Before any building, Kiwi runs an **active upfront brainstorm** — an interactive, highly-engaged discussion of phases, scope, and gray-area decisions — front-loading intent into the spec, a structured **decision record**, and a **preference profile**. Every human Q&A in that brainstorm (and in any later escalation) uses **GSD-style selector answers**: 2–4 concrete pre-filled options PLUS an always-available "type your own" free-text option. Once parallel worktree agents run their GSD pipelines and raise the normal `discuss-phase` questions, Kiwi answers them **itself** from the upfront context via a **decision-oracle** with **confidence scoring**: at/above the threshold Kiwi answers as the user's proxy; below it Kiwi escalates to the human — **rarely** — through the same selector Q&A.

This builds **ON the sealed v2 Conductor core** and does not re-open it. It reuses, unchanged: v2's control-file escalation protocol (`raiseBlocker` → `resolveBlocker` → `<agent-id>.inbox.md` → re-launch; `addEscalation`/`aggregateEscalations`; the "one consolidated question" rule), v2's per-worktree routing `config.json` seam, and v2's `/bgsd-status` view. It touches GSD only through the same three seams — the `/gsd-*` commands (esp. `gsd-new-project` for the intake spec and `discuss-phase`'s `--assumptions`/`--auto`/`--text` non-interactive modes for the auto-answer seam), the `.planning/` file contract, and `config.json` — and edits zero vendored GSD.

The roadmap is de-risked hardest-first around the **central design knot**: GSD's `discuss-phase`/`gsd-new-project` expect a HUMAN at the `AskUserQuestion` API, so the load-bearing, riskiest piece is the **decision-oracle + confidence scoring + the auto-answer-into-`discuss-phase` seam** (Phase E4). Everything upstream exists to feed it (E1 intake spec, E2 brainstorm + decision record, E3 preference profile), and everything downstream consumes it (E5 confidence-gated escalation, E6 docs). The bulk is **buildable + unit-testable deterministically with mocked model calls** (the oracle store, confidence arithmetic, question→record matching, threshold/escalation routing, selector-payload assembly, all intake/oracle file writes). Two classes of work are NOT pure deterministic build: (a) the **upfront brainstorm is interactive by design** — a real engaged human session, front-loading intent, which is the whole point, NOT a live-orchestration human-gate; and (b) the **live proxy-answer-during-a-real-run** path rides the **existing v2 `--live` gate** (off by default, `--dry-run` default, never CI, never `next`). Every phase is additive under `bgsd/`, reuses v0/v1/v2 contracts unchanged, never edits vendored GSD, and never touches `next`.

## Phases

**Phase Numbering:**
- This extension uses **E-prefixed** phases (E1, E2, E3…) to mark it as a **v2 EXTENSION** layered on the sealed v2 Conductor core (v2 Phases 1–9). E-phases run after v2 is sealed.
- Decimal E-phases (E2.1, E2.2): urgent insertions (marked INSERTED), appearing between their surrounding integers in numeric order.

**Ordering note:** Phases run in E-numeric order, but the riskiest, most load-bearing piece — the **decision-oracle + confidence + auto-answer seam (E4)** — is the center of gravity. It is front-loaded right after its three input dependencies are in place (the intake spec E1, the brainstorm decision record E2, the preference profile E3). E5 (escalation) consumes E4's confidence output + the v2 control-file protocol; E6 documents the surface last.

- [x] **Phase E1: NL/Voice Intake → Rich Intent Spec** - NL/voice description → Haiku spec-gen → a large, chunked, indexed Markdown intent spec, fed into `gsd-new-project` through the seam
- [x] **Phase E2: Active Upfront Brainstorm + Decision Record** - The interactive, selector-driven upfront discussion (phases/scope/gray-areas) that front-loads intent into a sealed, queryable decision record
- [x] **Phase E3: Preference Profile** - Derive a structured, source-tagged preference profile from the brainstorm answers — the secondary, lower-weight oracle source
- [ ] **Phase E4: Decision-Oracle + Confidence Scoring + discuss-phase Auto-Answer Seam** *(THE CENTRAL KNOT)* - The oracle store + deterministic confidence score + the auto-answer-into-`discuss-phase` seam (non-interactive GSD modes + the v2 inbox/re-launch path), gated by the confidence threshold
- [ ] **Phase E5: Confidence-Gated Human Escalation via Selectors** - Below-threshold/abstain → reuse the v2 control-file escalation as exactly one consolidated GSD-style selector question; answers enrich the oracle; rarity surfaced in `/bgsd-status`
- [ ] **Phase E6: Diagram-First Docs** - `/bgsd-intake` + upfront-brainstorm and decision-oracle + proxy-Q&A pages, GSD-Mintlify style, including the selector-always rule and the auto-answer/escalation decision diagram

## Phase Details

### Phase E1: NL/Voice Intake → Rich Intent Spec
**Goal**: A natural-language (or hyperpolymath voice) project description becomes a large, exhaustive Markdown **intent spec** — chunked and indexed for later pointer-sliced retrieval — and is handed to `gsd-new-project` through the seam so GSD produces its own planning files from the user's intent. This is the source-of-truth intent every later proxy answer derives from.
**Mode:** mvp
**Depends on**: the sealed v2 Conductor core (the `.bgsd/` namespace, run-id minting, ledger) + v1's Hyperpolymath-capture drop convention — first extension phase
**Requirements**: INTAKE-01, INTAKE-02, INTAKE-03, INTAKE-04
**Success Criteria** (what must be TRUE):
  1. `/bgsd-intake "<description>"` (or a hyperpolymath voice capture) opens `.bgsd/intake/<run-id>/` and a single Haiku spec-gen call (the MODEL SEAM) expands the raw description into a large `SPEC.md` covering goals/scope/surfaces/constraints/open-questions; the record/dir/write are deterministic with zero model calls (NFR-05).
  2. `SPEC.md` is chunked into addressable sections with stable section ids and a serialized chunk index, so a later query can retrieve only the matching section (pointer + slice), never the whole spec (NFR-09).
  3. The spec is handed to `gsd-new-project --auto` via its idea-document `@`-reference path so GSD generates `.planning/PROJECT.md`/`REQUIREMENTS.md`/`ROADMAP.md` from the intent, with zero edits to vendored GSD (NFR-03/04).
  4. A spec with an empty/degenerate open-questions section is surfaced, not passed downstream (NFR-06); the spec records provenance (raw input, model, timestamp) into the run ledger.
**Risk flags**: Low–medium. Spec-gen quality drives everything downstream, but a thin spec is recoverable because the E2 brainstorm closes the gaps. Mitigate: require a non-empty open-questions section (Criterion 4) so an under-specified spec routes more gray-areas into the brainstorm rather than poisoning the oracle silently.
**Plans**: TBD

### Phase E2: Active Upfront Brainstorm + Decision Record  *(INTERACTIVE by design)*
**Goal**: Before any decomposition/spawn, Kiwi runs an interactive, highly-engaged brainstorm — seeded from the spec's open-questions plus a gray-area analysis — and captures every answer into a sealed, queryable **decision record**. Every question is a GSD-style selector (options + "type your own"). This front-loads the intent that the oracle will later answer from.
**Mode:** mvp
**Depends on**: Phase E1 (the spec + its open-questions seed the brainstorm)
**Success Criteria** (what must be TRUE):
  1. **(INTERACTIVE by design)** Kiwi runs a real, engaged upfront discussion of phases/scope/gray-areas before any build step, seeded from the spec's open-questions + a gray-area analysis (reusing GSD's discuss-phase gray-area pattern) — interactive by design, NOT a live-orchestration human-gate (BRAINSTORM-01).
  2. **(selector-Q&A always — NFR-10)** Every brainstorm question renders as a GSD-style selector: 2–4 concrete pre-filled options PLUS an always-available "type your own" free-text option, honoring the freeform rule (switch to plain-text follow-up when the user explains freely, then resume selectors) and the `--text` plain-numbered-list fallback; no free-form-only prompt is ever shown. Selector payloads (header ≤12 chars, concrete non-generic options) assemble deterministically; only question/option generation is a model call.
  3. Every answer — chosen option or typed-own — lands as a structured entry in `DECISIONS.md` + `decisions.json` (stable decision id, question, option set shown, selection/typed text, locked scope, link to spec section), written deterministically (NFR-05).
  4. An explicit decision gate (GSD "Ready?" selector) loops over remaining open-questions until the user confirms intent is front-loaded, then seals the spec + decision record as the run's frozen baseline; scope-creep is captured to deferred-ideas, never actioned (BRAINSTORM-04).
**Risk flags**: Low. Reuses GSD's proven `questioning.md` selector + freeform + decision-gate patterns; this phase requires a real human session (interactive by design — see the human-session flag below), so its end-to-end criteria can only be exercised in an interactive run, but the selector-payload assembly + decision-record write are unit-testable deterministically with mocked answers.
**Plans**: TBD
**UI hint**: yes

### Phase E3: Preference Profile
**Goal**: Derive a structured **preference profile** from the brainstorm's answers + typed-own responses — the user's recurring leanings/defaults, each tagged by source decision with a strength weight — as the oracle's secondary, lower-weight source, reusable across runs as a seed.
**Mode:** mvp
**Depends on**: Phase E2 (the decision record is the substrate the profile rolls up from)
**Requirements**: PROFILE-01, PROFILE-02
**Success Criteria** (what must be TRUE):
  1. `profile.json` is derived from the decision record as a cheap deterministic roll-up (plus an optional Haiku summarize pass), with each preference tagged by its source decision id and a strength weight, and it never invents a preference not grounded in an answer (NFR-06).
  2. The profile is structured as a **lower-weight** oracle source: a profile-only match carries explicitly lower confidence than a direct decision-record match (it is a leaning, not a locked decision), feeding the E4 confidence score so profile-only answers are more likely to fall below threshold and escalate (NFR-11).
  3. The profile is reusable across runs as a seed (cross-run continuity) and is written only under `.bgsd/`, never leaking into `next` (NFR-01).
**Risk flags**: Low. Pure deterministic roll-up over the E2 record. Main risk is over-trusting a leaning as a decision — mitigated by Criterion 2 (profile matches are explicitly lower-confidence and thus bias toward escalation, not silent proxy answers).
**Plans**: TBD

### Phase E4: Decision-Oracle + Confidence Scoring + discuss-phase Auto-Answer Seam  *(THE CENTRAL KNOT)*
**Goal**: Build the **decision-oracle** — the load-bearing seam of this whole extension. From the sealed baseline (spec chunks + decision record + profile) it builds a deterministic queryable store; given an incoming `discuss-phase` question it retrieves candidates, computes a deterministic **confidence score**, and — when confidence ≥ threshold — answers as the user's proxy by injecting the answer through GSD's seam only (writing `.planning/` + running the worktree's discuss step in a non-interactive GSD mode, and resolving v2 control-file blockers via the inbox/re-launch path). Below threshold it abstains and hands off to E5.
**Mode:** mvp
**Depends on**: Phases E1 (spec chunks) + E2 (decision record) + E3 (profile); reuses the v2 control-file protocol (`control.mjs`) + the v2 routing `config.json` seam
**Requirements**: ORACLE-01, ORACLE-02, ORACLE-03, ORACLE-04
**Success Criteria** (what must be TRUE):
  1. The oracle builds a deterministic store under `.bgsd/oracle/<run-id>/` indexing spec chunks + decision record + profile, and for an incoming question (text + worktree phase/scope context) retrieves candidate records (decision entries first, then spec sections, then profile leanings) with match metadata as pointers + slices — never the whole spec (NFR-05/09).
  2. A deterministic confidence score in [0,1] is computed per candidate from explicit signals (match directness, match strength, specificity, source authority, conflict penalty); the score, its signal breakdown, and the chosen candidate are recorded for every question (auditable), with zero model calls in the scoring path (NFR-05/08).
  3. At confidence ≥ threshold, Kiwi auto-answers via the seam only: it writes the resolved decisions into the worktree's `.planning/` contract and runs the GSD discuss step in a non-interactive mode (`--assumptions`/`--auto`/`--text`), and resolves a mid-run control-file blocker via the v2 `resolveBlocker` → `<agent-id>.inbox.md` → re-launch path — with zero edits to vendored GSD (NFR-03/04); the whole auto-answer orchestration runs green under **mocked model calls** in unit tests.
  4. The threshold, the per-run auto-answer cap, and triage/answer model postures are config-driven (extending the v2 `conductor` block, not editing GSD); every auto-answer appends to `auto-answers.jsonl`; a threshold of 1.0 degrades cleanly to "escalate everything," proving the escalation path is always live (NFR-08/11).
**Risk flags**: **Highest-risk phase — the central knot.** Two hard problems: (a) injecting a proxy answer into a GSD questioning flow that expects a human, without editing GSD, and (b) scoring confidence well enough that Kiwi proxies confidently and escalates honestly. Mitigate: drive the answer in ONLY through the documented non-interactive discuss modes + the `.planning/` contract (Criterion 3) so the seam is stable across GSD versions; keep confidence pure-arithmetic and fully audited (Criterion 2); make the threshold config-tunable with 1.0 = escalate-everything as a always-live safety floor (Criterion 4); and reuse the proven v2 control-file inbox/re-launch path rather than inventing a new resume mechanism. The real proxy-answer-during-a-live-run rides the existing v2 `--live` gate; the logic is unit-tested under mocked model calls here.
**Plans**: TBD

### Phase E5: Confidence-Gated Human Escalation via Selectors
**Goal**: When the oracle's confidence is below threshold or it abstains (`insufficient_spec`/`unknown`), Kiwi does NOT auto-answer — it escalates to the human, **rarely**, reusing the v2 control-file escalation protocol and rendering exactly one consolidated, deduplicated question as a GSD-style selector. The human's answer enriches the oracle (and profile) so the same gray-area resolves at high confidence next time, and the rarity/honesty of escalation is surfaced in `/bgsd-status`.
**Mode:** mvp
**Depends on**: Phase E4 (the confidence output + abstain signal) + the v2 control-file protocol (`control.mjs`) + the v2 `/bgsd-status` surface
**Requirements**: ESCALATE-01, ESCALATE-02, ESCALATE-03, ESCALATE-04
**Success Criteria** (what must be TRUE):
  1. Below threshold or on abstain, Kiwi routes the question to escalation via the v2 protocol exactly — `addEscalation` + park the worktree in `needs_input`, aggregated by the Conductor while the rest of the run continues — never an auto-answer (NFR-06/07/11).
  2. **(selector-Q&A always — NFR-10)** The escalation surfaces as exactly one consolidated, deduplicated selector question through the Kiwi channel: 2–4 concrete pre-filled options (synthesized from the best low-confidence candidates) PLUS an always-available "type your own" free-text option; dedup (collapsing the same gray-area across worktrees) is deterministic; no free-form-only escalation prompt is ever shown.
  3. The human's answer (chosen or typed-own) is written back as a new sealed decision-record entry (and, if a general leaning, into the profile), so a similar later question resolves at high confidence without re-escalating; the answer flows to the waiting worktree via the v2 `resolveBlocker` → inbox → re-launch path (ESCALATE-03).
  4. `/bgsd-status` (v2 surface, reused) shows per run the auto-answered-vs-escalated counts, the running auto-answer rate, the current confidence threshold, and any pending human selector — so Kiwi's proxying is honest and escalations are visibly rare, never silently suppressed (NFR-06/08); telemetry captured deterministically (NFR-05).
**Risk flags**: Low–medium. The escalation plumbing is the proven v2 control-file protocol; the new risk is dedup quality (collapsing genuinely-distinct questions would hide a real unknown). Mitigate: dedup only on a strong deterministic match key and bias toward keeping questions separate (a false split costs one extra selector; a false merge hides an unknown — the worse failure). The live answer-to-a-real-worktree-mid-run portion rides the existing v2 `--live` gate.
**Plans**: TBD
**UI hint**: yes

### Phase E6: Diagram-First Docs
**Goal**: A user can run `/bgsd-intake`, go through the upfront brainstorm, and understand exactly how Kiwi answers discuss-phase questions as their proxy (and when it escalates) from the docs alone — including the selector-always rule and the confidence threshold.
**Mode:** mvp
**Depends on**: Phases E1–E5
**Requirements**: DOCS-07, DOCS-08
**Success Criteria** (what must be TRUE):
  1. A diagram-first `/bgsd-intake` + upfront-brainstorm page (GSD-Mintlify style) documents NL/voice → Haiku spec-gen → chunked intent spec → active upfront brainstorm (selector Q&A) → sealed decision record + preference profile → feed into `gsd-new-project`, including the selector-Q&A-always rule and the "interactive by design" nature of the brainstorm.
  2. A decision-oracle + proxy-Q&A page documents the oracle store, the confidence score + threshold, the auto-answer-into-`discuss-phase` seam, and the confidence-gated escalation via selectors, with the auto-answer/escalation decision diagram, the audit log, and the config knobs (threshold, auto-answer cap).
  3. Both pages render in the GSD-Mintlify docs site without breaking its existing navigation or build.
**Risk flags**: Low. Reuses the v0/v1/v2 docs pipeline; main risk is docs drifting from the shipped surface — write them last, against built behavior.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in E-numeric order: E1 → E2 → E3 → E4 → E5 → E6
(E4 — the decision-oracle + confidence + auto-answer seam — is the center of gravity, built right after its three input dependencies (E1 spec, E2 decision record, E3 profile) are in place. E5 consumes E4's confidence output + the v2 control-file protocol; E6 documents last. This whole sequence runs AFTER the sealed v2 Conductor core (v2 Phases 1–9).)

**Interactive-by-design phases/criteria** (a real engaged human session — front-loading intent or resolving a genuine unknown — NOT a live-orchestration human-gate):
- **Phase E2, Criteria 1–4 — the active upfront brainstorm.** This is interactive by design; the user is very engaged front-loading intent. Distinct from the live-run gate: it spawns no processes and merges nothing. The selector-payload assembly + decision-record writes are unit-testable deterministically with mocked answers; the full session is exercised in an interactive run.
- **Phase E5, Criterion 2 — the consolidated human selector** when an escalation fires (rare by design). Same nature: interactive, no live spawn.

**Human-gated criteria** (inherit the existing v2 `--live` gate; built + unit-tested behind mocked model/spawn calls, live wiring off by default, `--dry-run` default, never CI, never `next`):
- **Phase E4, Criterion 3 (live portion)** and **Phase E5, Criterion 3 (live portion)** — resolving a *real* worktree blocker mid-run (auto-answered or escalated) during a live `/bgsd-run` orchestration. These ride the existing v2 SPAWN-04 `--live` gate; the logic is unit-tested under mocked model calls.

**Deterministic-buildable (the bulk, unit-testable with mocked model calls):** all of E1 (spec-gen behind a mocked model; chunk index, write, validation), E3 (profile roll-up), E4's oracle store + confidence arithmetic + threshold/auto-answer routing + selector-payload assembly, E5's escalation routing + dedup + status telemetry, E6, plus the selector-payload + decision-record write logic of E2.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| E1. NL/Voice Intake → Rich Intent Spec | 1/1 | Complete | 2026-06-29 |
| E2. Active Upfront Brainstorm + Decision Record (INTERACTIVE) | 1/1 | Complete | 2026-06-29 |
| E3. Preference Profile | 1/1 | Complete | 2026-06-29 |
| E4. Decision-Oracle + Confidence + Auto-Answer Seam (CENTRAL KNOT) | 0/1 | Pending | — |
| E5. Confidence-Gated Human Escalation via Selectors | 0/1 | Pending | — |
| E6. Diagram-First Docs | 0/1 | Pending | — |

---
*Roadmap defined: 2026-06-29 — v2 extension layered on the sealed v2 Conductor core (v2 Phases 1–9).*
