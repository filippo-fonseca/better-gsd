# better-gsd v2

BGSD is a verified, worktree-based GSD conductor for Claude Code and Codex.
You start one session with the model you want to reason with. That live session
is the Conductor and Advisor. Quick work stays in that session; Feature and
Project work use isolated build and evaluation lanes on your existing Claude and
ChatGPT subscriptions. BGSD verifies the result and never writes directly to
your production branch.

## The model contract

| Role | Owns | Chosen at |
| --- | --- | --- |
| Conductor | scope, decomposition, seeds, advisor decisions, human interaction | your current Claude Code or Codex session |
| Build lane | Feature/Project Pipeline Agents, nested GSD workflow, internal reviews, repairs | BGSD session selector |
| Evaluation lane | Loop 1, Loop 2, fresh final review | BGSD session selector |

The default models are Claude Opus high for Claude lanes and GPT-5.6 Sol medium
for OpenAI lanes. The Conductor is never changed by that default: it remains the
model and effort of the Claude Code or Codex session you started. Choose one of
four profiles: Claude/Claude, OpenAI/OpenAI,
Claude build/OpenAI evaluate, or OpenAI build/Claude evaluate. Custom model ids
are validated against the selected provider and never silently fall back.

`fixed` routing is the default: every build unit uses the build model. In
`adaptive` routing, the Conductor may explicitly assign a heavy or light model
to a unit and records its reason. No assignment means heavy, never an invisible
downgrade. Here “heavy” means the profile's default build lane, not necessarily
high reasoning effort: the OpenAI heavy default is GPT-5.6 Sol medium.
Evaluation remains fixed.

## Why the proxy exists

You do not need a proxy to have Claude conduct Codex agents, or Codex conduct
Claude agents. BGSD launches each provider's CLI directly, so normal pipelines
use the subscription you already signed into.

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is optional. It is
for the different case where you deliberately want the **Claude Code harness and
tooling** to host a foreign model such as GPT through its Claude-compatible
endpoint. BGSD enables it only with `--proxy`, a configured local endpoint, a
model probe, and an explicit proxy token. It does not use provider API keys, and
it is never a fallback from direct CLI execution.

## Install

```sh
# Claude Code
claude plugin marketplace add filippo-fonseca/better-gsd
claude plugin install bgsd@better-gsd

# Codex
codex plugin marketplace add filippo-fonseca/better-gsd
codex plugin add bgsd@better-gsd
```

BGSD Doctor checks the selected CLIs, subscription login, GSD installation, and
optional proxy before a session. GSD is installed per runtime with:

```sh
npx -y @opengsd/gsd-core@latest --claude --global
npx -y @opengsd/gsd-core@latest --codex --global
```

## Start a session

Use the `bgsd-sesh` skill in Claude Code or Codex. It presents native selectors
for profile, custom models, routing mode, verification depth, and setup.

CLI equivalent:

```sh
node bgsd/scripts/session.mjs \
  --prompt "Build an audit log" \
  --profile claude-openai \
  --routing fixed
```

For a Claude Code harness backed by a verified local CLIProxyAPI endpoint:

```sh
export BGSD_PROXY_URL=http://127.0.0.1:8317
export BGSD_PROXY_TOKEN=<local-proxy-token>
node bgsd/scripts/session.mjs --prompt "Review this refactor" --profile openai --proxy
```

## Workflow depth

| Mode | Use it for | Pipeline | Verification |
| --- | --- | --- | --- |
| Quick | one contained correction | Conductor plan, implementation, and verify/fix; no GSD | direct verification loop |
| Feature | a scoped product change | a few worktrees; Loop 2 when needed | per-unit plus integration when applicable |
| Project | multi-surface work | discussion, DAG, waves, full GSD units | Loop 1, Loop 2, fresh review, human gate |

Quick never invokes GSD: the Conductor plans and implements it directly. Every
Feature/Project build unit runs a full GSD workflow. In those workflows, the
Conductor remains the Advisor: it authors seeds, reads control evidence at every
phase/commit/blocker/verification checkpoint, and can rewrite the durable worker
steering directive. Complexity controls workflow depth, not an unannounced model
downgrade. Work lands on `next`; the merge from `next` to `main` remains
human-only.

## Follow-up roadmap

- [#8](https://github.com/filippo-fonseca/better-gsd/issues/8): subscription-safe remote status/control endpoint for Hyperpolymath.
- [#9](https://github.com/filippo-fonseca/better-gsd/issues/9): remote pipeline inspection and control surface.
- [#10](https://github.com/filippo-fonseca/better-gsd/issues/10): desktop/text-editor experience inspired by T3 Code.

The detailed docs live in [bgsd/docs](./bgsd/docs), and the explainer site lives
in [bgsd/site](./bgsd/site).
