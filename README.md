# better-gsd (bgsd)

> Talk to the Conductor. It handles everything.

**bgsd** is an autonomous, self-verifying orchestration layer that runs on top of [GSD](https://github.com/open-gsd/gsd-core). You describe what you want in one prompt; the Conductor ("Kiwi") decomposes it, fans out parallel git-worktree agents that each run a tailored GSD flow, verifies every change (computer-use + vision), assembles the work on a standing `next` integration branch, and hands you a reviewable result. No agent ever writes to `main`.

bgsd is **gsd-agnostic**: it does not vendor GSD. It uses the `gsd-core` plugin installed in your Claude Code and keeps it current for you, so you always ride the latest GSD without ever syncing this repo.

## Install

```sh
claude plugin marketplace add filippo-fonseca/better-gsd
claude plugin install bgsd@better-gsd
```

At the start of every session the Conductor ensures `gsd-core` is installed and up to date.

## Use

```sh
/bgsd-init                   # one-time per repo: creates `next`, BGSD.md, and the .bgsd master folder
/bgsd-sesh "build me X"      # the one front door: describe it, then walk away
```

Everything else (`/bgsd-verify`, `/bgsd-run`, Loop 1, Loop 2, the review gate) is an internal stage the Conductor sequences for you.

## How it works

Conductor → Loop 1 (parallel Pipeline Agents + Testers, verify then fix) → merge into `next` → Loop 2 (whole-app integration verification + parallel fix agents) → User Review Gate → you merge `next` into `main` by hand.

- The plugin lives in [`bgsd/`](./bgsd).
- Docs are in [`bgsd/docs`](./bgsd/docs); the landing page is [`bgsd/site`](./bgsd/site).
- The design is in [`BETTER-GSD-DOCS/BETTER-GSD-PLAN.md`](./BETTER-GSD-DOCS/BETTER-GSD-PLAN.md).

## License

MIT
