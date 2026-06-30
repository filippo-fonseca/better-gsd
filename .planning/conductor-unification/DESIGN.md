# Conductor Unification + Reframe — DESIGN

## 0. What this is (and is NOT)

bgsd is **already fully built** (v0–v3 + the intake/proxy extension E1–E6). This
document does **not** propose new engines. It proposes a **front door + a scale
router + a reframe**:

- **One user-facing surface:** `/bgsd-sesh "<whatever I need>"` (a *session*).
  Kiwi, the Conductor, is the only interface and is **always on**. The user
  **chats**; they never invoke `/bgsd-verify`, `/bgsd-queue`, `/bgsd-run`,
  `/bgsd-integrate`, `/bgsd-user-eval`, `/bgsd-feedback` directly. Those become
  **internal stages** the Conductor orchestrates (and remain available as
  advanced/direct access — see §9).
- **The Conductor decides scale + depth itself** from the prompt: bug-fix/small
  vs feature vs project. It then runs **the SAME pipeline, scaled**: ONE agent
  for "change this button to X" (still through the whole verify→fix workflow,
  just one agent), the FULL parallel pipeline for a project.
- **Nothing built is wasted.** `session.mjs` is a thin orchestrator that *wires
  existing engines together* behind a deterministic scale classifier. No engine
  is rewritten; the live/`--live` split is preserved exactly.

This is the integration-and-routing layer that turns a pile of proven engines
into a single conversational product.

---

## 1. The `/bgsd-sesh` surface

### 1.1 Command

```
/bgsd-sesh "<whatever I need>"  [--project | --quick]
```

- **Name = "start session".** `/bgsd` MAY alias to `/bgsd-sesh`.
- A request is **always** a fix, a feature, or a project. The session is a
  **conversational loop**: it opens with the prompt, runs the scaled pipeline,
  and stays open (Kiwi answers downstream questions via the oracle, surfaces the
  always-on status view, and escalates to the human only when it must).
- The corresponding script entrypoint is `bgsd/scripts/session.mjs`
  (deterministic core; the real spawns/merges/PRs stay behind the existing
  `*-live.mjs` modules — see §8).

### 1.2 Flags (mutually exclusive)

| Flag | Mode | Meaning |
|------|------|---------|
| `--project` | `project` | **Forces** the full pipeline **AND discussion first**: intake → brainstorm → decision oracle, *then* decompose → parallel pipeline → Loop 2 → review → PR. |
| `--quick` | `quick` | **Forces** small: one (or a few) small things, **NO discussion**, **NO pre-prepare**, fast — but **STILL VERIFIED** (Loop 1 verify→fix never skipped). |
| *(none)* | `auto` | Conductor **auto-detects** scale from the prompt and routes to `quick` / `feature` / `project` itself. |

Flag → mode mapping is the only thing flags do; everything downstream is the
**same pipeline scaled by the resolved scale** (§4).

### 1.3 CLI shape (mirrors run.mjs / queue.mjs conventions)

```sh
# Auto-detect scale (default), dry-run by default for any live-spawning depth:
node bgsd/scripts/session.mjs --prompt "Change the CTA button to say 'Get started'"

# Force quick (no discussion, still verified):
node bgsd/scripts/session.mjs --prompt "Fix the 404 on /pricing" --quick

# Force project (discuss first, full pipeline). Live spawns are human-gated:
node bgsd/scripts/session.mjs --prompt "Build a billing dashboard with Stripe" --project

# The deterministic plan only (what scale, which engines, how deep) — no spawns:
node bgsd/scripts/session.mjs --prompt "..." --plan-only
```

`--plan-only` prints the resolved scale + the depth plan (the engine sequence)
and exits without spawning, mirroring the `--dry-run` discipline already used by
`run.mjs`. The real live execution is delegated to `run-live.mjs` /
`loop1-live.mjs` / `loop2-live.mjs` / `changelog-pr.mjs` exactly as today.

---

## 2. `session.mjs` orchestrator shape

`session.mjs` is a **deterministic state machine** that classifies scale, builds
a depth plan, and drives the existing engines. It owns no business logic that
isn't already in an engine; it is glue + a router. Like `run.mjs`, all live
boundaries are **dependency-injected** so the orchestrator is unit-testable
under mocks.

### 2.1 Public API

```js
// session.mjs
export const SCALES = Object.freeze(["quick", "feature", "project"]);
export const SESSION_MODES = Object.freeze(["auto", "quick", "project"]);

/**
 * classifyScale — deterministic scale classifier (§3).
 * @returns { scale, signals, unitCountEstimate, depthBreadth, confidence, modelSeam? }
 */
export function classifyScale({ prompt, mode }, opts = {});

/**
 * buildDepthPlan — map a resolved scale to the ordered engine plan (§4).
 * @returns { scale, stages: Stage[], discuss: boolean, verified: true }
 */
export function buildDepthPlan(scale, { prompt });

/**
 * startSession — the orchestrator entrypoint behind /bgsd-sesh.
 * mode ∈ auto|quick|project. Injected boundaries mirror run.mjs:
 *   discussFn, decomposeFn, spawnFn, readStatusFn, mergeFn,
 *   checkpointFn, verifyFn, fixFn, integrateFn, reviewFn, prFn, oracleFn
 * planOnly=true returns the plan without invoking any live boundary.
 */
export async function startSession({ prompt, mode = "auto", planOnly = false, ...injected });
```

### 2.2 Session lifecycle states

The session reuses the existing `run.mjs` `RUN_STATES` machine for any depth
that decomposes, and adds a thin pre-roll. Conceptually:

```
sesh-created
  → classifying        (deterministic scale classifier — §3)
  → discussing         (project only: intake → brainstorm → oracle seal)   [skipped for quick/feature]
  → planning           (quick: classify/route item ; feature/project: decompose → graph → waves)
  → <delegates to existing engine lifecycle>
       quick:    queue/Loop 1 item lifecycle  (queued→…→done|failed|blocked)
       feature:  run.mjs lifecycle, single-wave / few-unit
       project:  run.mjs lifecycle, full waves → integrating → review → done
  → conversing         (always-on: oracle answers, status view, rare escalations)
  → done | aborted | blocked | needs_input
```

`session.mjs` writes a small `.bgsd/sessions/<session-id>/session.json` (same
atomic write-temp-rename pattern as `run.mjs`/`queue.mjs`) recording: resolved
scale, mode, the depth plan, and a pointer to the underlying run/queue artifacts
(it stores **pointers, not blobs** — NFR-09). For `feature`/`project` it mints a
`run.mjs` run-id and delegates; for `quick` it enqueues a single queue item and
drives Loop 1.

---

## 3. Scale classifier (auto mode) — rules & thresholds

The classifier is **deterministic-first** with a clearly-marked optional model
seam (Haiku) for refinement, exactly mirroring the `classify-item.mjs` and
`decompose.mjs` seam conventions. It must produce the same answer offline.

### 3.1 Inputs / signals (all cheap, zero required model calls)

1. **Route class** from the existing heuristic `classifyHeuristic(title, body)`
   in `classify-item.mjs` → one of `trivial-fix | scoped-fix | feature |
   needs-clarification`. (We pass the prompt's first line as `title`, the rest
   as `body`.)
2. **Light decompose pass** — a cheap structural estimate of unit count +
   dependency breadth. The full `decompose.mjs` is a model seam, so the
   deterministic signal is a **prompt-shape heuristic** computed without a model:
   - **conjunct/clause count** — count of top-level work clauses split on
     `" and "`, `","`, `";"`, newlines, and bullet markers (`- `, `* `, `1.`).
   - **scope verbs** — count of distinct feature-signal verbs present
     (`add|build|create|implement|migrate|integrate|dashboard|api|endpoint…`,
     reusing `FEATURE_SIGNALS` from `classify-item.mjs`).
   - **surface breadth** — count of distinct named surfaces/areas
     (`ui|page|screen|api|db|schema|auth|billing|deploy…`).
   - **prompt length band** — chars, bucketed (`<160`, `<600`, `≥600`).
   - These feed `unitCountEstimate` (≈ clause count, floored at 1) and
     `depthBreadth` (distinct surfaces).
   *(MODEL SEAM, marked: when the Haiku scale-refiner is activated it may call a
   real light `decompose` to refine `unitCountEstimate`/`deps`; the heuristic
   remains the offline fallback and the deterministic core of the decision.)*
3. **Explicit flag override** — `--quick`/`--project` short-circuit the classifier.

### 3.2 The deterministic decision rules (evaluated in order)

```
INPUT: prompt, mode
IF mode == "quick"   → scale = quick     (forced; skip 1–7)
IF mode == "project" → scale = project   (forced; skip 1–7)
// mode == "auto" below:

routeClass        = classifyHeuristic(firstLine, rest).route_class
unitCountEstimate = max(1, clauseCount)
depthBreadth      = distinctSurfaces

1. needs-clarification  → ASK (return scale=null, action="clarify").
   The Conductor asks ONE clarifying question in-chat, then re-classifies.
   Never silently guess (NFR-06).

2. routeClass == "trivial-fix"
     AND unitCountEstimate == 1
     AND depthBreadth <= 1                          → QUICK

3. routeClass == "scoped-fix"
     AND unitCountEstimate <= 2
     AND depthBreadth <= 1                          → QUICK

4. unitCountEstimate >= 4
     OR depthBreadth >= 3
     OR (routeClass == "feature" AND lengthBand == "≥600")   → PROJECT

5. routeClass == "feature"
     AND unitCountEstimate in [1..3]
     AND depthBreadth in [1..2]                     → FEATURE

6. unitCountEstimate in [2..3] AND depthBreadth == 2 (any class) → FEATURE

7. DEFAULT (anything not matched above)             → FEATURE
   (the safe middle: never silently downgrades to quick, never auto-escalates
    to the heaviest discuss-first path without a strong signal.)
```

**Thresholds summary**

| Scale | Triggers (auto) |
|-------|-----------------|
| `quick` | trivial/scoped-fix **and** est. units ≤ 2 **and** ≤ 1 surface. |
| `feature` | feature-ish **or** 2–3 units / 2 surfaces; **the default** for ambiguous-but-classifiable work. |
| `project` | ≥ 4 units **or** ≥ 3 surfaces **or** a long feature prompt; forced by `--project`. |

**Confidence + the Haiku seam.** `classifyScale` returns a `confidence`
(`heuristic` by default). A **marked seam** `refineScaleWithModel(prompt,
heuristicResult)` may, when activated (Part 11 Haiku row), nudge a *borderline*
case **one step** (quick↔feature or feature↔project) — never more than one step,
never overriding an explicit flag, and never turning a `needs-clarification`
into a silent guess. The deterministic result is always computed first and is
the fallback. (Mirrors `classify-item.mjs`'s `classifyWithModel` stub and
`brainstorm.mjs`'s `refineFn` invariant-guarded pattern.)

### 3.3 Auto-escalation during a session

If a `quick`/`feature` session, mid-flight, reveals it is bigger than estimated
(e.g. Loop 1 hits a no-progress/blocked verdict that implies cross-surface
work, or the cheap decompose under `feature` yields ≥ 4 real units), the
Conductor **surfaces this in-chat and asks** to escalate the scale (quick→feature
or feature→project, one step). It never silently expands scope (NFR-06/08).
Escalation re-enters at the appropriate `buildDepthPlan` stage; already-done work
(merged units, passed items) is preserved by pointer.

---

## 4. Depth routing — the SAME pipeline, scaled

Every scale runs the **same conceptual pipeline** — *route/plan → execute →
**verify→fix** → (integrate) → (review) → record* — but with depth dialed by
scale. **Quick still verifies.** The table below maps each scale to the **real
engines** (with their actual exported entrypoints) and how deep each runs.

| Stage | `quick` (1–few agents, no discuss) | `feature` (mid) | `project` (full, discuss-first) |
|-------|-----------------------------------|-----------------|--------------------------------|
| **Discuss** | — (skipped) | — (skipped) | **YES.** `intake.mjs:generateIntentSpec()` → `brainstorm.mjs:runBrainstorm()` (selector Q&A, seal decisions) → `profile.mjs:buildPreferenceProfile()` → `oracle.mjs:buildOracle()`. Discusses **with the user first**. |
| **Classify / Route** | `classify-item.mjs:classifyItem()` → `route-item.mjs:routeItem()` (→ `/gsd-fast` or `/gsd-quick`). | `classifyItem`/`routeItem` per item **or** a small `decompose.mjs:buildUnits()` (1–3 units → `/gsd-plan-phase`). | `decompose.mjs`: `parseDecompositionResponse()` (Opus seam) → `buildUnits()` → `graph.mjs:buildGraph()` → `topoWaves()` → `verifyGraph()`. |
| **Fan-out** | none — single worktree (or a few sequential items via the queue drainer). | `worktree.mjs:planWorktrees()` for the few units; `scheduler.mjs:runScheduler()` with low `maxConcurrency`. | `worktree.mjs:planWorktrees()` + `scheduler.mjs:runScheduler()` full waves (`DEFAULT_MAX_CONCURRENCY`). |
| **Execute** | `run-live.mjs:liveSpawnFn` (1 agent) — `--live`-gated; deterministic core stubbed in `--plan-only`. | spawn the few unit agents (`run-live.mjs`), `--live`-gated. | spawn all wave agents (`run-live.mjs`), `--live`-gated. |
| **VERIFY→FIX (Loop 1)** | **YES — `loop1.mjs:runLoop1()`** per worktree (verify→fix, bounded, escalation ladder). **Never skipped.** | **YES — `runLoop1()` per worktree.** | **YES — `runLoop1()` per worktree.** |
| **Conflict + Merge** | trivial (1 branch → no integration branch needed for a single fix; merges straight to `rehearsal/<id>` if assembled). | `conflict.mjs:preCheckMerge()` + `computeMergeOrder()` + `executeMerges()` into `rehearsal/<id>`. | same — `conflict.mjs` full dependency-ordered merge with checkpoints (`run.mjs:recordCheckpoint`). |
| **Rehearsal assembly** | optional (single unit). | `rehearsal.mjs:planRehearsalAssembly()` → `executeRehearsalAssembly()`. | full `rehearsal.mjs` assembly + `aggregateDocs()`. |
| **Integration (Loop 2)** | **skipped** (single change; Loop 1 is the verification). | **Loop 2 if > 1 unit merged** — `loop2.mjs:runLoop2()` over `rehearsal/<id>`. | **YES — `runLoop2()`** integration verify→fix. |
| **User Review Gate** | **skipped by default** for a trivial verified fix (Loop 1 PASS is the gate); surfaced as a one-line confirm in chat. | `review.mjs:openReviewGate()` (interactive, never auto-passed). | `review.mjs:openReviewGate()` — mandatory. |
| **Changelog / PR** | optional: a single-line summary; PR only if the user asks. | `changelog-pr.mjs:aggregatePerAgentChangelog()` + `assemblePrBody()`; real PR `--live`-gated. | full per-agent CHANGELOG → PR (`changelog-pr.mjs`, real `gh pr create` `--live`-gated, never a default branch). |
| **Feedback loop** | `feedback.mjs:ingestFeedback()` (`--fast`) if the user reports a problem in-chat. | `feedback.mjs` full or `--fast`. | `feedback.mjs` full (re-runs both loops) on `request changes`. |
| **Always-on view** | `status.mjs:renderStatus()` (zero-model). | same. | same. |

### 4.1 The non-negotiable invariant: quick still verifies

`quick` is **fast** (no discussion, no decompose, no integration loop, no
mandatory review gate) but it **always runs `loop1.runLoop1()`** — a real
verify→fix Ralph loop with the v0 Tester. A `quick` session can terminate in
`done` only on a Tester `PASS`; `FAIL`→fix→re-verify (bounded), `BLOCKED/ERROR`
→ blocked, no-progress → failed. **There is no path where a `quick` change is
reported done without a Tester pass** (NFR-06). The only things `quick` drops
relative to `project` are the *discussion*, the *parallel fan-out*, the
*integration Loop 2*, and the *mandatory* human review gate — never verification.

### 4.2 `feature` is the middle, not a separate engine

`feature` reuses the **project engines** at small N: a tiny decompose (1–3
units), low-concurrency scheduler, Loop 1 each, a light conflict+merge, and Loop
2 only if more than one unit merged. It **skips discussion** (no intake/brainstorm)
and uses the interactive review gate. This is why "nothing built is wasted":
`feature` is just `project` with discussion off and N small.

---

## 5. Flag semantics (precise)

- `--project` → `mode="project"` → `classifyScale` returns `scale="project"`
  unconditionally; `buildDepthPlan("project")` sets `discuss=true`. The
  intake→brainstorm→oracle discussion runs **before** decomposition, with the
  user. Full pipeline.
- `--quick` → `mode="quick"` → `scale="quick"` unconditionally;
  `discuss=false`, `preprepare=false`, fast path, **`verified=true`** (Loop 1).
- *(no flag)* → `mode="auto"` → the §3 deterministic classifier picks the scale;
  `needs-clarification` triggers exactly one in-chat question, never a guess.
- Flags are mutually exclusive; passing both is a usage error.
- A flag **never** disables verification and **never** lets bgsd write a default
  branch.

---

## 6. The always-on conversational + status model

- **Kiwi is always on.** `/bgsd-sesh` opens a session and Kiwi stays present
  through the whole lifecycle. The user **chats**; they do not issue stage
  commands. Internally the Conductor sequences the stages from §4.
- **Downstream questions are answered by the oracle, not bounced to the user.**
  When a stage (e.g. a `/gsd-discuss-phase` step inside `project`, or a
  worktree agent raising a blocker) needs a decision, the Conductor calls
  `oracle.mjs:answerQuestion()` against the sealed baseline (spec + decisions +
  profile). If `confidence ≥ threshold` → it **auto-answers** through the GSD
  seam (`buildDiscussPhaseSeam()` / `control.mjs:resolveBlocker()`); if below
  threshold → it **abstains and escalates** (`escalate.mjs:runEscalation()` /
  `buildEscalationBatch()`), surfacing a **batched** selector question to the
  user in-chat. Escalation is **rare by design** (the oracle clears the common
  cases; `escalate.mjs` batches what's left). No silent green (NFR-06).
- **The status view is the always-on display.** `status.mjs:renderStatus({ run,
  agents, telemetry })` is the live, colorful, **zero-model** view: Kiwi banner,
  butler narration, run state/wave/units, the agent/worktree table, merge state,
  the review-gate badge, budget+context telemetry, and the constant **🔒
  main-protected** footer. For `quick`/`feature` the same renderer shows a
  reduced view (fewer agents). It is loaded from disk via `loadStatus({ runId })`
  and never blocks the conversation.
- **Context hygiene.** Long sessions use `context.mjs` (`estimatePressure`,
  `pressureDecision`, `writeHandoffManifest`, `liveCompact`/`liveRelaunch`) so
  the Conductor and its subagents never overflow — already built, just invoked
  by the session loop.

---

## 7. Mapping the old `/bgsd-*` commands to internal stages

| Old command | New role under the session |
|-------------|----------------------------|
| `/bgsd-verify` | Internal verify step inside Loop 1 / Loop 2 (`loop1`/`loop2` `verify` boundary). |
| `/bgsd-queue` | Internal `quick`-scale work-intake + drainer (`queue.mjs`). |
| `/bgsd-run` | Internal `feature`/`project` lifecycle (`run.mjs`). |
| `/bgsd-integrate` | Internal Loop 2 integration stage (`loop2.mjs`). |
| `/bgsd-user-eval` | Internal User Review Gate (`review.mjs`), surfaced in-chat at the right moment. |
| `/bgsd-feedback` | Internal feedback ingestion when the user reports an issue mid-session (`feedback.mjs`). |
| `/bgsd-changelog` | Internal CHANGELOG→PR assembly (`changelog-pr.mjs`). |
| `/bgsd-status` | The always-on display (`status.mjs`), shown continuously, not invoked. |

These remain runnable directly as **advanced / direct access** for power users
and debugging (see the reframe, §10), but they are no longer the **primary
surface**. The primary surface is the chat session.

---

## 8. Deterministic vs `--live` split (unchanged discipline)

The session changes **nothing** about the existing safety model; it inherits it:

- **Deterministic + unit-testable core:** `classifyScale`, `buildDepthPlan`, the
  session state machine, the stage sequencing, and all engine *controllers*
  (`runLoop1`, `runLoop2`, `runLifecycle`, `runScheduler`, `runBrainstorm`,
  `answerQuestion`, merge ordering, CHANGELOG/PR-body strings) run under **mocked
  injected boundaries** — no spawns, no merges, no PRs, no model calls required.
  `--plan-only` exercises exactly this path.
- **`--live`-guarded, human-gated boundaries (never `next`):** real worktree
  spawns (`run-live.mjs:liveSpawnFn`), real merges (`conflict.mjs:liveGitMergeFn`,
  `rehearsal.mjs:liveAssembleFn`), the live integration boot (`loop2-live.mjs`),
  the live review-app boot (`review.mjs:liveBootRehearsalApp`), real PR creation
  (`changelog-pr.mjs:liveCreatePr` — `requireNotDefaultBranch`), and the live
  oracle GSD invocation. Each keeps its existing `requireLiveFlag()` /
  `requireNotNextBranch()` / `--dry-run`-default guard.
- **The session never relaxes a guard.** `/bgsd-sesh` without `--live` is always
  safe: it classifies, plans, and (for `quick`) can run the deterministic Loop 1
  controller under mocks, but any real spawn/merge/boot/PR still requires the
  human-gated `--live` opt-in on the underlying `*-live.mjs` module, with
  `--dry-run` as the default and `next`/default branches never written.
- **Session-level human gates are preserved:** merge-boundary checkpoints
  (`run.mjs:recordCheckpoint`/`resumeFromCheckpoint`), the interactive review
  gate (`review.mjs:openReviewGate`, never auto-passed), and escalation prompts
  (`escalate.mjs`) all still pause for the human exactly as before.

---

## 9. What `session.mjs` must NOT do

- Must not reimplement any engine logic (it calls the real exports).
- Must not bypass Loop 1 for any scale (quick included).
- Must not auto-merge or auto-PR to `next`/any default branch.
- Must not silently guess a `needs-clarification` prompt's scale.
- Must not hold whole artifacts in memory — stores pointers, reads on demand.
- Must not run a real spawn/merge/PR without the existing `--live` gate.

---

## 10. The reframe (README / docs / PROJECT.md)

The product story changes from "a toolbox of `/bgsd-*` commands" to **"a single
always-on Conductor you chat with."** Concretely:

- **README / docs hero:** lead with `/bgsd-sesh "<whatever I need>"`. One front
  door. Explain that Kiwi auto-detects scale (quick fix / feature / project),
  runs the same verified pipeline scaled to fit, and stays on to converse.
  Show the three flag forms (`--quick`, *(auto)*, `--project`).
- **Reposition the `/bgsd-*` pages** as **"Internal stages / advanced direct
  access."** Keep them documented (they still work), but under a clearly-labeled
  "Under the hood" / "Power user" section, not as the primary quickstart. Add a
  one-line "this runs internally during a session" note at the top of each.
- **Add a "How the Conductor scales" page:** the §3 classifier table and the §4
  depth-routing table (scale → engines → depth), making explicit that **quick
  still verifies** and that the same pipeline is used throughout.
- **PROJECT.md:** add a "Unification / Reframe" milestone note in *What This Is*:
  the user surface is now the session; the old commands are internal stages
  (advanced access retained). Keep all hard rules/invariants unchanged (never
  write `next`, additive-only, GSD via seams). Update the *Requirements* /
  *Future Milestones* sections to record the session orchestrator + scale router
  as the unifying layer over v0–v3 + intake.
- **Self-check:** preserve the existing always-on-status and never-touch-`next`
  guarantees in every doc; do not introduce em-dash-spliced copy.

---

## 11. Engine reference (real APIs this design wires)

- **Scale signals:** `classify-item.mjs:classifyHeuristic/classifyItem`,
  `decompose.mjs:difficultyScore/buildUnits` (light pass).
- **Quick path:** `queue.mjs:addItem/transition/startDrainer`,
  `route-item.mjs:routeItem`, `loop1.mjs:runLoop1/defectSignature`,
  `loop1-live.mjs` (live verify/fix).
- **Feature/Project path:** `decompose.mjs`, `graph.mjs:buildGraph/topoWaves/
  verifyGraph`, `worktree.mjs:planWorktrees`, `scheduler.mjs:runScheduler`,
  `run.mjs:mintRunId/createRun/runLifecycle/recordCheckpoint/resumeFromCheckpoint/
  abortRun`, `run-live.mjs:liveSpawnFn/liveReadStatusFn/liveMergeFn/
  liveCheckpointFn/runLiveRun`, `conflict.mjs:preCheckMerge/computeMergeOrder/
  executeMerges/liveGitMergeFn`, `rehearsal.mjs:planRehearsalAssembly/
  executeRehearsalAssembly/aggregateDocs/generateChangelog/planBranchCleanup`,
  `loop2.mjs:runLoop2/assembleIntegrationReport`, `loop2-live.mjs`,
  `review.mjs:openReviewGate/buildReviewChecklist/resolveVerdict/liveBootRehearsalApp`,
  `feedback.mjs:ingestFeedback/parseFeedbackItems/planReRun/executeFeedbackPlan`,
  `changelog-pr.mjs:aggregatePerAgentChangelog/assemblePrBody/liveCreatePr/
  requireNotDefaultBranch`.
- **Discussion (project):** `intake.mjs:generateIntentSpec`,
  `brainstorm.mjs:runBrainstorm/buildBrainstormQuestions/sealDecisionRecord`,
  `profile.mjs:buildPreferenceProfile/queryProfile`,
  `oracle.mjs:buildOracle/loadOracle/answerQuestion/buildDiscussPhaseSeam`,
  `escalate.mjs:buildEscalationBatch/runEscalation/enrichOracleFromAnswers`.
- **Always-on + hygiene:** `status.mjs:renderStatus/loadStatus`,
  `control.mjs:readAllControlFiles/aggregateOpenBlockers/resolveBlocker/
  runHeartbeatTick`, `context.mjs:estimatePressure/pressureDecision/
  writeHandoffManifest/liveCompact/liveRelaunch`.
- **Safety:** every `*-live.mjs` `isLiveFlagSet()/requireLiveFlag()`,
  `run-live.mjs:requireNotNextBranch`, `changelog-pr.mjs:requireNotDefaultBranch`.
