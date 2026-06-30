# better-gsd — Implementation Plan

_An autonomous, two-loop, self-verifying orchestration layer built **on top of** GSD, shipped as an open-source Claude Code plugin. Working name: `better-gsd` (`/bgsd-_`).\*

---

## Part 1 — What we've agreed on (locked decisions)

These are settled. Everything in Part 2+ implements them.

1. **Additive layer over GSD, through an anti-corruption adapter — it never edits GSD's files.** `better-gsd` drives GSD only through stable seams (its `/gsd-*` commands, its `.planning/` file contract, its `config.json`). It can ship as a **sidecar plugin** beside GSD (GSD installed via `npx`, recommended) **or** as a **fork that vendors GSD as a git subtree** so you can merge upstream GSD updates safely and keep bgsd working. Either way GSD stays unmodified, so upgrades don't break bgsd. (Full mechanism in Part 12.)

2. **Two execution modes:** Project mode (`/bgsd-run` — one massive prompt) and Fix-stream mode (`/bgsd-queue` — a queue you keep feeding).

3. **The unit of parallelism is a whole GSD pipeline, not a task.** Each Pipeline Agent runs the _full_ discuss→plan→execute chain autonomously in its own git worktree.

4. **Atomic, constant commits.** Every Pipeline Agent commits continuously and atomically to its own branch — planning docs (GSD's `.planning/` markdown) as they're produced, and each execution step as it lands. Full version-control trail, always.

5. **The Conductor is the only thing you talk to — minimally.** Parallel agents can't talk to each other. The Conductor supervises them, prevents/resolves conflicts, and constantly checks up. **When an agent blocks or needs input, the Conductor answers it _itself_ first**; only if it's critical or genuinely unknown does it escalate to you. You never address a Pipeline Agent directly.

6. **One Tester per Pipeline Agent, running in parallel, against that worktree's own running instance.** (Answer to your question: yes — per-agent, parallel, worktree-local.) This forces **runtime isolation** — each worktree gets its own port + isolated DB/seed so testers don't collide.

7. **Two nested verify→fix loops (the core of the design):**
   - **Loop 1 — per worktree.** Tester checks the feature via computer-use/vision against GSD's acceptance criteria → defects → Ralph-style loop until that worktree passes.
   - **Loop 2 — integration.** Verified branches merge into one **integration branch per run** → Integration Tester checks the _whole assembled app_ (computer-use UAT + code review + alignment to requirements + active scrutiny for **improvements**, not just faults) → Conductor spawns **parallel fix agents** from the report → Ralph-style loop until the whole thing is clean. _This is the INTEGRATION VERIFICATION & FIXING phase._

8. **The integration branch.** All verified worktree branches for a run merge into one standing branch named **`next`** (configurable in `BGSD.md`). `next` is the rehearsal/integration mirror of production: it simulates the fully-merged app so integration can be tested without touching `main`. It is created off the base branch on first init, and fast-forwarded from `main` at the start of every sesh, so it never falls behind production.

9. **HARD RULE: nothing automated ever touches `main`.** No agent, no command, ever commits or PRs to the production/default branch. Only **you** merge `next` into `main`, by hand. This is non-negotiable, enforced by a guard hook (`requireNotProductionBranch`).

10. **User evaluation is abstracted to the integration branch.** When all loops finish, the Conductor prompts you (in the terminal and in the PR description) with a concrete, human-readable, **per-subagent** changelog of everything added, fixed, and changed, fully traceable. `/bgsd-user-eval` auto-starts servers/backend and hands you the localhost URL to click.

11. **Feedback mode.** `/bgsd-feedback` — you describe everything wrong; the **entire two-loop machine re-runs** on those items. Optional **`--fast`**: skips the loops — Conductor just spawns parallel fix agents (or a single agent for a single trivial fix — it decides) with no computer-use verification. Handles both the multi-fix and single-fix cases; only the _loop_ is skipped.

12. **Markdown documentation enforced on top of GSD.** Parallel worktrees each generate a ton of GSD `.planning/` markdown. The Conductor ingests these into its **own** aggregated documentation, and the repo keeps a permanent ledger of **every `bgsd` run** and **what each subagent did**.

13. **Branch hygiene.** After a run's branches are merged into `rehearsal/<run-id>`, the individual worktree branches are **deleted by default** (their work is merged + fully documented, so they're safe to drop — avoids hundreds of branches). **`rehearsal/*` branches are kept by default.** `/bgsd-clean-branches` deletes stale `rehearsal/*` branches that you've already merged into `main`.

14. **The Conductor is named Kiwi — always.** Every user-facing string refers to the orchestrator as **Kiwi**, with a kiwi-bird mascot rendered as a chunky terracotta pixel-block sprite on launch (Claude Code-style). It's the one agent you talk to, so it has a name and a face. (Full treatment in Part 16.)

---

## Part 2 — Hard rules & invariants (enforced, not aspirational)

| Invariant                             | Enforcement                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| No automated write to `main`          | `pre-push` / `PreToolUse` guard hook rejects any push/PR targeting the default branch unless invoked by the explicit user-merge path. |
| Every worktree is isolated            | Each gets its own git worktree, branch, port, and ephemeral DB/seed (`.env.bgsd`).                                                    |
| Every change is traceable             | Atomic commits + per-agent summary docs + a run ledger. Nothing lands without a paper trail.                                          |
| Conductor is the only human interface | Pipeline/Tester/fix agents never prompt the user directly; they write to control files the Conductor reads.                           |
| GSD stays unmodified                  | `better-gsd` only _calls_ `/gsd-*`; it never edits GSD's files.                                                                       |

---

## Part 3 — The engine: how parallelism actually works

**Key technical decision (from research): the Conductor is a _process_ orchestrator, not an in-context subagent tree.**

Claude Code now allows subagents to nest up to 5 levels (since v2.1.172, June 2026), but two facts push us to process isolation instead:

- Each Pipeline Agent needs its **own git worktree with its own running dev server** for its Tester. One Claude process can't sit in five worktrees running five servers at once.
- Token cost of deep in-context nesting compounds geometrically; GSD already fans out ~7× tokens on its own.

So:

- **Conductor** runs as a lightweight control loop (a script + a thin Claude "supervisor" agent). It launches each **Pipeline Agent as a headless `claude -p` process** pinned to a worktree, each free to use GSD's own subagents normally inside its 200k window.
- Coordination is via the **filesystem + git**, not shared context. This cleanly satisfies "parallel agents can't talk to each other, the Conductor manages them."

### Control-file protocol

Each agent owns `/.bgsd/control/<agent-id>.json`:

```json
{
  "agent_id": "wt-03-billing",
  "worktree": ".bgsd/worktrees/wt-03-billing",
  "branch": "bgsd-0042/billing",
  "phase": "execute", // discuss|ui|plan|execute|verify|fixing|done|blocked|failed
  "status": "blocked",
  "blocker": {
    "question": "Which payment provider — Stripe or Adyen?",
    "severity": "high"
  },
  "heartbeat": "2026-06-29T14:03:22Z",
  "commits": 17
}
```

**How blocking/answering works** (headless runs are non-interactive, so we don't pause mid-run):

1. **Prefer assumption-and-continue.** Agents run in GSD **assumptions mode** — they make a documented decision and keep going, logging it. Most "blockers" never stop anything.
2. **Hard blocker → clean exit with `status: blocked`.** The Conductor detects it, tries to **answer from context** (REQUIREMENTS.md, PROJECT.md, the codebase, prior runs). It writes the answer to `<agent-id>.inbox.md` and **re-launches the agent to resume** with that context appended.
3. **Only if the Conductor can't answer and it's high-severity** → it writes to the **user-escalation queue** and surfaces _one_ consolidated question to you through the Conductor channel.

The Conductor also watches **heartbeats** (stalled agent → restart) and runs **conflict pre-checks** (see Part 4).

---

## Part 4 — Git & branch model

```
main (production, 🔒 user-only)
└── rehearsal/bgsd-0042-auth-revamp        ← integration branch for the run
    ├── bgsd-0042/billing      (worktree branch — deleted after merge)
    ├── bgsd-0042/login-ui     (worktree branch — deleted after merge)
    └── bgsd-0042/session-mw   (worktree branch — deleted after merge)
```

- **Run ID:** `bgsd-<NNNN>-<slug>` — monotonic counter + short slug from the prompt. Stamped on the branch, the docs, and the PR.
- **Worktrees:** created under `.bgsd/worktrees/<agent-id>/`, branched off the _current_ `rehearsal/<run-id>` head (or off `main`'s head at run start for the first wave).
- **Merge order:** Conductor merges verified branches into `rehearsal/<run-id>` in **dependency order** (independent first). Before each merge it runs a **dry-run merge / conflict pre-check**; conflicts are resolved by a dedicated Conductor merge-resolver agent (which has the full requirements + both branches' summaries as context), not by the isolated Pipeline Agents.
- **Atomic commit discipline:** a per-worktree commit convention (`bgsd(<agent-id>): <phase> — <atomic step>`) plus a light hook that commits GSD planning artifacts the moment they're written. The trail is the audit log.
- **Cleanup:** after a successful merge of a worktree branch into `rehearsal/`, that branch + worktree are removed by default. `rehearsal/*` is retained. `/bgsd-clean-branches` prunes `rehearsal/*` branches already merged to `main`.

---

## Part 5 — The two loops in detail

### Loop 1 — per-worktree (verify → fix)

1. Pipeline Agent runs full GSD (`/gsd-discuss-phase --chain` → plan → execute), committing atomically.
2. On "execution complete," the Conductor spawns that worktree's **Tester** against its isolated running instance.
3. Tester drives the app via a **verification driver** (Playwright/Chrome MCP for web — DOM-aware and fast; full computer-use vision for native apps or pixel-level checks), walking GSD's acceptance criteria + `UI-SPEC.md`.
4. Output: structured `verification-report.json` (pass/fail per criterion + screenshots + defect list).
5. **Fail →** defects become a backlog; a Ralph-style **stop-hook** re-injects the Pipeline Agent to fix → re-test. Repeat until pass or `max_iterations`.
6. **Pass →** worktree branch is eligible for merge into `rehearsal/<run-id>`.

### Loop 2 — integration (verify → fix), after all worktrees merged

1. Conductor assembles `rehearsal/<run-id>` (all worktrees merged, conflicts resolved).
2. **Integration Tester** boots the _whole app_ and does: end-to-end computer-use UAT across feature boundaries, **code review of the integrated diff**, alignment check against the original prompt/requirements, and **active scrutiny for improvements** (not just regressions — feature-interaction smells, polish, consistency).
3. Output: `integration-report.json` (faults + improvement recommendations, each tagged to a file/feature).
4. Conductor spawns **parallel fix agents** off the report (in worktrees branched from `rehearsal/`), each fixing an independent item; re-merge.
5. Ralph-style loop at this layer: re-run Integration Tester → fix → repeat until clean or `max_iterations`.
6. **Clean →** advance to the User Review Gate.

> Same loop shape, applied twice: once per worktree, once over the assembled whole. That's the symmetry — local correctness _and_ integrated correctness, both earned autonomously.

---

## Part 6 — Documentation model (on top of GSD)

GSD writes per-project markdown into each worktree's `.planning/` (`PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `phases/XX-*/…` with CONTEXT/RESEARCH/PLAN/SUMMARY/VERIFICATION/UAT). `better-gsd` adds a repo-level ledger that _aggregates and indexes_ it:

```
.bgsd/
├── runs/
│   └── bgsd-0042-auth-revamp/
│       ├── RUN.md            # the dump, decomposition, dependency graph, timeline
│       ├── AGENTS.md         # per-subagent: what it was asked, did, decided, committed
│       ├── verification/     # Loop 1 + Loop 2 reports, screenshots
│       ├── integration.md    # INTEGRATION VERIFICATION & FIXING log
│       └── CHANGELOG.md      # human-readable, per-agent — feeds the PR body & user eval
├── ledger.md                # index of ALL runs ever, status, links
├── control/                 # live agent control + inbox files
└── worktrees/               # ephemeral worktree checkouts
```

The Conductor pulls each worktree's `.planning/` summaries into `AGENTS.md`/`CHANGELOG.md` so the whole repo has a permanent, traceable record of every run and every subagent — exactly the GSD-style markdown discipline, enforced one level up.

---

## Part 7 — Command surface

| Command                                    | Purpose                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/bgsd-run "<prompt>"`                     | Project mode. Decompose → parallel full-GSD worktrees → Loop 1 → merge to `rehearsal/<run-id>` → Loop 2 → User Review Gate.                                        |
| `/bgsd-queue [add\|start\|status]`         | Fix-stream mode. Persistent queue you keep feeding; Conductor chews through it with the same verification loops.                                                   |
| `/bgsd-status`                             | Live view of all agents, worktrees, loop iterations, blockers, merge state.                                                                                        |
| `/bgsd-user-eval`                          | Auto-boot servers/backend for `rehearsal/<run-id>`; print the localhost URL + the test checklist.                                                                  |
| `/bgsd-feedback "<what's wrong>" [--fast]` | Re-run both loops on your feedback. `--fast` = parallel fix agents, no loops, no computer-use verification (Conductor picks single vs. multi agent automatically). |
| `/bgsd-verify`                             | **(v0)** Standalone Tester: point at a running app + acceptance criteria, get a defect report. The riskiest piece, shippable alone.                                |
| `/bgsd-clean-branches`                     | Delete stale `rehearsal/*` branches already merged into `main`.                                                                                                    |
| `/bgsd-abort`                              | Stop a run, preserve docs + branches for inspection.                                                                                                               |

---

## Part 8 — Build sequence (de-risked: hardest assumption first)

**v0 — Standalone Tester (`/bgsd-verify`).**
Prove the single hardest thing in isolation: an agent that boots a running app and verifies it via computer-use/vision against GSD acceptance criteria, returning a reliable structured defect list. Build the verification-driver abstraction (Playwright/Chrome + computer-use fallback) and runtime isolation here. _If this isn't reliable, nothing downstream matters — cheapest possible place to learn that._

**v1 — Fix-stream mode (`/bgsd-queue`) + Loop 1.**
Queue file → classify/route to GSD quick path → execute → Tester → Ralph stop-hook → next item, autonomously. Wire the **Hyperpolymath capture → cron → queue** drop. This is your daily driver and the lowest-risk autonomy; it exercises one worktree + one loop end-to-end.

**v2 — Project orchestrator (`/bgsd-run`) + parallelism + Loop 1 across worktrees.**
Conductor: decomposition, dependency graph, headless process spawning, control-file protocol, heartbeat/restart, conflict pre-check + merge-resolver, `rehearsal/<run-id>`, doc aggregation, branch cleanup. **With a Conductor→user checkpoint at merge boundaries** (don't promise fire-and-forget yet).

**v3 — Loop 2 (integration) + User Review Gate + feedback mode.**
INTEGRATION VERIFICATION & FIXING, `/bgsd-user-eval`, `/bgsd-feedback [--fast]`, per-agent CHANGELOG into the PR. As trust accrues, relax the v2 checkpoints toward true walk-away.

---

## Part 9 — Open technical risks & decisions to make

1. **Tester reliability is the whole ballgame.** Flaky selectors, auth/seed state, and "knowing what correct looks like." Mitigation: lean hard on GSD's acceptance criteria + `UI-SPEC.md` as the oracle; prefer DOM-aware Playwright/Chrome over pixel vision where possible; treat computer-use vision as the fallback for native/visual-only checks.
2. **Runtime isolation for parallel testers.** Need a clean per-worktree port + ephemeral DB/seed scheme (`.env.bgsd` with port offsets, disposable SQLite or branch DB). Decide the convention early — it's load-bearing.
3. **Cost & latency.** N full pipelines + computer-use boots is token-heavy and slow. Design for **throughput** (background queue) over latency (you waiting). Add per-run budget caps and `max_iterations` on both loops.
4. **Headless block/resume ergonomics.** Confirm the cleanest `claude -p` resume mechanism for the "Conductor answers, agent continues" path (context-append re-launch vs. session resume). Spike this in v2.
5. **Conductor conflict resolution quality.** Auto-resolving cross-worktree merge conflicts is genuinely hard; keep a human-escalation path for conflicts the merge-resolver isn't confident about.
6. **Decompose quality.** Bad decomposition → bad parallelism (false independence → conflicts). The Conductor's dependency graph needs a verification pass (reuse GSD's plan-checker pattern) before spawning.

---

## Part 10 — Repo layout (the plugin itself)

```
better-gsd/
├── .claude-plugin/
│   ├── plugin.json              # declares dependency on gsd
│   └── marketplace.json
├── commands/
│   ├── bgsd-run.md  bgsd-queue.md  bgsd-status.md  bgsd-user-eval.md
│   ├── bgsd-feedback.md  bgsd-verify.md  bgsd-clean-branches.md  bgsd-abort.md
├── agents/
│   ├── conductor.md             # supervisor: decompose, dispatch, answer, merge
│   ├── merge-resolver.md        # cross-worktree conflict resolution
│   ├── pipeline-agent.md        # wrapper that runs full GSD in a worktree
│   ├── tester.md                # Loop 1 computer-use/vision UAT
│   └── integration-tester.md    # Loop 2 whole-app UAT + scrutiny
├── hooks/
│   ├── verify-loop-stop-hook.sh # Ralph: re-inject until Tester passes
│   ├── atomic-commit.sh         # commit planning + execution artifacts
│   └── guard-main.sh            # HARD RULE: block any automated write to main
├── scripts/
│   ├── conductor.py             # process orchestrator + control-file loop
│   ├── classify-fix.py          # queue item → GSD route
│   ├── runtime-isolate.sh       # per-worktree port + DB/seed
│   └── doc-aggregate.py         # worktree .planning/ → .bgsd/runs/<id>/
└── README.md                    # open-source; self-update note for upstream GSD
```

---

## Part 11 — Model + effort routing policy

**What GSD already gives us (inherit, don't fight):** GSD configures models in `.planning/config.json` via **model profiles** across six phase slots — planning, discuss, research, execution, verification, completion. Its **balanced** default assigns **Opus to the planner only** (architectural decisions + goal decomposition) and **Sonnet** to execution/research/verification, with per-agent overrides allowed. So inside each Pipeline Agent, GSD routes its own subagents — `better-gsd` just _sets the profile_ and lets GSD do its thing. (Current lineup: **Opus 4.8** = most capable, **Sonnet 4.6** = balanced workhorse, **Haiku 4.5** = ~15× cheaper than Opus.)

**Two knobs, not one — the Conductor sets `model` _and_ `effort` per dispatch.** Reasoning effort (low → medium → high → xhigh → max) is the second dial — exactly what you do by hand when you crank a subagent to max for a gnarly task and down to low for boilerplate. The Conductor sets both for _every_ thing it spawns (executors, Testers, fix agents, doc writers), **and it has its own** `model`+`effort` as a Claude Code agent. Effort is set **dynamically** from task signals; both knobs escalate on failure.

**Our framing — two stakes axes plus a zeroth rule:**

- **Stakes**: does an error here cascade across the whole run? → more model + more effort.
- **Frequency**: how often does it run × the parallel fan-out multiplier? → cheaper model, lower effort.
- **Rule zero — if it's deterministic, use no model at all.** Polling, heartbeats, port assignment, git dry-run merges, running test commands, _capturing_ console/network logs — all script. The biggest cost win is not paying a model to babysit.

**The routing map (defaults):**

| Component / task                                                          | Model                                | Effort                      | Why                                                           |
| ------------------------------------------------------------------------- | ------------------------------------ | --------------------------- | ------------------------------------------------------------- |
| Conductor control loop (poll, heartbeat, ports, git dry-run merge, spawn) | **script**                           | —                           | Pure plumbing.                                                |
| Conductor — **its own supervisor persona**                                | **Sonnet** (→Opus for the two below) | medium                      | It's a CC agent; needs a baseline model+effort.               |
| Conductor — decompose prompt → dependency graph                           | **Opus**                             | **xhigh**                   | Highest leverage; bad decomposition poisons all parallelism.  |
| Conductor — merge-conflict resolution                                     | **Opus**                             | high                        | Hard reasoning, high blast radius.                            |
| Conductor — blocker triage + queue classify                               | **Haiku**                            | low                         | High-frequency, low-stakes judgment.                          |
| Conductor — answer an answerable blocker                                  | **Sonnet**                           | medium                      | Context reasoning, not architecture.                          |
| Pipeline Agent (full GSD)                                                 | **GSD `balanced` profile**           | **auto (per-plan)**         | Conductor passes an effort hint from plan complexity.         |
| Tester — capture console/network/DOM, run test cmds                       | **script**                           | —                           | Deterministic — _catches the `<script>`-in-JSX class of bug._ |
| Tester — interpret output / vision "does it look right"                   | **Sonnet**                           | medium (→high if ambiguous) | Vision + judgment, mid-stakes.                                |
| Tester — defect classification & summary                                  | **Haiku**                            | low                         | Cheap summarization.                                          |
| Integration Tester (whole-app UAT + scrutiny + improvements)              | **Opus**                             | **xhigh**                   | Cross-feature reasoning; final gate before _you_ see it.      |
| Fix agents (Loop 1 & Loop 2)                                              | **Sonnet**                           | medium                      | Most fixes are mid-complexity.                                |
| `--fast` fixes (no loop)                                                  | **Haiku / Sonnet**                   | low                         | Trivial, user-described.                                      |
| Doc aggregation / CHANGELOG generation                                    | **Haiku**                            | low                         | Summarization.                                                |

**Dynamic effort — how the Conductor picks the band.** Before each dispatch it computes a cheap difficulty score from signals it already has: plan size (files/LOC touched), number of dependencies, research-heaviness/novelty, and **prior failure count** for that item. Score → effort band (trivial→low … gnarly→max). No model call needed to decide; it's a scored heuristic, and the Tester's pass/fail feeds back into the score.

**Escalation ladder — climb the cheap knob first.** On failure the order is **effort, then model**: retry the _same_ item one effort band higher on the same model (cheap increment); if it still fails after `escalate_after_iters`, escalate the model (at high effort). Items that pass first try stay put. So spend is _adaptive to demonstrated difficulty_, not a flat tier — and we exhaust thinking before we pay for a bigger model.

**Budget & ceilings.**

- Per-run **token/$ cap** in config. Under pressure the Conductor **downshifts only non-critical layers** — first by dropping _effort_ a band on Tester-interpret + fix agents, then model — and **never** downshifts decompose / merge-resolve / the integration verdict.
- `CLAUDE_CODE_SUBAGENT_MODEL` exposed as a **hard global ceiling** for "cheap mode" runs.
- The multiplier to watch is **parallelism × GSD fan-out** (e.g. 5 worktrees × ~7×). Affordability = **Opus + high effort confined to the ~4 high-stakes judgment points** (decompose, merge-resolve, integration verdict, escalated fixes), everything deterministic pushed to scripts, and effort dialed to difficulty everywhere else.

**Config shape** (`better-gsd` `config.json` → `models` block; every leaf is a `{model, effort}` pair):

```json
{
  "models": {
    "conductor": {
      "self": { "model": "sonnet", "effort": "medium" },
      "decompose": { "model": "opus", "effort": "xhigh" },
      "merge_resolve": { "model": "opus", "effort": "high" },
      "blocker_triage": { "model": "haiku", "effort": "low" },
      "blocker_answer": { "model": "sonnet", "effort": "medium" }
    },
    "pipeline_gsd_profile": "balanced",
    "pipeline_effort": "auto",
    "tester": {
      "interpret": { "model": "sonnet", "effort": "medium" },
      "classify": { "model": "haiku", "effort": "low" }
    },
    "integration_tester": { "model": "opus", "effort": "xhigh" },
    "fix_agent": {
      "default": { "model": "sonnet", "effort": "medium" },
      "escalate": { "model": "opus", "effort": "high" },
      "escalate_after_iters": 2
    },
    "fast_fix": { "model": "haiku", "effort": "low" },
    "docs": { "model": "haiku", "effort": "low" }
  },
  "escalation": { "order": ["effort", "model"] },
  "budget": { "per_run_usd_cap": 25, "downshift_on_pressure": true }
}
```

**Two-level routing — the Conductor reaches _inside_ GSD.** This is the high-leverage part. Because each worktree _is_ a GSD run, and GSD reads its per-role model assignments from that worktree's `.planning/config.json` (`model_overrides` across planner / executor / researcher / verifier + the six phase slots), the Conductor doesn't stop at "this worktree = Sonnet." It writes a **per-worktree GSD config**, tuning each GSD role independently:

- **Executor** — where code is actually written — is the role the Conductor **promotes** when a worktree is high-value or complex (→ Opus, high/xhigh effort). This is the cell that deserves the spend.
- **Researcher / verifier / completion(docs)** — lower-leverage, repetitive — are **demoted** to Haiku + low effort. They summarize and check; they don't need deep reasoning. _This is where "don't waste tokens" actually bites — every verifier and documentor in the whole run can be cheap._
- Because GSD runs **phase-by-phase**, the Conductor can **rewrite the config between phases**: cheap during discuss/research, promote the executor right before `/gsd-execute-phase` for the one hard phase, then drop back down for verification and docs.

So routing is a **matrix, not a dial**: _(outer)_ which worktree × _(inner)_ which GSD role × _(when)_ which phase — each cell getting the cheapest model+effort that clears its bar. The executor of the single hard worktree might be Opus/xhigh while every verifier and documentor across the entire run stays Haiku/low. Example config the Conductor writes into a **high-value** worktree:

```json
{
  "model_overrides": {
    "planning": { "model": "opus", "effort": "medium" },
    "execution": { "model": "opus", "effort": "high" },
    "research": { "model": "haiku", "effort": "low" },
    "verification": { "model": "haiku", "effort": "low" },
    "completion": { "model": "haiku", "effort": "low" }
  }
}
```

…and for a **routine** worktree, `execution` drops to Sonnet/medium. The Conductor derives every cell from the same difficulty score — per worktree, per role, per phase.

Net: Opus + high effort for the few decisions that cascade, Sonnet at difficulty-tuned effort for the bulk of code + vision, Haiku + low effort for everything that classifies/checks/summarizes, **scripts for everything deterministic** — applied as a per-worktree × per-role × per-phase matrix, with a two-knob escalation ladder so _thinking_ is spent before _money_, and both only where difficulty earns it.

## Part 12 — Upgrade-resilient architecture (surviving GSD updates)

**Goal:** GSD ships fast (138 contributors, ~57 releases in four months). You must be able to pull a new GSD whenever you like and have bgsd keep working. The design makes that a non-event.

**Principle — an Anti-Corruption Layer (ACL).** bgsd treats GSD as a third-party dependency with a _public contract_, and routes **every** assumption about GSD through one thin adapter. bgsd code never reaches into GSD internals.

The contract = three stable seams (these change far slower than GSD's guts):

1. **Command seam** — bgsd invokes GSD only via its public slash commands (`/gsd-*`) and CLI (`gsd-tools.cjs`). Commands are GSD's most stable surface.
2. **Filesystem seam** — bgsd reads GSD outputs from the documented `.planning/` layout (PROJECT/REQUIREMENTS/ROADMAP/STATE + phase artifacts).
3. **Config seam** — bgsd influences GSD by _writing_ `config.json` (model profiles, `model_overrides`), never by patching GSD behavior.

**The adapter (`gsd-adapter/`)** encapsulates all three: command names, file paths, config schema. If GSD renames `/gsd-execute-phase`, moves a file, or reshapes config, **you fix one module**, and everything else (Conductor, Testers, doc aggregation) keeps calling the adapter unchanged.

**Distribution — two ways, both upgrade-safe:**

- **Option A — sidecar (recommended).** bgsd is its own repo/plugin; GSD is installed separately via `npx get-shit-done-cc@latest`. **Zero merge surface** — GSD updates on its own, bgsd updates on its own. Simplest possible upgrade story.
- **Option B — fork that merges upstream (what you asked for).** Vendor GSD as a **git subtree** under `vendor/gsd/`; all bgsd code lives in additive dirs (`bgsd/…`) GSD never touches. Pulling upstream is `git subtree pull --prefix vendor/gsd …` — it only touches GSD's tree, so conflicts are near-zero. The single overlap point (the plugin manifest listing commands) is handled by a **build step that concatenates GSD's + bgsd's manifests at install time**, so source files never collide.

**Contract tests + `bgsd doctor`.** A small suite asserts the seams after any GSD change: do the `/gsd-*` commands bgsd depends on still exist? Does `.planning/` still have the expected files/shape? Does `config.json` still accept our `model_overrides` keys? bgsd pins a **`gsd_contract_version`** (the GSD version range it's verified against) and ships a compatibility note.

**Self-updating, made safe (your original cron idea).** A cron job: `git subtree pull` (or `npx …@latest`) → run contract tests → **accept the update only if green; auto-rollback + notify if red.** So the fork stays evergreen without ever silently breaking bgsd. This is the "auto-update my own fork on top of GSD" idea from your first capture — with a safety interlock.

---

## Part 13 — Token-efficiency doctrine (intelligence where it converts, nowhere else)

Model+effort routing (Part 11) is one lever. These are the rest. Principle: **spend tokens only where they convert into correctness; starve everything else.**

1. **Scripts over models (rule zero).** Polling, heartbeats, ports, git dry-run merges, running tests, _capturing_ logs — deterministic, never a model.
2. **The Conductor is a script loop, so its context never balloons.** It doesn't hold the whole run in one window; it reads/writes small control + ledger files. No fat supervisor context accumulating tokens.
3. **Fresh-context discipline (inherited from GSD).** GSD already keeps the main session at 30–40% by spawning fresh subagents; bgsd preserves that — no degraded long sessions, no re-paying for bloated context.
4. **Minimal context handoff — pass pointers, not blobs.** Each headless agent gets only its slice (its plan + the _relevant excerpt_ of requirements). Control files carry file paths, not pasted content.
5. **Capture-then-summarize.** Raw console/network/DOM/logs land in files via script; only the **failing slice** (the 12 error lines, not 10k) is handed to a model to interpret.
6. **Structured outputs, not prose.** Testers emit JSON reports; the Conductor reads fields. Cheaper to produce, trivial to parse, no essay tax.
7. **Prompt caching across the fan-out.** Stable system prompts + requirements/spec docs are cached across the many subagent calls in a run — a large saving precisely because the fan-out is wide.
8. **Verification-driver ladder.** Console → network → DOM (cheap/free) run before vision (expensive). Most bugs — including your `<script>`-in-JSX — die before a single vision call.
9. **Don't re-verify the unchanged.** Loop 2 scopes integration testing to the merged diff + feature-interaction surface, not the whole app on every iteration.
10. **Shared research cache.** The run ledger lets worktrees reuse prior research/decisions (and GSD's "learnings") instead of N agents independently re-researching the same stack question.
11. **Effort before money (escalation ladder).** Exhaust thinking on the current model before paying for a bigger one; dial effort to a scored difficulty, not a flat max.
12. **Live budget telemetry.** `/bgsd-status` shows running token/$; a per-run cap triggers graceful downshift of non-critical layers (effort first, then model) — never the cascading-decision points.

The throughline: **Opus + high effort on the ~4 places errors cascade; Haiku/low or pure script on everything that classifies, checks, or summarizes; and never pay twice for context, logs, or research you already have.**

## Part 14 — User documentation & landing page

Two audiences, two artifacts: **docs** that make it usable, a **landing page** that makes it understandable in ten seconds. Both are **diagram-first** — the architecture is the product, so lead with the picture and let prose follow.

### Documentation (docs-as-code, in-repo)

Mirror GSD's own approach — it ships `USER-GUIDE` / `COMMANDS` / `CONFIGURATION` as Markdown rendered with **Mintlify** — so a bgsd reader feels at home and the toolchain is proven. Structure under `docs/`:

- **Installation** — prerequisites (Claude Code, Node, `jq`, Python, a GSD install) and the three install paths: **plugin marketplace** (`/plugin marketplace add <repo>` → `/plugin install bgsd@<owner>`), **sidecar** (`npx get-shit-done-cc@latest` for GSD + clone bgsd beside it), or the **git-subtree fork**. Each path ends with `bgsd doctor` to confirm the GSD contract is satisfied. Spell out the org `availableModels` allowlist requirement (Opus/Sonnet/Haiku) for the routing policy.
- **Quickstart** — install, run your first `/bgsd-run`, watch it self-verify, review + merge. ≤5 minutes, anchored by the _4-command flow_ diagram.
- **Usage / everyday workflow** — the real loop: feed the fix-queue, kick a project run, read `/bgsd-status`, run `/bgsd-user-eval`, give `/bgsd-feedback`, then merge yourself. Includes the `--fast` path and how to wire the Hyperpolymath-capture → queue cron.
- **Mental model** — the two-loop architecture diagram (reused from this plan) + a short paragraph each on Conductor, Pipeline Agent, Tester, the two loops, the rehearsal branch, and the never-touch-`main` rule.
- **The two modes** — Project (`/bgsd-run`) vs Fix-stream (`/bgsd-queue`), each with a worked example and a flow diagram.
- **Command reference** — every `/bgsd-*` with flags (`--fast`, etc.), in GSD's `COMMANDS.md` style.
- **Configuration** — the `models` block (model + effort + the per-worktree × role × phase matrix), budget caps, escalation order; copy-paste examples.
- **Branch & safety model** — the branch diagram (`main` / `rehearsal/<id>` / worktrees), atomic-commit convention, cleanup, and the hard rule.
- **Troubleshooting & FAQ** — blocked agents, budget hit, a failed contract test after a GSD update, how to read `.bgsd/runs/<id>/`.

**Diagrams:** author the four core ones as **Mermaid/SVG checked into the repo** (versioned alongside docs) — two-loop architecture, quickstart 4-command flow, branch model, routing matrix. Each sparse; detail in the prose beneath.

**Cadence:** write the matching page **with each version** (v0 → Quickstart + verify; v1 → Fix-stream; v2 → Project/Conductor; v3 → feedback/eval) so docs never lag the code.

### Landing page (minimal, one screen)

A single static page; one job — a developer gets the pitch and the install command without scrolling far.

- **Hero** — one line: _"GSD that tests its own work — and doesn't stop until it's right."_ + a subline, the install command (copy button), and GitHub/Docs buttons.
- **The one visual** — the two-loop diagram. It _is_ the product; nothing competes with it.
- **Three value props** — runs full GSD in parallel · verifies with real computer-use (catches what you'd otherwise only catch by hand) · never touches `main`.
- **A ~20s loop clip/GIF** — `/bgsd-run` → agents work → Tester catches a bug → auto-fix → green. Show, don't tell.
- **Footer** — open-source (MIT), link to the fork, "built on GSD."

**Stack:** a single HTML/Tailwind page (or a tiny Astro/Next site), no backend, flat and fast, **deployed on Vercel**. Build it at the v1 public-release milestone (docs come earlier, alongside each version).

---

## Part 15 — Open-source & community contribution readiness

bgsd is public from the start, so the repo is built to _receive_ contributions, not just publish code.

**License & attribution.** MIT. Confirm GSD's license is MIT-compatible and credit it prominently ("built on GSD") in the README, landing page, and `NOTICE`. The git-subtree vendor keeps GSD's own license intact in `vendor/gsd/`.

**Community health files (GitHub standard set).**

- `README.md` — what/why, the two-loop diagram, install, quickstart, links.
- `CONTRIBUTING.md` — dev setup, how to run the contract tests + `bgsd doctor`, coding conventions, the commit/PR style, and **the golden rule: extend through the adapter and additive dirs, never edit `vendor/gsd/`.**
- `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md` (responsible disclosure — relevant, since bgsd runs autonomous agents + computer-use), `SUPPORT.md`.
- Issue + PR templates, `CODEOWNERS`, and a `good-first-issue` / `help-wanted` label set.

**Make the extension points the contribution surface.** The architecture is already modular; document each seam as a place to contribute:

- **Verification drivers** (new Tester backends — Playwright, Chrome MCP, native computer-use, mobile).
- **`/loop` presets** (new Ralph presets, à la claude-loop's preset system).
- **Fix classifiers / GSD routes** (`classify-fix.py` rules).
- **Model+effort policies** (alternate routing profiles).
- **The GSD adapter** (keeping bgsd compatible across GSD versions — the most valuable community contribution).

Ship an `ARCHITECTURE.md` (this plan, distilled) so contributors grok the Conductor / adapter / two-loop structure before touching code.

**CI / quality gates (GitHub Actions).** On every PR: lint + format, the **contract-test suite against a matrix of GSD versions**, and `bgsd doctor`. Green required to merge. This is also what guards the self-updating cron (Part 12) — same tests, two triggers.

**Releases & distribution.** Semantic versioning, a maintained `CHANGELOG.md`, GitHub Releases, and a `marketplace.json` so anyone can `/plugin marketplace add` + `/plugin install`. Pin and publish the `gsd_contract_version` range per release.

**Governance.** Start solo-maintainer with clear triage labels; document the path to adding maintainers. Note the division of labor for contributors: **GSD upstream owns the dev pipeline; the community owns the bgsd orchestration/verification/routing layer on top.**

## Part 16 — Identity: "Kiwi" the conductor

- **The Conductor is named Kiwi, everywhere.** In the terminal, the docs, the status line, and every user-facing string the orchestrator is **Kiwi** ("Kiwi is decomposing your prompt…", "Kiwi merged 3 worktrees", "Kiwi needs your input on one thing"). It's the single agent you talk to, so it gets a name and a face.
- **Mascot — a kiwi bird, two renderings:**
  - **Terminal sprite** — a chunky pixel-block kiwi in **terracotta/brown ANSI (256-color)**, printed Claude Code-style with an info column to its right (name · model+effort · cwd · status). A mini 3-row variant heads `/bgsd-status`. _(Built by hand as block glyphs — `kiwi-launch.sh` prints it colored; `kiwi-banner.txt` is the reference.)_
  - **Vector logo** — the flat SVG kiwi for the README, docs, and landing page (`assets/kiwi.svg`).
- **Wordmark** — "KIWI" via **oh-my-logo** (`npx oh-my-logo "KIWI" sunset --filled`), the same filled-gradient tool built to mirror Claude Code's banner; shown on `--big` launch and atop the docs/landing hero.
- **The status line is always honest** — the sprite's status row shows live truth: worktree count, current loop/phase, budget state, and a constant **🔒 main-protected** indicator (a visual reminder of the hard rule).

---

_Foundations: GSD `.planning/` model (PROJECT/REQUIREMENTS/ROADMAP/STATE + phase artifacts), its waves/UI-SPEC/acceptance-criteria, its `config.json` model profiles (6 phase slots, balanced = Opus-planner/Sonnet-rest) + per-agent `model_overrides`, and its Mintlify docs convention; the Ralph Wiggum stop-hook loop (ghuntley; Anthropic `ralph-wiggum` plugin); Conductor's worktree-isolation model; Claude Code subagent/headless orchestration (nesting to depth 5 since v2.1.172, but process isolation chosen for runtime separation), `model:`/effort frontmatter and `CLAUDE_CODE_SUBAGENT_MODEL` ceiling; ACL/adapter + git-subtree vendoring for upgrade resilience; oh-my-logo for the terminal wordmark._
