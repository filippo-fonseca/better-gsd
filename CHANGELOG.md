# Changelog

All notable changes to **better-gsd (bgsd)** are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor bumps may carry breaking changes, flagged with `!`).

## [Unreleased]

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
  plans; Opus executes.* It is **off by default** and runs only when `--fable` is
  passed, or when the Conductor opts a specific unit in. Difficulty does not trigger
  it — plain units just run the normal GSD workflow on Opus.
- `/bgsd-run-agent` gained `--seed-plan`: when present, the Opus plan phase reviews
  and augments the Fable plan instead of planning from scratch.
- `--fable` flag: turn the Fable pre-plan on for every unit in a session.
- `--sonnet` flag: allow the executor to drop to Sonnet on trivial (< 0.2) units.

### Fixed
- The Fable pre-planner was no-opping (empty agent, zero tool uses) because the
  Conductor spawned `/bgsd-plan-unit` via the in-session Agent tool, which only
  offers opus/sonnet/haiku and cannot run Fable. It must be launched as a Bash
  `claude -p --model claude-fable-5` subprocess; `bgsd-sesh.md` now documents this
  explicitly (a CRITICAL callout plus a 🧠 branded role that is never an Agent-tool
  subagent).

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

[Unreleased]: https://github.com/filippo-fonseca/better-gsd/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.9.0
[0.8.2]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.8.2
[0.8.1]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.8.1
[0.8.0]: https://github.com/filippo-fonseca/better-gsd/releases/tag/v0.8.0
