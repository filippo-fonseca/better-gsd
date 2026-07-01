# Architecture

This document is a readable overview of how **bgsd** works end to end: the
pipeline, the repo layout, the pure-plus-seam-plus-test pattern, and how model
selection and per-agent context management fit in. For depth on any single
stage, follow the links into [`bgsd/docs`](./bgsd/docs).

---

## The one-sentence version

You send one prompt to the Conductor (codename **Kiwi**). Kiwi sizes the job,
fans out parallel worktree agents that each run a tailored GSD flow, verifies
every change for real, merges verified work onto a safe `next` branch,
integration-tests the whole thing, and hands you a review gate. You do the final
`next` to `main` merge by hand. No agent ever writes to the production branch.

---

## The pipeline, end to end

```
                 /bgsd-sesh "..."
                        |
                        v
              +-------------------+
              |   Conductor (Kiwi)|   sizes the job (quick / feature / project),
              |  classify + plan  |   builds the execution plan
              +-------------------+
                        |
                        v
        +--------------------------------+
        |  Decompose into units (DAG)    |   project-scale: a verified graph of GSD units
        +--------------------------------+
                        |
                        v
   ============ Loop 1 (parallel, one lane per unit) ============
   |                                                            |
   |   git worktree per unit (with .env* copied in)            |
   |            |                                              |
   |            v                                              |
   |   run a tailored GSD flow for the unit                    |
   |            |                                              |
   |            v                                              |
   |   verify for real:                                        |
   |     - Playwright Tester drives the app                    |
   |     - goal-backward code verifier vs. criteria            |
   |            |                                              |
   |            v                                              |
   |   defects? --> re-route to GSD for a fix --> re-verify    |
   |   (bounded loop, escalating model effort each pass)       |
   ============================================================
                        |
                        v
        +--------------------------------+
        | conflict pre-check + merge     |   verified branches merge into `next`
        | into the standing `next` branch|   in dependency order; Kiwi resolves conflicts
        +--------------------------------+
                        |
                        v
   ============ Loop 2 (integration on `next`) ================
   |  boot the whole assembled app on `next`, verify e2e,     |
   |  dispatch parallel fix agents on defects, re-merge,      |
   |  re-verify until clean                                   |
   ============================================================
                        |
                        v
        +--------------------------------+
        |   User Review Gate             |   Kiwi boots `next`, hands you a localhost URL
        |   (never auto-passes)          |   and a per-agent changelog; waits for approval
        +--------------------------------+
                        |
                        v
        +--------------------------------+
        |   CHANGELOG + PR into `next`    |   aggregates per-agent changelogs, assembles a PR body
        +--------------------------------+
                        |
                        v
              you merge next -> main       (manual, human-only; Kiwi gives you the exact command)
```

Feedback from the review gate (`/bgsd-feedback "..."`) turns your findings into a
new fix pass and loops back through verification.

For the authoritative flowchart and per-stage detail, see
[`docs/conductor-session.mdx`](./bgsd/docs/conductor-session.mdx),
[`docs/bgsd-run.mdx`](./bgsd/docs/bgsd-run.mdx), and
[`docs/bgsd-loop2-review.mdx`](./bgsd/docs/bgsd-loop2-review.mdx).

---

## Auto-scale

bgsd always runs the same pipeline; scale only decides how deep and wide it
goes.

| Scale | Trigger (auto) | What runs |
|-------|----------------|-----------|
| **quick** | one small change (roughly one unit, one surface) | one agent, no discussion, direct execution, still fully verified (Loop 1 never skipped) |
| **feature** | a few units, mid-size | a few agents, some parallelism, integration loop if more than one unit |
| **project** | broad prompt (many units or several surfaces) | full fan-out: decompose, parallel worktrees, Loop 1 per worktree, merge into `next`, Loop 2, review; discusses with you first |

A manual scale flag (`--quick` / `--feature` / `--project`) bypasses the
thresholds unconditionally. The `--no-usage-verification` knob is orthogonal:
it keeps the code verifier but skips Playwright UI testing.

---

## Repo layout

```
better-gsd/
  README.md                       front page
  CONTRIBUTING.md                 dev + branch/release model
  CODE_OF_CONDUCT.md
  SECURITY.md
  ARCHITECTURE.md                 this file
  LICENSE                         MIT
  .claude-plugin/
    marketplace.json              root marketplace (points at ./bgsd)
  installer/
    install.mjs                   thin npm launcher (npx better-gsd@latest)
    package.json
    README.md
  bgsd/                           the plugin itself
    .claude-plugin/
      plugin.json                 plugin manifest (name, version, Playwright MCP)
      marketplace.json            in-repo marketplace entry
    commands/                     /bgsd-* slash commands (Markdown runbooks)
      bgsd-sesh.md                the one front door
      bgsd-init.md  bgsd-queue.md  bgsd-verify.md  bgsd-resume.md
      bgsd-gui.md   bgsd-status.md bgsd-user-eval.md bgsd-integrate.md
      bgsd-feedback.md bgsd-changelog.md bgsd-run.md bgsd-escalate.md
      bgsd-capture.md
    agents/
      tester.md                   Playwright Tester persona + driver-ladder runbook
    scripts/                      the engine (pure *.mjs + *-live.mjs seams + test-*.mjs)
    docs/                         *.mdx doc pages
    fixtures/                     canary Next.js fixture (PASS on /, FAIL on /buggy)
    schemas/                      verification-report JSON Schema
    site/                         landing page
    PERSONALITY.md                Kiwi voice contract
    README.md                     plugin-level readme
```

The version is duplicated across three manifests (`bgsd/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `bgsd/.claude-plugin/marketplace.json`); a
release bumps all three. Runtime output (gitignored) lands under `.bgsd/runs/`.

---

## The pure-plus-seam-plus-test pattern

The engine is deliberately built so that all logic is testable without touching a
real repo, network, or browser.

- **Pure core (`scripts/*.mjs`).** Each module is a set of pure,
  dependency-injected functions. Side effects (git, filesystem, process
  spawning) are passed in, not imported and called directly. The routing table,
  the state machine, the status renderer, and the difficulty scorer are all pure.
- **Live seam (`scripts/*-live.mjs`).** For each pure module that needs the real
  world, a `-live.mjs` companion wires the real implementations in. For example,
  `loop1.mjs` is the pure Loop 1 controller and `loop1-live.mjs` is its live
  runner; `run.mjs` is the pure Conductor state machine and `run-live.mjs` its
  live runner.
- **Guards.** The live seams protect dangerous operations: `requireLiveFlag` (a
  `--live` flag must be present for multi-process orchestration and live
  captures) and `requireNotProductionBranch` (nothing may write the production
  branch). Guards throw detailed refusals rather than acting silently.
- **Tests (`scripts/test-*.mjs`).** Home-grown, dependency-free suites using
  `node:assert/strict` and a small local `test()` runner. Each prints
  `N passed, M failed` and exits non-zero on any failure. There are **40** of
  them today; all must exit 0. Run them with:

  ```sh
  for t in bgsd/scripts/test-*.mjs; do node "$t"; done
  ```

The overarching rule is **no silent green**: verification emits
`INSUFFICIENT_EVIDENCE`, `BLOCKED`, or `FAIL` rather than ever fabricating a
`PASS`.

---

## How verification works

Loop 1 and Loop 2 both verify with a four-rung driver ladder, cheapest and most
reliable first. Most defects die at rung 1.

| Rung | Tool | Catches |
|------|------|---------|
| 1 Console | `browser_console_messages` | React warnings, hydration errors, JS exceptions |
| 2 Network | `browser_network_requests` | 4xx/5xx responses, failed resource loads |
| 3 DOM | `browser_snapshot` | missing elements, wrong structure, unmet criteria |
| 4 Vision | `browser_take_screenshot` | purely visual criteria (fallback only) |

The Tester agent (`bgsd/agents/tester.md`) drives the running app; a
goal-backward code verifier separately checks the change against its acceptance
criteria. See [`docs/bgsd-verify.mdx`](./bgsd/docs/bgsd-verify.mdx) for the
report schema and criteria formats.

---

## Model and effort selection

Each unit is scored with a cheap, deterministic **difficulty heuristic** (no
model call). Two selectors use that score.

**Quick-scale route class** (`scripts/route-item.mjs`): a single item maps to a
GSD surface and a coarse posture.

| Route class | GSD surface | Model posture | Effort |
|-------------|-------------|---------------|--------|
| trivial-fix | `/gsd-fast` | fast | low |
| scoped-fix | `/gsd-quick` | balanced | medium |
| feature | `/gsd-plan-phase` then `/gsd-execute-phase` | quality | high |

**Per-unit posture for feature/project units** (`scripts/decompose.mjs`
`deriveModelPosture`): the `[0,1]` difficulty score falls into one of four bands,
each fixing the executor's model and effort, written to the worktree's
`config.json` as `bgsd_unit_posture`.

| Difficulty | Executor model / effort |
|------------|-------------------------|
| ≥ 0.70 | `opus` / `xhigh` |
| 0.40 – 0.70 | `opus` / `high` |
| 0.20 – 0.40 | `sonnet` / `high` |
| < 0.20 | `haiku` / `high` |

Within a unit, the **researcher** drops one band (floored at `haiku`/`high`) and
the **verifier** is fixed at `haiku`/`low`. Harder units ride a stronger model;
trivial units skip research and planning. Every band is overridable in `BGSD.md`
under `model_posture`.

---

## Per-agent context management

Each worker agent runs with a large (roughly 1M-token) context window, and the
Conductor watches each one's context pressure. When an agent crosses **0.70** of
its window, its context is compacted; when it crosses **0.90**, the agent is
relaunched from a handoff so work continues cleanly rather than degrading near
the limit. This monitor lives in the context module of the engine and keeps long
parallel runs stable.

---

## Bounded autonomy

Every loop is bounded (`max_iterations`), every Conductor run is bounded by a
budget cap, and every irreversible action (real merges, PRs, the `next` to
`main` step) is human-gated. Combined with the not-production-branch guard, this
is what makes it safe to let bgsd run a whole build on its own: it can do a lot,
but it cannot ship to production without you.
