# better-gsd (bgsd)

**Autonomous, self-verifying orchestration built on top of GSD — as an additive Claude Code plugin.**

bgsd runs your GSD pipeline, then verifies the result with real browser testing, and loops until the output is clean. The make-or-break capability: catching **console errors a screenshot alone would miss** (React `validateDOMNesting` warnings, hydration mismatches, missing-key props) before anything more complex is built on top.

> "Very good, sir. I shall begin verification at once."
> — Kiwi, the bgsd Conductor

---

## Core Value

The single most important thing bgsd does:

> An agent that boots a running app and verifies it against acceptance criteria, returning a **reliable, structured defect list** — including catching **console-level errors a screenshot alone would miss** (the make-or-break test).

This was proven at v0, in isolation, before any orchestration was built on top of it: `/bgsd-verify` against a Next.js canary returned `FAIL` on a `<div>`-in-`<p>` defect (a real React console error invisible to a screenshot) and `PASS` on the clean route, reproducibly across reruns.

---

## How It Works

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

## Milestone Map

| Version | Name | Status |
|---------|------|--------|
| **v0** | Standalone Tester + `/bgsd-verify` | **PROVEN** (2026-06-29) |
| **v1** | Fix-stream + `/bgsd-queue` + Loop 1 | **BUILT** (2026-06-29) |
| **v2** | Conductor (Kiwi) + `/bgsd-run` + `/bgsd-status` | **BUILT** (2026-06-29) |
| v3 | Loop 2 + User Review Gate + `/bgsd-user-eval` + `/bgsd-feedback` | Planned |
| v2-intake | Intake/proxy extension (E1–E6) | Planned |
| v4 | Remote orchestration | Planned |

Live runs at v1 and v2 are guarded behind `--live` and remain human-gated. The deterministic core at every version is unit-tested (85 tests at v1; 14 suites across v0+v1+v2).

---

## Command Surface

### `/bgsd-verify` (v0)

Boot or attach to a running app and verify it against acceptance criteria.

```bash
# Verify an already-running app
/bgsd-verify http://localhost:3000 --criteria path/to/UI-SPEC.md

# Boot and verify in one command
/bgsd-verify --boot bgsd/fixtures/canary-next \
             --criteria bgsd/fixtures/canary-next/acceptance.md

# Ad-hoc inline criteria
/bgsd-verify http://localhost:3000 \
             --inline "Page loads without console errors; Nav renders correctly"
```

Stdout contract — always exactly one line:
```
PASS  .bgsd/runs/<run-id>/verification-report.json
FAIL  .bgsd/runs/<run-id>/verification-report.json
```

Full schema-validated `verification-report.json` lands on disk. See [`docs/bgsd-verify.mdx`](./docs/bgsd-verify.mdx).

---

### `/bgsd-queue` (v1)

A persistent fix-stream. Items move through classify → route → execute → verify → loop.

```bash
# Add an item
node bgsd/scripts/queue.mjs add --title "Fix nav collapse on mobile" \
                                 --body "Collapses below 768 px."

# Check queue status (zero model calls)
node bgsd/scripts/queue.mjs status

# Drain the queue
node bgsd/scripts/queue.mjs start

# Dry-run: preview without mutating state
node bgsd/scripts/queue.mjs start --dry-run
```

See [`docs/bgsd-queue.mdx`](./docs/bgsd-queue.mdx).

---

### `/bgsd-run` (v2 — human-gated `--live`)

The Conductor (Kiwi). Decomposes a large prompt into a DAG, fans units across parallel git worktrees, and checkpoints at every wave boundary.

```bash
# Always safe: resolve the graph, print the spawn plan, exit
node bgsd/scripts/run.mjs --prompt "Add user auth and rate limiting"

# Live: requires explicit flag + the checklist in docs/bgsd-run.mdx
node bgsd/scripts/run-live.mjs --live --prompt "..." --budget-cap 5.00
```

See [`docs/bgsd-run.mdx`](./docs/bgsd-run.mdx).

---

### `/bgsd-status` (v2)

Kiwi live status view. Color-coded per-worktree badges, Loop 1 iteration counts, merge history, budget and context telemetry. Zero model calls.

```bash
# One-shot snapshot (most recent run)
node bgsd/scripts/status.mjs

# Live watch, refresh every 3 seconds
node bgsd/scripts/status.mjs --watch

# Target a specific run
node bgsd/scripts/status.mjs --run-id bgsd-0042-add-user-auth
```

See [`docs/bgsd-status.mdx`](./docs/bgsd-status.mdx).

---

### `/bgsd-capture` (v1)

Hyperpolymath capture adapter. Fetches external items and enqueues them into `/bgsd-queue`. Default path is safe: dry-run, mock source, zero credentials.

```bash
# Dry-run against mock fixture (always safe)
node bgsd/scripts/capture-cron.mjs

# Live Hyperpolymath hookup (human-gated)
node bgsd/scripts/capture-cron.mjs --live --no-dry-run
```

See [`docs/hyperpolymath-capture.mdx`](./docs/hyperpolymath-capture.mdx).

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
    bgsd-verify.md       # /bgsd-verify slash command
    bgsd-queue.md        # /bgsd-queue slash command
    bgsd-run.md          # /bgsd-run slash command
    bgsd-status.md       # /bgsd-status slash command
    bgsd-capture.md      # /bgsd-capture slash command
  docs/
    index.mdx            # table of contents for all doc pages
    quickstart.mdx       # install + canary proof walkthrough
    bgsd-verify.mdx      # /bgsd-verify full reference
    bgsd-queue.mdx       # /bgsd-queue full reference
    bgsd-run.mdx         # /bgsd-run Conductor reference
    bgsd-status.mdx      # /bgsd-status live view reference
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
| [`docs/quickstart.mdx`](./docs/quickstart.mdx) | Install, canary proof, first `/bgsd-verify` run |
| [`docs/bgsd-verify.mdx`](./docs/bgsd-verify.mdx) | Arguments, criteria formats, report schema, driver-ladder details |
| [`docs/bgsd-queue.mdx`](./docs/bgsd-queue.mdx) | Fix-stream lifecycle, state machine, Loop 1 behavior |
| [`docs/bgsd-run.mdx`](./docs/bgsd-run.mdx) | Conductor pipeline, graph, scheduler, conflict resolver, `--live` checklist |
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
