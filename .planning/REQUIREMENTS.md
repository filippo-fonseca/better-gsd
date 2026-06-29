# Requirements: better-gsd (bgsd) — Milestone 1 (v0)

**Defined:** 2026-06-29
**Core Value:** An agent that boots a running app and verifies it against acceptance criteria, returning a reliable, structured defect list — including catching console-level errors a screenshot alone would miss (the make-or-break test).
**Milestone:** Milestone 1 = v0 only (the Standalone Tester + `/bgsd-verify`).

## Non-Functional Constraints (Hard Rules — enforced, not aspirational)

These apply to every v0 requirement and must hold at all times.

- [ ] **NFR-01 (Branch safety)**: bgsd never writes, commits, pushes, or opens a PR to the default/production branch (`next`). All work lands on `feat/bgsd-v0` or other non-default branches. No automation targets `next`, ever.
- [ ] **NFR-02 (Additive code)**: All bgsd source lives under its own top-level `bgsd/` namespace (plus its own `bgsd/plugin.json` manifest). bgsd never adds files into GSD's own directories in a way that changes GSD behavior.
- [ ] **NFR-03 (Never edit vendored GSD)**: The forked GSD source (root `commands/`, `agents/`, `gsd-core/`, `skills/`, `hooks/`, `.claude-plugin/plugin.json`, `src/`, etc.) is read-only to bgsd. bgsd makes zero edits to it.
- [ ] **NFR-04 (Seams only)**: bgsd touches GSD only through three stable seams — (1) GSD's `/gsd-*` slash commands, (2) the documented `.planning/` file contract, (3) `config.json`. No reaching into GSD internals.
- [ ] **NFR-05 (Capture-then-summarize)**: Raw console/network/DOM output is captured to files by scripts/MCP tool calls; only the failing slice is passed to a model. Never pay a model to poll or babysit a browser/server.
- [ ] **NFR-06 (No silent green)**: When the tester cannot actually drive a real browser session (MCP unavailable, server not ready, prod build), it emits a structured `BLOCKED`/`ERROR`/`UNRELIABLE` verdict — never a fabricated `PASS`.

## v1 Requirements (this milestone = v0)

Requirements for the v0 release. Each maps to exactly one roadmap phase.

### Plugin Skeleton (SKEL)

- [ ] **SKEL-01**: bgsd loads as a second, additive plugin manifest (`bgsd/plugin.json`) alongside vendored GSD, with zero edits to GSD's `.claude-plugin/plugin.json`.
- [ ] **SKEL-02**: The additive `bgsd/` namespace exists with stub `commands/bgsd-verify.md`, `agents/tester.md`, and `scripts/runtime-isolate.sh`, plus `.bgsd/runs/` and `.bgsd-tmp/` gitignored runtime dirs.
- [ ] **SKEL-03**: A loading probe confirms the `/bgsd-verify` command is recognized by Claude Code without colliding with any `/gsd-*` command.
- [ ] **SKEL-04**: An MCP-reachability spike resolves whether the tester can reach Playwright MCP tools (re: CC bugs #13254/#13605); the working invocation path (e.g. `general-purpose` subagent, foreground) is documented as a decision.

### Runtime Isolation (ISO)

- [ ] **ISO-01**: `runtime-isolate.sh` assigns a deterministic-but-collision-safe port (hash of worktree path + `lsof` availability check) and reports the chosen port.
- [ ] **ISO-02**: The helper provisions an ephemeral SQLite DB (and optional seed) and writes a `.env.bgsd` that overrides only `PORT`/`DATABASE_URL`, leaving the app's `.env`/`.env.local` untouched.
- [ ] **ISO-03**: The helper boots one Next.js app in dev mode (`NODE_ENV=development`/`next dev`) and detects readiness by grepping the dev-server log (`Ready in` / `compiled successfully` / `ready started server`) before signaling ready, with a timeout guard.
- [ ] **ISO-04**: The helper tears down cleanly — kills the server process and removes the ephemeral DB (unless `--keep-db`) — leaving no orphaned port or state.

### Verification Driver (DRIVER)

- [ ] **DRIVER-01**: The tester drives the app via pinned `@playwright/mcp`, running the ladder in priority order: console → network → DOM snapshot → screenshot/vision (fallback only).
- [ ] **DRIVER-02**: The console listener is attached BEFORE navigation and captures three buckets (`errors`, `warnings`, `pageErrors`); React `validateDOMNesting` / hydration / missing-`key` regexes are matched against the `error` bucket.
- [ ] **DRIVER-03**: A pre-flight MCP probe (no-op `browser_snapshot`) runs before testing; on failure the tester emits `BLOCKED: mcp_unavailable` with install guidance instead of a corrupt or fabricated report.
- [ ] **DRIVER-04**: The tester uses semantic selectors and `domcontentloaded` (never `networkidle`) as its wait strategy, and records `build_mode` so console assertions on a prod build are flagged `UNRELIABLE`.

### Verify Command (VERIFY)

- [ ] **VERIFY-01**: `/bgsd-verify` accepts a running app URL (or boots one via `runtime-isolate.sh` with `--boot`) plus acceptance criteria from a GSD `UI-SPEC.md`/acceptance file OR inline.
- [ ] **VERIFY-02**: The command spawns the tester (via the MCP-working invocation path from SKEL-04), which iterates every acceptance criterion 1:1 through the ladder — no check without a criterion, no criterion unchecked.
- [ ] **VERIFY-03**: The command prints only a verdict line (`PASS`/`FAIL`/`BLOCKED`) plus the report path to stdout; the full report is written to `.bgsd/runs/<run-id>/`.

### Report Schema (REPORT)

- [ ] **REPORT-01**: The tester emits `verification-report.json` with a `criteria[]` array (per-criterion `id`, `description`, `source`, `status` pass/fail/skip, `driver`, `evidence`).
- [ ] **REPORT-02**: The report includes a `defects[]` array with `severity` (critical/high/medium/low) and `source` (console/network/dom/vision), plus a `screenshots[]` array (sparse: initial load + defect evidence only).
- [ ] **REPORT-03**: The report includes a `driver_ladder` audit (which rungs ran + finding counts), an `environment` block (port, db, node_env, framework), and a top-level `verdict` (PASS/FAIL/ERROR).

### Make-or-Break Proof (PROOF)

- [ ] **PROOF-01**: A real Next.js canary page renders an intentional `<script>`-in-JSX (or hydration) defect that looks normal in a screenshot but emits a console-level error.
- [ ] **PROOF-02**: `/bgsd-verify` run against the canary returns `FAIL`, with a defect whose `source: console` maps to the relevant acceptance criterion — proving the error a screenshot misses is caught.
- [ ] **PROOF-03**: `/bgsd-verify` run against the cleaned (defect-removed) page returns `PASS`, proving no false positive. (This pair gates v0 success.)

### Docs (DOCS)

- [ ] **DOCS-01**: A diagram-first Quickstart page (Mermaid/SVG, GSD-Mintlify style) walks a user from install through a first `/bgsd-verify` run.
- [ ] **DOCS-02**: A `/bgsd-verify` usage page documents arguments, the acceptance-criteria input formats, the report schema, and how the driver ladder behaves.

## Deferred (v1+) — Out of Scope for this Milestone

Tracked but explicitly NOT in the v0 roadmap. Promoted into Active scope only at a future milestone boundary.

### Orchestration & Autonomy

- **DEF-01 (v2)**: Conductor / Kiwi orchestrator (decomposition, dependency graph, headless spawning, control-file protocol, heartbeat/restart, conflict pre-check + merge-resolver, doc aggregation, branch cleanup).
- **DEF-02 (v2)**: Parallelism — whole-pipeline-per-worktree, headless process spawning, control-file protocol.
- **DEF-03 (v1/v2)**: Loop 1 — per-worktree verify→fix Ralph loop with stop-hook.
- **DEF-04 (v3)**: Loop 2 — integration verify→fix on `rehearsal/<run-id>` + User Review Gate.
- **DEF-05 (v1–v3)**: Commands `/bgsd-run`, `/bgsd-queue`, `/bgsd-status`, `/bgsd-user-eval`, `/bgsd-feedback`, `/bgsd-clean-branches`, `/bgsd-abort`.
- **DEF-06 (v2+)**: Model + effort routing matrix, budget caps, escalation ladder.
- **DEF-07 (v1+)**: Upgrade-resilient subtree vendoring (`vendor/gsd/`), `bgsd doctor`, contract tests.
- **DEF-08 (v1 public)**: Landing page.

### Captured Addenda (post-PRD — land in v1+/Conductor scope)

- **DEF-09 (v1+)**: Caffeinate during runs — after user approval at plugin setup, keep the Mac awake (`caffeinate`) through long autonomous runs. (Setup-time helper.)
- **DEF-10 (v2+)**: Conductor context management — Conductor and its parallel subagents must never overflow context; orchestrate compaction/clear when needed, and exploit large/1M context windows appropriately.
- **DEF-11 (v2+)**: Always-on live terminal (Kiwi) view — the human always has a live terminal view of what the Conductor/Kiwi is doing (active subagents, current stage, where input is needed). Extends `/bgsd-status` + Kiwi status line.

## Out of Scope (this milestone)

| Feature | Reason |
|---------|--------|
| Conductor / Kiwi / parallelism / worktrees | Orchestration is v2; v0 proves the single Tester in isolation first |
| Loop 1 / Loop 2 (verify→fix) | Autonomy loops are v1/v3; v0 only proves verification, not fixing |
| `chrome-devtools-mcp` as primary driver | Requires live Chrome (not headless-first); diverging tool vocabulary; `@playwright/mcp` chosen |
| Production-build verification | React dev-only warnings vanish in prod bundle; v0 forces dev mode |
| Postgres / multi-DB isolation | v0 targets ephemeral SQLite for the canary; Postgres schema isolation deferred |
| Screenshot-only / vision-first verification | Misses console errors entirely — fails the v0 make-or-break test |

## Traceability

Each requirement maps to exactly one phase. NFRs are cross-cutting (apply to all phases).

| Requirement | Phase | Status |
|-------------|-------|--------|
| SKEL-01 | Phase 1 | Pending |
| SKEL-02 | Phase 1 | Pending |
| SKEL-03 | Phase 1 | Pending |
| SKEL-04 | Phase 1 | Pending |
| ISO-01 | Phase 2 | Pending |
| ISO-02 | Phase 2 | Pending |
| ISO-03 | Phase 2 | Pending |
| ISO-04 | Phase 2 | Pending |
| DRIVER-01 | Phase 3 | Pending |
| DRIVER-02 | Phase 3 | Pending |
| DRIVER-03 | Phase 3 | Pending |
| DRIVER-04 | Phase 3 | Pending |
| VERIFY-01 | Phase 4 | Pending |
| VERIFY-02 | Phase 4 | Pending |
| VERIFY-03 | Phase 4 | Pending |
| REPORT-01 | Phase 4 | Pending |
| REPORT-02 | Phase 4 | Pending |
| REPORT-03 | Phase 4 | Pending |
| PROOF-01 | Phase 5 | Pending |
| PROOF-02 | Phase 5 | Pending |
| PROOF-03 | Phase 5 | Pending |
| DOCS-01 | Phase 6 | Pending |
| DOCS-02 | Phase 6 | Pending |
| NFR-01..06 | All phases (cross-cutting) | Pending |

**Coverage:**
- v0 functional requirements: 23 total (SKEL 4, ISO 4, DRIVER 4, VERIFY 3, REPORT 3, PROOF 3, DOCS 2)
- Mapped to phases: 23
- Unmapped: 0 ✓
- Non-functional constraints: 6 (cross-cutting, enforced across all phases)

---
*Requirements defined: 2026-06-29*
*Last updated: 2026-06-29 after initial definition*
