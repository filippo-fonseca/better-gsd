# Roadmap: better-gsd (bgsd) — Milestone 1 (v0)

## Overview

v0 ships the Standalone Tester and `/bgsd-verify`: an agent that boots a running app and verifies it against acceptance criteria, returning a reliable, structured defect list — including console-level errors a screenshot would miss. The roadmap is deliberately de-risked hardest-first. Phase 1 resolves the two open integration risks (additive second-plugin loading; MCP reachability from a plugin subagent) cheaply before anything is built on them. Phases 2-4 stand up the isolation helper, the verification-driver ladder, and the command + report schema. Phase 5 is the make-or-break proof that gates v0 success. Phase 6 documents it. Every phase is additive under `bgsd/`, never edits vendored GSD, and never touches the `next` branch.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Integration Spike + Plugin Skeleton** - Resolve plugin-loading + MCP-reachability risks, stand up additive bgsd namespace
- [x] **Phase 2: Runtime-Isolation Helper** - Boot one Next.js app cleanly on an isolated port + ephemeral DB, detect readiness, tear down
- [x] **Phase 3: Verification-Driver Ladder** - Console-first ladder over `@playwright/mcp` with pre-flight probe and dev-mode capture
- [x] **Phase 4: /bgsd-verify Command + Tester Agent + Report Schema** - Criteria-driven verification emitting structured `verification-report.json`
- [ ] **Phase 5: Make-or-Break Proof** - Canary Next.js page proves the console error a screenshot misses is caught (FAIL) and clean passes (PASS)
- [x] **Phase 6: Diagram-First Docs** - Quickstart + `/bgsd-verify` usage pages, diagram-first, GSD-Mintlify style

## Phase Details

### Phase 1: Integration Spike + Plugin Skeleton
**Goal**: De-risk the two open integration unknowns cheaply, then stand up the additive bgsd skeleton on proven ground.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: SKEL-01, SKEL-02, SKEL-03, SKEL-04
**Success Criteria** (what must be TRUE):
  1. Claude Code loads `bgsd/plugin.json` as a second plugin alongside vendored GSD with zero edits to GSD's `.claude-plugin/plugin.json` (fallback decision recorded if CLAUDE.md `@`-includes are needed instead).
  2. The `/bgsd-verify` stub command is recognized and runs without colliding with any `/gsd-*` command.
  3. A documented decision records whether the tester can reach Playwright MCP tools and via which invocation path (e.g. `general-purpose` subagent, foreground), given CC bugs #13254/#13605; a pre-flight probe approach is chosen if direct access fails.
  4. The additive `bgsd/` namespace exists with stub `commands/bgsd-verify.md`, `agents/tester.md`, `scripts/runtime-isolate.sh`, and gitignored `.bgsd/runs/` + `.bgsd-tmp/`.
**Plans**: TBD

### Phase 2: Runtime-Isolation Helper
**Goal**: A shell helper boots exactly one Next.js app instance cleanly, in isolation, and tears it down without residue.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: ISO-01, ISO-02, ISO-03, ISO-04
**Success Criteria** (what must be TRUE):
  1. Running `runtime-isolate.sh` against a Next.js app picks a deterministic, collision-checked port and reports it.
  2. The helper writes `.env.bgsd` overriding only `PORT`/`DATABASE_URL` and provisions an ephemeral SQLite DB, leaving the app's `.env`/`.env.local` untouched.
  3. The app boots in dev mode and the helper signals ready only after detecting the readiness string in the dev-server log (with a timeout guard), never on a blind sleep.
  4. Teardown kills the server and removes the ephemeral DB (unless `--keep-db`), leaving no orphaned port or state.
**Plans**: TBD

### Phase 3: Verification-Driver Ladder
**Goal**: The tester reliably drives a running app through the console→network→DOM→vision ladder, capturing the make-or-break console class.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: DRIVER-01, DRIVER-02, DRIVER-03, DRIVER-04
**Success Criteria** (what must be TRUE):
  1. Against a running app, the ladder executes in order (console → network → DOM snapshot → screenshot fallback) using pinned `@playwright/mcp`.
  2. The console listener is attached before navigation and captures `errors`/`warnings`/`pageErrors` buckets; React `validateDOMNesting`/hydration/missing-`key` regexes match against the `error` bucket.
  3. A pre-flight MCP probe runs first; when MCP is unavailable the tester emits `BLOCKED: mcp_unavailable` with install guidance instead of a corrupt report.
  4. Navigation uses `domcontentloaded` + semantic selectors (never `networkidle`), and a non-dev `build_mode` flags console assertions `UNRELIABLE`.
**Plans**: TBD
**UI hint**: yes

### Phase 4: /bgsd-verify Command + Tester Agent + Report Schema
**Goal**: A user-runnable command turns acceptance criteria + a running app into a structured, criterion-by-criterion defect report.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: VERIFY-01, VERIFY-02, VERIFY-03, REPORT-01, REPORT-02, REPORT-03
**Success Criteria** (what must be TRUE):
  1. `/bgsd-verify` accepts a running URL (or `--boot` via the isolation helper) plus acceptance criteria from a GSD `UI-SPEC.md`/acceptance file or inline.
  2. The tester iterates every criterion 1:1 through the ladder (no check without a criterion, no criterion unchecked) and writes `verification-report.json` to `.bgsd/runs/<run-id>/`.
  3. The report contains `criteria[]` (per-criterion pass/fail/skip + driver + evidence), `defects[]` (severity + source console|network|dom|vision), `screenshots[]`, a `driver_ladder` audit, an `environment` block, and a top-level `verdict`.
  4. Stdout prints only the verdict line + report path; the full JSON never floods stdout.
**Plans**: TBD
**UI hint**: yes

### Phase 5: Make-or-Break Proof
**Goal**: Prove the core bet — the tester catches a console-level error a screenshot misses, and does not cry wolf on a clean page. Gates v0 success.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: PROOF-01, PROOF-02, PROOF-03
**Success Criteria** (what must be TRUE):
  1. A real Next.js canary page renders an intentional `<script>`-in-JSX (or hydration) defect that looks normal in a screenshot but emits a console-level error.
  2. `/bgsd-verify` against the canary returns `FAIL` with a `source: console` defect mapped to the relevant acceptance criterion.
  3. `/bgsd-verify` against the cleaned page returns `PASS` with no false-positive defect.
  4. The FAIL/PASS pair is reproducible across reruns (same verdict, populated `evidence`), confirming no listener-timing or dev-mode regression.
**Plans**: TBD
**UI hint**: yes

### Phase 6: Diagram-First Docs
**Goal**: A new user can install bgsd and run their first verification from the docs alone.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: DOCS-01, DOCS-02
**Success Criteria** (what must be TRUE):
  1. A diagram-first Quickstart page (Mermaid/SVG, GSD-Mintlify style) takes a user from install through a first `/bgsd-verify` run.
  2. A `/bgsd-verify` usage page documents arguments, acceptance-criteria input formats, the report schema, and ladder behavior.
  3. The docs render in the GSD-Mintlify docs site without breaking its existing navigation or build.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Integration Spike + Plugin Skeleton | 1/1 | Complete | 2026-06-29 |
| 2. Runtime-Isolation Helper | 1/1 | Complete | 2026-06-29 |
| 3. Verification-Driver Ladder | 1/1 | Complete | 2026-06-29 |
| 4. /bgsd-verify Command + Report Schema | 1/1 | Complete | 2026-06-29 |
| 5. Make-or-Break Proof | 0/TBD | Not started | - |
| 6. Diagram-First Docs | 1/1 | Complete | 2026-06-29 |
