# Contributing to bgsd

Thanks for your interest in improving **better-gsd (bgsd)**. This guide covers dev setup, the code conventions the engine follows, how to run the tests, and the branch, commit, and release model.

Please also read the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## Dev setup

There is no build step. bgsd's engine is plain ES modules run directly with Node.

1. Clone the repo:

   ```sh
   git clone https://github.com/filippo-fonseca/better-gsd.git
   cd better-gsd
   ```

2. Install **Node 18 or newer** (the only runtime requirement; see `installer/package.json` `engines`). There are no npm dependencies to install for the engine itself; the scripts are dependency-free.

3. Run the test suite (below) to confirm a clean baseline.

The plugin surface (commands, agents, docs) is Markdown and MDX; the engine is `bgsd/scripts/*.mjs`.

---

## Code conventions

### Pure core plus a live seam

Every engine module is written as a **pure, dependency-injected** function or set of functions: no direct git, filesystem, network, or process access baked in. Side effects are passed in as injected dependencies. This keeps the core deterministic and unit-testable without touching a real repo.

Each pure module is paired with a `*-live.mjs` seam that wires the real implementations (git, `fs`, spawning processes) into the pure core. For example, `loop1.mjs` is the pure controller and `loop1-live.mjs` is its live runner; `run.mjs` is the pure state machine and `run-live.mjs` is its live runner.

### Guard every mutation

The live seams guard destructive or process-spawning operations behind explicit gates:

- `requireLiveFlag` / a `--live` flag on `process.argv`: multi-process orchestration and live captures refuse to run without it, throwing a detailed refusal instead of silently acting.
- `requireNotProductionBranch`: nothing may commit or write to the production branch. All integration lands on the standing `next` branch.

If you add a new operation that mutates a repo or spawns processes, route it through the same gates. Do not let a pure function reach out to the real world directly.

### No silent green

The project's core rule: **nothing is reported done without real verification.** Any new verification path must emit an honest terminal state rather than a fabricated pass:

- insufficient evidence yields `INSUFFICIENT_EVIDENCE`;
- a missing MCP or unbootable app yields `BLOCKED`;
- a real defect yields `FAIL`.

A `FAIL` is always called a `FAIL`. Never fabricate a `PASS`.

### Tests

Tests are home-grown, dependency-free `bgsd/scripts/test-*.mjs` files. Each one uses `node:assert/strict`, a small local `test()` runner, prints a summary line (`N passed, M failed`), and exits non-zero if anything fails. There are **40** test files today, and every one must exit 0.

New behavior should come with tests. Because the core is pure, you can test logic by injecting fakes; you should not need a live repo, network, or MCP to test the deterministic paths.

---

## Running the suite

Run every test file and confirm none fail:

```sh
for t in bgsd/scripts/test-*.mjs; do node "$t"; done
```

To fail loudly on the first broken suite in CI-style output:

```sh
for t in bgsd/scripts/test-*.mjs; do node "$t" >/dev/null || echo "FAIL $t"; done
```

No `FAIL` lines means the suite is green. There is no separate CI yet, so run this locally before you push.

---

## Branch and release model

- `next` is the **standing integration and release branch**, and it is what users install from. There is no meaningful `main` for this repo.
- Do your work on a **feature branch**, then push to `next`. Agents never write to a production branch; the `next` to `main` merge is a human-only step.
- Keep the plugin **additive**: new bgsd code lives under `bgsd/`. Do not edit vendored GSD directories.
- bgsd reaches GSD only through documented seams: the `/gsd-*` slash commands, the `.planning/` file contract, and `config.json`. Never reach into GSD internals.

---

## Commit and PR conventions

- Make **small, atomic commits**, one per logical unit of work. Do not batch a whole feature into a single commit.
- Stage with **explicit pathspecs** (for example `git add bgsd/scripts/foo.mjs`). Never use `git add -A` or `git add .`, which can pull in unintended files.
- Use **Conventional-Commits-style prefixes** scoped to bgsd:
  - `feat(bgsd):` a new capability
  - `fix(bgsd):` a bug fix
  - `docs(bgsd):` documentation only
  - `chore(bgsd):` tooling, config, housekeeping
- Open a pull request against `next`. In the description, use a closing keyword (`Closes #<n>`) so merging auto-closes the issue.
- Confirm the test suite passes and that you did not introduce any silent-green path.

See the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) for the checklist.

---

## Adding a new command

A bgsd command is four coordinated pieces. Add all of them:

1. **`bgsd/commands/<name>.md`**: the slash-command definition (frontmatter plus the runbook Claude follows). This is the user- or Conductor-facing surface.
2. **`bgsd/scripts/<name>.mjs`**: the pure, dependency-injected engine that implements the logic.
3. **`bgsd/scripts/<name>-live.mjs`**: the live seam that wires real git and filesystem access into the pure engine, guarded behind `--live` and `requireNotProductionBranch` where it mutates.
4. **`bgsd/scripts/test-<name>.mjs`**: unit tests for the pure engine, using `node:assert/strict` and the local `test()` runner, exiting non-zero on any failure.

Wire the command into the plugin the same way existing commands are wired, and add a doc page under `bgsd/docs/` if it is user-facing.

---

## Bumping the version

The version lives in **three manifests** and a release bumps all three together:

1. `bgsd/.claude-plugin/plugin.json` (`version`)
2. `.claude-plugin/marketplace.json` (the `bgsd` plugin entry's `version`)
3. `bgsd/.claude-plugin/marketplace.json` (the `bgsd` plugin entry's `version`)

Keep them identical. The current version is `0.2.0`.

---

## Questions

Open a GitHub issue at [`filippo-fonseca/better-gsd`](https://github.com/filippo-fonseca/better-gsd/issues) using one of the issue templates.
