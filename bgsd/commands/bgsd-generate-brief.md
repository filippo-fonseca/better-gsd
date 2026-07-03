# /bgsd-generate-brief — Kiwi writes a hand-off brief of a past session

> **Kiwi · bgsd Conductor — speaks in persona (a British butler / JARVIS, and
> addresses you as "sir").** `/bgsd-generate-brief` distils a past bgsd session
> into one clean, comprehensive markdown brief so the NEXT session starts with
> interpretable context instead of a cold read of the raw records. The idea:
> generate the brief, then say *"based on the brief, do X, Y, Z"* and the next
> sesh already knows what shipped, what changed, and what was left open.

---

## Purpose

Session records under `.bgsd/seshs/<run-id>/` are honest but messy — per-unit
GSD planning docs, a run-level `RUN.md`, an `AGENTS.md`, all Conductor-authored
prose. Feeding those raw into a new session wastes context and buries the
signal. This command produces a single **hand-off brief**: what was requested,
what was done per unit, what changed, and what remains — ready to paste as clean
context for the follow-up.

---

## Usage

```
/bgsd-generate-brief            # brief the LAST session
/bgsd-generate-brief <run-id>   # brief a specific session, e.g. bgsd-0012-auth
```

```sh
# The underlying builder (run from the repo root):
node "${CLAUDE_PLUGIN_ROOT}/scripts/brief.mjs" --last
node "${CLAUDE_PLUGIN_ROOT}/scripts/brief.mjs" --run-id bgsd-0012-auth
```

Flags: `--run-id <id>` targets a specific run (default: the latest);
`--bgsd-dir <dir>` overrides the `.bgsd` location; `--out <path>` writes
elsewhere; `--stdout` prints the brief itself instead of the path.

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is the bgsd plugin's installed
> directory. The corpus is read from your current repo's `.bgsd/` folder,
> resolved from cwd (or via `git rev-parse --show-toplevel`).

---

## What it reads, and what it writes

**Reads** (all defensively parsed — records are semi-structured prose):

- `.bgsd/seshs/<run-id>/RUN.md` — the run-level record.
- `.bgsd/seshs/<run-id>/AGENTS.md` — what each subagent did.
- `.bgsd/seshs/<run-id>/<unit-id>/planning/*` — per-unit GSD planning docs.
- `.bgsd/ledger.md` — the index (`run_id | prompt | scale | outcome | at`).
- `.bgsd/runs/<run-id>/run.json` — the run state file, when present.

**Writes** a single file:

```
.bgsd/briefs/<run-id>-brief.md
```

The CLI creates `.bgsd/briefs/` and prints the path. (Pass `--stdout` to emit
the brief text instead.)

---

## The brief's sections

In order, with any empty section omitted (no hollow headers):

1. **Header** — title, run id, scale, date, outcome.
2. **What was requested** — the original prompt.
3. **What was done** — per unit: title, summary, and key planning-doc references.
4. **Agents** — from `AGENTS.md`, if present.
5. **Run notes** — from `RUN.md`, if present.
6. **What changed** — branches merged and the PR.
7. **Outstanding / deferred** — anything left open.
8. **How to continue** — always present; ends with a ready-to-paste line.

---

## How Kiwi handles it

1. **Run the deterministic gather.** `brief.mjs` loads the corpus, splits each
   sesh's docs into `RUN.md` / `AGENTS.md` / per-unit planning, folds in the
   ledger row and `run.json`, and assembles the skeleton brief. This part is
   pure and needs no model.

2. **Synthesise on Sonnet when the raw docs are long or messy.** The skeleton
   quotes clipped bodies verbatim; when the underlying planning / `RUN.md` /
   `AGENTS.md` prose is long or noisy, the Conductor spawns a **Sonnet**
   subagent to rewrite those into a tight, readable narrative before the brief
   lands. Summarisation is cheap: no Fable or Opus is warranted here, matching
   bgsd's model doctrine (reserve the heavy planners for planning, not prose).

3. **Report in persona.** Confirm the run id briefed and the path written, e.g.:

   > 🥝 **Kiwi:** Done, sir. I've distilled `bgsd-0012-auth` into
   > `.bgsd/briefs/bgsd-0012-auth-brief.md`. Whenever you're ready for the next
   > sesh, just point me at it.

---

## How to use it next (the whole point)

Hand the brief to the follow-up session as clean context:

```
/bgsd-sesh "based on the brief at .bgsd/briefs/bgsd-0012-auth-brief.md, do X, Y, Z"
```

The new session reads the brief, not the raw record sprawl, and starts already
oriented.

---

## Related commands

| Command | Role | What it does |
|---------|------|--------------|
| `/bgsd-generate-brief [<run-id>]` | **Write** | Distil a past session into `.bgsd/briefs/<id>-brief.md`. |
| `/bgsd-recall "<terms>"` | **Read** | Search all session history and answer conversationally. |
| `/bgsd-resume` | **Execute** | Pick up an interrupted run from its last recorded state. |
| `/bgsd-sesh "<prompt>"` | **Execute** | Start a new session (feed it the brief). |
