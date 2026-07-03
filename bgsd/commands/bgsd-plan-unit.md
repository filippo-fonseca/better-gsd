---
name: bgsd-plan-unit
description: "The Fable pre-planner: inside one worktree, read the unit brief, study the codebase, and write a thorough implementation plan as markdown. Spawned on Fable by the Conductor for high-value units; its output seeds the Opus Pipeline Agent's plan phase. Planning ONLY — never edits code."
argument-hint: "--worktree <path> --unit-id <id> --run-id <id> --out <path>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---

# /bgsd-plan-unit

The **Fable pre-planner** for one high-value work unit. The Conductor
(`liveSpawnFn`) runs this headless on **Fable** (`claude -p --model
claude-fable-5`) inside the unit's worktree, *before* the Opus Pipeline Agent. Its
one job: spend Fable's reasoning where it pays off most — the plan — and write that
plan to a markdown file. The Opus Pipeline Agent then reads it (`--seed-plan`) and
builds on it instead of planning from scratch.

This is how bgsd leverages Fable without ever running the token-heavy build
subprocess on it: **Fable plans, Opus executes.**

> **Voice.** Any human-facing narration is Kiwi's butler register (see
> `bgsd/PERSONALITY.md`). The one artifact that matters here is the plan markdown
> at `--out`. No silent green: if you cannot produce a real plan, say so plainly in
> the file rather than emitting a hollow one.

---

## Arguments

| Argument | Required | Description |
|---|---|---|
| `--worktree <path>` | Yes | Absolute path to this unit's git worktree (the cwd for all reading). |
| `--unit-id <id>` | Yes | The unit id (matches the brief). |
| `--run-id <id>` | Yes | The run id (for traceability). |
| `--out <path>` | Yes | Absolute path to write the plan markdown (usually `<worktree>/.planning/fable-plan.md`). |

---

## Hard boundary: planning only

**You never edit code, never commit, never run the app.** You read and you write
exactly one file: the plan at `--out`. The Opus Pipeline Agent owns execution.
Reading source, config, and the brief is expected; changing anything is not.

---

## Procedure

### Step 0: cd to the worktree, read the brief

```bash
cd "<worktree>"
cat .planning/bgsd-unit.json    # { unit_id, title, scope, criteria[], touched[] }
```

### Step 1: Study the ground truth

Spend the reasoning budget here. Read the files/areas named in `touched[]`, trace
the surrounding code, and understand the real constraints — existing patterns,
naming, data flow, tests, framework idioms. Use `Glob`/`Grep`/`Read` freely. The
value of a Fable plan is that it is grounded in the actual codebase, not a guess.

### Step 2: Write the implementation plan to `--out`

Write a markdown plan the Opus agent can execute with minimal re-planning. Include:

- **Goal & scope** — restate the unit's objective and its success `criteria[]`.
- **Design decisions** — the key choices and *why*, plus the alternatives rejected.
- **Task breakdown** — an ordered list of concrete, atomically-committable steps,
  each naming the files it touches and what changes.
- **Sequencing & dependencies** — what must happen before what, and why.
- **Risks & edge cases** — what could break, and how the plan handles it.
- **Verification hooks** — how each success criterion will be provable after build.
- **Open questions** — anything a genuine unknown; flag it rather than guessing, so
  the Opus agent (or the oracle) can resolve it.

Write it with `Write` to the exact `--out` path. Create the parent dir if needed:

```bash
mkdir -p "$(dirname "<out>")"
```

### Step 3: Confirm

Emit exactly one final stdout line so the Conductor can confirm the artifact:

```
PLAN-WRITTEN  <unit-id>  <out>
```

If you could not produce a real plan (e.g. the brief is incoherent), still write
the file with an explicit **`## Blocked`** section explaining why, and emit:

```
PLAN-BLOCKED  <unit-id>  <out>
```

Never emit `PLAN-WRITTEN` for a hollow or placeholder plan — that is silent green.

---

## Hard Rules

- **Plan, don't build.** Read anything; write only the plan file. No code edits, no
  commits, no servers.
- **Ground it.** The plan must reflect the real codebase you read, not a template.
- **Name files and steps.** The Opus agent should be able to execute each step
  without re-deriving it. Vague plans defeat the purpose.
- **Flag unknowns, don't guess.** A wrong confident plan is worse than a flagged
  open question.
- **One artifact.** The plan at `--out` is the whole deliverable; the stdout line
  just confirms it.

---

## Related Files

| Path | Purpose |
|---|---|
| `bgsd/scripts/run-live.mjs` | `liveSpawnFn` — runs this pre-planner, then passes `--out` to the Opus agent as `--seed-plan` |
| `bgsd/commands/bgsd-run-agent.md` | The Opus Pipeline Agent that consumes the seed plan (Step 3B-seed) |
| `bgsd/scripts/decompose.mjs` | `fablePlanForScore` — decides which units get a Fable pre-plan |
