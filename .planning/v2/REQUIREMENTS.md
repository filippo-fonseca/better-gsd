# Requirements: better-gsd (bgsd) — Milestone 3 (v2)

**Defined:** 2026-06-29
**Core Value (v2):** A project orchestrator — **Kiwi, the Conductor** — that takes one large prompt, decomposes it into a dependency graph of units, spawns whole GSD pipelines **in parallel across isolated git worktrees** (headless `claude -p` processes), coordinates them through a **control-file protocol** (heartbeat/restart, assumption-and-continue, escalate-only-if-unknown), runs **Loop 1 per worktree**, does a **conflict pre-check + merge-resolver**, assembles a single **`rehearsal/<run-id>`** integration branch in dependency order, **aggregates each worktree's docs** into a run ledger, **cleans up** merged branches, and **checkpoints to the user at merge boundaries** — all behind an **always-on, colorful live status view** and with **context that never overflows**, and never touching the `next` branch.
**Milestone:** Milestone 3 = v2 only (`/bgsd-run` Conductor + multi-worktree parallelism + Loop 1 across worktrees + the live status view + Conductor context management). Builds directly on the v0 Standalone Tester and the v1 Loop 1 / queue / routing engine.
**Plan source:** `BETTER-GSD-DOCS/better-gsd-plan.md` — Part 3 (engine + control-file protocol), Part 4 (git/branch model, merge order, cleanup), Part 5 Loop 1 (per-worktree verify→fix), Part 6 (doc-aggregation ledger). Routing matrix from Part 11; live-terminal + context addenda from Part 16 / Part 13 §2 (carried in PROJECT.md as DEF-10/DEF-11/DEF-22). Engine constraints from Part 1 §3–13, Part 2.

## Non-Functional Constraints (Hard Rules — enforced, not aspirational)

These apply to every v2 requirement and must hold at all times. NFR-01..07 are inherited unchanged from v0/v1; v2 adds NFR-08 (bounded/reversible autonomy at fan-out scale) and NFR-09 (context never overflows).

- [ ] **NFR-01 (Branch safety)**: bgsd never writes, commits, pushes, or opens a PR to the default/production branch (`next`). All work lands on `feat/bgsd-v0` (or a later feat branch) and on `rehearsal/<run-id>` + ephemeral worktree branches. Only the human merges `rehearsal/<run-id>` → `next`, by hand. A guard hook rejects any automated write to the default branch. (Plan Part 1 §9, Part 2, Part 4.)
- [ ] **NFR-02 (Additive code)**: All bgsd source lives under its own `bgsd/` namespace (plus its `bgsd/.claude-plugin/plugin.json` manifest and `.bgsd*` runtime dirs — `runs/`, `control/`, `worktrees/`, `ledger.md`). bgsd never adds files into GSD's own directories in a way that changes GSD behavior. (Plan Part 1 §1, Part 6, Part 10.)
- [ ] **NFR-03 (Never edit vendored GSD)**: The forked GSD source (root `commands/`, `agents/`, `gsd-core/`, `skills/`, `hooks/`, `.claude-plugin/plugin.json`, root `.gitignore`, root `docs/`, `src/`) is read-only to bgsd. bgsd makes zero edits to it. (Plan Part 2, Part 12.)
- [ ] **NFR-04 (Seams only)**: bgsd touches GSD only through three stable seams — (1) GSD's `/gsd-*` slash commands, (2) the documented `.planning/` file contract, (3) `config.json` / per-worktree `model_overrides`. No reaching into GSD internals. The Conductor influences each worktree's GSD run only by writing that worktree's `.planning/config.json`. (Plan Part 1 §1, Part 11 two-level routing, Part 12.)
- [ ] **NFR-05 (Scripts over models / capture-then-summarize — "rule zero")**: The Conductor control loop, heartbeat polling, port/DB fan-out, git dry-run merges (conflict pre-check), worktree create/teardown, status-view rendering, doc-aggregation file copies, branch cleanup, and ledger I/O are deterministic scripts — never a model. Only the high-stakes judgment points (decompose, merge-conflict resolution, blocker answer, Tester interpret) call a model, and they get only their failing slice / relevant excerpt — never the whole run. (Plan Part 11 "rule zero", Part 13 §1–6.)
- [ ] **NFR-06 (No silent green)**: When a worktree cannot be truly verified (Tester emits `BLOCKED`/`ERROR`/`UNRELIABLE`, server won't boot, MCP unavailable, or Loop 1 exhausts `max_iterations` without a clean pass), or when a merge conflict the merge-resolver is not confident about cannot be auto-resolved, that worktree ends in a structured non-PASS terminal state (`blocked`/`failed`/`needs_input`) and its branch is held back from `rehearsal/<run-id>` — never a fabricated `done`/`merged`. (Plan Part 5 §5, Part 9 §5, v0/v1 NFR-06.)
- [ ] **NFR-07 (Conductor is the only human interface)**: Pipeline/Tester/fix/merge agents never prompt the user directly; they write to control files the Conductor reads. The Conductor answers answerable blockers itself first (from REQUIREMENTS/PROJECT/codebase/prior runs) and surfaces exactly one consolidated, deduplicated question to the user only for high-severity unknowns, through the Kiwi channel. (Plan Part 1 §5, Part 2, Part 3 §2–3.)
- [ ] **NFR-08 (Bounded, reversible autonomy at fan-out scale)**: Every loop (Loop 1 per worktree) is bounded by a configurable `max_iterations` and exits cleanly on any stop condition; the whole run is bounded by a per-run budget/token cap that downshifts only non-critical layers (effort first, then model) and never the cascading-decision points (decompose, merge-resolve). The Conductor checkpoints to the user at every merge boundary (no fire-and-forget at this milestone). The live multi-process orchestration run is human-gated: off by default, explicit opt-in, dry-run path provided, never CI, never `next`. (Plan Part 5 §5, Part 8 v2 "don't promise fire-and-forget yet", Part 9 §3, Part 11 budget.)
- [ ] **NFR-09 (Context never overflows)**: The Conductor is a script loop holding only small control + ledger files (pointers, not blobs); it never accumulates a fat supervisor context. Each headless Pipeline Agent gets only its slice (its plan + the relevant excerpt of requirements) inside its own 200k window. When any agent (or the Conductor's supervisor persona) approaches its limit, the Conductor orchestrates compaction/clear or a fresh-context re-launch, and exploits large/1M context windows where available — context pressure is monitored deterministically and surfaced in the status view. (Plan Part 13 §2–4, Part 16, PROJECT.md DEF-10/DEF-22.)

## v2 Requirements (this milestone)

Requirements for the v2 release. Each maps to exactly one roadmap phase. Grouped by area: RUN, GRAPH, SPAWN, CTRL, CONFLICT, REHEARSE, STATUS, CTX, plus DOCS. The bulk is buildable + unit-testable deterministically with **mocked process spawns**; the live multi-process run is isolated into a single human-gated phase/criterion (mirroring v1 Loop 1).

### Orchestrator Entry & Run Lifecycle (RUN)

- [ ] **RUN-01**: `/bgsd-run "<prompt>"` is the project-mode entrypoint (Part 7): it mints a monotonic run ID `bgsd-<NNNN>-<slug>`, opens a run record under `.bgsd/runs/<run-id>/` + a `ledger.md` index entry, and drives the full lifecycle decompose → fan-out → Loop 1 per worktree → conflict-checked merge into `rehearsal/<run-id>` → checkpoint to user. The lifecycle driver is a deterministic script loop (NFR-05); it never holds the whole run in context (NFR-09). (Plan Part 7, Part 8 v2, Part 4.)
- [ ] **RUN-02**: The run lifecycle is an explicit, auditable state machine (`created → decomposed → spawning → executing → verifying → merging → checkpoint → (done | aborted | needs_input)`), every transition timestamped to the run record, so an interrupted run is resumable from persisted state without re-spawning completed worktrees or re-merging merged branches. (Plan Part 6 ledger discipline, Part 1 §4 traceability, Part 3.)
- [ ] **RUN-03**: The Conductor checkpoints to the user at every merge boundary — before a wave merges into `rehearsal/<run-id>` and after the final assembly — surfacing what merged, what is held back (non-PASS worktrees), and the one consolidated blocker question if any, then waiting for go/no-go rather than proceeding fire-and-forget (NFR-07/08). v2 never merges `rehearsal/<run-id>` into `next`. (Plan Part 8 v2 "Conductor→user checkpoint at merge boundaries", Part 1 §9.)
- [ ] **RUN-04**: `/bgsd-abort` stops an in-flight run cleanly — signals all live worktree processes to exit, preserves every worktree branch, control file, and the run ledger for inspection, and marks the run `aborted` — leaving no orphaned process, port, or partial merge. (Plan Part 7, Part 4 cleanup discipline.)

### Decomposition & Dependency Graph (GRAPH)

- [ ] **GRAPH-01**: The Conductor decomposes the prompt into a set of units, each unit a whole-GSD-pipeline-sized work item with a stable id, title, scope summary, and a touched-surface estimate (files/areas) — the unit of parallelism is a whole GSD pipeline, not a task (Plan Part 1 §3). Decomposition is the single highest-leverage model call: Opus / xhigh effort per the Part 11 "decompose prompt → dependency graph" row. (Plan Part 3, Part 11.)
- [ ] **GRAPH-02**: Units are arranged into a directed acyclic dependency graph; the graph data structure (nodes, edges, topological wave grouping) is a deterministic structure the Conductor builds and serializes to the run record (`RUN.md`) — independent units land in the same wave, dependent units in later waves. (Plan Part 3, Part 4 "merges in dependency order", Part 6.)
- [ ] **GRAPH-03**: The dependency graph passes a verification pass before any spawn — a cycle check plus a false-independence / overlap heuristic (units whose touched-surface estimates collide are flagged as a likely hidden dependency, reusing GSD's plan-checker pattern) — because bad decomposition poisons all parallelism (Plan Part 9 §6). A graph that fails verification is re-decomposed or escalated, never spawned. (Plan Part 9 §6, NFR-06.)
- [ ] **GRAPH-04**: Per-unit GSD model posture is derived from a cheap difficulty score (touched-surface size, dependency count, novelty, prior-attempt count) into the per-worktree × per-role × per-phase routing matrix written to each worktree's `.planning/config.json` — promoting the executor of a high-value/complex unit (→ Opus, high/xhigh) and demoting researcher/verifier/completion (→ Haiku, low) — by the config seam only, never by editing GSD (NFR-04). (Plan Part 11 two-level routing.)

### Worktree + Headless Spawn (SPAWN)

- [ ] **SPAWN-01**: For each unit in a ready wave, a deterministic script creates an isolated git worktree under `.bgsd/worktrees/<agent-id>/` on a branch `<run-id>/<slug>` branched off the current `rehearsal/<run-id>` head (or off the base branch head at run start for the first wave), with its own port + ephemeral DB/seed via the v0 `runtime-isolate.sh` convention fanned out per worktree so testers never collide. (Plan Part 4, Part 3 §1, Part 9 §2, builds on v0 ISO.)
- [ ] **SPAWN-02**: Each unit runs as a headless `claude -p` Pipeline Agent pinned to its worktree, executing the full GSD chain (discuss→plan→execute) in GSD assumptions mode, free to use GSD's own subagents inside its 200k window. The spawn boundary is dependency-injected: the deterministic controller decides *which* units to spawn and *when*; the actual process launch is an injected function so the controller is unit-testable with **mocked spawns** and the real launch lives in a `*-live` path. (Plan Part 3 §1, Part 1 §3, mirrors v1 loop1/loop1-live DI split.)
- [ ] **SPAWN-03**: Spawning respects wave ordering and a configurable max-parallelism cap: only units whose graph dependencies are all `merged` are eligible to spawn, and no more than `max_parallel` worktrees run concurrently — the scheduler is a deterministic function over the graph + control-file states (NFR-05). Caffeinate keeps the Mac awake for the duration of a live run (opt-in setup helper, DEF-09). (Plan Part 3, Part 11 "parallelism × GSD fan-out" multiplier, Part 13 §2.)
- [ ] **SPAWN-04 (HUMAN-GATED live run)**: The real end-to-end multi-process orchestration — spawning ≥2 concurrent headless `claude -p` Pipeline Agents across real worktrees with real servers, driving them through Loop 1 to merge — is built and unit-tested in isolation behind mocked spawns first, then exercised only via an explicit, off-by-default `--live` opt-in, human-supervised, never in automated CI, and never writing `next`. A `--dry-run` path resolves the graph, prints the spawn plan + would-be worktrees/branches, and exits without launching anything. (Plan Part 8 v2, Part 9 §4, NFR-08; mirrors v1 Phase 3 live-run criterion.)

### Control-File Protocol + Heartbeat/Restart (CTRL)

- [ ] **CTRL-01**: Each agent owns `/.bgsd/control/<agent-id>.json` carrying `agent_id`, `worktree`, `branch`, `phase` (discuss|ui|plan|execute|verify|fixing|done|blocked|failed), `status`, optional `blocker` (`question` + `severity`), `heartbeat` (ISO timestamp), and `commits` — the documented schema is the coordination contract; coordination is via filesystem + git, never shared context (Plan Part 3 control-file protocol, Part 13 §4). Control-file read/write is deterministic (NFR-05).
- [ ] **CTRL-02**: The Conductor watches heartbeats deterministically: an agent whose heartbeat is older than a configurable staleness threshold is treated as stalled and restarted (re-launched on the same worktree/branch, resuming from its committed state) — heartbeat polling and the stall decision are pure scripted logic with the restart action dependency-injected (testable under mocked spawns). (Plan Part 3 "watches heartbeats → restart", NFR-05/08.)
- [ ] **CTRL-03**: The blocker protocol follows assumption-and-continue → clean-exit-on-hard-blocker → Conductor-answers-from-context → re-launch-with-inbox: agents prefer documented assumptions and keep going; a hard blocker is a clean exit with `status: blocked`; the Conductor tries to answer from context (REQUIREMENTS/PROJECT/codebase/prior runs), writes the answer to `<agent-id>.inbox.md`, and re-launches the agent to resume with that context appended — pass pointers, not blobs (NFR-09). Triage is Haiku/low, answering is Sonnet/medium per Part 11. (Plan Part 3 §1–3, Part 11.)
- [ ] **CTRL-04**: Only an unanswerable, high-severity blocker reaches the user — the Conductor writes it to a user-escalation queue and surfaces exactly one consolidated, deduplicated question through the Kiwi channel (NFR-07); the corresponding worktree parks in `blocked`/`needs_input` while the rest of the run continues unimpeded. (Plan Part 3 §3, Part 1 §5, NFR-06/07.)

### Conflict Pre-Check + Merge-Resolver (CONFLICT)

- [ ] **CONFLICT-01**: Before each merge of a verified worktree branch into `rehearsal/<run-id>`, the Conductor runs a deterministic git **dry-run merge / conflict pre-check** (no model) that reports whether the merge is clean and, if not, the exact conflicted paths/hunks — capture-then-summarize, scripts over models (NFR-05). (Plan Part 4, Part 11 "git dry-run merge = script", Part 13 §1.)
- [ ] **CONFLICT-02**: A clean pre-check merges the branch into `rehearsal/<run-id>` in dependency order (independent first, then dependents) and marks the unit `merged`; merge order is a deterministic function of the dependency graph + which units have passed Loop 1. (Plan Part 4 "merge order — dependency order", Part 5 §6.)
- [ ] **CONFLICT-03**: A non-clean pre-check hands the conflict to a dedicated **merge-resolver** agent (Opus / high effort per Part 11) that has the full requirements + both branches' summaries (not the isolated Pipeline Agents) and proposes a resolution; the resolver is invoked behind a dependency-injected boundary so the orchestration is testable with a **mocked resolver**. (Plan Part 4, Part 9 §5, Part 11 "merge-conflict resolution = Opus/high".)
- [ ] **CONFLICT-04**: A conflict the merge-resolver is not confident about is **not** auto-resolved — the unit is held back from `rehearsal/<run-id>` in a `needs_input` state with the conflict + proposed resolution attached, and surfaced at the merge-boundary checkpoint for human resolution (NFR-06/07). No fabricated clean merge. (Plan Part 9 §5 "keep a human-escalation path", NFR-06.)

### Rehearsal Branch + Doc Aggregation + Cleanup (REHEARSE)

- [ ] **REHEARSE-01**: The Conductor assembles a single per-run integration branch `rehearsal/<run-id>` from all verified worktree branches merged in dependency order — the branch that simulates the fully-merged app for inspection — never `dev`/`develop`, never `next`. v2 stops at assembly + checkpoint; it does not run Loop 2 over `rehearsal/<run-id>` (that is v3). (Plan Part 4, Part 1 §8, Part 5 Loop 1 §6.)
- [ ] **REHEARSE-02**: Doc aggregation is a deterministic script that pulls each worktree's `.planning/` summaries into the run record — `RUN.md` (the prompt dump, decomposition, dependency graph, timeline) and `AGENTS.md` (per-subagent: what it was asked, did, decided, committed) — and updates the global `.bgsd/ledger.md` index of all runs with status + links (NFR-05). (Plan Part 6, Part 1 §12.)
- [ ] **REHEARSE-03**: Branch cleanup is deterministic and reversible-safe: after a worktree branch is successfully merged into `rehearsal/<run-id>`, its branch + worktree checkout are removed by default (work is merged + documented); `rehearsal/*` is retained. `/bgsd-clean-branches` prunes only `rehearsal/*` branches already merged into the base branch, and never deletes an unmerged branch. (Plan Part 4 cleanup, Part 1 §13, Part 7, NFR-01.)
- [ ] **REHEARSE-04**: A per-run human-readable CHANGELOG (per-agent: what each subagent added/fixed/changed, traceable) is generated into the run record by a cheap summarizer (Haiku/low per Part 11) — the seed that will feed the v3 PR body and user-eval, built now so the ledger is complete, but NOT wired into a PR at this milestone. (Plan Part 6, Part 1 §10, Part 11 "doc aggregation = Haiku/low".)

### Live Colorful Status View (STATUS)

- [ ] **STATUS-01**: `/bgsd-status` renders an always-on, colorful, read-only live view of the whole run built on `bgsd/scripts/ui.mjs` (banner, color-coded state badges, stage renderer): the current run stage, every active worktree/subagent with a color-coded state badge (running/blocked/needs-input/done/failed), Loop 1 iteration counts, current GSD phase per worktree, merge state, and where user input is needed — so the human can manually track a hands-off run at all times. Rendering reads control + ledger files; zero model calls in the view path (NFR-05). (Plan Part 7, Part 16, PROJECT.md DEF-11/DEF-22.)
- [ ] **STATUS-02**: The Kiwi identity is consistent everywhere — the terracotta pixel-block kiwi sprite + an info column (name · model+effort · cwd · status) on launch, a mini 3-row variant heading `/bgsd-status`, and every user-facing orchestrator string reading "Kiwi" ("Kiwi is decomposing your prompt…", "Kiwi merged 3 worktrees", "Kiwi needs your input on one thing"). The status line shows live truth including a constant **🔒 main-protected** indicator. (Plan Part 16, Part 1 §14.)
- [ ] **STATUS-03**: The status view surfaces live budget + context telemetry — running token/$ against the per-run cap, the parallelism × fan-out multiplier in effect, and any context-pressure / downshift state — so the human can see spend and context health and the graceful-downshift trigger is visible, not silent (NFR-08/09). Telemetry is captured deterministically (NFR-05). (Plan Part 13 §12, Part 11 budget, Part 16.)
- [ ] **STATUS-04**: The status view degrades correctly in non-TTY / `NO_COLOR` / CI environments (plain output, no ANSI) and updates incrementally without corrupting the terminal during a long live run, reusing ui.mjs's existing environment detection — the live view never itself becomes a source of noise or a blocking process. (Plan Part 16, reuses v1 ui.mjs COLOR_OK discipline, NFR-05.)

### Conductor Context Management (CTX)

- [ ] **CTX-01**: The Conductor never accumulates a fat supervisor context: the orchestration loop is a script that reads/writes small control + ledger files and passes pointers (file paths), not pasted content, to every spawned agent — minimal-context handoff is enforced by the spawn boundary, and each agent gets only its slice. (Plan Part 13 §2 + §4, NFR-09.)
- [ ] **CTX-02**: Context pressure is monitored deterministically per agent and for the Conductor's supervisor persona (token/usage signals captured by script); when an agent approaches its window limit the Conductor orchestrates compaction/clear or a fresh-context re-launch (resuming from committed state + an inbox pointer), and prefers/exploits a large/1M context window where the run config makes one available — fresh-context discipline inherited from GSD, no degraded long sessions. (Plan Part 13 §3, PROJECT.md DEF-10, NFR-09.)
- [ ] **CTX-03**: Shared work is cached, not re-derived: a run-level research/decision cache (and GSD "learnings") lets worktrees reuse prior research instead of N agents re-researching the same stack question, and stable system prompts + requirements/spec docs are prompt-cached across the wide fan-out — never paying twice for context, logs, or research already produced. (Plan Part 13 §7 + §10, NFR-05/09.)

### Docs (DOCS)

- [ ] **DOCS-05**: A `/bgsd-run` + Conductor usage page (GSD-Mintlify style, diagram-first) documents project mode end-to-end — decompose → dependency graph → parallel worktrees → Loop 1 → conflict-checked merge into `rehearsal/<run-id>` → merge-boundary checkpoint — with the two-loop/branch-model diagrams, the control-file protocol, and the routing matrix, plus the exact human-gated steps to run a real `--live` orchestration (and the `--dry-run` default). (Plan Part 14, Part 6, mirrors v0/v1 docs cadence.)
- [ ] **DOCS-06**: A `/bgsd-status` + Kiwi page documents the live status view (badges, stage renderer, budget/context telemetry, the 🔒 main-protected indicator), `/bgsd-clean-branches`, and `/bgsd-abort`, so a user can read and drive a live run from the docs alone. (Plan Part 14, Part 16, Part 7.)

## Deferred (v3+) — Out of Scope for this Milestone

Tracked but explicitly NOT in the v2 roadmap. Promoted into Active scope only at a future milestone boundary. (v1 deferred items DEF-12..DEF-16/DEF-22 are now activated by v2; DEF-17..DEF-21 remain deferred.)

### Integration & Feedback (v3)

- **DEF-17 (v3)**: Loop 2 — integration verify→fix on the assembled `rehearsal/<run-id>`, the Integration Tester (whole-app UAT + code review of the integrated diff + alignment check + active scrutiny for improvements), `integration-report.json`, and parallel fix agents off the integration report re-merged in a Ralph loop. v2 only *assembles* `rehearsal/<run-id>` and checkpoints; it does not run Loop 2 over it. (Plan Part 5 Loop 2, Part 8 v3.)
- **DEF-18 (v3)**: User Review Gate — `/bgsd-user-eval` (auto-boot servers/backend + localhost URL + test checklist) and the per-subagent CHANGELOG wired into the PR body (v2 generates the CHANGELOG into the ledger but does not open a PR). (Plan Part 7, Part 10, Part 8 v3.)
- **DEF-19 (v3)**: `/bgsd-feedback "<what's wrong>" [--fast]` — re-run both loops on user feedback; `--fast` = parallel fix agents / single agent with no loops, no computer-use verification. (Plan Part 7, Part 1 §11, Part 8 v3.)
- **DEF-23 (v3+)**: Relaxing the v2 merge-boundary checkpoints toward true walk-away as trust accrues — v2 keeps every merge-boundary checkpoint mandatory. (Plan Part 8 v3.)

### Infrastructure (carried)

- **DEF-20 (v2+/ongoing)**: Upgrade-resilient subtree vendoring (`vendor/gsd/`), the `gsd-adapter/` module, `bgsd doctor`, seam contract tests against a GSD-version matrix, `gsd_contract_version` pin, self-updating cron with green-only interlock. v2 keeps the v0 marketplace-install path + the implicit seam usage; full ACL hardening continues post-v2. (Plan Part 12, Part 15.)
- **DEF-21 (v1 public / ongoing)**: Landing page (single Vercel-hosted page, the two-loop diagram, install command). Built at the public-release milestone; not gated on v2. (Plan Part 14.)

## Out of Scope (this milestone)

| Feature | Reason |
|---------|--------|
| Loop 2 (integration verify→fix) + Integration Tester + `integration-report.json` | v3; v2 only assembles `rehearsal/<run-id>` and checkpoints, no whole-app integration pass (Plan Part 5 Loop 2, Part 8 v3) |
| `/bgsd-user-eval`, `/bgsd-feedback`, per-agent CHANGELOG-into-PR | User Review Gate + feedback mode are v3; v2 writes the CHANGELOG into the ledger only (Plan Part 8 v3) |
| Auto-merging `rehearsal/<run-id>` → `next`, or relaxing merge-boundary checkpoints | Hard rule — only the human merges to `next`; v2 keeps every checkpoint mandatory (Plan Part 1 §9, Part 8 v2) |
| Running real concurrent headless `claude -p` processes in automated CI | Process spawning is human-gated for v2; live multi-process run flagged off-by-default, built-and-tested in isolation behind mocked spawns (NFR-08, SPAWN-04) |
| Full `gsd-adapter/` + contract-test matrix + self-update cron hardening | Carried infra (DEF-20); v2 reuses the v0/v1 seam usage and marketplace install |
| Landing page | v1-public/ongoing milestone (DEF-21), independent of v2 |

## Traceability

Each requirement maps to exactly one phase. NFRs are cross-cutting (apply to all phases). Phases are ordered hardest/riskiest-first (see ROADMAP.md). The live multi-process orchestration run is isolated into a single human-gated criterion (Phase 4) so the rest is buildable + unit-testable deterministically with mocked spawns.

| Requirement | Phase | Status |
|-------------|-------|--------|
| GRAPH-01 | Phase 1 | Pending |
| GRAPH-02 | Phase 1 | Pending |
| GRAPH-03 | Phase 1 | Pending |
| GRAPH-04 | Phase 1 | Pending |
| CTRL-01 | Phase 2 | Pending |
| CTRL-02 | Phase 2 | Pending |
| CTRL-03 | Phase 2 | Pending |
| CTRL-04 | Phase 2 | Pending |
| SPAWN-01 | Phase 3 | Pending |
| SPAWN-02 | Phase 3 | Pending |
| SPAWN-03 | Phase 3 | Pending |
| SPAWN-04 | Phase 4 | Pending |
| RUN-01 | Phase 4 | Pending |
| RUN-02 | Phase 4 | Pending |
| RUN-03 | Phase 4 | Pending |
| RUN-04 | Phase 4 | Pending |
| CONFLICT-01 | Phase 5 | Pending |
| CONFLICT-02 | Phase 5 | Pending |
| CONFLICT-03 | Phase 5 | Pending |
| CONFLICT-04 | Phase 5 | Pending |
| REHEARSE-01 | Phase 6 | Pending |
| REHEARSE-02 | Phase 6 | Pending |
| REHEARSE-03 | Phase 6 | Pending |
| REHEARSE-04 | Phase 6 | Pending |
| STATUS-01 | Phase 7 | Pending |
| STATUS-02 | Phase 7 | Pending |
| STATUS-03 | Phase 7 | Pending |
| STATUS-04 | Phase 7 | Pending |
| CTX-01 | Phase 8 | Pending |
| CTX-02 | Phase 8 | Pending |
| CTX-03 | Phase 8 | Pending |
| DOCS-05 | Phase 9 | Pending |
| DOCS-06 | Phase 9 | Pending |
| NFR-01..09 | All phases (cross-cutting) | Pending |

**Coverage:**
- v2 functional requirements: 33 total (RUN 4, GRAPH 4, SPAWN 4, CTRL 4, CONFLICT 4, REHEARSE 4, STATUS 4, CTX 3, DOCS 2)
- Mapped to phases: 33
- Unmapped: 0 ✓
- Non-functional constraints: 9 (cross-cutting, enforced across all phases)
- Human-gated requirements (built + tested in isolation behind mocked spawns; live run flagged off by default): **SPAWN-04** (live multi-process orchestration run — Phase 4 live-run criterion); plus the live-process portions of CTRL-02 (real restart), CONFLICT-03 (real merge-resolver invocation), and RUN-01/RUN-03 (real live lifecycle) which are exercised only under the same `--live` gate. Everything else is deterministic-buildable with mocked spawns/resolver.

**Note on counts:** SPAWN comprises SPAWN-01..04 (4 reqs); SPAWN-01..03 map to Phase 3 (deterministic worktree/scheduler logic) and SPAWN-04 (the human-gated live run) maps to Phase 4 (the run-lifecycle phase that owns the live `--live` criterion), keeping "one requirement → exactly one phase" while front-loading the highest-risk live wiring into the lifecycle phase.

---
*Requirements defined: 2026-06-29*
*Last updated: 2026-06-29 after initial v2 definition*
