# BGSD v2 plugin

BGSD v2 is installed in both Claude Code and Codex. It keeps the same core GSD
workflow while making the execution lanes explicit and provider-neutral.

Use `bgsd-sesh` to start. The Conductor detects the current session model,
then the native selector chooses the build/evaluation profile, routing mode, and
optional proxy transport. `bgsd-doctor` installs or verifies GSD for every
selected runtime before work starts.

| Profile | Build | Evaluate |
| --- | --- | --- |
| Claude | Claude | Claude |
| OpenAI | OpenAI | OpenAI |
| Claude/OpenAI | Claude | OpenAI |
| OpenAI/Claude | OpenAI | Claude |

Build agents execute full GSD workflows inside isolated worktrees. Evaluation
agents independently verify Loop 1, Loop 2, and final review. API-key billing is
not a supported lane: child processes scrub provider API keys and use the
subscription login for the selected CLI. The optional CLIProxyAPI transport is
only for intentionally using the Claude Code harness against a foreign model.

See the repository [README](../README.md) and [docs](./docs) for setup and the
Quick/Feature/Project workflow table.
