<div align="center">

# better-gsd (bgsd)

### Talk to the Conductor. It handles everything.

**bgsd** is an autonomous, self-verifying orchestration layer on top of [GSD](https://github.com/open-gsd/gsd-core), shipped as a single Claude Code plugin. Describe what you want in one prompt; the Conductor sizes the job, fans out parallel git-worktree agents that each run a tailored GSD flow, verifies every change for real, assembles the work on a safe branch, and hands you a reviewable result. No agent ever writes to your production branch.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![version](https://img.shields.io/badge/version-0.4.3-informational.svg)](./bgsd/.claude-plugin/plugin.json)
[![tests](https://img.shields.io/badge/tests-40%20passing-brightgreen.svg)](#architecture-at-a-glance)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[Landing page](https://site-filippo-fonsecas-projects.vercel.app) · [Docs](./bgsd/docs) · [Contributing](./CONTRIBUTING.md) · [Architecture](./ARCHITECTURE.md)

</div>

---

## Table of contents

- [What is bgsd](#what-is-bgsd)
- [Install](#install)
- [First run](#first-run)
- [Everyday use](#everyday-use)
- [How it works](#how-it-works)
- [Features](#features)
- [Architecture at a glance](#architecture-at-a-glance)
- [Docs](#docs)
- [Contributing](#contributing)
- [License](#license)

---

## What is bgsd

You talk to one entity: the Conductor, codename **Kiwi**. You never juggle stage commands or babysit agents. You say what you need in plain English, and Kiwi runs the whole build for you: sizing, planning, parallel execution, real verification, integration, and a review gate.

bgsd is **gsd-agnostic**: it does not vendor or bundle GSD. It uses the `gsd-core` plugin installed in your Claude Code and keeps it current for you, so you always ride the latest GSD without ever syncing this repo. Kiwi also provisions the Playwright browser tooling it needs at the start of every session.

The one hard invariant, enforced in code and not just documented: **agents never write to your production branch.** All integration lands on a standing `next` branch, and the `next` to `main` merge is a manual, human-only step.

---

## Install

You need Claude Code first. Then, in any terminal:

```sh
claude plugin marketplace add filippo-fonseca/better-gsd
claude plugin install bgsd@better-gsd
```

Run `/reload-plugins` inside Claude Code (or restart) so the `/bgsd-*` commands appear. The plugin is global across every repo; you never reinstall per project.

There is also a thin npm launcher that runs the same steps for you:

```sh
npx better-gsd@latest
```

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
| `--quick` | Force small scale. No discussion, fast, still fully verified (Loop 1 is never skipped). |
| `--feature` | Force feature scale. A few units, some parallelism, integration loop if more than one unit. |
| `--project` | Force full pipeline. Kiwi discusses with you first (brainstorm, clarify, plan), then executes. |
| `--no-usage-verification` | Code-only verify. Runs the goal-backward verifier but skips Playwright UI testing (good for non-UI changes). |
| `--gui` | Open the live web dashboard of all agents by lane and GSD substage. |
| `--plan-only` / `--dry-run` | Preview only. Classify and print the plan; nothing runs. |

A manual scale flag always wins: it bypasses auto-scale thresholds unconditionally.

Kiwi orchestrates a handful of other commands for you, so you rarely call them directly: `/bgsd-init`, `/bgsd-queue` (cross-session backlog: add/status/peek/done/start), `/bgsd-verify`, `/bgsd-resume` (resume an interrupted session from `.bgsd/runs/`), `/bgsd-gui`, `/bgsd-status`, `/bgsd-user-eval` (review gate), `/bgsd-integrate` (Loop 2), `/bgsd-feedback`, `/bgsd-changelog`, and `/bgsd-run`.

---

## How it works

After your one prompt, Kiwi runs this pipeline (scaled up or down to fit the job):

1. **Kiwi sizes the job:** a quick fix, a feature, or a full project. Bigger jobs get more machinery.
2. **It splits the work into units** and spins up **parallel worker agents**, each in its own isolated copy of the repo (a git worktree). Each worker runs a tailored slice of GSD: a trivial unit skips research and planning; a UI-heavy unit gets the full UI design phase. Each gets a model sized to its difficulty.
3. **Everything gets verified, for real.** A Playwright Tester agent drives the actual app (clicking, screenshots, checking console, network, and DOM), and a goal-backward code verifier checks the change against its acceptance criteria. It loops fix-then-recheck until it genuinely passes. There is no "looks done, ship it." Never silent green.
4. **Verified work merges into `next`**, and Kiwi resolves any conflicts.
5. **The whole assembled app on `next` is integration-tested** (Loop 2), with more fix agents looping until clean.
6. **The review gate:** Kiwi boots the app, hands you a localhost URL to click around, and shows a per-agent changelog of everything that changed. If something is off, you say so (`/bgsd-feedback "..."`) and it re-runs.
7. **You ship.** When you are happy, **you** merge `next` into `main` by hand (Kiwi gives you the exact command). No agent ever writes to your production branch. That is the one hard rule.

Throughout, Kiwi narrates live behind a colored `kiwi · conductor` pill ("4/4 agents finished, 2/4 verified and merged into next"), files a GitHub issue per unit that its pull request closes, and logs every session into `.bgsd/` so you can later ask "what did we change in the auth work last week?".

---

## Features

| Feature | What it gives you |
|---------|-------------------|
| One front door | `/bgsd-sesh "..."` is the entire interface; Kiwi runs every stage for you. |
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
| Settings as a file | `BGSD.md` holds your knobs; tell Kiwi a preference in chat and it self-edits the file. |
| Memory | Every session is recorded under `.bgsd/`; any Claude can read that history later. |

---

## Architecture at a glance

- The plugin lives in [`bgsd/`](./bgsd): commands in [`bgsd/commands`](./bgsd/commands), the tester agent in [`bgsd/agents`](./bgsd/agents), the engine in [`bgsd/scripts`](./bgsd/scripts), docs in [`bgsd/docs`](./bgsd/docs), and the landing page in [`bgsd/site`](./bgsd/site).
- A thin npm launcher lives in [`installer/`](./installer).
- The engine is written as **pure, dependency-injected** modules (`bgsd/scripts/*.mjs`) paired with a `*-live.mjs` seam that wires real git and filesystem access and guards every mutation behind `--live` and a not-production-branch check.
- Tests are home-grown `bgsd/scripts/test-*.mjs` files (`node:assert/strict`, a local `test()` runner). There are **40** of them today, and all must exit 0. Run the suite with:

  ```sh
  for t in bgsd/scripts/test-*.mjs; do node "$t"; done
  ```

For the full pipeline walkthrough and repo layout, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Docs

Full doc pages live in [`bgsd/docs/`](./bgsd/docs); start at [`docs/index.mdx`](./bgsd/docs/index.mdx).

| Page | Contents |
|------|----------|
| [`conductor-session.mdx`](./bgsd/docs/conductor-session.mdx) | Start here. The Conductor session: `/bgsd-sesh` entry, auto-scale, flags, full pipeline flowchart. |
| [`quickstart.mdx`](./bgsd/docs/quickstart.mdx) | Install, `/bgsd-init`, and the canary proof walkthrough. |
| [`bgsd-verify.mdx`](./bgsd/docs/bgsd-verify.mdx) | Verify arguments, criteria formats, report schema, driver-ladder details. |
| [`bgsd-queue.mdx`](./bgsd/docs/bgsd-queue.mdx) | Fix-stream lifecycle, state machine, Loop 1 behavior. |
| [`bgsd-run.mdx`](./bgsd/docs/bgsd-run.mdx) | Conductor pipeline, graph, scheduler, conflict resolver. |
| [`bgsd-status.mdx`](./bgsd/docs/bgsd-status.mdx) | Live status view, color badges, budget telemetry. |
| [`bgsd-loop2-review.mdx`](./bgsd/docs/bgsd-loop2-review.mdx) | Loop 2 integration and the User Review Gate. |
| [`bgsd-feedback-changelog.mdx`](./bgsd/docs/bgsd-feedback-changelog.mdx) | Feedback ingestion and per-agent changelog aggregation. |

---

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup, the pure and seam and test conventions, the "no silent green" rule, the branch and release model, and commit and PR conventions. Please also read the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) and report security issues per [`SECURITY.md`](./SECURITY.md).

---

## License

MIT, see [`LICENSE`](./LICENSE).
