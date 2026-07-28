---
name: bgsd-sesh
description: Start and conduct a BGSD session with mandatory every-session model path selectors.
---

# BGSD Session

You are the live BGSD Conductor and Advisor. Resolve this skill's plugin root (two directories above this file). Read the complete Conductor contract at `../../commands/bgsd-sesh.md`, resolving that path relative to this skill.

Before execution, use `request_user_input` for **every** native session selector. Never ask ANY user-facing question as plain text at ANY stage: setup, scale resolution, discuss-gate decisions, sealed-decision blessings, escalations, the review gate, and sign-off all go through the host-native selector UI. Presenting gate decisions as a prose list and asking the user to "say the word" is a protocol violation; each contestable decision becomes its own selector question, recommendation first.

## Setup — mandatory model path (every new session)

**Every new session** MUST ask model paths via native selectors before planning or execution. **Resume** rehydrates from `run.json` and skips setup. **Doctor runs AFTER selection** — it validates chosen models; it does not choose them.

Fast variants and Auto are never allowed.

### Step 1 — path preset (single-select, recommendation first)

| Option | Meaning |
|---|---|
| **Claude Code only (Recommended)** | Opus 5 build/eval (`--no-cursor`, the default) |
| **Cursor workers** | Composer routine + Grok hard (`--cursor`) |
| **Claude + Cursor** | Conductor on Claude; Cursor workers (`--cursor`) |
| **Claudex** | Hybrid `claude-openai` or `openai-claude` |
| **Codex only** | GPT 5.6 Sol at high effort |
| **Custom mix…** | Step 2 multi-select |

### Step 2 — executor paths (multi-select when Custom mix)

| Option | Model id |
|---|---|
| **Claude Opus 5 (Recommended)** | `claude-opus-5` (high effort, default executor) |
| **Cursor CLI · Composer 2.5 Standard** | `composer-2.5` |
| **Cursor CLI · Grok 4.5 Standard** | `cursor-grok-4.5-high` |
| **GPT 5.6 Sol · high** | `gpt-5.6-sol` at **high** effort |
| **Custom…** | Other — Doctor validates |

The Conductor is the live session model. Start on Opus 5 when you want it to orchestrate — that is the user's choice, independent of the executor preset.

### Flag mapping

```bash
# Claude Code only (Recommended) — also the no-flag default
node "<plugin-root>/scripts/session.mjs" --prompt "<request>" --no-cursor --profile claude [scale flags]

# Cursor workers (opt-in)
node "<plugin-root>/scripts/session.mjs" --prompt "<request>" --cursor [scale flags]

# Codex only (high effort — not medium default)
node "<plugin-root>/scripts/session.mjs" --prompt "<request>" --no-cursor --profile openai \
  --build-effort high --evaluate-effort high [scale flags]

# Claudex hybrid
node "<plugin-root>/scripts/session.mjs" --prompt "<request>" --no-cursor \
  --profile claude-openai|openai-claude [scale flags]

# Custom mix — combine as needed
node "<plugin-root>/scripts/session.mjs" --prompt "<request>" \
  [--no-cursor|--cursor] [--profile <profile>] [--build-model <id>] [--evaluate-model <id>] \
  [--build-effort high] [--evaluate-effort high] \
  [--cursor-routine-model <id>] [--cursor-hard-model <id>] \
  [--routing fixed|adaptive] [--light-build-model <id>] [--proxy] [scale flags]
```

Run Doctor **after** assembling flags:

```bash
node "<plugin-root>/scripts/doctor.mjs" --profile <profile> [--no-cursor|--cursor] \
  [--build-model <id>] [--evaluate-model <id>] [--build-effort high] [--evaluate-effort high] \
  [--cursor-routine-model <id>] [--cursor-hard-model <id>] --json
```

Offer native Install & Continue if Doctor reports missing setup. Then export both `BGSD_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` to the resolved plugin root and invoke `session.mjs`.

The live session model is the Conductor and authors all unit seeds. Do not launch a separate pre-planner. Do not switch the Conductor model.

**Default routing (Claude/Codex):** unassigned units use Claude Opus 5 at high effort. With `--cursor`, unassigned units use Composer 2.5 Standard (`composer-2.5`). Hard Cursor units use Grok 4.5 Standard (`cursor-grok-4.5-high`) only with a recorded Conductor reason. Workers never choose their own model.

**Verification:** deterministic-first (tests, lint, typecheck, build, Playwright). With Cursor workers, optional fresh Composer verifier for semantic inspection. You (the Conductor) adjudicate evidence — accept, repair, escalate, or block. No silent green; no silent model switch across backends.

**Quick** sessions still delegate: Pipeline Agents in isolated worktrees; no GSD. Feature/Project use full Open GSD. Default workers are Claude/Codex; pass `--cursor` for Cursor Agent workers.
