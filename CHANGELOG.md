# Changelog

All notable changes to **better-gsd (bgsd)** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor bumps may carry breaking changes, flagged with `!`).

## [Unreleased]

## [0.11.0] - 2026-07-10

### Added
- **Fable-as-Advisor mode.** When the Conductor's own brain is Fable, Kiwi now
  acts as a live reviewing advisor across the pipeline instead of a passive
  dispatcher: it reviews each wave unit's sealed plan, steers before execution,
  checks in on commits as they land, and authors the next wave's seed plans
  itself — writing them directly so `run-live.mjs` uses the Conductor-authored
  seed and **skips the redundant standalone Fable pre-planner subprocess**. The
  advisor reviews distilled artifacts only (sealed plan, commit log,
  verification report), never raw diffs.
  - **Gated, OFF by default.** Active only when `conductor.fable_advisor` is
    `"auto"` (default) AND any of: the brain IS Fable, `--fable` was passed, or
    the user approved a proposal. Set the setting `true`/`false` to force or
    hard-disable. New `advisor.mjs` holds the pure gate + the Conductor-seed
    seam; `node advisor.mjs gate --model <id>` reports the verdict.

## [0.10.0] - 2026-07-05

### Fixed
- **Pipeline agents now spawn on the latest Opus (`claude-opus-4-8`), not the
  stale bare `opus` alias** (which resolved to Opus 4.7). `resolveSpawnModel`
  and the harness model tables share a single `LATEST_OPUS` source of truth.
- **Env files propagate into every worktree and the integration boot.** `.env*`
  files are copied into each pipeline-agent worktree and the sesh-wide checkout
  (worktrees skip gitignored files, so apps previously booted without them). The
  env preflight confirms uncovered files instead of guessing.
- **GUI defaults to the latest sesh, emits proper per-sesh deep-links** (clicking
  a link opens the sesh it was clicked from), and shows concurrent seshs
  distinctly instead of lumping them under "Loop 1 agents."

### Added
- **Harness-agnostic operation (Claude Code or Codex).** The entire pipeline
  routes through a harness layer that maps semantic tiers (opus/sonnet/haiku/
  fable) to the active harness's models. Run the whole Conductor from Codex via
  `conductor.mjs`, and switch back to Claude Code mid-project with zero
  migration — all durable state lives in `.bgsd/`.
- **Session recall.** At the start of every `/bgsd-sesh`, the Conductor reviews
  this repo's history (most recent sesh + prompt-relevant past seshs) so prior
  context carries forward. Dedicated `/bgsd-recall` for deep search.
- **Per-repo queue / backlog.** Bank ideas mid-sesh with `/bgsd-queue`; a bare
  `/bgsd-sesh` offers the queued batch in a multi-pick selector. The canonical
  backlog is `.bgsd/queue`, never a `.planning/` file.

## [0.9.1] - 2026-07-03

### Fixed
- **The Fable pre-planner is launched as a Bash subprocess, never the Agent tool.**
  It was no-opping (empty agent, zero tool uses) because the Conductor spawned
  `/bgsd-plan-unit` via the in-session Agent tool, which only offers
  opus/sonnet/haiku and cannot run Fable. `bgsd-sesh.md` now instructs launching it
  via `claude -p /bgsd-plan-unit --model claude-fable-5` on the worktree and passing
  `--seed-plan` to the Opus agent, and adds a 🧠 branded role that is never an
  Agent-tool subagent.

### Changed
- **The Fable pre-plan is now off by default and opt-in only.** Difficulty no longer
  auto-triggers it (previously units at ≥ 0.5 got one automatically). Plain units run
  the normal GSD workflow on Opus; a pre-plan runs only when `--fable` is passed or
  the Conductor opts a specific unit in. `fablePlanForScore` is flag-driven;
  `fable_plan.default` is `false`.

## [0.9.0] - 2026-07-03

Model-routing overhaul: **Opus is the standard for every role; Fable is never the
executor.** Fable's reasoning is now leveraged only as an optional, standalone
upstream pre-planner that seeds the Opus pipeline.

### Changed
- **BREAKING — the executor is never Fable.** The per-unit worktree subprocess runs
  `opus/xhigh` on every unit. It drops to `sonnet/xhigh` only on trivial units
  (difficulty < 0.2) and only with the new `--sonnet` flag. Previously hard units
  (≥ 0.5) built on Fable, which guzzled tokens on the highest-volume role.
- The in-pipeline planner is now always `opus/high` (it builds on a Fable pre-plan
  when one was produced, via `--seed-plan`).
- Verifier, tester, and Loop-2 fix agents moved to Opus (`opus/medium`) from
  Haiku/Sonnet. Opus is now the default across every role.
- Default config (`init.mjs`) and `BGSD.md` prose updated to the Opus-everywhere
  doctrine; `thresholds.opus` renamed to `thresholds.sonnet`.

### Added
- **Standalone Fable pre-planner (`/bgsd-plan-unit`).** A `claude -p --model
  claude-fable-5` subprocess that plans only (never edits code), writes
  `.planning/fable-plan.md`, and seeds the Opus pipeline agent. Slogan: *Fable
  plans; Opus executes.* (Made opt-in / off-by-default in 0.9.1.)
- `/bgsd-run-agent` gained `--seed-plan`: when present, the Opus plan phase reviews
  and augments the Fable plan instead of planning from scratch.
- `--fable` flag: turn the Fable pre-plan on for every unit in a session.
- `--sonnet` flag: allow the executor to drop to Sonnet on trivial (< 0.2) units.

## [0.8.2] - 2026-07-03

### Fixed
- **Per-repo fix queue.** `queue.mjs` derived its `.bgsd/queue` path from the
  script's own location (the shared plugin cache), so every project drained one
  global backlog — the Conductor in one repo saw items enqueued from another. The
  queue is now resolved from the invoking repo (git top-level, falling back to cwd),
  matching `bgsdmd.mjs`/`brief.mjs`. `BGSD_QUEUE_DIR` overrides for tests.

### Changed
- **Explore floors at Opus.** The per-unit scout/researcher now runs `opus/high`
  (`opus/medium` when trivial) instead of sonnet/haiku — explore quality gates plan
  quality. Conductor-wide session-level exploring uses the Conductor's own model.

## [0.8.1] - 2026-07-02

### Fixed
- **Model doctrine correction.** Clarified that bgsd cannot force the Conductor's
  model (it only nudges, both ways) and cannot spawn a Fable subagent in-session
  (the agent tool offers only opus/sonnet/haiku). The Conductor model is the user's
  live session; Fable was realized per-unit via a real `claude -p --model` on the
  worktree subprocess (superseded by the 0.9.0 pre-planner design).

### Removed
- Dropped the session-start splash and the `/rename`/`/color` step from
  `/bgsd-sesh` (the splash moved to the npm installer's post-install output).

## [0.8.0] - 2026-07-02

### Added
- **`/bgsd-generate-brief`.** Synthesizes a comprehensive markdown brief of a
  completed session (request, per-unit work, agents, changes, outstanding items,
  and a ready-to-paste "how to continue" line) to `.bgsd/briefs/<run-id>-brief.md`.
  Defaults to the last session; narrative synthesis runs on Sonnet.

---

Versions prior to 0.8.0 predate this changelog; see the git history for details.

[Unreleased]: https://github.com/filippo-fonseca/better-gsd/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/filippo-fonseca/better-gsd/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.9.1
[0.9.0]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.9.0
[0.8.2]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.8.2
[0.8.1]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.8.1
[0.8.0]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.8.0
