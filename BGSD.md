# BGSD.md — bgsd settings

This file configures how bgsd (the Conductor, "Kiwi") runs in this repo. Every
knob lives in the `bgsd-settings` block below and ships with a sensible default.
Edit the block to override; Kiwi reads it at the start of every sesh. You can
also write prose preferences (tone, risk appetite, "always ask before X") in the
Notes section and Kiwi will respect them.

## Settings

- **integration_branch** — the standing branch that acts as the rehearsal /
  integration mirror of `main`. Worktree branches merge here; `integration ->
  main` is always a manual, human-only merge.
- **base_branch** — `null` auto-detects from `origin/HEAD` (falls back to
  `main`, then `master`). Set explicitly to pin it.
- **git.sync_integration_from_base** — ff-update the integration branch from the
  base branch at the start of every sesh, so it never falls behind production.
- **git.integration_to_main** — kept `manual`: no agent ever commits to
  `main`. Kiwi only suggests the merge command for you to run.
- **github.issues** — file one atomic issue per work unit plus one epic issue
  per sesh; each PR closes its issue on merge.
- **github.require_remote** — when there's no GitHub remote, skip all issue/PR
  machinery and just branch + merge locally.
- **env.propagate / env.files** — git worktrees don't carry gitignored files, so
  Kiwi copies these env files from the repo root into every worktree (and onto
  the integration branch) so your apps actually run. Edit the globs to match
  this repo's env files.
- **harness** — bgsd is LLM/CLI **agnostic**. A sesh runs identically whether
  you drive it from **Claude Code** or **Codex**, and you can switch between them
  mid-project (e.g. to dodge one provider's usage limits) with zero friction: all
  durable state lives in `.bgsd/` files, so switching back and forth just works.
  `harness.active: "auto"` detects the harness from the environment (`AGENT=codex`
  → Codex; otherwise Claude Code); pin it to `"claude"`/`"codex"` to force one.
  `harness.models` maps bgsd's semantic tiers (opus/sonnet/haiku/fable) to each
  harness's model equivalents — retune here if a provider's model names drift.
- **model_posture** — the per-unit model + effort routing. Executor uses the
  unit's difficulty tier; researcher drops one tier (capped at `medium`);
  verifier is fixed. Override any tier, threshold, or role here. The tier names
  resolve to the ACTIVE harness's models via `harness.models` above.
- **verification.usage_testing** — `true` runs the full Tester ladder including
  the Playwright/vision rung (driving the real app). `false` skips that UI
  usage-testing but STILL runs the goal-backward code verification
  (gsd-verifier), so quick fixes and non-UI changes don't pay for browser
  testing. Toggle per-session with `--no-usage-verification`, or tell Kiwi
  ("stop UI-testing quick fixes") and it sets this for you. It never disables
  code verification — "no silent green" still holds.
- **conductor** — persona + narration. `narrate` streams stage-aware live
  updates; `suggest_gate_commands` makes Kiwi hand you the exact command at
  every human gate. `fable_advisor` controls **Fable-as-Advisor mode**: when on,
  Kiwi actively reviews each wave unit's sealed plan, steers before execution,
  checks in on commits, and authors the next wave's seed plans itself (reviewing
  distilled artifacts only, never raw diffs). `"auto"` (default) follows the
  three-criteria gate — on when your brain IS Fable, OR `--fable` was passed, OR
  you approved a proposal; off otherwise. Set `true` to force on, `false` to
  hard-disable even on Fable.
- **context** — per-subagent context-window management. `max_window_tokens`
  is the model's full window (Pipeline Agents run on ~1M tokens). When an
  agent's usage crosses `compact_at` (fraction of the window) Kiwi compacts it
  proactively; crossing `relaunch_at` clears and relaunches the agent from its
  handoff manifest, into a fresh small window. Raise the fractions to let agents
  run longer before Kiwi intervenes.

```json bgsd-settings
{
  "version": 1,
  "integration_branch": "next",
  "base_branch": null,
  "git": {
    "sync_integration_from_base": true,
    "integration_to_main": "manual"
  },
  "env": {
    "propagate": true,
    "files": [
      ".env",
      ".env.local",
      ".env.*.local"
    ]
  },
  "github": {
    "issues": true,
    "require_remote": true
  },
  "harness": {
    "active": "auto",
    "models": {
      "claude": { "opus": "claude-opus-4-8", "sonnet": "sonnet", "haiku": "haiku", "fable": "claude-fable-5" },
      "codex":  { "opus": "gpt-5-codex", "sonnet": "gpt-5", "haiku": "gpt-5-mini", "fable": "gpt-5-codex" }
    }
  },
  "model_posture": {
    "thresholds": {
      "high": 0.7,
      "medium": 0.4
    },
    "tiers": {
      "high": {
        "model": "opus",
        "effort": "xhigh"
      },
      "medium": {
        "model": "sonnet",
        "effort": "high"
      },
      "low": {
        "model": "haiku",
        "effort": "medium"
      }
    },
    "researcher": "one-tier-below",
    "verifier": {
      "model": "haiku",
      "effort": "low"
    }
  },
  "verification": {
    "usage_testing": true
  },
  "conductor": {
    "persona": "kiwi",
    "narrate": true,
    "suggest_gate_commands": true,
    "fable_advisor": "auto"
  },
  "context": {
    "max_window_tokens": 1000000,
    "compact_at": 0.7,
    "relaunch_at": 0.9
  }
}
```

## Notes

<!-- Free-form preferences for Kiwi. Examples:
- Never use haiku for verification.
- Always ask before deleting files.
- Prefer terse PR descriptions. -->
