# /bgsd-sesh — the Conductor session (the one front door)

> **Kiwi · bgsd Conductor — run a session**
> `/bgsd-sesh "<whatever I need>"` is the single entry point to bgsd. Kiwi, the
> Conductor, is always on. By default, the session **runs immediately** — classify,
> plan, and execute. Pass `--plan-only` (or `--dry-run`) to preview without running.
> Real merges and PRs are human-gated at merge-boundary checkpoints and never touch `main`.

**Voice:** lead **every** message you send in this session with the Markdown pill
`🥝 **kiwi · conductor**` (on its own line), so the user always sees the message is
from the Conductor. This is a chat/Markdown badge you type yourself, not the ANSI
`kiwiPill()` helper (that one is for terminal script output and does not render in
chat). Keep structured outputs (verdict lines, JSON, status signals) literal and
pill-free. See `bgsd/PERSONALITY.md`.

**Name the workspace at the start.** As one of the first things you do when a
session begins, label this Claude Code terminal so parallel sessions are easy to
tell apart: run **`/rename`** to set an apt name (e.g. `bgsd · <2 to 4 word task
summary>`, drawn from the prompt) and **`/color`** to set a **random** color (pick
one at random each session). Do this once, up front, right after the splash. If
either command is not available in this harness, skip it silently and carry on,
it is a nicety, never a blocker.

You never invoke `/bgsd-verify`, `/bgsd-queue`, `/bgsd-run`, `/bgsd-integrate`,
`/bgsd-user-eval`, or `/bgsd-feedback` directly anymore. Those are now **internal
stages** that a session sequences (they remain available as advanced direct
access — see "Under the hood" below).

---

## Usage

```
/bgsd-sesh "<whatever I need>"  [--quick | --feature | --project]
/bgsd-sesh                       # no prompt → Kiwi proposes the next backlog item
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

## Verification depth — `--no-usage-verification` (orthogonal)

bgsd verifies in two depths. The goal-backward **code verification** (the
gsd-verifier: "did it build what was asked, is everything proper") **always
runs** — that is the floor, and "no silent green" depends on it. The heavier
**Playwright usage testing** (the Tester driving the real app: console → network
→ DOM → vision) is the part you can turn off.

| Flag | Effect |
|------|--------|
| *(default)* | **Full** verification: gsd-verifier code check **plus** Playwright usage testing. |
| `--no-usage-verification` | **Code-only:** still runs the gsd-verifier against the unit's criteria, but **skips the Playwright UI usage testing**. For a quick fix or a non-UI change that doesn't need browser testing. |

It is orthogonal to `--quick`/`--feature`/`--project` (combine freely), and it
propagates to **every** worktree Pipeline Agent and the Loop 2 integration Tester
via `BGSD_USAGE_TESTING`. Persist it as the repo default with the
`verification.usage_testing` knob in `BGSD.md`.

**Kiwi can toggle it for you, any time.** Tell Kiwi "stop UI-testing quick fixes"
or "turn usage testing back on" and it edits `verification.usage_testing` in
`BGSD.md` itself (via `bgsdmd.mjs:editSettingLive`) and reports the change — the
same way Claude Code edits its own settings. Set it per-session with the flag, or
per-repo by telling Kiwi.

---

## Modes, headless UI, and the planning selector

Two more orthogonal knobs, plus how Kiwi opens a session.

**Execution modes (per role, three levels).** Pipeline agents and verifiers each
run in one of three modes:

| Mode | Pipeline agents | Verifiers |
|------|-----------------|-----------|
| `fast` | skip research, go straight to plan/execute | code-only, quick checks |
| `thorough` | research every unit before planning | full driver ladder every time |
| `adaptive` | **the Conductor decides per unit and adapts** | **decides per unit** |

`adaptive` is the **default and recommended** setting: Kiwi sizes each unit and
gives the hard ones research while trivial ones skip it. Override per-session
with `--mode <fast|thorough|adaptive>` (pipeline) and `--verify-mode <…>`
(verifiers), or persist in `BGSD.md` under `modes`.

**Headless UI.** `--headless-ui` runs Playwright **headless**: no visible browser
or server window pops up on your machine (discreet). It is orthogonal to
`--no-usage-verification` (that decides *whether* the Playwright rung runs;
headless decides *how* it runs). Persist as `verification.headless` in `BGSD.md`.
Both propagate to every Tester via `BGSD_HEADLESS_UI`.

**Ask at the start.** When you open a session (especially at project scale),
present a short **AskUserQuestion selector** for how thorough to be, before fan-out:
the pipeline mode (Fast / Thorough / Adaptive-recommended) and, if it matters,
the verifier mode, with Adaptive pre-selected. The user can also just accept the
defaults. This is the GSD-style "how thorough do you want planning" prompt.

**Precedence (absolute).** A manually-passed flag ALWAYS wins, above everything:
flag > `BGSD.md` config > default. Kiwi never overrides a flag the user typed.

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
question with an **AskUserQuestion selector** (see "How Kiwi asks you things"
below) and re-classifies; it never silently guesses a scale (NFR-06).
A marked Haiku seam may nudge a borderline case by at most one step; the
deterministic heuristic is always computed first and is the floor.

---

## Starting with no prompt — the backlog

You don't always have to type what to build. bgsd keeps a persistent **backlog**
(the queue at `.bgsd/queue/queue.json`) so scope you defer is never lost, and so
you can open a session with nothing to say and let Kiwi pull the next thing.

**Run `/bgsd-sesh` with no prompt.** Kiwi looks at the backlog first:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" peek   # the next queued item, or "(empty …)"
```

- **Backlog has a next item** → Kiwi proposes it with an AskUserQuestion selector:
  **Start «title»** / **Pick a different backlog item** / *(type a new prompt)*.
  On confirm, Kiwi runs a normal, properly-scaled session using that item's
  title + body as the prompt. When that session reaches `done`, Kiwi marks the
  item resolved so the backlog drains and never re-proposes it:

  ```sh
  node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" done <item-id> --note "ran sesh <id>"
  ```

  If the session fails or is abandoned, Kiwi leaves the item `queued` so it
  surfaces again next time.
- **Backlog is empty** → Kiwi asks (selector) what you'd like to build, with a
  free-text option to just type it.

**Deferring scope mid-session.** Whenever you and Kiwi agree to push a piece of
scope to later ("scope #165's filter/sort later, not urgent"), Kiwi **enqueues
it** instead of dropping it, and says so ("Queued for later — it's in the
backlog."):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" add \
  --title "Notion properties: filter & sort" \
  --body  "Deferred from this sesh; MVP shipped add/edit fields, filter+sort still open." \
  --source "defer:#165"
```

**At the end of every session.** When a session reaches its terminal state, if
the backlog is non-empty Kiwi proposes the next item the same way — **Start
next: «title»** / **Stop here** / *(something else)* — so the queue drains
naturally across sessions without you re-typing anything. The full loop: defer →
backlog → next sesh (or end-of-sesh) picks it up.

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

## The live dashboard — `--gui` (open and close on command)

Pass `--gui` to open a local web dashboard that tracks the whole pipeline live:
the parallel Loop 1 Pipeline Agents, the Verification lane, the Loop 2
Integrator, and the Review Gate, each card showing the agent's GSD substage,
status, and progress. Above the lanes, a **pipeline timeline** (Discuss →
Decompose → Loop 1 → Merge → Loop 2 → Review) shows where the run is **even
before any agent spawns**, so intake, discussion, and decomposition are visible.
As you move through the pipeline, advance the stage so the dashboard keeps up
(`gui-live.mjs stage <name> --note "..."`) AND register each agent you spawn
(`gui-live.mjs agent <id> --unit "<u>" --phase <p> --status running`), updating
it as it advances. Without those calls the board shows "idle"; with them it
reflects the real fan-out. The dashboard refreshes
on its own (polls every 1.5s) and reads only run state (read-only; it never
touches git or `main`).

```
/bgsd-sesh "…" --gui      # run the session and open the dashboard
```

**It opens automatically — no fumbling, no confirmation.** Two triggers, and both
open it immediately:

1. **`--gui` is passed** → the session harness spawns the dashboard itself and
   prints the URL. You do nothing.
2. **You tell Kiwi to open it** ("open the gui", "open the dashboard", "show me
   the dashboard") at any point, before, during, or after fan-out → Kiwi runs
   `gui-live.mjs start` **right away** (detached, in the background) and hands you
   the clickable `http://localhost:<port>`. It does not ask whether to open it, it
   just opens it and gives you the link.

Tell it "close the gui" and it runs `gui-live.mjs stop`. Kiwi opens or closes it
at any point in a session. See `/bgsd-gui` for the full command. As always, Kiwi
gives the full URL to click, never a bare port.

---

## Brand every subagent (emoji + role + model)

When you spawn ANY subagent (a Pipeline Agent, researcher, Tester, integrator,
reviewer, or a helper like Explore), give it a **consistent, branded label** so
the user can tell at a glance what it is, which unit it owns, and what model it
runs, the way GSD tags its agents. The task **description** you pass is what shows
in the Claude Code UI, so make it: `<emoji> <Role> · <unit> (<model>)`.

| Role | Emoji | Example description |
|------|-------|---------------------|
| Conductor (you) | 🥝 | `🥝 Kiwi · conductor` |
| Pipeline Agent (executor) | 🔧 | `🔧 Pipeline · search-bar (opus/xhigh)` |
| Researcher | 🔎 | `🔎 Research · search-bar (sonnet)` |
| UI designer | 🎨 | `🎨 UI · header (opus)` |
| Tester (usage verify) | 🧪 | `🧪 Tester · search-bar` |
| Verifier (code / gsd) | ⚖️ | `⚖️ Verify · search-bar` |
| Integrator (Loop 2) | 🔀 | `🔀 Integrator · next` |
| Reviewer (gate) | 📋 | `📋 Review · next` |

Keep it uniform across the whole fan-out so a wave of agents reads as one branded
set. (The colored background on the agent tag is Claude Code's own rendering; the
emoji + role + model is the part bgsd controls, and it is what makes them
recognizable.) Use the same emoji when you register the agent on the dashboard
(`gui-live.mjs agent …`) so the terminal and the dashboard match.

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
   surfaces the question as an **AskUserQuestion selector** in the live view +
   the escalation inbox and marks **only the dependent unit** `needs_input` (via
   `control.mjs`). **Every other unit keeps progressing.** It is never a global
   blocking prompt. Your answer unblocks just that one unit.

Most downstream questions never reach you: the oracle (`oracle.mjs:answerQuestion`)
auto-answers from the sealed spec + decisions + profile, and the rare leftovers
are **batched** non-blockingly via `escalate.mjs`.

---

## How Kiwi asks you things — always a selector, never a wall of prose

Whenever Kiwi needs an answer from you, it asks with the **AskUserQuestion**
tool: a GSD-style arrow-key selector with a few concrete options, and you can
always type your own answer as the last choice. This is the one way Kiwi asks —
a vague prompt to disambiguate, a scale to confirm, a gray-area decision the
oracle escalated, the review gate, or "which backlog item next." Kiwi never
buries a question in a paragraph of prose when a selector fits.

- **At most 4 options — hard limit.** AskUserQuestion accepts **2 to 4** options
  per question; passing 5 or more fails with "Invalid tool parameters." Never
  author a question with more than 4 choices. If a decision has more than four
  candidates, **bundle them into 4 or fewer** coherent options up front (group
  related choices, or offer presets) and let the user refine via type-your-own.
  Do not emit 5 and correct after the error. This matches the shape
  `escalate.mjs:buildEscalationBatch` enforces (`options[2–4]` + a free-text
  `other`); render each escalation-batch item as one AskUserQuestion call.
- **Type-your-own is always available** and does not count toward the 4: it is
  the tool's built-in free-text answer, so you get up to 4 presets plus "type
  your own." You are never boxed into the presented choices.
- **One decision per question.** Independent decisions become separate
  AskUserQuestion items, not one compound prose question.
- Worker questions still pass through the oracle first; only genuine escalations
  reach you, and when they do, they reach you as a selector.

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
  bgsd assembles into the standing `next` branch. On approval Kiwi **opens the
  `next → main` landing PR for you automatically** (files the unit issues, adds
  `Closes #…`, hands you the PR link), but it **never merges** it: the
  `next → main` merge is yours, always. Kiwi does not ask whether to open the PR
  and does not offer to merge.
- **No silent green.** Verification is never skipped; the review gate is never
  auto-passed; escalations surface a real question rather than a guess.
- **Clickable URLs, never bare ports.** Whenever Kiwi mentions a running app or
  dev server, it prints the full `http://localhost:<port>` (or the real host) so
  you can click it. A bare `:3137` is never acceptable, in the gate or in
  free-form narration.

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
| `/bgsd-resume` | pick up an interrupted session from `.bgsd/runs/` (auto-selects the latest in-flight run) |
| `/bgsd-gui` | open/close the live web dashboard tracking every agent by lane + GSD substage |
| `/bgsd-memory` | save a setting or preference to `BGSD.md` in natural language (flags still override) |
