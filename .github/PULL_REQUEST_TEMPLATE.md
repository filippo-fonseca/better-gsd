## Summary

<!-- What does this PR change and why? Keep it focused: one logical unit per PR. -->

## Related issue

<!-- Use a closing keyword so the issue auto-closes on merge. -->
Closes #

## Changes

<!-- Bulleted list of the concrete changes. -->
-

## Checklist

- [ ] Tests pass: `for t in bgsd/scripts/test-*.mjs; do node "$t"; done` (no `FAIL`)
- [ ] New behavior comes with tests under `bgsd/scripts/test-*.mjs`
- [ ] **No silent green:** any verification path emits `INSUFFICIENT_EVIDENCE` / `BLOCKED` / `FAIL` on failure, never a fabricated `PASS`
- [ ] Additive only: new code under `bgsd/`; no edits to vendored GSD directories
- [ ] Mutations routed through the `*-live.mjs` seam and its guards (`--live` / `requireNotProductionBranch`); no agent writes the production branch
- [ ] PR targets `next`, commits are small and atomic, staged with explicit pathspecs
- [ ] Version bumped across all three manifests if this is a release

## Notes for reviewers

<!-- Anything reviewers should know: tradeoffs, follow-ups, screenshots. -->
