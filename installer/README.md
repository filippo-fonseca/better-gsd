# better-gsd

The one-line launcher for **bgsd**, an autonomous, self-verifying orchestration layer on top of GSD for Claude Code.

```bash
npx better-gsd@latest
```

That command:

1. Adds the public bgsd marketplace to Claude Code (`claude plugin marketplace add filippo-fonseca/better-gsd`).
2. Installs the bgsd plugin at user scope (`claude plugin install bgsd@better-gsd --scope user`).
3. Installs the gsd-core engine globally and non-interactively (`npx -y @opengsd/gsd-core@latest --claude --global`).

This package is only a thin installer. The plugin itself ships from the GitHub marketplace [filippo-fonseca/better-gsd](https://github.com/filippo-fonseca/better-gsd), not from npm.

## Flags

- `--dry-run`: print the commands it would run, then exit.
- `--help`: show usage.

## After installing

In Claude Code, run `/reload-plugins`, then `/bgsd-init` in your repo, then `/bgsd-sesh "build me X"`.
