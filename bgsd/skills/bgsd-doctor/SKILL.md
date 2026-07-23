---
name: bgsd-doctor
description: Validate BGSD v2 CLIs, subscription authentication, provider-specific GSD installations, and chosen models — after the Conductor has captured user selection.
---

# BGSD Doctor

**Doctor validates; it does not choose.** The Conductor must capture worker/executor
model paths through native selectors **before** invoking Doctor. Doctor confirms
that the selected models exist, auth is subscription-backed, and required CLIs are
ready. It never substitutes defaults or overrides the user's selection.

Resolve this skill's plugin root (two directories above this file), then run:

```bash
node "<plugin-root>/scripts/doctor.mjs" --profile <profile> [--no-cursor] \
  [--build-model <id>] [--evaluate-model <id>] [--build-effort high] [--evaluate-effort high] \
  [--cursor-routine-model <id>] [--cursor-hard-model <id>] [--proxy] --json
```

Use the flags assembled from the session's native model-path selectors. When the
profile is unknown before selection, do not run Doctor until the Conductor has
captured the path preset and any custom mix choices.

Interpret the JSON without printing credential values.

If setup is missing, use `request_user_input` to show one native selector with **Install & Continue**, **Change profile**, and **Stop**. Never ask this as plain text. On Install & Continue:

- Missing Claude login: run `claude auth login`, then re-run doctor.
- Missing Codex login: run `codex login`, then re-run doctor.
- Missing Claude GSD: `npx -y @opengsd/gsd-core@latest --claude --global`.
- Missing Codex GSD: `npx -y @opengsd/gsd-core@latest --codex --global`.
- Missing Cursor login: run `cursor-agent login`, then re-run doctor.

Only proceed when every **selected** lane reports subscription authentication and its GSD runtime is ready. API-key-backed sessions are unsupported. Custom model ids entered via selector Other must pass Doctor's model-availability checks.
