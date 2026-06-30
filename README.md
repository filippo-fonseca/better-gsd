# better-gsd (bgsd)

> Talk to the Conductor. It handles everything.

**bgsd** is an autonomous, self-verifying orchestration layer on top of [GSD](https://github.com/open-gsd/gsd-core). You describe what you want in one prompt; the Conductor ("Kiwi") sizes the job, fans out parallel git-worktree agents that each run a tailored GSD flow, verifies every change for real (computer-use and vision), assembles the work on a safe `next` branch, and hands you a reviewable result. No agent ever writes to your production branch.

bgsd is **gsd-agnostic**: it does not vendor GSD. It uses the `gsd-core` plugin installed in your Claude Code and keeps it current for you, so you always ride the latest GSD without ever syncing this repo.

## 1. Install it (one time, ever)

You need Claude Code first. Then, in any terminal:

```sh
claude plugin marketplace add filippo-fonseca/better-gsd
claude plugin install bgsd@better-gsd
```

Run `/reload-plugins` inside Claude Code (or restart) so the `/bgsd-*` commands appear. The plugin is global across every repo; you never reinstall per project. bgsd does not contain GSD: the first time you run a session, the Conductor checks for the `gsd-core` plugin, installs it if missing, and keeps it updated for you.

## 2. First time in a project (one time per repo)

Open your project (it must be a git repo) and run:

```
/bgsd-init
```

This sets the repo up once: it creates a long-lived **`next`** branch (a safe staging copy of your main branch where work is assembled), writes a **`BGSD.md`** settings file, records itself in your **`CLAUDE.md`** so any Claude knows this is a bgsd repo, and creates a **`.bgsd/`** folder that logs every session. It never touches your production branch. You can skip this and go straight to step 3, since a session runs the same setup automatically.

## 3. Every time you want to build something

One front door, always the same:

```
/bgsd-sesh "what you want, in plain English"
```

Optional flags: `--quick` / `--feature` / `--project` force the size, and `--plan-only` previews without doing anything. That is the whole loop: open repo, run `/bgsd-sesh "..."`, review, ship. Repeat forever.

## How it works

You are talking to **Kiwi**, the Conductor. After your one prompt:

1. **Kiwi sizes the job:** a quick fix, a feature, or a full project. Bigger jobs get more machinery.
2. **It splits the work into units** and spins up **parallel worker agents**, each in its own isolated copy of the repo (a git "worktree"). Each worker runs a tailored slice of GSD: a trivial unit skips the research and planning steps; a UI-heavy unit spins up the full UI design phase. Each gets a model sized to its difficulty.
3. **Everything gets verified, for real.** A Tester agent drives the actual app (clicking, screenshots, checking console, network, and DOM) and loops fix-then-recheck until it genuinely passes. There is no "looks done, ship it." Never silent green.
4. **Verified work merges into `next`**, and Kiwi resolves any conflicts.
5. **The whole assembled app on `next` is integration-tested**, with more fix agents looping until clean.
6. **The review gate:** Kiwi boots the app, hands you a localhost URL to click around, and shows a per-agent changelog of everything that changed. If something is off, you say so (`/bgsd-feedback "..."`) and it re-runs.
7. **You ship.** When you are happy, **you** merge `next` into `main` by hand (Kiwi gives you the exact command). No agent ever writes to your production branch. That is the one hard rule.

Throughout, Kiwi narrates live ("4/4 agents finished, 2/4 verified and merged into next"), files a GitHub issue per unit that its pull request closes, and logs every session into `.bgsd/` so you can later ask "what did we change in the auth work last week?".

## Nice extras

- **Settings live in `BGSD.md`.** Edit it, or just tell Kiwi a preference in chat ("never use the cheap model for verification") and it updates the file itself and reports what changed, like Claude Code does with CLAUDE.md.
- **It remembers.** Every session is recorded under `.bgsd/` (`ledger.md` plus `seshs/<run-id>/`). Any Claude can read that history, even outside a bgsd session, to understand what was built.
- **Interrupt anytime.** Drop a message mid-session; agents keep working, and a question never freezes the whole pipeline (only the one unit that needs the answer waits).

## Layout

- The plugin lives in [`bgsd/`](./bgsd); docs in [`bgsd/docs`](./bgsd/docs); the landing page in [`bgsd/site`](./bgsd/site).
- The design is in [`BETTER-GSD-DOCS/BETTER-GSD-PLAN.md`](./BETTER-GSD-DOCS/BETTER-GSD-PLAN.md).

## License

MIT
