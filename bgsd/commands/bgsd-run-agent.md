---
name: bgsd-run-agent
description: "The pipeline-agent brain: inside one worktree, read the unit's per-unit phase config and run the tailored GSD flow (or a direct fix for quick units), proxying human questions to the oracle. Spawned by the Conductor, one per unit."
argument-hint: "--worktree <path> --unit-id <id> --run-id <id> --control-file <path> [--scale <quick|feature|project>] [--seed-plan <path>]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Skill
  - Agent
---

# /bgsd-run-agent

The **Pipeline Agent** for one work unit. The Conductor (`liveSpawnFn`) creates a
git worktree for the unit, writes its `.planning/config.json` (the per-unit
`bgsd_phase_config` + `bgsd_unit_posture` seams) and a `.planning/bgsd-unit.json`
brief, then spawns this command headless inside that worktree. Everything below
runs against the unit's **isolated** branch + port + DB — never the main repo.

> **Voice.** Human-facing narration is Kiwi's butler register (see
> `bgsd/PERSONALITY.md`). Structured outputs (control-file JSON, the stdout
> verdict line) never change. No silent green: a failure is reported honestly.

This is the seam that makes the Loop-1 Pipeline Agents in the two-loop
architecture actually run GSD — dynamically tailored per unit, not one-size-fits-all.

---

## Arguments

| Argument | Required | Description |
|---|---|---|
| `--worktree <path>` | Yes | Absolute path to this unit's git worktree (the cwd for all work). |
| `--unit-id <id>` | Yes | The unit id (matches the control file and the brief). |
| `--run-id <id>` | Yes | The run id (for control-file + artifact paths). |
| `--control-file <path>` | Yes | **Absolute** path to `<repo>/.bgsd/runs/<run-id>/control/<unit-id>.json` in the MAIN repo (worktrees don't carry the gitignored `.bgsd/runs/`, so the Conductor passes the absolute path). |
| `--scale <quick\|feature\|project>` | No | Session scale. `quick` forces the direct-fix path regardless of config. |
| `--port <n>` | No | The unit's isolated dev-server port (for any in-agent verification). |
| `--seed-plan <path>` | No | Path to a **Fable-produced** plan markdown (usually `.planning/fable-plan.md`). When present, the plan phase treats it as the **authoritative starting plan** — this Opus agent reviews and augments it rather than planning from scratch. The costly Fable reasoning already ran upstream; do not re-do it. |

---

## What decides whether GSD runs

**Scale gates GSD; per-unit config tailors it.** A `quick`/fix unit never went
through decompose, so it has no `bgsd_phase_config` — the Pipeline Agent just
makes the change directly. `feature`/`project` units carry a `bgsd_phase_config`
the Conductor derived from difficulty + touched-area (`phaseconfig.mjs`), and this
agent runs exactly the GSD phases it turns on:

- `ui_phase` → run `/gsd-ui-phase` (produce the UI-SPEC) **before** planning.
- `ai_integration_phase` → run `/gsd-ai-integration-phase` (AI-SPEC) before planning.
- always → `/gsd-plan-phase` then `/gsd-execute-phase`.
- `research` / `plan_check` → honored **inside** plan-phase via the GSD `workflow`
  toggles this agent writes into config.
- `code_review` → run `/gsd-code-review` after execute.

The `phaseconfig.mjs --plan` CLI resolves all of this deterministically, so this
agent never guesses the phase order.

---

## Orchestration Procedure

### Step 0: Parse args, cd to the worktree

```bash
cd "<worktree>"
```

All work happens here. Never write outside this worktree except the control file
at its absolute `--control-file` path.

---

### Step 1: Announce running on the control file

Ensure the control file exists and mark the agent running. (The Conductor creates
it at spawn; this is idempotent and also covers a resumed relaunch.)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs" update \
  --path "<control-file>" --status running --phase plan --note "pipeline agent started"
```

Update the control file at each phase transition (`--phase ui|plan|execute|verify`,
`--note "<what you're doing>"`, `--commit <sha>` as you commit) so the live view
and the scheduler track this unit. Heartbeat by updating on every phase change.

---

### Step 2: Resolve the phase plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseconfig.mjs" --plan .planning --scale <scale>
```

This prints JSON: `{ mode, workflow, phases }`.

- `mode: "direct"` → go to **Step 3A** (direct fix, no GSD).
- `mode: "gsd"` → go to **Step 3B** (run the listed `phases` in order).

Read the unit brief for what to build:

```bash
cat .planning/bgsd-unit.json    # { unit_id, title, scope, criteria[], touched[] }
```

---

### Step 3A: Direct-fix path (quick / fix units)

No GSD. Implement the change described by the brief directly:

1. Make the smallest correct edit that satisfies `title` + `scope` + `criteria`.
2. Commit atomically with a clear message.
3. Record the commit: `control.mjs update --path <cf> --phase execute --commit <sha>`.

Then go to **Step 4**. (Loop 1 verify still runs after this agent exits — "no GSD"
never means "unverified.")

---

### Step 3B: GSD path (feature / project units)

**First, hand GSD its workflow toggles** so research / plan_check / code_review are
honored inside the phases. Write the `workflow` object from Step 2 into the GSD
config (this is GSD's own config key; it coexists with the bgsd seams):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseconfig.mjs" --plan .planning --scale <scale> \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);if(p.workflow){const fs=require("fs");const cp=".planning/config.json";const c=fs.existsSync(cp)?JSON.parse(fs.readFileSync(cp,"utf8")):{};c.workflow={...(c.workflow||{}),...p.workflow};fs.writeFileSync(cp,JSON.stringify(c,null,2))}})'
```

Then run each phase in `phases` order, updating the control file phase as you go.
For each `{ id, command }`:

| Phase id | Skill to invoke | Control `--phase` |
|---|---|---|
| `ui-phase` | `/gsd-ui-phase` | `ui` |
| `ai-integration-phase` | `/gsd-ai-integration-phase` | `plan` |
| `plan` | `/gsd-plan-phase` | `plan` |
| `execute` | `/gsd-execute-phase` | `execute` |
| `code-review` | `/gsd-code-review` | `verify` |

Invoke each via the Skill tool, scoped to this worktree's `.planning/`. GSD writes
its phase artifacts (UI-SPEC.md, PLAN.md, commits) into the worktree. Skip any
phase not in the list — that is the per-unit tailoring working as designed.

---

### Step 3B-seed: If a Fable pre-plan exists, build on it — don't re-plan

If `--seed-plan <path>` was passed and the file exists, a **Fable planner already
did the deep, high-value planning** for this unit and wrote it as markdown. You are
on Opus; your job at the plan phase is to **review, validate, and augment** that
plan, not to regenerate it from scratch (that would waste the tokens we spent on
Fable precisely to avoid).

```bash
test -n "<seed-plan>" && test -f "<seed-plan>" && cat "<seed-plan>"
```

1. Read the seed plan in full. Treat its task breakdown, sequencing, and design
   decisions as the **authoritative starting point**.
2. Reconcile it against the unit brief (`.planning/bgsd-unit.json`) and the live
   codebase. Only change the plan where it is wrong, stale, or missing a concrete
   step — and note *why* when you do.
3. Carry the reconciled plan into `/gsd-plan-phase` as its basis (write it through
   to `PLAN.md`), so execute runs against the Fable-grade plan. Do **not** discard
   it and start over.

If `--seed-plan` was not passed (or the file is absent), plan normally on Opus.

---

### Step 3B-oracle: Answer GSD's human questions as the user's proxy

GSD phases (discuss / plan) raise questions that normally block on a human. **Do
not block.** Answer them yourself from the sealed context, exactly as the Conductor
would:

1. Load the decision oracle if this run has one (project scale builds it at
   intake/brainstorm):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/oracle.mjs" --answer \
     --run-id <run-id> --phase <phase> --question "<the GSD question>"
   ```

   It returns either `auto_answer` (confidence ≥ threshold, with the answer +
   source) or `escalate`.

2. On `auto_answer` → feed that answer back into the GSD phase and continue.
3. On `escalate` (or no oracle store, e.g. a feature-scale run) → answer from the
   unit brief + `.planning/` decisions if you confidently can. If it is a genuine
   unknown you must not guess, **park this unit** and escalate non-blockingly:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs" update \
     --path "<control-file>" --status needs_input --phase plan \
     --note "escalated: <one-line question>"
   ```

   The Conductor batches escalations to the human via `escalate.mjs`; every other
   unit keeps progressing. When the answer arrives, resume from this phase.

Never fabricate a decision on a high-stakes unknown just to keep moving.

---

### Step 4: Finish — mark the unit done (or failed)

On success (all phases ran, changes committed):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs" update \
  --path "<control-file>" --status done --phase done --note "unit complete"
echo "DONE  <unit-id>"
```

On an unrecoverable failure:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs" update \
  --path "<control-file>" --status failed --phase failed --note "<why>"
echo "FAILED  <unit-id>"
```

stdout is exactly one final line: `DONE <unit-id>` or `FAILED <unit-id>`. The
Conductor's Loop 1 then runs verify→fix on this worktree before any merge.

---

## Hard Rules

- **Scale gates GSD.** Quick/fix units take the direct path; feature/project units
  run the tailored GSD phases. Never run full GSD on a quick unit, never skip GSD
  on a feature/project unit.
- **Per-unit tailoring is authoritative.** Run exactly the phases `phaseconfig.mjs
  --plan` lists — no more, no less. The Conductor already decided.
- **Proxy, don't block.** Answer GSD's questions from sealed context; escalate only
  true unknowns, and non-blockingly (park just this unit).
- **Stay in the worktree.** All work is on the unit's isolated branch. The only
  write outside is the control file at its absolute path. Never touch `next`/main.
- **No silent green.** A failed unit ends `failed`, never `done`.

---

## Quick Reference: Script Invocations

| Step | Script | Purpose |
|---|---|---|
| 1,4 | `control.mjs create\|update` | Manage this unit's control file |
| 2,3B | `phaseconfig.mjs --plan .planning --scale <s>` | Resolve the ordered phase plan + workflow toggles |
| 3B | Skill: `/gsd-ui-phase`, `/gsd-ai-integration-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-code-review` | Run the tailored GSD phases |
| 3B-oracle | `oracle.mjs --answer` | Auto-answer GSD questions as the user's proxy |

---

## Related Files

| Path | Purpose |
|---|---|
| `bgsd/scripts/phaseconfig.mjs` | Derives + resolves the per-unit phase plan (`resolvePhasePlan`) |
| `bgsd/scripts/control.mjs` | Agent control-file protocol + CLI |
| `bgsd/scripts/oracle.mjs` | Decision oracle — auto-answers discuss questions from sealed context |
| `bgsd/scripts/run-live.mjs` | `liveSpawnFn` — creates the worktree + config + brief and spawns this command |
| `bgsd/commands/bgsd-plan-unit.md` | The Fable pre-planner whose markdown arrives here as `--seed-plan` (Step 3B-seed) |
| `bgsd/scripts/decompose.mjs` | `writeUnitWorktreeConfig` — writes the two per-unit config seams |
