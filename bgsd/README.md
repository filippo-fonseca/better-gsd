<p align="center">
  <img src="../assets/banner.svg" alt="bgsd — Git. Ship. Done. On steroids. One sesh: the Conductor scopes a prompt, fans out parallel git-worktree agents that each run a full GSD batch, verifies every change through real computer use, merges onto a safe next branch, and keeps main protected behind a human-only merge." width="100%">
</p>

# better-gsd (bgsd)

**Autonomous, self-verifying orchestration built on top of GSD — as an additive Claude Code plugin.**

A tiny plugin (markdown files and a handful of zero-dependency Node scripts) that fans out a full parallel, self-verifying GSD pipeline. Lightweight to install; ultra-potent in what it does.

You talk to the Conductor (default name **Kiwi**, customizable in `BGSD.md`). They handle everything else.

> "Very good, sir. I shall begin verification at once."
> — Kiwi, the bgsd Conductor

---

## The single entry point

```
/bgsd-sesh "<whatever I need>"   [--quick | --feature | --project] [--plan-only | --dry-run]
```

That's it. One command, one ongoing session, always-on Conductor.

You describe what you need (a bug fix, a feature, an entire project) and the Conductor auto-detects the scale, decides how many agents to spin up, and **runs the full pipeline immediately**. Pass `--plan-only` (or its alias `--dry-run`) to preview the plan without executing anything. The pipeline integrates everything on the standing **`next`** branch; the `next` → `main` merge is a manual, human-only step. The one hard invariant is that **agents never write to `main`** (the production branch).

You never call `/bgsd-verify`, `/bgsd-queue`, `/bgsd-run`, or any other stage command directly. Those are internal stages the Conductor runs for you.

### One-time setup: `/bgsd-init`

```
/bgsd-init
```

`/bgsd-init` sets a repo up for bgsd. It is idempotent (safe to run repeatedly) and runs automatically as a preflight on every `/bgsd-sesh`, so you rarely call it by hand. It:

- creates the standing **`next`** integration branch off the auto-detected base branch (and fast-forwards it from `main` if it already exists);
- scaffolds a persistent, committed **`.bgsd/`** master folder: `seshs/` (a queryable knowledge base of every past session), `ledger.md` (the append-only run ledger), and `config.json`;
- writes a **`BGSD.md`** settings file at the repo root (the user-editable knobs, like a CLAUDE.md for bgsd);
- makes the GSD config bgsd-compatible.

### The integration branch: `next`

bgsd keeps one standing integration branch, **`next`** (the name is configurable in `BGSD.md`). It is the rehearsal mirror of production. Worktree branches merge into `next`; Loop 2 verifies the integrated app on `next`; the User Review Gate boots `next`; and `next` → `main` is a manual, human-only merge. At the start of every session, `next` is created if missing and fast-forwarded from `main`.

---

## Auto-scale: the same pipeline, scaled

bgsd always runs the same pipeline. Scale determines how deep and wide it goes.

| Signal                                                           | What the Conductor does                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **quick** (one bug, a minor change; ≤2 units, 1 surface)         | One agent, no pre-discussion, direct execution — but still fully verified. Never skips the Loop 1 verify→fix cycle.                                                                              |
| **feature** (a few units, mid-size; a few units, mid-size scope) | A few agents, no pre-discussion, some parallelism, integration loop if >1 unit.                                                                                                                  |
| **project** (broad prompt, many units; ≥4 units or ≥3 surfaces)  | Full parallel pipeline: decompose → parallel git worktrees → Loop 1 per worktree → conflict pre-check + merge into `next` → Loop 2 integration on `next` → review. Pre-discusses with you first. |

The scale threshold is decided by the Conductor, not by you. You can always override with a flag.

**A manual flag always wins, unconditionally.** The auto-scale thresholds above apply only when no flag is given. `--feature` on a 2–3-unit task still runs the feature pipeline; `--project` on a tiny task still discusses with you first and runs the full pipeline.

---

## Flags

| Flag          | Behavior                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_      | Conductor auto-detects scale and **executes immediately**.                                                                                                 |
| `--quick`     | Quick mode. **No discussion, no pre-prepare.** Fast — but still verified. Never skips Loop 1. Executes immediately.                                        |
| `--feature`   | Feature mode. No pre-discussion, some parallelism, integration loop if >1 unit. Executes immediately.                                                      |
| `--project`   | Full pipeline mode. The Conductor **discusses with you first** (brainstorm, clarify, plan), then executes. Real merges/PRs are human-gated at checkpoints. |
| `--fable`     | Arm **Claude Fable 5** for the toughest pipeline agents (difficulty ≥ 0.4 / Opus-tier units). The Conductor asks permission per candidate before putting any agent on Fable; you can keep it on Opus (token-heavy) for any agent, or drop Fable entirely, any time. Never used silently. Persist with `models.fable: on` in `BGSD.md`; the per-agent permission gate still applies. Researchers, verifiers, and testers are never Fable candidates. |
| `--plan-only` | **Preview only.** Classify + print the depth plan; invoke zero boundaries. Nothing executes.                                                               |
| `--dry-run`   | Alias for `--plan-only`. Same preview behavior.                                                                                                            |

A manual flag always wins, unconditionally; the auto-scale thresholds apply only in auto mode.

---

## Settings: `BGSD.md`

`BGSD.md` is the user-editable settings file, written by `/bgsd-init` at the repo root. It works like a CLAUDE.md: you edit it, the Conductor reads it at the start of every sesh, and the Conductor can self-edit it when you ask it to change a setting in chat (for example, "use a branch called `staging` instead of `next`"). Every knob ships with a default, so an unedited `BGSD.md` is a complete, working config.

| Setting                  | What it controls                                                | Default                           |
| ------------------------ | --------------------------------------------------------------- | --------------------------------- |
| Integration branch name  | The standing integration branch worktrees merge into            | `next`                            |
| Model + effort posture   | Which models and effort bands the pipeline uses                 | balanced/auto-escalating          |
| Env-file propagation     | Which `.env*` files are copied into each worktree               | `.env`, `.env.local`              |
| GitHub issue/PR behavior | Whether to open atomic issues and PRs, and against which branch | atomic issues on; PRs into `next` |
| Conductor narration      | Verbosity and tone of the Conductor's live narration            | on, conversational                |

**Env propagation.** Git worktrees do not carry gitignored files, so apps that need `.env*` to boot would otherwise come up broken in a worktree. The Conductor copies the configured `.env*` files from the repo root into each worktree so every app boots with its real environment.

**Atomic GitHub issues.** Each work unit gets its own GitHub issue, and the PR that merges that unit into `next` closes it. The session itself has an epic issue that tracks the whole run. (This is being wired now.)

---

## Scale comparison

|                                    | quick                             | feature                  | project                              |
| ---------------------------------- | --------------------------------- | ------------------------ | ------------------------------------ |
| **Example**                        | "change this button to blue"      | "add a dark-mode toggle" | "build auth + billing + a dashboard" |
| **Auto-scale trigger**             | ≤2 units, 1 surface               | a few units, mid-size    | ≥4 units or ≥3 surfaces              |
| **Upfront discussion**             | no                                | no                       | yes (intake/brainstorm)              |
| **Decompose + parallel worktrees** | no — single                       | some, low concurrency    | full fan-out                         |
| **Integration loop (Loop 2)**      | no                                | yes if >1 unit           | yes                                  |
| **Formal review gate**             | no (Loop 1 PASS + 1-line confirm) | yes                      | yes                                  |
| **Verification (Loop 1)**          | always                            | always                   | always                               |

---

## What the Conductor actually runs

These are **internal stages** — you never call them directly. The Conductor orchestrates all of them on your behalf:

| Stage                                      | What it does                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Init / preflight**                       | Runs `/bgsd-init`: ensures `next` exists and is fast-forwarded from `main`, scaffolds `.bgsd/`, writes `BGSD.md`, copies configured `.env*` files into worktrees       |
| **Classify / route**                       | Determines scale (quick / feature / project) and builds the execution plan                                                                                             |
| **Decompose**                              | For project-scale: breaks the prompt into a verified DAG of GSD units                                                                                                  |
| **Worktree fan-out**                       | Spawns parallel git worktrees, one per unit, isolated from each other (with the configured `.env*` files copied in so apps boot)                                       |
| **Loop 1 — verify→fix per worktree**       | Runs each GSD unit, then verifies with real browser testing. On defects, re-routes to GSD for a fix. Loops up to the configured max, escalating model effort each time |
| **Conflict pre-check + merge into `next`** | Detects merge conflicts before they land; merges verified branches into the standing `next` integration branch in dependency order                                     |
| **Loop 2 — integration verify→fix**        | Boots the integrated app on `next` and verifies end-to-end. Dispatches parallel fix agents on defects, re-merges, re-verifies                                          |
| **User Review Gate**                       | Boots `next`, shows a per-criterion checklist, waits for your approval. Never auto-passes                                                                              |
| **Feedback ingestion**                     | Turns your review findings into a new fix pass. `--fast` mode runs parallel fix agents without re-verification (always flagged `UNVERIFIED`)                           |
| **CHANGELOG + PR**                         | Aggregates per-agent changelogs across all loops and assembles a PR body. Opens an atomic PR into `next`; the `next` → `main` merge stays human-only   |

Throughout the run, the Conductor leads every message with a name pill — `🥝 Kiwi:` by default (customizable in `BGSD.md`) — narrating the pipeline with the exact stage and agent names, X/Y progress counts ("4/4 agents finished, 2/4 verified and merged into `next`"), an explanation of each PR and merge, and the exact command to type at every human gate. The always-on live status view (`/bgsd-status` machinery) runs throughout and shows you what every agent is doing, where Loop 1 stands per worktree, merge history, budget, and context pressure.

Oh-my-logo gradient banners print at session start, between each stage, at finish, and on init — so you always know exactly where in the pipeline the Conductor is at a glance.

### Live dashboard (`/bgsd-gui`)

For a real-time bird's-eye view of the whole pipeline, pass `--gui` or run `/bgsd-gui` at any point. The Conductor opens a local web dashboard showing every agent live: the parallel Loop 1 Pipeline Agents, the Verification lane, the Loop 2 Integrator, and the Review Gate. Each card shows the agent's GSD substage, status, and progress. You can watch the entire run move through the pipeline — unparalleled visibility into what every agent is actually doing. The Conductor already keeps the terminal legible with per-message narration, so the GUI is not required; but when you are running many agents at once, the animated full-pipeline dashboard makes it even better.

---

## Core Value: the make-or-break test

The single most important thing bgsd does:

> An agent that boots a running app and verifies it against acceptance criteria, returning a **reliable, structured defect list** — including catching **console-level errors a screenshot alone would miss** (the make-or-break test).

This was proven at v0, in isolation, before any orchestration was built on top of it: `/bgsd-verify` against a Next.js canary returned `FAIL` on a `<div>`-in-`<p>` defect (a real React console error invisible to a screenshot) and `PASS` on the clean route, reproducibly across reruns.

The Conductor inherits this guarantee. Every path through the pipeline — whether a one-agent quick fix or a full parallel project run — still ends in a verified result. No silent green, ever.

---

## How verification works: the four-rung driver ladder

bgsd uses a four-rung driver ladder — cheapest and most reliable first:

| Rung          | Tool                       | What it catches                                   |
| ------------- | -------------------------- | ------------------------------------------------- |
| **1 Console** | `browser_console_messages` | React warnings, hydration errors, JS exceptions   |
| **2 Network** | `browser_network_requests` | 4xx/5xx responses, failed resource loads          |
| **3 DOM**     | `browser_snapshot`         | Missing elements, wrong structure, unmet criteria |
| **4 Vision**  | `browser_take_screenshot`  | Purely visual criteria (fallback only)            |

Vision is a last resort, not a crutch. Most bugs die at rung 1.

**No silent green.** If the Playwright MCP is absent, bgsd emits `BLOCKED` — not a fabricated `PASS`. If evidence is insufficient, the verdict is `INSUFFICIENT_EVIDENCE`. Every non-clean stop produces a structured terminal state.

---

## Talk to one thing: the sesh

Vanilla GSD, like most Claude Code frameworks, runs one linear flow at a time. That never matched how you actually want to drive Claude Code: one intent in, many things happening at once, all under one roof. So bgsd wraps GSD in a **sesh**.

Everything starts with a single command:

```
/bgsd-sesh "build new public-facing forum portion of app"
```

You pick how big the job is with a scope flag:

| Flag | Scope | Reach for it when |
| --- | --- | --- |
| `--quick` | a single change | a bug fix, a copy tweak, one endpoint |
| `--feature` | one feature | a settings page, an export button, Google sign-in |
| `--project` | a whole slice of product | a forum, billing, an onboarding flow |

From there you talk to one entity: the Conductor. It asks you a short set of scoping questions, breaks the work into units, and orchestrates everything else. One prompt in, one reviewable branch out.

## Session memory: recall + the backlog

bgsd sessions are not amnesiac, and everything here is **per-repo** (kept under the invoking repo's `.bgsd/`, so projects never bleed into each other).

**Recall — every sesh remembers the last one.** At the start of every `/bgsd-sesh`, before any work fans out, the Conductor glances back at this repo's history: the most recent session (from `.bgsd/ledger.md`) plus any past sessions relevant to your prompt (searched over `.bgsd/seshs/`). It opens with a one-line recall, and if you say *"based on the last sesh, let's fix such-and-such"* it carries that prior context forward instead of treating the request as new. For a deliberate, deep search of the whole history, there's the dedicated `/bgsd-recall`.

**The backlog — leave ideas for the next sesh.** While a session runs you keep thinking of what to do next. Bank each one with `/bgsd-queue "<idea>"` (or just tell Kiwi "queue that for next sesh"); they pile up in this repo's queue. When you're done, run a bare `/bgsd-sesh` and the Conductor shows the whole queued batch in a selector, so you multi-pick what to pull into the next session, or ignore it and type a fresh prompt. Deferred scope is never lost and never re-typed. (This queue at `.bgsd/queue` is bgsd's one canonical backlog — not any `.planning/` file.)

## Harness-agnostic: Claude Code or Codex, switch anytime

bgsd is **LLM/CLI agnostic**. A sesh runs identically whether you drive it from **Claude Code** or **Codex** (OpenAI's CLI), and you can switch between them mid-project — if one provider's usage runs out, work under the other for a few hours and switch back — with zero friction. All durable state lives in harness-independent `.bgsd/` files, so a sesh started under one picks up seamlessly under the other; you shouldn't have to notice anything.

Kiwi detects the harness at sesh start (`harness.active: "auto"` — `AGENT=codex` → Codex, else Claude Code; pin it in `BGSD.md` or via `BGSD_HARNESS`). bgsd's semantic model tiers (opus/sonnet/haiku/fable) resolve to the active harness's equivalents via `harness.models` (Claude: `claude-opus-4-8`, …; Codex: `gpt-5-codex`, `gpt-5`, `gpt-5-mini`), and every pipeline agent spawns on that harness's CLI — so switching actually moves the work, and the quota, to that provider. Each unit records which harness ran it; the state itself is shared.

## GSD on steroids: GSD runs inside every agent

Here is the part that makes it powerful. GSD does not run once over your whole request. It runs inside every parallel agent.

When you fire `--project "build new public-facing forum portion of app"`, the Conductor scopes it into units and spins up one git-worktree agent per unit, for example:

- `auth` for accounts, sessions, sign-in
- `posts api` for threads, replies, the data layer
- `feed ui` for the public feed and post views
- `moderation` for reports, flags, safe-content rules

Each of those agents runs its **own full GSD batch** in its **own isolated worktree**, at the same time. So instead of one linear GSD pass over the project, you get N complete GSD cycles running in parallel, one per slice.

The Conductor decides which GSD phases each unit gets: research phases on harder units, `/gsd-ui-phase` for UI-heavy units, `/gsd-ai-integration-phase` for AI integration units, a code-review gate on harder work. Trivial or quick units skip GSD phases entirely and apply a direct fix. This is per-unit tailoring, not a one-size-fits-all flow.

Think of vanilla GSD as one chef cooking a five-course meal start to finish. bgsd is the head chef (the Conductor) who takes the order, hands each course to its own station, has every station cook its full recipe at once, and tastes every plate before it leaves the kitchen.

## Verified for real, then a safe landing

Nothing is trusted on faith. Every agent's work is checked by a Playwright tester that drives the actual app: clicking, screenshotting, and reading the console, network, and DOM. Insufficient evidence returns `INSUFFICIENT_EVIDENCE`, never a silent green.

Only verified work converges onto a `next` branch. No agent ever writes to `main`. The `next` to `main` merge is yours, and yours alone.

---

## Build history

| Version       | Name                                                    | Status                  |
| ------------- | ------------------------------------------------------- | ----------------------- |
| **v0**        | Standalone Tester + verify engine                       | **PROVEN** (2026-06-29) |
| **v1**        | Fix-stream + Loop 1                                     | **BUILT** (2026-06-29)  |
| **v2**        | Conductor (Kiwi) + parallel orchestration + status view | **BUILT** (2026-06-29)  |
| **v3**        | Loop 2 + User Review Gate + feedback mode               | **BUILT** (2026-06-29)  |
| **v0.5.0**    | End-to-end pipeline runs; per-unit GSD tailoring; gradient banners | **LIVE** (2026-07-01) |
| **v2-intake** | Conductor intake/proxy extension (E1–E6)                | In progress             |
| v4            | Remote orchestration                                    | Planned                 |

As of v0.5.0, the full two-loop autonomous pipeline runs end-to-end. A plain `/bgsd-sesh` fires the entire pipeline with zero friction (no `--live` human-gate for the execution path itself; only the `main`/`master` branch guard remains). The deterministic core is unit-tested (19 suites green across v0+v1+v2+v3).

---

## Installation

bgsd is an installable, standalone Claude Code plugin. Add the marketplace and install it:

```bash
claude plugin marketplace add filippo-fonseca/better-gsd
claude plugin install bgsd@better-gsd
```

Then run `/reload-plugins` (or restart Claude Code) so the new commands bind.

That is the only install step you own. bgsd is **gsd-agnostic**: it does not vendor or bundle GSD. It uses the user-installed `gsd-core` plugin, and the Conductor keeps that dependency current for you. At the start of every `/bgsd-sesh`, the Conductor sets up what it needs so you do not have to:

- **gsd-core.** The Conductor ensures the `gsd-core` plugin is installed and up to date (under the hood: `claude plugin marketplace add open-gsd/gsd-core`, `claude plugin install gsd-core --scope user`, and `claude plugin update gsd-core` to refresh it). You never manage GSD by hand. After an update, Claude Code needs `/reload-plugins` or a restart to apply, and the Conductor tells you when that is the case.
- **Playwright.** The Conductor ensures the Playwright browser tooling (used for the computer-use / vision verification that powers Loop 1 and Loop 2) is available.

You just talk to the Conductor. It provisions gsd-core and Playwright at sesh start.

**Optional: run the canary proof**

The canary proof is a quick way to confirm the verify engine works end to end on your machine. It is optional; a normal `/bgsd-sesh` provisions everything it needs on its own.

```bash
/bgsd-verify --boot bgsd/fixtures/canary-next \
             --criteria bgsd/fixtures/canary-next/acceptance.md
```

Expected: `PASS  .bgsd/runs/.../verification-report.json`

Then verify the buggy route (the defect is a `<div>` nested inside `<p>`, invisible to a screenshot):

```bash
/bgsd-verify http://localhost:<port>/buggy \
             --criteria bgsd/fixtures/canary-next/acceptance.md
```

Expected: `FAIL  .bgsd/runs/.../verification-report.json`

Run the fixture in `development` mode: React's `validateDOMNesting` warning is stripped from production builds.

**Start a Conductor session**

```bash
/bgsd-sesh "your task here"              # auto-detect scale and execute (default)
/bgsd-sesh "your task here" --quick      # quick, no discussion, still verified
/bgsd-sesh "your task here" --feature    # feature mode, some parallelism
/bgsd-sesh "your task here" --project    # full pipeline, discuss first, then execute
/bgsd-sesh "your task here" --plan-only  # preview only — classify + plan, nothing runs
/bgsd-sesh "your task here" --dry-run    # alias for --plan-only
```

---

## Layout

```
bgsd/
  .claude-plugin/
    plugin.json          # bgsd plugin manifest (additive; zero edits to GSD's)
    marketplace.json     # local marketplace so bgsd can be loaded in-project
  agents/
    tester.md            # bgsd tester persona + driver-ladder runbook
  commands/
    bgsd-sesh.md         # /bgsd-sesh — the Conductor session entry point
    bgsd-init.md         # /bgsd-init — one-time, idempotent repo setup (also runs as sesh preflight)
    bgsd-verify.md       # /bgsd-verify — internal verify stage
    bgsd-queue.md        # /bgsd-queue — internal fix-stream stage
    bgsd-run.md          # /bgsd-run — internal Conductor orchestration stage
    bgsd-status.md       # /bgsd-status — live status view
    bgsd-capture.md      # /bgsd-capture — Hyperpolymath capture adapter
  docs/
    index.mdx            # table of contents (Conductor Session as entry point)
    conductor-session.mdx  # PRIMARY: /bgsd-sesh reference + pipeline flowchart
    quickstart.mdx       # install + /bgsd-init + canary proof walkthrough
    bgsd-verify.mdx      # internal stage reference
    bgsd-queue.mdx       # internal stage reference
    bgsd-run.mdx         # internal stage reference
    bgsd-status.mdx      # live view reference
    hyperpolymath-capture.mdx  # Hyperpolymath capture adapter
    INTEGRATION-NOTES.md # plugin loading + MCP reachability decisions
  fixtures/
    canary-next/         # minimal Next.js fixture (PASS on /, FAIL on /buggy)
  schemas/
    verification-report.schema.json  # JSON Schema draft-07 for the report
  scripts/
    queue.mjs            # queue library + CLI
    classify-item.mjs    # heuristic keyword classifier
    route-item.mjs       # ROUTING_TABLE + model posture writer
    loop1.mjs            # Loop 1 controller (pure, injectable)
    loop1-live.mjs       # live process-spawning implementations (--live required)
    run.mjs              # Conductor state machine + dry-run CLI
    run-live.mjs         # Conductor live runner (--live required)
    status.mjs           # pure status renderer + watch loop
    context.mjs          # context-pressure monitor + handoff + research cache
    capture.mjs          # capture adapter seam
    capture-cron.mjs     # cron entry point
    capture-live.mjs     # live source (--live required)
    ui.mjs               # terminal UX: Kiwi banner, color badges, stage renderer
    parse-criteria.mjs   # acceptance criteria parser
    build-report.mjs     # report assembler + verdict printer
    runtime-isolate.sh   # boot one app in isolation
  site/
    index.html           # landing page
  PERSONALITY.md         # Kiwi voice contract (butler vs structured output)
  README.md              # this file
```

Runtime output (gitignored) lands in `.bgsd/runs/<run-id>/`; scratch in `.bgsd-tmp/`.

---

## Hard Rules

These invariants are enforced in code, not just aspirationally documented:

| Invariant                        | Enforcement                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents never write to `main`** | `main` (the production/default branch) is never written, committed, or PR'd by an agent. All integration lands on the standing `next` branch; the `next` → `main` merge is a manual, human-only step. |
| **Additive only**                | bgsd lives under `bgsd/` (plus runtime `.bgsd*/` dirs). It never edits GSD's directories.                                                                                                             |
| **Never edit vendored GSD**      | `commands/`, `agents/`, `gsd-core/`, `skills/`, `hooks/`, root `README.md`, `LICENSE`, `docs/` — all read-only to bgsd.                                                                               |
| **Seams only**                   | bgsd reaches GSD only through (1) `/gsd-*` slash commands, (2) the `.planning/` file contract, and (3) `config.json`.                                                                                 |
| **No silent green (NFR-06)**     | Insufficient evidence → `INSUFFICIENT_EVIDENCE`. MCP absent → `BLOCKED`. Never a fabricated `PASS`.                                                                                                   |
| **Bounded autonomy (NFR-08)**    | Every loop is bounded by `max_iterations`; every Conductor run by `--budget-cap`; every wave requires a human go/no-go.                                                                               |
| **Live runs human-gated**        | `--live` flag required for multi-process orchestration and live captures. Guards check `process.argv` and throw a detailed refusal if absent.                                                         |

---

## Personality & UX

bgsd's agents — and the Conductor (default name **Kiwi**, customizable in `BGSD.md`) — speak in a refined **British-butler / JARVIS** voice: courteous, calm, conspicuously competent, and occasionally touched with confident modern slang. The Conductor addresses the user as "sir."

The butler persona flavors **human-facing narration only** — preambles, status summaries, progress banners. It never touches the structured outputs: verdict lines, `verification-report.json`, YAML frontmatter, and `BLOCKED`/`ERROR` signals stay strictly literal and machine-parseable.

A `FAIL` is always called a `FAIL`. The butler is unfailingly honest about failure.

See [`PERSONALITY.md`](./PERSONALITY.md) for the full voice contract and examples.

Terminal UX lives in [`scripts/ui.mjs`](./scripts/ui.mjs) — a dependency-free helper (Kiwi banner, color-coded state badges, stage renderer; `NO_COLOR`/non-TTY safe). Try it:

```bash
node bgsd/scripts/ui.mjs --demo
```

---

## Documentation

Full doc pages live in `bgsd/docs/`. See [`docs/index.mdx`](./docs/index.mdx) for a linked table of contents.

| Page                                                                 | Contents                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`docs/conductor-session.mdx`](./docs/conductor-session.mdx)         | **Start here.** The Conductor session — `/bgsd-sesh` entry, auto-scale, flags, full pipeline flowchart |
| [`docs/quickstart.mdx`](./docs/quickstart.mdx)                       | Install, canary proof, first verify run                                                                |
| [`docs/bgsd-verify.mdx`](./docs/bgsd-verify.mdx)                     | Arguments, criteria formats, report schema, driver-ladder details (internal stage)                     |
| [`docs/bgsd-queue.mdx`](./docs/bgsd-queue.mdx)                       | Fix-stream lifecycle, state machine, Loop 1 behavior (internal stage)                                  |
| [`docs/bgsd-run.mdx`](./docs/bgsd-run.mdx)                           | Conductor pipeline, graph, scheduler, conflict resolver (internal stage)                               |
| [`docs/bgsd-status.mdx`](./docs/bgsd-status.mdx)                     | Live status view, color badges, budget telemetry                                                       |
| [`docs/hyperpolymath-capture.mdx`](./docs/hyperpolymath-capture.mdx) | Capture adapter, cron setup, human-gated live hookup                                                   |

---

## Contributing

bgsd is open source (MIT). A few things to know before contributing:

- **Branch:** all work on `feat/bgsd-v0` (or a named feature branch). Agents never commit to `main`; integration lands on `next`, and the `next` → `main` merge is human-only.
- **Additive:** new bgsd code under `bgsd/`; never edit vendored GSD directories.
- **Seams:** bgsd reaches GSD only through the three documented seams — never internals.
- **No silent green:** any new verification path must emit `BLOCKED`/`ERROR` on failure, not a fabricated pass.
- **Tests:** the deterministic scripts have unit tests under `bgsd/scripts/test-*.mjs`. New behavior should come with tests.

For questions, file a GitHub issue at `filippo-fonseca/better-gsd`.

---

## License

MIT — see [`LICENSE`](../LICENSE) at the repo root.

---

_bgsd is an additive layer on [`@opengsd/gsd-core`](https://github.com/opengsd/gsd-core). `main` is production and is never written to by agents; the standing `next` branch is the integration mirror that the pipeline builds on, and `next` → `main` is always a manual, human-only merge._
