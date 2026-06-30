# /bgsd-sesh — the Conductor session (the one front door)

> **Kiwi · bgsd Conductor — run a session**
> `/bgsd-sesh "<whatever I need>"` is the single entry point to bgsd. Kiwi, the
> Conductor, is always on. By default, the session **runs immediately** — classify,
> plan, and execute. Pass `--plan-only` (or `--dry-run`) to preview without running.
> Real merges and PRs are human-gated at merge-boundary checkpoints and never touch `main`.

You never invoke `/bgsd-verify`, `/bgsd-queue`, `/bgsd-run`, `/bgsd-integrate`,
`/bgsd-user-eval`, or `/bgsd-feedback` directly anymore. Those are now **internal
stages** that a session sequences (they remain available as advanced direct
access — see "Under the hood" below).

---

## Usage

```
/bgsd-sesh "<whatever I need>"  [--quick | --feature | --project]
```

```sh
# Auto-detect scale and EXECUTE (the default — no flag needed):
node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --prompt "Change the CTA button to 'Get started'"

# Force quick (no discussion, still verified) and execute:
node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --prompt "Fix the 404 on /pricing" --quick

# Force feature (decompose into 1-3 units, no discussion, still verified) and execute:
node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --prompt "Add a search bar to the header" --feature

# Force project (discuss first, full pipeline) and execute. Real merges/PRs are human-gated:
node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --prompt "Build a billing dashboard with Stripe" --project

# Preview only — classify + plan, zero boundaries invoked, nothing spawned:
node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --prompt "..." --plan-only
node "${CLAUDE_PLUGIN_ROOT}/scripts/session.mjs" --prompt "..." --dry-run   # alias for --plan-only
```

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code to the bgsd
> plugin's installed directory. The engine code always comes from there. Runtime
> output (`.bgsd/runs/…`, queue state, etc.) is written to the **current working
> repo** (your cwd). You can run `/bgsd-sesh` from ANY repo; bgsd's engine finds
> itself automatically.

---

## Flags (mutually exclusive)

| Flag | Mode | Meaning |
|------|------|---------|
| `--project` | `project` | **Forces** the full pipeline **and discussion first**: intake → brainstorm → oracle, then decompose → parallel pipeline → Loop 2 → review → PR. Executes immediately. |
| `--feature` | `feature` | **Forces** feature depth: decompose into 1-3 units, parallel execution, Loop 1 per worktree, merge, Loop 2, review, PR. No discussion. **Still verified.** Executes immediately. |
| `--quick` | `quick` | **Forces** small: one (or a few) small things, **no discussion**, **no pre-prepare**, fast, **still verified** (Loop 1 verify→fix is never skipped). Executes immediately. |
| *(none)* | `auto` | Kiwi **auto-detects** scale from the prompt and **executes** immediately. |
| `--plan-only` | preview | **Preview only.** Classify + print the depth plan; invoke zero boundaries. Nothing spawns or runs. |
| `--dry-run` | preview | **Alias for `--plan-only`.** Same preview behavior. |

**Manual flags are unconditional.** When you pass `--quick`, `--feature`, or
`--project`, the auto-scale thresholds are bypassed entirely. A `--feature` flag
on a tiny 1-unit prompt still produces a feature depth plan; a `--quick` flag on
a large prompt still forces the quick path. The flag is the contract.

Passing any two of `--quick`, `--feature`, `--project` together is a usage error.
A flag never disables verification and never lets bgsd write `main` or any production branch.

---

## How Kiwi picks the scale (auto mode)

Deterministic, zero required model calls. Kiwi reads cheap signals from the prompt:

- **route class** from `classify-item.mjs:classifyHeuristic` (trivial-fix / scoped-fix / feature / needs-clarification),
- **unit-count estimate** ≈ number of top-level work clauses (split on " and ", commas, semicolons, newlines, bullets),
- **surface breadth** = number of distinct named system areas (ui / api / db / auth / billing / deploy / …),
- **prompt length band**.

| Scale | Triggers (auto) |
|-------|-----------------|
| `quick` | trivial/scoped-fix **and** ≤ 2 estimated units **and** ≤ 1 surface. |
| `feature` | feature-ish, **or** 2–3 units / 2 surfaces; the **default** for ambiguous-but-classifiable work. |
| `project` | ≥ 4 units **or** ≥ 3 surfaces **or** a long feature prompt. |

If the prompt is too vague (`needs-clarification`), Kiwi asks **one** clarifying
question in chat and re-classifies — it never silently guesses a scale (NFR-06).
A marked Haiku seam may nudge a borderline case by at most one step; the
deterministic heuristic is always computed first and is the floor.

---

## The same pipeline, scaled — and **quick still verifies**

Every scale runs the same conceptual pipeline — *route/plan → execute →
**verify→fix** → (integrate) → (review) → record* — with depth dialed by scale.

| Stage | `quick` | `feature` | `project` |
|-------|---------|-----------|-----------|
| Discuss | — | — | **yes** (intake/brainstorm/oracle, with you, first) |
| Classify / Decompose | single item | small decompose (1–3 units) | full decompose → graph → waves |
| Execute | 1 agent | few agents, low concurrency | all wave agents, full concurrency |
| **Verify→Fix (Loop 1)** | **yes — never skipped** | **yes** | **yes** |
| Conflict + Merge | trivial | light | full dep-ordered |
| Integration (Loop 2) | — | if > 1 unit merged | **yes** |
| User Review Gate | one-line confirm | interactive | mandatory |
| Changelog / PR | optional | per-agent → PR | full → PR |

> **The non-negotiable invariant: quick still verifies.** A `quick` session can
> reach `done` only on a Tester **PASS**. FAIL → fix → re-verify (bounded);
> BLOCKED/ERROR → blocked; no-progress → failed. There is no path where a quick
> change is reported done without a Tester pass. The only things quick drops are
> the *discussion*, the *parallel fan-out*, the *integration Loop 2*, and the
> *mandatory* review gate — never verification.

---

## The always-on, non-blocking session

A session is a live, fully async loop. Nothing about it blocks the conversation:

1. **Live tracking.** The session continuously renders the Kiwi live view
   (`status.mjs:renderStatus`): per-agent status, stage/wave, what's happening,
   the budget/context telemetry, and the constant 🔒 **main-protected** footer.
2. **Interject anytime.** A user-message inbox
   (`.bgsd/runs/<id>/session-inbox/`) is read **between orchestration steps**. A
   message you drop in is **ingested without halting** any agent — it can add or
   adjust work, or answer a pending question. Agents keep orchestrating.
3. **Non-blocking questions.** When Kiwi must ask you (the oracle abstains), it
   posts the question to the live view + the escalation inbox and marks **only
   the dependent unit** `needs_input` (via `control.mjs`). **Every other unit
   keeps progressing.** It is never a global blocking prompt. Your answer (via
   the inbox) unblocks just that one unit.

Most downstream questions never reach you: the oracle (`oracle.mjs:answerQuestion`)
auto-answers from the sealed spec + decisions + profile, and the rare leftovers
are **batched** non-blockingly via `escalate.mjs`.

---

## BLOCKED behavior (hard stop — no silent fallback)

If the session harness cannot run, **STOP immediately** and emit a loud blocked
message. Do NOT attempt to "handle the task directly", edit files by hand, or
silently skip the pipeline. The only valid responses are:

```
BLOCKED: <reason>
Remedy: <what the user must do to fix it>
```

Common blocked conditions:

| Condition | BLOCKED message |
|-----------|-----------------|
| `node` not found or node error on `session.mjs` | `BLOCKED: Cannot invoke session harness — node error: <error>. Remedy: ensure Node 18+ is on PATH and the bgsd plugin is installed.` |
| `${CLAUDE_PLUGIN_ROOT}` is unset or empty | `BLOCKED: CLAUDE_PLUGIN_ROOT is not set — bgsd plugin root is unknown. Remedy: ensure bgsd is installed as a Claude Code plugin and the session is started from Claude Code (not a bare shell).` |
| Playwright MCP unavailable (for the verify step) | `BLOCKED: @playwright/mcp is not available — cannot run UI verification. Remedy: install and enable the Playwright MCP server, then retry.` |

**Never silently bypass the pipeline.** If an error occurs mid-session, surface it
as a BLOCKED or FAILED status in the live view and stop. A silent "I'll just do it
manually" path does not exist.

---

## Safety (inherited, never relaxed)

- **Sessions run by default; `--plan-only` / `--dry-run` previews.** The default
  run executes the orchestration pipeline, but real irreversible actions (git merge,
  gh pr create) are human-gated at merge-boundary checkpoints. They require the
  explicit `--live` opt-in on the underlying `*-live.mjs` module.
- **`main` is never written.** Every real boundary keeps its existing
  `requireLiveFlag()` / `requireNotProductionBranch` / `requireNotDefaultBranch` guard.
  bgsd assembles into the standing `next` branch; only you merge `next` → `main` by hand.
- **No silent green.** Verification is never skipped; the review gate is never
  auto-passed; escalations surface a real question rather than a guess.

---

## Under the hood (advanced direct access)

The old commands still work and map to internal session stages:

| Command | Internal role |
|---------|---------------|
| `/bgsd-verify` | the verify step inside Loop 1 / Loop 2 |
| `/bgsd-queue` | quick-scale work intake + drainer |
| `/bgsd-run` | feature/project lifecycle (`run.mjs`) |
| `/bgsd-integrate` | Loop 2 integration stage |
| `/bgsd-user-eval` | the User Review Gate, surfaced in chat |
| `/bgsd-feedback` | feedback ingestion when you report an issue mid-session |
| `/bgsd-changelog` | CHANGELOG → PR assembly |
| `/bgsd-status` | the always-on live view, shown continuously |
