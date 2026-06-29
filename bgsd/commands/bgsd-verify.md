---
name: bgsd-verify
description: "Boot or attach to a running app and verify it against acceptance criteria, returning a structured defect list (console → network → DOM → vision)."
argument-hint: "<url | --boot> [--criteria <file> | --inline \"...\"]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
---

# /bgsd-verify

> **Status — v0 skeleton (Phase 1).** The interface below is declared so the command
> loads and is recognized without colliding with any `/gsd-*` command (SKEL-03).
> The verification engine is implemented in Phases 3–4 (the driver ladder, the tester
> agent, and the `verification-report.json` schema). Running it now reports `NOT_IMPLEMENTED`.

## What this will do

Take a **running app** (a URL, or `--boot` to start one via `scripts/runtime-isolate.sh`)
plus **acceptance criteria** (a GSD `UI-SPEC.md`/acceptance file, or `--inline`), spawn the
bgsd tester, and walk every criterion 1:1 through the verification-driver ladder:

```
console messages  →  network errors  →  rendered DOM  →  screenshot / vision (fallback only)
```

It returns a verdict and writes a structured report.

## Arguments (planned)

| Arg | Meaning |
|-----|---------|
| `<url>` | Verify an already-running app at this URL. |
| `--boot` | Boot one isolated instance first via `runtime-isolate.sh` (unique port + ephemeral DB). |
| `--criteria <file>` | Acceptance criteria from a GSD `UI-SPEC.md` / acceptance file. |
| `--inline "..."` | Acceptance criteria given inline. |

## Output (planned)

- **stdout**: a single verdict line (`PASS` / `FAIL` / `BLOCKED`) plus the report path. Nothing else.
- **file**: `.bgsd/runs/<run-id>/verification-report.json` — per-criterion pass/fail, a defect
  list (severity + source), screenshot paths, a driver-ladder audit, and an environment block.

## Hard rules (enforced)

- **No silent green.** If the tester cannot drive a real browser session (MCP unavailable,
  server not ready, prod build), it emits `BLOCKED` / `ERROR` / `UNRELIABLE` — never a fabricated `PASS`.
- **Branch safety.** bgsd never writes, commits, or PRs to the production branch (`next`).

## Current behavior

This stub prints a `NOT_IMPLEMENTED` notice and exits without pretending to verify anything.
