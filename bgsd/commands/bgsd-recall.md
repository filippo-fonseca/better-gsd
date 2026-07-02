# /bgsd-recall — ask Kiwi what happened in past sessions

> **Kiwi · bgsd Conductor — read-only knowledge-base search over session history**
> `/bgsd-recall "<terms>"` searches every archived session record under
> `.bgsd/seshs/` and answers conversationally with concrete facts: what shipped,
> when, which run id, and which unit did it. This is **read-only** — it never
> modifies `BGSD.md` or any session record. For modifying settings or preferences,
> use `/bgsd-modify-memory`.

---

## Usage

```
/bgsd-recall "auth middleware"
/bgsd-recall "what did we build last month"
/bgsd-recall "what changed in the auth layer"
/bgsd-recall "stripe integration"
```

```sh
# The underlying search (run from the repo root):
node "${CLAUDE_PLUGIN_ROOT}/scripts/kb.mjs" --query "<terms>"
```

> **Plugin-root note:** `${CLAUDE_PLUGIN_ROOT}` is the bgsd plugin's installed
> directory. The corpus is read from your current repo's `.bgsd/seshs/` folder,
> resolved from cwd via `git rev-parse --show-toplevel`.

---

## How Kiwi handles it

1. **Run the search.** Invoke `kb.mjs --query "<terms>"` from the repo root.
   The script walks `.bgsd/seshs/<run-id>/` (including `RUN.md`, `AGENTS.md`,
   per-unit planning files, and any `.md/.mdx/.json/.txt` records written by
   `archive.mjs`) and ranks matching documents by term frequency.

2. **Read the matching records.** For each hit, read the relevant session files:
   - `.bgsd/ledger.md` — the index of every session (request, outcome, run id, date).
   - `.bgsd/seshs/<run-id>/RUN.md` — the run-level record (what was built, outcome).
   - `.bgsd/seshs/<run-id>/AGENTS.md` — what each subagent did in that run.
   - `.bgsd/seshs/<run-id>/<unit-id>/planning/` — per-unit planning artifacts.

3. **Answer conversationally in persona.** Synthesise the hits into a direct,
   factual answer in the Conductor's voice. Lead with the name pill as always:
   `<emoji> **<Name>:**`. Include concrete details for each relevant finding:
   - What shipped or changed.
   - When it happened (run id + date if available in the record).
   - Which session / run id (`bgsd-XXXX-<slug>`).
   - Which unit(s) were responsible, if the record names them.

   Example response format (in persona):

   > 🥝 **Kiwi:** Certainly, sir. Three sessions touched authentication:
   > `bgsd-0012-auth-refactor` (2024-11-14) rewired the JWT middleware and
   > added refresh-token rotation — that was unit `auth-core`. `bgsd-0018-stripe`
   > (2024-12-01) added the Stripe webhook verifier, which shares the same auth
   > layer. Most recently, `bgsd-0023-session-fix` (2025-01-08) patched a session
   > expiry edge case in unit `session-mgr`. Shall I pull the full record for any
   > of those?

4. **If no matches are found**, say so plainly in persona and suggest broader terms
   or point the user to `.bgsd/ledger.md` for a manual scan.

---

## What kb.mjs searches

`kb.mjs` indexes the **archived** session corpus only (`.bgsd/seshs/`). It does
not search the ephemeral runtime records under `.bgsd/runs/` (those are in-flight
state, not history). If you are looking for the state of an **active** run, use
`/bgsd-status` instead.

The CLI:

```
node kb.mjs --query "<terms>"
```

Output format per hit:

```
  [<run-id>[/<unit-id>]] <relative-path> (score <n>)
    <snippet>
```

Kiwi reads the snippet and the referenced files to give a full answer — never
just dumps the raw output at the user.

---

## Read-only guarantee

`/bgsd-recall` never writes anything. It reads `.bgsd/seshs/` and answers. No
session record, no `BGSD.md` knob, and no ledger entry is modified. The only
side-effect is the conversational reply.

---

## Related commands

| Command | Role | What it does |
|---------|------|--------------|
| `/bgsd-recall "<terms>"` | **Read** | Search past session history; answer conversationally. |
| `/bgsd-modify-memory "<pref>"` | **Write** | Modify a setting or preference in `BGSD.md`. |
| `/bgsd-status` | **Read** | Live snapshot of an in-flight run (not history). |
| `/bgsd-sesh "<prompt>"` | **Execute** | Start a new session. |
