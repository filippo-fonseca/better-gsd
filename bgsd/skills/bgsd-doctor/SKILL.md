---
name: bgsd-doctor
description: Check BGSD v2 CLIs, subscription authentication, provider-specific GSD installations, models, and optional proxy health.
---

# BGSD Doctor

Resolve this skill's plugin root (two directories above this file), then run:

```bash
node "<plugin-root>/scripts/doctor.mjs" --profile <profile> [--build-model <id>] [--evaluate-model <id>] [--proxy] --json
```

Use the current session profile when known; otherwise use `claude` under Claude and `openai` under Codex. Interpret the JSON without printing credential values.

If setup is missing, use `request_user_input` to show one native selector with **Install & Continue**, **Change profile**, and **Stop**. Never ask this as plain text. On Install & Continue:

- Missing Claude login: run `claude auth login`, then re-run doctor.
- Missing Codex login: run `codex login`, then re-run doctor.
- Missing Claude GSD: `npx -y @opengsd/gsd-core@latest --claude --global`.
- Missing Codex GSD: `npx -y @opengsd/gsd-core@latest --codex --global`.

Only proceed when every selected lane reports subscription authentication and its GSD runtime is ready. API-key-backed sessions are unsupported.
