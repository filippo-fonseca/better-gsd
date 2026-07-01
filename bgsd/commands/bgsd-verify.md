---
name: bgsd-verify
description: "Boot or attach to a running app and verify it against acceptance criteria, returning a structured defect list (console → network → DOM → vision)."
argument-hint: "<url | --boot <app-dir>> [--criteria <file> | --inline \"...\"]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
---

# /bgsd-verify

Verify a running app against acceptance criteria and write a structured
`verification-report.json`. Every acceptance criterion is checked 1:1 against
the four-rung driver ladder (console → network → DOM → vision). The output
is a single verdict line on stdout and a report file on disk.

> **Voice & output discipline.** Human-facing narration is delivered in Kiwi's
> British-butler register (addresses you as "sir"; see `bgsd/PERSONALITY.md`).
> The structured outputs never change: the stdout verdict line stays exactly
> `PASS|FAIL|ERROR  <report-path>` and the report JSON stays literal. The butler
> is unfailingly honest about a failure — "no silent green," in costume.

---

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<url>` | One of `<url>` or `--boot` | Verify an already-running app at this URL. |
| `--boot <app-dir>` | One of `<url>` or `--boot` | Boot one isolated instance first via `runtime-isolate.sh`, then verify it. |
| `--criteria <file>` | One of `--criteria` or `--inline` | Acceptance criteria from a GSD `UI-SPEC.md` or acceptance file. |
| `--inline "..."` | One of `--criteria` or `--inline` | Acceptance criteria given inline (quote the string; separate criteria with `;` or newlines). |
| `--no-usage-verification` | No | Code-only mode: run the goal-backward gsd-verifier against the criteria but **skip the Playwright usage-testing ladder** (no browser). Equivalent to `BGSD_USAGE_TESTING=0`. |
| `--headless-ui` | No | Run Playwright **headless** (no visible browser/server window). Equivalent to `BGSD_HEADLESS_UI=1`. Orthogonal to usage-testing. |

---

## Verification mode (BGSD_USAGE_TESTING)

bgsd verifies in two modes; the goal-backward **code verification** (gsd-verifier)
always runs. The Playwright **usage testing** (the driver ladder below) is toggled
by the session — off for quick fixes and non-UI changes:

- **Full (default):** `BGSD_USAGE_TESTING=1` or unset → run the full
  console → network → DOM → vision ladder.
- **Code-only:** `BGSD_USAGE_TESTING=0` (set by `/bgsd-sesh --no-usage-verification`,
  the `--no-usage-verification` arg here, or the `verification.usage_testing`
  BGSD.md knob) → **skip the ladder and the MCP probe**, run the gsd-verifier
  code/goal check, and emit a report with `verification_mode: "code-only"` and
  every ladder rung marked skipped. A missing Playwright MCP is **not** BLOCKED in
  this mode. "No silent green" still holds: `PASS` requires the gsd-verifier to
  confirm the criteria.

The Tester agent (`bgsd/agents/tester.md`) reads `BGSD_USAGE_TESTING` first and
branches accordingly.

---

## Output

- **stdout:** exactly one line: `PASS|FAIL|ERROR  .bgsd/runs/<run-id>/verification-report.json`
- **file:** `.bgsd/runs/<run-id>/verification-report.json` — full report (per-criterion
  pass/fail, defect list, screenshot index, driver-ladder audit, environment block).

---

## Orchestration Procedure

### Step 0: Generate a run ID

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
```

All run artifacts land under `.bgsd/runs/$RUN_ID/`.

---

### Step 1: Resolve the target URL (VERIFY-01)

**Case A — URL provided directly:**

```
url = <url>   # e.g. http://localhost:3000
```

**Case B — `--boot <app-dir>` provided:**

```bash
# Boot the app in isolation. The script prints PORT: and DATABASE_URL:, then READY.
OUTPUT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/runtime-isolate.sh" up <app-dir>)"
PORT="$(echo "$OUTPUT" | grep '^PORT:' | cut -d: -f2 | tr -d ' ')"
url="http://localhost:${PORT}"
```

The script is safe to call repeatedly; it assigns a unique port per invocation.
Record the `<app-dir>` so you can tear it down in Step 6.

---

### Step 2: Parse acceptance criteria (VERIFY-01)

**From a file (`--criteria <file>`):**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-criteria.mjs" --file <file> --pretty \
  > .bgsd/runs/$RUN_ID/criteria.json
```

**Inline (`--inline "..."`):**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-criteria.mjs" --inline "<inline-string>" --pretty \
  > .bgsd/runs/$RUN_ID/criteria.json
```

The output is a JSON array `[{ id, description, source }]`. Every criterion
gets a stable ID (`CRIT-01`, `CRIT-02`, ...). Read this file; you will pass it
to the tester in Step 3.

---

### Step 3: Spawn the tester subagent (VERIFY-02)

> **Why a general-purpose subagent, not the plugin subagent:** CC bugs #13254
> and #13605 mean plugin subagents may not inherit MCP tools (specifically
> `@playwright/mcp`). Spawn a **general-purpose Agent** seeded with the tester
> runbook. See `bgsd/docs/INTEGRATION-NOTES.md` for the full rationale.

Spawn the agent with:

```
Agent(
  system_prompt = contents of bgsd/agents/tester.md,
  task = """
    Run id: <RUN_ID>
    Target URL: <url>
    Criteria: <contents of .bgsd/runs/<RUN_ID>/criteria.json>

    Execute the bgsd tester runbook exactly as written. Do not skip the
    pre-flight MCP probe. After completing all steps, write the following
    to disk as .bgsd/runs/<RUN_ID>/run-results.json:

    {
      "run_id": "<RUN_ID>",
      "environment": {
        "port": <port or null>,
        "db":   <DATABASE_URL or null>,
        "node_env": <NODE_ENV or null>,
        "framework": <detected framework or null>,
        "build_mode": <"development"|"production">,
        "url":  "<url>"
      },
      "criteria_results": [
        {
          "id": "<criterion id>",
          "description": "<criterion description>",
          "source": "<criterion source>",
          "status": "pass|fail|skip",
          "driver": "console|network|dom|vision|none",
          "evidence": <raw finding entry or null>
        }
        // ... one entry per criterion, no omissions (VERIFY-02)
      ],
      "defects": [
        {
          "id": "DEF-01",
          "severity": "critical|high|medium|low",
          "source": "console|network|dom|vision",
          "description": "<human description>",
          "evidence": <raw entry>,
          "criterion_id": "<id or null>"
        }
        // ... one entry per defect
      ],
      "screenshots": [
        { "label": "initial-load", "path": "screenshot.png" }
        // sparse: initial load + defect evidence only
      ],
      "driver_ladder": {
        "console": { "ran": true|false, "findings": <count> },
        "network": { "ran": true|false, "findings": <count> },
        "dom":     { "ran": true|false, "findings": <count> },
        "vision":  { "ran": true|false, "findings": <count> }
      },
      "error": false   // set to true if the pre-flight probe fails (BLOCKED)
    }

    Mapping rules (VERIFY-02 — no check without a criterion, no criterion unchecked):
    - Every criterion from the criteria list must appear in criteria_results.
    - No criteria_results entry may exist without a corresponding criterion.
    - For each defect, set criterion_id to the criterion it violated, or null
      for a global defect not tied to a specific criterion.

    If the MCP pre-flight probe fails, set "error": true and stop. Do not
    fabricate passing results.
  """
)
```

Wait for the agent to complete and confirm `.bgsd/runs/<RUN_ID>/run-results.json`
exists before proceeding.

---

### Step 4: Assemble the report (REPORT-01..03 + VERIFY-03)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-report.mjs" .bgsd/runs/$RUN_ID/run-results.json
```

This script:
1. Computes the top-level verdict (`PASS` / `FAIL` / `ERROR`).
2. Validates the assembled report object against all required field shapes.
3. Writes `.bgsd/runs/$RUN_ID/verification-report.json` to disk.
4. Prints **exactly one line** to stdout (VERIFY-03):

```
PASS  .bgsd/runs/<run-id>/verification-report.json
```

or `FAIL ...` / `ERROR ...`. That single line is the final output of the command.

---

### Step 5: Teardown (if `--boot` was used)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/runtime-isolate.sh" down <app-dir>
```

Always tear down the booted instance, even if the run failed or errored.
Use a trap or a finally-equivalent to ensure this runs regardless.

---

## Hard Rules

- **No silent green.** If the MCP probe fails, the tester emits `"error": true`
  and the assembler outputs `ERROR`. Never fabricate a `PASS`.
- **1:1 criterion coverage (VERIFY-02).** Every criterion is checked; every
  check maps to a criterion. No orphans on either side.
- **Stdout discipline (VERIFY-03).** Only the single verdict line reaches
  stdout. Full JSON never floods the terminal.
- **Branch safety.** bgsd writes ONLY into `.bgsd/` and `.bgsd-tmp/` directories.
  It never touches, stages, or commits anything outside `bgsd/`.

---

## Quick Reference: Script Invocations

| Step | Script | Purpose |
|---|---|---|
| 1 | `bgsd/scripts/runtime-isolate.sh up <dir>` | Boot isolated app (if `--boot`) |
| 2 | `bgsd/scripts/parse-criteria.mjs --file <f>` | Parse criteria from file |
| 2 | `bgsd/scripts/parse-criteria.mjs --inline "..."` | Parse inline criteria |
| 3 | Agent seeded with `bgsd/agents/tester.md` | Drive browser ladder, save `run-results.json` |
| 4 | `bgsd/scripts/build-report.mjs <run-results.json>` | Assemble, validate, write report |
| 5 | `bgsd/scripts/runtime-isolate.sh down <dir>` | Teardown (if `--boot`) |

---

## Related Files

| Path | Purpose |
|---|---|
| `bgsd/agents/tester.md` | Tester runbook (ladder procedure, pre-flight probe, capture/classify steps) |
| `bgsd/scripts/classify-capture.mjs` | Classifies raw MCP capture into findings |
| `bgsd/scripts/parse-criteria.mjs` | Parses acceptance criteria from file or inline string |
| `bgsd/scripts/build-report.mjs` | Assembles `verification-report.json` and prints the verdict |
| `bgsd/schemas/verification-report.schema.json` | JSON Schema (draft-07) for the report contract |
| `bgsd/scripts/test-report.mjs` | Unit tests for the parser + assembler |
| `bgsd/docs/INTEGRATION-NOTES.md` | MCP invocation decision and CC bug references |
