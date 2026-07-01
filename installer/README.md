<div align="center">

<img src="https://github.com/filippo-fonseca/better-gsd/raw/next/assets/banner.svg" alt="bgsd — Git. Ship. Done. On steroids. One sesh: the Conductor scopes a prompt, fans out parallel git-worktree agents that each run a full GSD batch, verifies every change through real computer use, merges onto a safe next branch, and keeps main protected behind a human-only merge." width="100%">

# better-gsd (bgsd)

### Talk to the Conductor. It handles everything.

**bgsd** is an autonomous, self-verifying orchestration layer on top of [GSD](https://github.com/open-gsd/gsd-core), shipped as a single Claude Code plugin. It's lightweight to install (markdown files and a handful of zero-dependency Node scripts), yet it orchestrates a full parallel, self-verifying build pipeline: describe what you want in one prompt and the Conductor sizes the job, fans out parallel git-worktree agents that each run a tailored GSD flow, verifies every change for real, assembles the work on a safe branch, and hands you a reviewable result. No agent ever writes to your production branch.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/filippo-fonseca/better-gsd/blob/next/LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![version](https://img.shields.io/badge/version-0.5.1-informational.svg)](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/.claude-plugin/plugin.json)
[![tests](https://img.shields.io/badge/tests-43%20passing-brightgreen.svg)](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/scripts)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/filippo-fonseca/better-gsd/blob/next/CONTRIBUTING.md)

[Landing page](https://site-filippo-fonsecas-projects.vercel.app) · [Docs](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/docs) · [Contributing](https://github.com/filippo-fonseca/better-gsd/blob/next/CONTRIBUTING.md) · [Architecture](https://github.com/filippo-fonseca/better-gsd/blob/next/ARCHITECTURE.md)

</div>

---

## What is bgsd

You talk to one entity: the Conductor (default name **Kiwi**, customizable in `BGSD.md`). You never juggle stage commands or babysit agents. You say what you need in plain English, and the Conductor runs the whole build for you: sizing, planning, parallel execution, real verification, integration, and a review gate.

bgsd is **gsd-agnostic**: it does not vendor or bundle GSD. It uses the `gsd-core` plugin installed in your Claude Code and keeps it current for you, so you always ride the latest GSD without ever syncing this repo. The Conductor also provisions the Playwright browser tooling it needs at the start of every session.

The one hard invariant, enforced in code and not just documented: **agents never write to your production branch.** All integration lands on a standing `next` branch, and the `next` to `main` merge is a manual, human-only step.

---

## Install

You need Claude Code first. The fastest path is this npm launcher, which wires up the marketplace, the plugin, and the `gsd-core` engine for you:

```sh
npx better-gsd@latest
```

Or do it by hand:

```sh
claude plugin marketplace add filippo-fonseca/better-gsd
claude plugin install bgsd@better-gsd
```

Run `/reload-plugins` inside Claude Code (or restart) so the `/bgsd-*` commands appear. The plugin is global across every repo; you never reinstall per project.

bgsd does not contain GSD. The first time you run a session, the Conductor checks for the `gsd-core` plugin (`@opengsd/gsd-core`, installed via `npx`), installs it if missing, keeps it updated, and provisions Playwright MCP for verification.

---

## First run

Open your project (it must be a git repo) and run:

```
/bgsd-init
```

This sets the repo up once. It is idempotent (safe to run repeatedly) and also runs automatically as a preflight on every `/bgsd-sesh`, so you rarely call it by hand. It:

- creates a long-lived **`next`** branch (a safe staging copy of your base branch where work is assembled);
- scaffolds a committed **`.bgsd/`** folder that records every session (`seshs/`, an append-only `ledger.md`, and `config.json`);
- writes a **`BGSD.md`** settings file at the repo root (user-editable knobs, like a CLAUDE.md for bgsd);
- records a managed block in your **`CLAUDE.md`** so any Claude knows this is a bgsd repo.

It never touches your production branch.

---

## Everyday use

One front door, always the same:

```
/bgsd-sesh "what you want, in plain English"
```

That is the whole loop: open repo, run `/bgsd-sesh "..."`, review, ship. Repeat forever.

**Flags** (all optional):

| Flag | What it does |
|------|--------------|
| *(none)* | Conductor auto-detects scale and executes immediately. |
| *(no prompt)* | `/bgsd-sesh` with no prompt: the Conductor proposes the next item from your backlog. |
| `--quick` | Force small scale. No discussion, fast, still fully verified (Loop 1 is never skipped). |
| `--feature` | Force feature scale. A few units, some parallelism, integration loop if more than one unit. |
| `--project` | Force full pipeline. The Conductor discusses with you first (brainstorm, clarify, plan), then executes. |
| `--mode fast\|thorough\|adaptive` | Pipeline-agent depth. `fast` skips research, `thorough` researches every unit, `adaptive` (default) lets the Conductor decide per unit. |
| `--verify-mode fast\|thorough\|adaptive` | Verifier depth, same three levels; `adaptive` is the default. |
| `--no-usage-verification` | Code-only verify. Runs the goal-backward verifier but skips Playwright UI testing (good for non-UI changes). |
| `--headless-ui` | Run Playwright headless: no visible browser or server window pops up (discreet). |
| `--gui` | Open the live web dashboard of all agents by lane and GSD substage. |
| `--plan-only` / `--dry-run` | Preview only. Classify and print the plan; nothing runs. |

A manual flag always wins: **flag > `BGSD.md` > default**. Scale flags bypass the auto-scale thresholds unconditionally.

You mostly just use `/bgsd-sesh`, but a few other commands are useful directly: **`/bgsd-resume`** (pick up an interrupted session), **`/bgsd-gui`** (open the live dashboard), **`/bgsd-memory "..."`** (save a setting or preference to `BGSD.md` in plain English), `/bgsd-init`, `/bgsd-queue` (backlog: add/status/peek/done/start), `/bgsd-verify`, and `/bgsd-status`. The Conductor orchestrates the rest for you (`/bgsd-user-eval`, `/bgsd-integrate`, `/bgsd-feedback`, `/bgsd-changelog`, `/bgsd-run`). **Every command and every flag is in the [Commands Reference](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/commands-reference.mdx).**

---

## How it works

After your one prompt, the Conductor runs this pipeline (scaled up or down to fit the job):

1. **The Conductor sizes the job:** a quick fix, a feature, or a full project. Bigger jobs get more machinery.
2. **It splits the work into units** and spins up **parallel worker agents**, each in its own isolated copy of the repo (a git worktree). Each worker runs a tailored slice of GSD: a trivial unit skips research and planning; a UI-heavy unit gets the full UI design phase. Each gets a model sized to its difficulty.
3. **Everything gets verified, for real.** A Playwright Tester agent drives the actual app (clicking, screenshots, checking console, network, and DOM), and a goal-backward code verifier checks the change against its acceptance criteria. It loops fix-then-recheck until it genuinely passes. There is no "looks done, ship it." Never silent green.
4. **Verified work merges into `next`**, and the Conductor resolves any conflicts.
5. **The whole assembled app on `next` is integration-tested** (Loop 2), with more fix agents looping until clean.
6. **The review gate:** the Conductor boots the app, hands you a localhost URL to click around, and shows a per-agent changelog of everything that changed. If something is off, you say so (`/bgsd-feedback "..."`) and it re-runs.
7. **You ship.** When you are happy, **you** merge `next` into `main` by hand (the Conductor gives you the exact command). No agent ever writes to your production branch. That is the one hard rule.

Throughout, the Conductor leads every message with a name pill — `🥝 Kiwi:` by default (customizable in `BGSD.md`) — narrating the current stage and agent counts ("4/4 agents finished, 2/4 verified and merged into next"). It also files a GitHub issue per unit that its pull request closes and logs every session into `.bgsd/` so you can later ask "what did we change in the auth work last week?".

### Live dashboard (`/bgsd-gui`)

When you want a real-time bird's-eye view of the whole pipeline, pass `--gui` to `/bgsd-sesh` or run `/bgsd-gui` at any point. The Conductor opens a local web dashboard showing every agent live: the parallel Loop 1 Pipeline Agents, the Verification lane, the Loop 2 Integrator, and the Review Gate — each card showing its GSD substage, status, and progress. The Conductor already keeps the terminal legible with per-message narration, so the GUI is not required. When you are running many agents at once, though, the animated full-pipeline view makes it even better: unparalleled visibility into what every agent is actually doing.

---

## Features

| Feature | What it gives you |
|---------|-------------------|
| One front door | `/bgsd-sesh "..."` is the entire interface; the Conductor runs every stage for you. |
| Auto-scale | The same pipeline sized to the job (quick / feature / project), overridable by flag. |
| Real verification | A Playwright Tester driving the app plus a goal-backward code verifier; a four-rung driver ladder (console, network, DOM, vision). |
| No silent green | Insufficient evidence yields `INSUFFICIENT_EVIDENCE`; a missing MCP yields `BLOCKED`. Never a fabricated `PASS`. |
| Parallel worktrees | One isolated git worktree per unit, with `.env*` files copied in so apps actually boot. |
| Safe integration | Verified branches merge into a standing `next` branch; `next` to `main` is human-only. |
| Cross-session backlog | Defer scope with `/bgsd-queue`; a no-prompt sesh pulls the next item. |
| Verification-depth knob | `--no-usage-verification` for code-only verification on non-UI changes. |
| Per-agent context management | Watches each roughly 1M-token agent, compacts at 0.70 and relaunches at 0.90 of its window. |
| Resume | `/bgsd-resume` picks an interrupted session back up from `.bgsd/runs/`. |
| Live dashboard | `--gui` opens a colorful web view of every agent by lane and GSD substage. |
| Settings as a file | `BGSD.md` holds your knobs; tell the Conductor a preference in chat and it self-edits the file. |
| Memory | Every session is recorded under `.bgsd/`; any Claude can read that history later. |

---

## Architecture at a glance

- The plugin lives in [`bgsd/`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd): commands in [`bgsd/commands`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/commands), the tester agent in [`bgsd/agents`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/agents), the engine in [`bgsd/scripts`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/scripts), docs in [`bgsd/docs`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/docs), and the landing page in [`bgsd/site`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/site).
- A thin npm launcher lives in [`installer/`](https://github.com/filippo-fonseca/better-gsd/tree/next/installer).
- The engine is written as **pure, dependency-injected** modules (`bgsd/scripts/*.mjs`) paired with a `*-live.mjs` seam that wires real git and filesystem access. A plain `/bgsd-sesh` runs the whole live pipeline end-to-end, with a hard not-production-branch guard on every mutation so `main` is never touched.
- Tests are home-grown `bgsd/scripts/test-*.mjs` files (`node:assert/strict`, a local `test()` runner). There are **43** of them today, and all must exit 0. Run the suite with:

  ```sh
  for t in bgsd/scripts/test-*.mjs; do node "$t"; done
  ```

For the full pipeline walkthrough and repo layout, see [`ARCHITECTURE.md`](https://github.com/filippo-fonseca/better-gsd/blob/next/ARCHITECTURE.md).

---

## Docs

Full doc pages live in [`bgsd/docs/`](https://github.com/filippo-fonseca/better-gsd/tree/next/bgsd/docs); start at [`docs/index.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/index.mdx).

| Page | Contents |
|------|----------|
| [`conductor-session.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/conductor-session.mdx) | Start here. The Conductor session: `/bgsd-sesh` entry, auto-scale, flags, full pipeline flowchart. |
| [`bgsd-verify.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/bgsd-verify.mdx) | Verify arguments, criteria formats, report schema, driver-ladder details. |
| [`bgsd-queue.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/bgsd-queue.mdx) | Fix-stream lifecycle, state machine, Loop 1 behavior. |
| [`bgsd-run.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/bgsd-run.mdx) | Conductor pipeline, graph, scheduler, conflict resolver. |
| [`bgsd-status.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/bgsd-status.mdx) | Live status view, color badges, budget telemetry. |
| [`bgsd-loop2-review.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/bgsd-loop2-review.mdx) | Loop 2 integration and the User Review Gate. |
| [`bgsd-feedback-changelog.mdx`](https://github.com/filippo-fonseca/better-gsd/blob/next/bgsd/docs/bgsd-feedback-changelog.mdx) | Feedback ingestion and per-agent changelog aggregation. |

---

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](https://github.com/filippo-fonseca/better-gsd/blob/next/CONTRIBUTING.md) for dev setup, the pure and seam and test conventions, the "no silent green" rule, the branch and release model, and commit and PR conventions. Please also read the [`CODE_OF_CONDUCT.md`](https://github.com/filippo-fonseca/better-gsd/blob/next/CODE_OF_CONDUCT.md) and report security issues per [`SECURITY.md`](https://github.com/filippo-fonseca/better-gsd/blob/next/SECURITY.md).

---

## License

MIT, see [`LICENSE`](https://github.com/filippo-fonseca/better-gsd/blob/next/LICENSE).
