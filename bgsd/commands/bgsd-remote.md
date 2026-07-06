---
name: bgsd-remote
description: "Expose a local HTTP bridge to observe and drive a running Conductor session from off-box (e.g. a phone app): stream real-time output, send messages, answer questions."
argument-hint: "start [--run-id <id>] [--port <n>] [--lan|--host <ip>] [--token <t>] | stop | status | emit \"<text>\" | mirror | tail [--since <seq>]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---

# /bgsd-remote

Bring up (or tear down) the **remote-control bridge** for a live bgsd session.
The bridge is a dependency-free local HTTP server (`scripts/remote.mjs`) that
lets something OUTSIDE the terminal (a mobile app, a script, another agent)
watch a session and steer it in real time:

- **See its output** — `GET /api/events` (poll) or `GET /api/stream` (SSE).
- **See the pipeline** — `GET /api/state` (stage, per-unit status, pending questions).
- **Send it a message** — `POST /api/message { text }`.
- **Answer a question** — `POST /api/answer { answersUnit, answer }`.

It invents no new control flow. Output is mirrored to an append-only event log
(`.bgsd/runs/<run-id>/remote-outbox.jsonl`); inbound messages land in the SAME
`session-inbox` (`.bgsd/runs/<run-id>/session-inbox/*.json`) the running session
loop already drains every tick, so a remote answer resolves a parked unit
exactly like a local one. Read/observe + inject only: it never runs git and
never writes to `main`.

> **Reachability.** The default bind is loopback (`127.0.0.1`): only this
> machine can reach it, so pair it with a tunnel (`cloudflared`, `ngrok`) for
> true off-network control. `--lan` binds `0.0.0.0` so a phone on the same
> Wi-Fi can reach it directly. **Any non-loopback bind requires the token**
> (auto-generated at `start`).

---

## Subcommands

| Subcommand | Description |
|---|---|
| `start` | Launch the bridge as a detached daemon; prints the URL + token. Resolves the latest run unless `--run-id` is given. |
| `stop` | Stop the running bridge (by pid from the pointer file). |
| `status` | Is it up? Print URL, run, pid, token. |
| `emit "<text>"` | Append one line to the outbox so the app sees it. The Conductor calls this to mirror each narrated line. |
| `mirror` | Snapshot the current narrated stage into the outbox (deduped against the last stage). Cheap; call it at stage transitions. |
| `tail [--since <seq>]` | Print outbox events locally (`--json` for the raw payload). Handy for debugging. |

---

## start

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/remote.mjs" start \
  [--run-id <id>]     # default: the latest run under .bgsd/runs
  [--port <n>]        # default: 0 (OS picks a free port)
  [--lan]             # bind 0.0.0.0 (LAN-reachable); or --host <ip>
  [--token <t>]       # default: auto-generated (always generated)
```

**Output (stdout):**

```
bgsd remote bridge up
  url    http://localhost:53421
  run    run-3f9c…
  token  9a1b2c…            (send as: Authorization: Bearer <token>  or  ?token=<token>)
```

A pointer file `.bgsd/remote.json` records `{ pid, host, port, url, run_id,
token, started_at }` so `stop`/`status` can find the daemon. Daemon output is
appended to `.bgsd/remote.log` for diagnosis (never silently swallowed).

---

## emit / mirror — feeding the outbox

The app's "real-time output" is the outbox event log. Because the Conductor's
narration is terminal text, **when `remote.enabled` the Conductor mirrors each
user-facing line** it prints:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/remote.mjs" emit "Loop 1: 3/4 agents finished, 2/4 verified…"
node "${CLAUDE_PLUGIN_ROOT}/scripts/remote.mjs" mirror   # snapshot the stage at each transition
```

Each event is `{ seq, at, type, text, meta? }` with a monotonic `seq`; the app
polls `/api/events?since=<lastSeq>` or holds `/api/stream` open.

---

## Sending messages + answering questions (inbound)

Inbound needs no Conductor action; the session loop drains `session-inbox`
itself. The bridge just writes the file:

- `POST /api/message { "text": "prioritize the auth unit" }` → a normal
  interjection the Conductor ingests without halting.
- `POST /api/answer { "answersUnit": "<unit-id>", "answer": "Google OAuth" }` →
  resolves a parked (`needs_input`) unit; the session continues from that phase.

`GET /api/state` lists `pending_questions` (`{ answersUnit, title, question }`)
so the app knows which units are waiting and what to answer.

---

## Config

Persist defaults in `BGSD.md`:

```json bgsd-settings
{
  "remote": { "enabled": false, "host": "loopback", "port": 0 }
}
```

- `enabled` — when `true`, the Conductor starts the bridge at sesh start and
  mirrors its narration automatically. Per-session override: `--remote` /
  `--remote-lan` on `/bgsd-sesh`.
- `host` — `loopback` (127.0.0.1) or `lan` (0.0.0.0).
- `port` — `0` lets the OS pick.

---

## Security

- **Token-gated.** Every route checks the token when one is set (constant-time
  compare). A non-loopback bind refuses to run tokenless.
- **Local + additive.** The bridge only reads run state and writes inbox/outbox
  files under `.bgsd/`. It never touches git, never writes to `main`.
- **Bind narrowly.** Prefer loopback + a tunnel you control over `--lan` on an
  untrusted network. The token is your only credential; treat it like one.

---

## Related Files

| Path | Purpose |
|---|---|
| `bgsd/scripts/remote.mjs` | The bridge: pure core + HTTP daemon + CLI |
| `bgsd/scripts/test-remote.mjs` | Unit tests |
| `bgsd/docs/remote-protocol.mdx` | Full endpoint/auth/event-schema reference for app + agent implementers |
| `bgsd/scripts/gui-live.mjs` | The dashboard daemon this mirrors (`modelForRun`, `latestRunId`) |
| `bgsd/scripts/session.mjs` | The session loop that drains `session-inbox` (`defaultInboxReader`) |
| `.bgsd/runs/<run-id>/remote-outbox.jsonl` | Outbox event log (Conductor → app) |
| `.bgsd/runs/<run-id>/session-inbox/*.json` | Inbox messages (app → Conductor) |
| `.bgsd/remote.json` | Daemon pointer (pid, port, url, token) |
