# /bgsd-integrate — Loop 2 Live Integration Run (Kiwi, the Conductor)

`/bgsd-integrate` (or equivalently, advancing a run to its `integrating` state via
`runLiveLoop2()`) is the **Phase 2** live integration step in the v3 two-loop machine.
It takes the standing `next` integration branch that the v2 Conductor assembled into
and runs **Loop 2** against it: boot the whole integrated app, run the Integration Tester
end-to-end across feature boundaries, dispatch parallel fix agents on any integration
defects, re-merge, and re-verify in a bounded Ralph-style loop until clean (or a stop
condition fires).

**Default: `--dry-run`.** No app is booted, no Tester is run, and no fixes are
dispatched unless you explicitly pass `--live` after reading the human-gated checklist.

---

## What Loop 2 does

```
next assembled (v2 Conductor)
  → LOOP2-01: advance run.json → "integrating"
  → LOOP2-02: boot integrated app (runtime-isolate.sh)
            + run Integration Tester → integration-report.json
                verdict ∈ PASS | FAIL | ERROR | BLOCKED
  → PASS:   integration_done → advance to User Review Gate (Phase 3)
  → ERROR / BLOCKED: integration_blocked (fix NEVER called; NFR-06)
  → FAIL:
      → LOOP2-03: dispatch build-lane fix agents using the session contract
                  in worktrees off next
               → re-merge via conflict.mjs (dependency-ordered)
               → re-verify (goto LOOP2-02)
  → stop conditions (LOOP2-04):
      max_iterations reached  → integration_failed
      same defect signature   → integration_failed (no-progress)
      BLOCKED or ERROR        → integration_blocked
```

The loop shape is identical to v1 Loop 1, applied at integration scope:
"Same loop shape, applied twice" (Plan Part 5).

---

## Architecture

The live integration run is split into two layers, mirroring the `loop1` / `loop1-live`
and `run` / `run-live` split from v1/v2:

| File | Purpose |
|------|---------|
| `bgsd/scripts/loop2.mjs` | **Phase 1** — deterministic Loop 2 controller (no real processes). All live operations are dependency-injected. Unit-testable under mocked `verify`/`fix`/`reMerge`. |
| `bgsd/scripts/loop2-live.mjs` | **Phase 2** — guarded live seam (this command's backing code). Provides `liveVerify`, `liveFix`, `liveReMerge`, and `runLiveLoop2`. Refuses without `--live`. |

---

## Usage

```sh
# Dry-run (the default — prints the integration plan, creates nothing):
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop2-live.mjs"
# → HUMAN-GATED refusal; shows the checklist and exits non-zero.

# Live run (human-gated — read the checklist below first):
node "${CLAUDE_PLUGIN_ROOT}/scripts/loop2-live.mjs" --live \
  --run-id bgsd-0001-my-feature \
  --rehearsal-branch next \
  --max-iterations 5
```

Or programmatically (from the Conductor):

```js
import { runLiveLoop2 } from "./bgsd/scripts/loop2-live.mjs";

// Only call this after passing --live in process.argv
const result = await runLiveLoop2({
  runId:           "bgsd-0001-my-feature",
  rehearsalBranch: "next",
  runJsonPath:     ".bgsd/runs/bgsd-0001-my-feature/run.json",
  loopOpts:        { maxIterations: 5 },
});
// result: { outcome, reason, iterations, reportPath, logPath, lastReport }
```

---

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--run-id <id>` | Yes | The run identifier (e.g. `bgsd-0001-my-feature`). |
| `--rehearsal-branch <branch>` | No (default: `next`) | The standing integration branch to run against. |
| `--max-iterations <n>` | No (default: 5) | Hard cap on fix→re-merge→re-verify cycles (LOOP2-04). |
| `--dry-run` | No (the default) | Print the integration plan without booting or fixing anything. |
| `--live` | **Human-gated** | Engage the real live integration path. See checklist below. |
| `--budget-cap <$>` | Recommended with `--live` | Per-run token/cost cap (also `BGSD_BUDGET_CAP`). |

---

## Integration report

The Integration Tester emits `integration-report.json` at
`.bgsd/runs/<run-id>/integration-report.json`. It reuses the v0 report contract
unchanged (`verdict`, `criteria_results`, `defects`) and adds an `integration`
block with integration-specific scrutiny metadata:

```json
{
  "run_id":        "bgsd-0001-my-feature",
  "generated_at":  "2026-06-29T00:00:00.000Z",
  "scope":         "integration",
  "verdict":       "PASS | FAIL | ERROR | BLOCKED",
  "integration": {
    "rehearsal_branch": "next",
    "iteration":        0,
    "scrutiny": {
      "cross_boundary_uat":     true,
      "integrated_diff_review": true,
      "alignment_check":        true,
      "improvement_scrutiny":   true
    }
  },
  "criteria_results": [ ... ],
  "defects":          [ ... ]
}
```

An integration log is also written to `.bgsd/runs/<run-id>/integration.md`
with the full iteration trail and stop reason.

---

## `--live` — human-gated live integration run (LOOP2-05, NFR-10)

The live path boots the actual integrated app on `next` and drives real
Integration-Tester→fix cycles. It is **off by default** and requires an explicit
`--live` opt-in.

### Before you run `--live`

Work through this checklist every time:

1. **Branch safety.** You are on a feature branch, NOT `main`.
   Verify: `git branch --show-current`
2. **Phase 1 controller clean.** `loop2.mjs` ran green under mocked `Tester`/`fix`
   in unit tests before this step.
3. **Budget cap.** You have a per-run budget cap set (`--budget-cap` or
   `BGSD_BUDGET_CAP` env var) to limit model spend.
4. **Stay awake.** `caffeinate -dimsu &` is running so the Mac does not
   sleep while the integration run is in flight.
5. **Watch the terminal.** This is NOT fire-and-forget. Kiwi prints iteration
   progress; you must be present to respond to stop conditions.
6. **Isolation in place.** `runtime-isolate.sh` isolation is configured: the
   integrated `next` app runs on its own port/DB/env with no shared state with production.
7. **`next` is the integration branch.** Fix-agent worktrees branch off
   `next`, and the re-merge targets `next`. `main` is NEVER touched
   automatically. Only you can merge `next` → `main` by hand.

### Stop conditions (LOOP2-04, NFR-06, NFR-08)

| Condition | Outcome | run.json state |
|-----------|---------|----------------|
| Integration Tester returns `PASS` | `integration_done` | advances to review gate |
| `BLOCKED` or `ERROR` verdict | `integration_blocked` | fix NEVER called |
| Same defect signature twice (no progress) | `integration_failed` | `integration_failed` |
| `max_iterations` reached | `integration_failed` | `integration_failed` |

No fabricated clean integrations — ever (NFR-06: no silent green).

---

## Guard implementation

Every exported live function in `loop2-live.mjs` calls `requireLiveFlag()` as its
FIRST executable line. The check uses `process.argv`, NOT `process.env`, so a CI
environment variable cannot accidentally unlock the live path.

`runLiveLoop2()` also calls `requireNotProductionBranch()` (independently of `--live`)
to enforce NFR-01 unconditionally. The integration branch `next` is allowed; only the
production branch (`main`/`master`) is refused.

```js
// Exact guard, mirrors loop1-live.mjs and run-live.mjs:
export function requireLiveFlag() {
  if (!process.argv.includes("--live")) {
    throw new Error(/* human-readable refusal + checklist */);
  }
}

export function requireNotProductionBranch() {
  const branch = spawnSync("git", ["branch", "--show-current"], ...).stdout.trim();
  if (branch === "main" || branch === "master") {
    throw new Error(/* NFR-01 violation message */);
  }
}
```

---

## What the `--dry-run` default prints

Without `--live`, every live function throws the human-gated refusal, which
includes the safety checklist and the correct invocation. There is no silent pass
and no integration work is performed.

```
======================================================================
HUMAN-GATED: loop2-live.mjs refused to run.

The live Loop 2 integration run (real `next` app boot + real
Integration Tester→fix cycles) requires an explicit --live flag
to prevent accidental automation.

To run this supervised:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/loop2-live.mjs" --live [options]
...
======================================================================
```

---

## Related files

| File | Purpose |
|------|---------|
| `bgsd/scripts/loop2.mjs` | Phase 1 deterministic Loop 2 controller (mocked boundaries) |
| `bgsd/scripts/loop2-live.mjs` | Phase 2 live seam (this command) |
| `bgsd/scripts/test-loop2.mjs` | Unit tests for `loop2.mjs` (all-mocked) |
| `bgsd/scripts/test-loop2-live.mjs` | Unit tests for `loop2-live.mjs` (guard + refusal) |
| `bgsd/scripts/runtime-isolate.sh` | Boot/readiness/teardown for the integrated `next` app |
| `bgsd/scripts/build-report.mjs` | Integration Tester → `integration-report.json` |
| `bgsd/scripts/conflict.mjs` | Dependency-ordered re-merge after fixes |
| `bgsd/scripts/run.mjs` | Run lifecycle state machine (`advanceState` → `integrating`) |

---

## Safety guarantees

- **NFR-01 (branch safety):** bgsd never writes to `main`. Fix-agent branches
  and the re-merge all target the standing `next` branch. Only you merge
  `next` → `main` by hand.
- **NFR-06 (no silent green):** `BLOCKED`/`ERROR` verdicts park the run immediately
  without calling fix. No integration-defect backlog is silently cleared.
- **NFR-08 (bounded, reversible autonomy):** Loop 2 is bounded by `max_iterations`
  and exits cleanly on any stop condition. The per-run budget cap limits model spend.
- **NFR-10 (live integration run is human-gated):** Real booting and real Tester→fix
  cycles are exercised only under explicit `--live` opt-in, human-supervised, never
  in automated CI, `main` never written. `--dry-run` is the default.
- **No-progress detection:** If the same integration-defect signature recurs across
  iterations (no progress), Loop 2 stops immediately rather than burning budget on
  a stuck fix cycle.
