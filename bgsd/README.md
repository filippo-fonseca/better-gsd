# better-gsd (bgsd)

**Autonomous, self-verifying orchestration built on top of GSD — as an additive Claude Code plugin.**

You talk to the Conductor (codename **Kiwi**). Kiwi handles everything else.

> "Very good, sir. I shall begin verification at once."
> — Kiwi, the bgsd Conductor

---

## The single entry point

```
/bgsd-sesh "<whatever I need>"   [--quick | --feature | --project] [--plan-only | --dry-run]
```

That's it. One command, one ongoing session, always-on Conductor.

You describe what you need — a bug fix, a feature, an entire project — and the Conductor auto-detects the scale, decides how many agents to spin up, and **runs the full pipeline immediately**. Pass `--plan-only` (or its alias `--dry-run`) to preview the plan without executing anything. Real merges and PRs are human-gated at merge-boundary checkpoints and never touch `next`.

You never call `/bgsd-verify`, `/bgsd-queue`, `/bgsd-run`, or any other stage command directly. Those are internal stages Kiwi runs for you.

---

## Auto-scale: the same pipeline, scaled

bgsd always runs the same pipeline. Scale determines how deep and wide it goes.

| Signal | What Kiwi does |
|--------|----------------|
| **quick** (one bug, a minor change; ≤2 units, 1 surface) | One agent, no pre-discussion, direct execution — but still fully verified. Never skips the Loop 1 verify→fix cycle. |
| **feature** (a few units, mid-size; a few units, mid-size scope) | A few agents, no pre-discussion, some parallelism, integration loop if >1 unit. |
| **project** (broad prompt, many units; ≥4 units or ≥3 surfaces) | Full parallel pipeline: decompose → parallel git worktrees → Loop 1 per worktree → conflict pre-check + merge → `rehearsal/<run-id>` → Loop 2 integration → review. Pre-discusses with you first. |

The scale threshold is decided by the Conductor, not by you. You can override with a flag.

**A manual flag always wins, unconditionally.** The auto-scale thresholds above apply only when no flag is given. `--feature` on a 2–3-unit task still runs the feature pipeline; `--project` on a tiny task still discusses with you first and runs the full pipeline.

---

## Flags

| Flag | Behavior |
|------|----------|
| *(none)* | Conductor auto-detects scale and **executes immediately**. |
| `--quick` | Quick mode. **No discussion, no pre-prepare.** Fast — but still verified. Never skips Loop 1. Executes immediately. |
| `--feature` | Feature mode. No pre-discussion, some parallelism, integration loop if >1 unit. Executes immediately. |
| `--project` | Full pipeline mode. The Conductor **discusses with you first** (brainstorm, clarify, plan), then executes. Real merges/PRs are human-gated at checkpoints. |
| `--plan-only` | **Preview only.** Classify + print the depth plan; invoke zero boundaries. Nothing executes. |
| `--dry-run` | Alias for `--plan-only`. Same preview behavior. |

A manual flag always wins, unconditionally — the auto-scale thresholds apply only in auto mode.

---

## Scale comparison

| | quick | feature | project |
|---|---|---|---|
| **Example** | "change this button to blue" | "add a dark-mode toggle" | "build auth + billing + a dashboard" |
| **Auto-scale trigger** | ≤2 units, 1 surface | a few units, mid-size | ≥4 units or ≥3 surfaces |
| **Upfront discussion** | no | no | yes (intake/brainstorm) |
| **Decompose + parallel worktrees** | no — single | some, low concurrency | full fan-out |
| **Integration loop (Loop 2)** | no | yes if >1 unit | yes |
| **Formal review gate** | no (Loop 1 PASS + 1-line confirm) | yes | yes |
| **Verification (Loop 1)** | always | always | always |

---

## What the Conductor actually runs

These are **internal stages** — you never call them directly. Kiwi orchestrates all of them on your behalf:

| Stage | What it does |
|-------|--------------|
| **Classify / route** | Determines scale (quick / feature / project) and builds the execution plan |
| **Decompose** | For project-scale: breaks the prompt into a verified DAG of GSD units |
| **Worktree fan-out** | Spawns parallel git worktrees, one per unit, isolated from each other |
| **Loop 1 — verify→fix per worktree** | Runs each GSD unit, then verifies with real browser testing. On defects, re-routes to GSD for a fix. Loops up to the configured max, escalating model effort each time |
| **Conflict pre-check + merge** | Detects merge conflicts before they land; merges verified branches into `rehearsal/<run-id>` in dependency order |
| **Loop 2 — integration verify→fix** | Boots the integrated `rehearsal/<run-id>` app and verifies end-to-end. Dispatches parallel fix agents on defects, re-merges, re-verifies |
| **User Review Gate** | Auto-boots the integrated build, shows a per-criterion checklist, waits for your approval. Never auto-passes |
| **Feedback ingestion** | Turns your review findings into a new fix pass. `--fast` mode runs parallel fix agents without re-verification (always flagged `UNVERIFIED`) |
| **CHANGELOG + PR** | Aggregates per-agent changelogs across all loops and assembles a PR body. Opens the PR against a non-default branch (never `next`) behind `--live` |

The always-on live status view (`/bgsd-status` machinery) is Kiwi's dashboard — it runs throughout and shows you what every agent is doing, where Loop 1 stands per worktree, merge history, budget, and context pressure.

---

## Core Value: the make-or-break test

The single most important thing bgsd does:

> An agent that boots a running app and verifies it against acceptance criteria, returning a **reliable, structured defect list** — including catching **console-level errors a screenshot alone would miss** (the make-or-break test).

This was proven at v0, in isolation, before any orchestration was built on top of it: `/bgsd-verify` against a Next.js canary returned `FAIL` on a `<div>`-in-`<p>` defect (a real React console error invisible to a screenshot) and `PASS` on the clean route, reproducibly across reruns.

The Conductor inherits this guarantee. Every path through the pipeline — whether a one-agent quick fix or a full parallel project run — still ends in a verified result. No silent green, ever.

---

## How verification works: the four-rung driver ladder

bgsd uses a four-rung driver ladder — cheapest and most reliable first:

| Rung | Tool | What it catches |
|------|------|-----------------|
| **1 Console** | `browser_console_messages` | React warnings, hydration errors, JS exceptions |
| **2 Network** | `browser_network_requests` | 4xx/5xx responses, failed resource loads |
| **3 DOM** | `browser_snapshot` | Missing elements, wrong structure, unmet criteria |
| **4 Vision** | `browser_take_screenshot` | Purely visual criteria (fallback only) |

Vision is a last resort, not a crutch. Most bugs die at rung 1.

**No silent green.** If the Playwright MCP is absent, bgsd emits `BLOCKED` — not a fabricated `PASS`. If evidence is insufficient, the verdict is `INSUFFICIENT_EVIDENCE`. Every non-clean stop produces a structured terminal state.

---

## Build history

| Version | Name | Status |
|---------|------|--------|
| **v0** | Standalone Tester + verify engine | **PROVEN** (2026-06-29) |
| **v1** | Fix-stream + Loop 1 | **BUILT** (2026-06-29) |
| **v2** | Conductor (Kiwi) + parallel orchestration + status view | **BUILT** (2026-06-29) |
| **v3** | Loop 2 + User Review Gate + feedback mode | **BUILT** (2026-06-29) |
| **v2-intake** | Conductor intake/proxy extension (E1–E6) | In progress |
| v4 | Remote orchestration | Planned |

All live runs are guarded behind `--live` and remain human-gated. The deterministic core is unit-tested (19 suites green across v0+v1+v2+v3).

---

## Installation

bgsd is a self-contained local plugin. It loads as a second plugin via a local marketplace — GSD's own `.claude-plugin/plugin.json` is never touched.

**Step 1: Register and install the plugin**

```bash
claude plugin marketplace add ./bgsd     # register the local Directory-source marketplace
claude plugin install bgsd@bgsd-local    # install the bgsd plugin (user scope)
```

**Step 2: Add Playwright MCP** (pinned version — do not substitute without re-running the canary proof)

```bash
claude mcp add playwright -- npx @playwright/mcp@0.0.76
```

**Step 3: Restart Claude Code, then run the canary proof**

```bash
/bgsd-verify --boot bgsd/fixtures/canary-next \
             --criteria bgsd/fixtures/canary-next/acceptance.md
```

Expected: `PASS  .bgsd/runs/.../verification-report.json`

Then verify the buggy route (the defect is a `<div>` nested inside `<p>` — invisible to a screenshot):

```bash
/bgsd-verify http://localhost:<port>/buggy \
             --criteria bgsd/fixtures/canary-next/acceptance.md
```

Expected: `FAIL  .bgsd/runs/.../verification-report.json`

Run the fixture in `development` mode: React's `validateDOMNesting` warning is stripped from production builds.

**Step 4: Start a Conductor session**

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
    bgsd-verify.md       # /bgsd-verify — internal verify stage
    bgsd-queue.md        # /bgsd-queue — internal fix-stream stage
    bgsd-run.md          # /bgsd-run — internal Conductor orchestration stage
    bgsd-status.md       # /bgsd-status — live status view
    bgsd-capture.md      # /bgsd-capture — Hyperpolymath capture adapter
  docs/
    index.mdx            # table of contents (Conductor Session as entry point)
    conductor-session.mdx  # PRIMARY: /bgsd-sesh reference + pipeline flowchart
    quickstart.mdx       # install + canary proof walkthrough
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

| Invariant | Enforcement |
|-----------|-------------|
| **Never write/commit/PR to `next`** | All work lands on `feat/bgsd-v0` or other non-default branches. No automated push to the default branch, ever. |
| **Additive only** | bgsd lives under `bgsd/` (plus runtime `.bgsd*/` dirs). It never edits GSD's directories. |
| **Never edit vendored GSD** | `commands/`, `agents/`, `gsd-core/`, `skills/`, `hooks/`, root `README.md`, `LICENSE`, `docs/` — all read-only to bgsd. |
| **Seams only** | bgsd reaches GSD only through (1) `/gsd-*` slash commands, (2) the `.planning/` file contract, and (3) `config.json`. |
| **No silent green (NFR-06)** | Insufficient evidence → `INSUFFICIENT_EVIDENCE`. MCP absent → `BLOCKED`. Never a fabricated `PASS`. |
| **Bounded autonomy (NFR-08)** | Every loop is bounded by `max_iterations`; every Conductor run by `--budget-cap`; every wave requires a human go/no-go. |
| **Live runs human-gated** | `--live` flag required for multi-process orchestration and live captures. Guards check `process.argv` and throw a detailed refusal if absent. |

---

## Personality & UX

bgsd's agents — and the Conductor (codename **Kiwi**) — speak in a refined **British-butler / JARVIS** voice: courteous, calm, conspicuously competent, and occasionally touched with confident modern slang. The agent addresses the user as "sir."

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

| Page | Contents |
|------|----------|
| [`docs/conductor-session.mdx`](./docs/conductor-session.mdx) | **Start here.** The Conductor session — `/bgsd-sesh` entry, auto-scale, flags, full pipeline flowchart |
| [`docs/quickstart.mdx`](./docs/quickstart.mdx) | Install, canary proof, first verify run |
| [`docs/bgsd-verify.mdx`](./docs/bgsd-verify.mdx) | Arguments, criteria formats, report schema, driver-ladder details (internal stage) |
| [`docs/bgsd-queue.mdx`](./docs/bgsd-queue.mdx) | Fix-stream lifecycle, state machine, Loop 1 behavior (internal stage) |
| [`docs/bgsd-run.mdx`](./docs/bgsd-run.mdx) | Conductor pipeline, graph, scheduler, conflict resolver (internal stage) |
| [`docs/bgsd-status.mdx`](./docs/bgsd-status.mdx) | Live status view, color badges, budget telemetry |
| [`docs/hyperpolymath-capture.mdx`](./docs/hyperpolymath-capture.mdx) | Capture adapter, cron setup, human-gated live hookup |

---

## Contributing

bgsd is open source (MIT). A few things to know before contributing:

- **Branch:** all work on `feat/bgsd-v0` (or a named feature branch). Never commit to `next`.
- **Additive:** new bgsd code under `bgsd/`; never edit vendored GSD directories.
- **Seams:** bgsd reaches GSD only through the three documented seams — never internals.
- **No silent green:** any new verification path must emit `BLOCKED`/`ERROR` on failure, not a fabricated pass.
- **Tests:** the deterministic scripts have unit tests under `bgsd/scripts/test-*.mjs`. New behavior should come with tests.

For questions, file a GitHub issue at `filippo-fonseca/better-gsd`.

---

## License

MIT — see [`LICENSE`](../LICENSE) at the repo root.

---

*bgsd is an additive layer on [`@opengsd/gsd-core`](https://github.com/opengsd/gsd-core). The fork's default branch (`next`) is treated as production and is never written to by bgsd.*
