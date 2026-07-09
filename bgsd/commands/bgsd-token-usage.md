# /bgsd-token-usage — ask Kiwi how many tokens the sesh burned

> **Kiwi · bgsd Conductor — read-only token + cost accounting over a run**
> `/bgsd-token-usage` reports how many tokens the architecture spent, broken
> down by model, by role (planner / executor / researcher / verifier / Fable
> pre-planner / Conductor), and by agent — with a dollar estimate per bucket.
> This is **read-only**: it reads the ledger at `.bgsd/runs/<run-id>/tokens.json`
> (or the archived `.bgsd/seshs/<run-id>/tokens.json`) and answers. It never
> spends tokens of its own beyond the reply.

---

## Usage

```
/bgsd-token-usage                       # newest run — full breakdown
/bgsd-token-usage --run-id bgsd-0042-x  # a specific past run
```

```sh
# The underlying report (run from the repo root):
node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.mjs" report [--run-id <id>] [--json]
```

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is the bgsd plugin's installed
> directory. The ledger is read from your current repo's `.bgsd/` folder,
> resolved from cwd via `git rev-parse --show-toplevel`. With no `--run-id`,
> it picks the newest run by mtime.

---

## How Kiwi handles it

1. **Run the report.** Invoke `tokens.mjs report` from the repo root (add
   `--run-id` to target a past run, `--json` when you want the raw rollup).

2. **Read the rollup.** The script sums every recorded agent call into:
   - **total** — input / output / cache-read tokens, USD, and call count.
   - **by model** — where the spend concentrates (e.g. Opus vs Sonnet vs a
     Codex `gpt-5.x`), the single best signal of routing efficiency.
   - **by role** — planner / executor / researcher / verifier / fable-plan /
     conductor, so you can see which stage of the pipeline is token-heavy.
   - **by agent** — per-unit totals (the worktree subprocess for each unit).

3. **Answer conversationally in persona.** Lead with the name pill
   (`🥝 **Kiwi:**`) and give the human the headline (total cost + tokens),
   then call out where the tokens went and any efficiency read — e.g. "the
   executor on unit `u-2` was 60% of the spend; a `--sonnet` pass there would
   roughly halve it." Never just dump the raw table.

   Example (in persona):

   > 🥝 **Kiwi:** This sesh burned **1.42M in / 0.31M out** across 11 agent
   > calls, sir — about **$4.85**. Opus did the heavy lifting (94% of cost);
   > the executor role alone was $3.60. The Fable pre-planner was a rounding
   > error. If you'd like, I can flag the two trivial units that ran on Opus
   > for a Sonnet downgrade next time.

4. **Note incomplete data plainly.** A `+` suffix on a cost (e.g. `$2.10+`)
   means one or more calls had **no known pricing** for their model, so the
   figure is a floor. A row with `source: none` means only the model/effort
   was known (no token counts were captured from the harness transcript).

---

## What tokens.mjs reads

`tokens.mjs` reads the per-run ledger written during a sesh:

- **live:** `.bgsd/runs/<run-id>/tokens.json` (in-flight)
- **archived:** `.bgsd/seshs/<run-id>/tokens.json` (after ship/rehearsal)

Each row records `role`, `harness`, `model`, `effort`, input/output/cache
tokens, a computed `cost_usd`, and a `source` (`measured` from a harness
transcript, `estimated` from a byte proxy, or `none`). Pricing is a built-in
July-2026 Claude + Codex table; override a row's cost at record time with
`--cost` if provider prices drift.

---

## Read-only guarantee

`/bgsd-token-usage` never writes anything. It reads the ledger and answers.
No session record, no `BGSD.md` knob, and no ledger row is modified.

---

## Related commands

| Command | Role | What it does |
|---------|------|--------------|
| `/bgsd-token-usage [--run-id]` | **Read** | Token + cost rollup for a run. |
| `/bgsd-status` | **Read** | Live snapshot of an in-flight run. |
| `/bgsd-recall "<terms>"` | **Read** | Search past session history. |
| `/bgsd-sesh "<prompt>"` | **Execute** | Start a new session. |
