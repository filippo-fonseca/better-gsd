---
name: bgsd-token-usage
description: Ask Kiwi how many tokens a BGSD session burned, broken down by lane, model, role, and unit.
---

# /bgsd-token-usage — what the session cost

`/bgsd-token-usage` reports how many tokens the architecture actually spent and
where. The numbers are read from durable per-run accounting, and where a real
harness transcript exists they are **measured**, not estimated. Never expose
credentials, and never imply API pricing when the run used subscription-backed
CLIs — cost figures are indicative, for routing insight, not a bill.

## Usage

The underlying report (run from the repo root):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.mjs" report [--run-id <id>] [--json]
```

With no `--run-id`, it reports the latest run.

## How Kiwi handles it

1. **Run the report.** Invoke `tokens.mjs report` from the repo root. Use
   `--run-id` when the user names a session; otherwise the latest run.
2. **Narrate it in persona, but keep the numbers literal.** Lead with the
   Conductor pill, then give the reader:
   - **Headline totals:** input / output / cache tokens and indicative cost for
     the whole session.
   - **Per lane:** build vs evaluation, each with its concrete provider/model
     (e.g. `claude/claude-opus-4-8 high`, `openai/gpt-5.6-sol medium`) so the
     split between building and verifying is visible.
   - **Per role and per unit:** Conductor, Pipeline Agents, verifiers, fix
     agents — and which unit each belongs to — so a runaway unit is obvious.
   - **Source:** mark each row `measured` (harvested from the harness
     transcript) or `estimated`, and say which, so the reader trusts the
     measured rows and discounts the estimates.
3. **Explain the routing, don't just dump rows.** Tie the spend back to the
   model contract: which lanes were fixed, which units the Conductor assigned
   in adaptive mode and the reason it recorded, and where the tokens
   concentrated. If one heavy unit dominated, say so; if adaptive routing put a
   light tier on trivial work and saved tokens, call that win out.
4. **Offer the efficiency read.** Where the evidence supports it, note one or
   two concrete levers (a unit that could have run light next time, a
   verification loop that retried more than expected) — framed as insight for
   the next session, never as a reason to relax the verification floor.

## Guardrails

- Read-only: this command inspects recorded usage and never edits state.
- Do not recommend a model downgrade from difficulty alone. Adaptive routing is
  an explicit Conductor assignment with a recorded reason; token pressure is an
  input to that judgment, not a substitute for it.
- Evaluation-lane spend is the cost of not shipping silent green. Report it,
  never propose trimming verification to save tokens.

## Related

- `bgsd-sesh` — the session that produced the usage.
- The model contract on `run.json` records the lanes these numbers priced.
