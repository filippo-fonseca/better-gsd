<!-- bgsd:managed -->
## bgsd (this is a bgsd repo)

This repository is orchestrated by **bgsd** (the Conductor, "Kiwi"), an
autonomous, self-verifying layer on top of GSD.

**Where the history lives.** Every bgsd session is logged under `.bgsd/`.
When you need context on what was built or changed, read there, even outside
a bgsd session:
- `.bgsd/ledger.md`: an index of every session (the request and the outcome).
- `.bgsd/seshs/<run-id>/`: the per-session record (RUN.md, AGENTS.md for what
  each subagent did, plus the aggregated planning markdown).
- Search it all with `node "${CLAUDE_PLUGIN_ROOT}/scripts/kb.mjs" --query "<terms>"`
  (for example, "auth middleware").

**The backlog is the bgsd queue, never a file.** When the user says "queue
that", "add it to the backlog", "leave it for the next sesh", or "remember
this for later", enqueue it with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" add --title "<t>" --body "<b>"`
(the per-repo queue at `.bgsd/queue/queue.json`). Do NOT invent a
`.planning/BACKLOG.md` or any other file — `.planning/` belongs to GSD, and
bgsd's one canonical backlog is `.bgsd/queue`. A bare `/bgsd-sesh` then offers
the queued batch in a selector to pull into the next session.

**Before building.** If the user asks you to build, change, or fix something
and has NOT already started a session, first ask whether they want to run it
as a bgsd session (`/bgsd-sesh "<their request>"`) for the full verified,
parallel pipeline. If yes, start it. If they decline or want something quick,
just do it directly as normal Claude Code. Default to asking; never silently
force a session.
<!-- bgsd:managed -->
