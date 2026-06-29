# better-gsd (bgsd)

An open-source Claude Code plugin that layers an autonomous, self-verifying
orchestration system **on top of** GSD. This directory is bgsd's **own additive
namespace** — GSD (at the repo root) stays unmodified; bgsd touches it only through
stable seams (GSD's `/gsd-*` commands, the `.planning/` file contract, and `config.json`).

## This milestone — v0 only

v0 ships the **Standalone Tester** and **`/bgsd-verify`**: an agent that boots a running
app and verifies it against acceptance criteria, returning a reliable, structured defect
list — including console-level errors a screenshot alone would miss.

The Conductor, parallelism, and the verify→fix loops are **out of scope for v0** (see
`.planning/REQUIREMENTS.md → Deferred (v1+)`).

## Layout

```
bgsd/
  .claude-plugin/
    plugin.json        # the bgsd plugin manifest (additive — zero edits to GSD's)
    marketplace.json   # local marketplace so bgsd can be installed/loaded in-project
  commands/
    bgsd-verify.md     # /bgsd-verify (stub in Phase 1; engine in Phases 3–4)
  agents/
    tester.md          # the bgsd tester persona (stub in Phase 1; ladder in Phase 3)
  scripts/
    runtime-isolate.sh # boot one app in isolation (stub in Phase 1; impl in Phase 2)
  docs/
    INTEGRATION-NOTES.md  # Phase-1 spike decisions (plugin loading + MCP reachability)
```

Runtime output (gitignored) lands in `.bgsd/runs/<run-id>/`; scratch in `.bgsd-tmp/`.

## Installing locally (activation)

bgsd is a self-contained local plugin. To load it without editing vendored GSD:

```bash
claude plugin marketplace add ./bgsd     # register the local marketplace
claude plugin install bgsd@bgsd-local    # install the plugin
# restart Claude Code to load /bgsd-verify
```

See `docs/INTEGRATION-NOTES.md` for the loading + MCP-reachability decisions.

## Hard rules (enforced)

- **Never write/commit/PR to the production branch (`next`).** All work lands on `feat/bgsd-v0`.
- **Additive only.** bgsd lives under `bgsd/` (plus its `.bgsd*` runtime dirs); it never
  edits GSD's directories.
- **Seams only.** bgsd reaches GSD only through `/gsd-*` commands, `.planning/`, and `config.json`.
- **No silent green.** When the tester can't drive a real browser, it emits
  `BLOCKED` / `ERROR` / `UNRELIABLE` — never a fabricated `PASS`.

## Personality & UX

bgsd's agents — and the future Conductor (codename **Kiwi**) — speak in a refined
**British-butler / JARVIS** voice, addressing the user as "sir," with calm competence
and the odd swaggering one-liner. The voice flavors human-facing narration only; the
structured outputs (verdict line, `verification-report.json`, `BLOCKED`/`ERROR`) stay
strictly literal. See [`PERSONALITY.md`](./PERSONALITY.md).

Terminal UX lives in [`scripts/ui.mjs`](./scripts/ui.mjs) — a dependency-free helper
(Kiwi banner, color-coded state badges, stage renderer; `NO_COLOR`/non-TTY safe).
Try it: `node bgsd/scripts/ui.mjs --demo`.
