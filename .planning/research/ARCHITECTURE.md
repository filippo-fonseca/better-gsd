# Architecture Patterns — better-gsd v0 (Standalone Tester)

**Domain:** Claude Code plugin (additive layer on a GSD fork)
**Researched:** 2026-06-29
**Confidence:** HIGH (based on direct repo inspection + PRD source)

---

## Recommended Architecture

### Additive Directory Layout (Critical — Never Edits Vendored GSD)

The repo root IS the GSD fork. GSD owns: `commands/gsd/`, `agents/gsd-*.md`, `scripts/gsd-*.{sh,js,cjs}`, `hooks/`, `.claude-plugin/plugin.json`, `skills/`, `src/`, `gsd-core/`. These are read-only to bgsd.

bgsd lives entirely under a top-level `bgsd/` namespace plus its own plugin manifest:

```
better-gsd/                          ← repo root (GSD fork)
├── .claude-plugin/
│   └── plugin.json                  ← GSD's manifest (READ-ONLY to bgsd)
├── bgsd/                            ← ALL bgsd v0 source lives here
│   ├── plugin.json                  ← bgsd's OWN manifest (separate file)
│   ├── commands/
│   │   └── bgsd-verify.md           ← /bgsd:verify slash command
│   ├── agents/
│   │   └── tester.md                ← Tester agent (verification driver)
│   ├── scripts/
│   │   └── runtime-isolate.sh       ← per-instance port + DB isolation
│   └── reports/                     ← (gitignored) runtime output landing zone
│       └── .gitkeep
├── .bgsd/                           ← runtime state (gitignored except structure)
│   └── runs/                        ← verification-report.json lands here per run
├── .planning/
│   ├── PROJECT.md
│   ├── config.json
│   └── research/                    ← this file
└── ... (all GSD dirs, untouched)
```

**Why `bgsd/` not a flat layout:** GSD already owns `commands/`, `agents/`, `scripts/` at root. Putting bgsd files there would be additive in name but visually colliding and fragile — a GSD update that adds `commands/gsd-verify.md` would shadow bgsd's file. A dedicated `bgsd/` dir makes the boundary physical and unambiguous.

**Why a separate `bgsd/plugin.json`:** GSD's `.claude-plugin/plugin.json` points `"commands": "./commands/gsd/"`. bgsd must NOT edit that file. Instead bgsd ships its own manifest at `bgsd/plugin.json` which Claude Code loads as a second plugin alongside GSD. This is the correct multi-plugin pattern for a fork: two manifests, two command namespaces, zero file collision.

### Component Boundaries (v0)

| Component | File | Responsibility | Reads From | Writes To |
|-----------|------|----------------|------------|-----------|
| `/bgsd-verify` command | `bgsd/commands/bgsd-verify.md` | Entry point: parse args (URL + spec path), invoke Tester agent, emit report path | User CLI args, `.planning/` acceptance spec | stdout |
| Tester agent | `bgsd/agents/tester.md` | Drive verification ladder (console → network → DOM → vision), emit `verification-report.json` | Running app URL, acceptance criteria file | `.bgsd/runs/<run-id>/verification-report.json` |
| Runtime isolate | `bgsd/scripts/runtime-isolate.sh` | Boot one app instance at a unique port with ephemeral DB/seed, export `.env.bgsd` | Project root (detects framework), `.env.bgsd.template` | `.env.bgsd` (ephemeral), stdout port |
| Report schema | (JSON, emitted by Tester) | Structured defect list + verdict | Tester findings | `.bgsd/runs/<run-id>/verification-report.json` |

### Data Flow

```
User: /bgsd-verify <url> <spec>
        |
        v
bgsd/commands/bgsd-verify.md
  - if no URL: calls runtime-isolate.sh → gets port → constructs URL
  - reads acceptance criteria (UI-SPEC.md or inline)
  - spawns Tester agent with (url, criteria, run-id)
        |
        v
bgsd/agents/tester.md  (verification driver ladder)
  Step 1: script — capture console logs via Chrome MCP / Playwright
  Step 2: script — capture network errors (4xx/5xx)
  Step 3: script — query DOM for expected elements / text
  Step 4: model (Sonnet/medium) — interpret ambiguous findings, vision fallback
  Step 5: model (Haiku/low) — classify defects, write report
        |
        v
.bgsd/runs/<run-id>/
  verification-report.json
  screenshots/
        |
        v
/bgsd-verify prints: PASS/FAIL + defect count + report path
```

---

## Runtime Isolation — `bgsd/scripts/runtime-isolate.sh`

### Port Allocation Strategy

Use a deterministic-but-collision-safe scheme: base port (3100) + hash of the absolute worktree path mod 900. This gives a stable port per worktree across restarts (idempotent) while avoiding collisions across parallel instances. Fallback: if the computed port is in use, increment until a free one is found (max 10 tries, fail loudly).

```bash
#!/usr/bin/env bash
# bgsd/scripts/runtime-isolate.sh
# Usage: source bgsd/scripts/runtime-isolate.sh
# Exports: BGSD_PORT, BGSD_DB_PATH, BGSD_ENV_FILE

set -euo pipefail

WORKTREE_ROOT="${1:-$(pwd)}"
BASE_PORT=3100

# Deterministic port: hash worktree path to 0-899, add to base
_hash=$(echo -n "$WORKTREE_ROOT" | cksum | awk '{print $1}')
_candidate=$(( BASE_PORT + (_hash % 900) ))

# Find a free port (up to 10 offsets)
for i in $(seq 0 9); do
  _port=$(( _candidate + i ))
  if ! lsof -i TCP:"$_port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    BGSD_PORT=$_port
    break
  fi
done
: "${BGSD_PORT:?ERROR: could not find a free port near $_candidate}"

# Ephemeral DB: SQLite file scoped to this run
BGSD_RUN_ID="${BGSD_RUN_ID:-bgsd-$(date +%s)}"
BGSD_DB_PATH="${WORKTREE_ROOT}/.bgsd-tmp/${BGSD_RUN_ID}.db"
mkdir -p "$(dirname "$BGSD_DB_PATH")"

# Write .env.bgsd (sourced by the app start command)
BGSD_ENV_FILE="${WORKTREE_ROOT}/.env.bgsd"
cat > "$BGSD_ENV_FILE" <<ENV
PORT=${BGSD_PORT}
DATABASE_URL=file:${BGSD_DB_PATH}
NODE_ENV=test
BGSD_RUN_ID=${BGSD_RUN_ID}
ENV

export BGSD_PORT BGSD_DB_PATH BGSD_ENV_FILE BGSD_RUN_ID
echo "bgsd-isolate: port=${BGSD_PORT} db=${BGSD_DB_PATH}"
```

**Key decisions:**
- `.env.bgsd` convention: apps load this file at startup (via `dotenv -e .env.bgsd -- <start-cmd>` or equivalent). It overrides `PORT` and `DATABASE_URL` only. App's `.env` and `.env.local` are unchanged.
- Ephemeral SQLite at `.bgsd-tmp/<run-id>.db` — created fresh per run, deleted after verification (or kept for debugging with `--keep-db`).
- `.bgsd-tmp/` is gitignored globally by bgsd's `.gitignore` addition.
- For Postgres-backed apps: substitute `DATABASE_URL` with a test-schema URL (e.g. `postgres://localhost/app_bgsd_<run-id>`). The script detects `DATABASE_URL` format and creates/drops the schema. SQLite is the default for Next.js apps with Prisma/Drizzle SQLite config.
- Seed: after DB creation, run `npm run db:seed -- --env .env.bgsd` (configurable via `BGSD_SEED_CMD` in `.env.bgsd.template`).

### `.env.bgsd.template` Convention

Projects that need bgsd testing create `.env.bgsd.template` at their root:

```bash
# .env.bgsd.template — checked into the project repo
# bgsd fills PORT, DATABASE_URL, BGSD_RUN_ID at runtime.
# Add any test-mode overrides here:
NEXT_PUBLIC_API_URL=http://localhost:${PORT}
BGSD_SEED_CMD=npm run db:seed:test
DISABLE_RATE_LIMITING=true
```

This keeps project-specific overrides versioned without touching `.env` or `.env.local`.

---

## Plugin Manifest — `bgsd/plugin.json`

Claude Code's plugin system allows multiple `plugin.json` manifests. GSD's manifest is at `.claude-plugin/plugin.json` and declares `"commands": "./commands/gsd/"` (namespace: `gsd:`). bgsd's manifest lives at `bgsd/plugin.json` and declares its own commands directory and namespace:

```json
{
  "name": "bgsd",
  "displayName": "better-gsd (bgsd)",
  "version": "0.1.0",
  "description": "Autonomous verification layer for GSD — /bgsd-verify and the Standalone Tester.",
  "author": {
    "name": "filippo-fonseca",
    "url": "https://github.com/filippo-fonseca"
  },
  "homepage": "https://github.com/filippo-fonseca/better-gsd",
  "repository": "https://github.com/filippo-fonseca/better-gsd",
  "license": "MIT",
  "requires": ["gsd-core"],
  "commands": "./bgsd/commands/",
  "agents": "./bgsd/agents/",
  "hooks": "./bgsd/hooks.json"
}
```

**Namespace collision prevention:**
- GSD command names follow the pattern `gsd:<name>` (e.g. `/gsd:verify`, `/gsd:execute-phase`).
- bgsd command names follow `bgsd:<name>` (e.g. `/bgsd:verify`).
- Because each manifest declares its own `commands` directory path, there is zero file collision. A GSD update adding `commands/gsd/verify.md` does not touch `bgsd/commands/bgsd-verify.md`.

### Command File Format — `bgsd/commands/bgsd-verify.md`

Follows GSD's existing command frontmatter style (inspected from `commands/gsd/audit-fix.md`):

```markdown
---
type: prompt
name: bgsd:verify
description: Standalone Tester — boot a running app and verify it against acceptance criteria, returning a structured defect report.
argument-hint: "[--url <url>] [--spec <path>] [--boot] [--keep-db]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Agent
---
```

### Agent File Format — `bgsd/agents/tester.md`

Follows GSD's agent frontmatter style (inspected from `agents/gsd-eval-planner.md`):

```markdown
---
name: bgsd-tester
description: Drives the verification-driver ladder (console → network → DOM → vision) against a running app instance. Emits verification-report.json.
tools: Read, Write, Bash, mcp__playwright__*, mcp__chrome__*
color: teal
---
```

---

## Report Schema — `verification-report.json`

```json
{
  "$schema": "https://bgsd.dev/schemas/verification-report/v0.json",
  "run_id": "bgsd-1751234567",
  "timestamp": "2026-06-29T14:03:22Z",
  "target_url": "http://localhost:3101",
  "spec_path": ".planning/phases/01-foundation/UI-SPEC.md",
  "verdict": "FAIL",
  "summary": {
    "total_criteria": 8,
    "passed": 6,
    "failed": 2,
    "defect_count": 3,
    "critical_count": 1
  },
  "criteria": [
    {
      "id": "crit-01",
      "description": "Page title renders 'Dashboard'",
      "source": "UI-SPEC.md#L12",
      "status": "pass",
      "driver": "dom",
      "evidence": "document.title === 'Dashboard'"
    },
    {
      "id": "crit-02",
      "description": "No console errors on load",
      "source": "UI-SPEC.md#L18",
      "status": "fail",
      "driver": "console",
      "evidence": "2 console errors captured (see defects)"
    }
  ],
  "defects": [
    {
      "id": "defect-01",
      "criterion_id": "crit-02",
      "severity": "critical",
      "source": "console",
      "message": "Warning: Each child in a list should have a unique 'key' prop.",
      "location": "http://localhost:3101/_next/static/chunks/page.js:42",
      "raw": "<full console message>",
      "screenshot": null
    },
    {
      "id": "defect-02",
      "criterion_id": "crit-02",
      "severity": "high",
      "source": "console",
      "message": "Error: <script> cannot appear as a child of <head>. Did you use next/script?",
      "location": "http://localhost:3101/_next/static/chunks/app.js:11",
      "raw": "<full console message>",
      "screenshot": null
    },
    {
      "id": "defect-03",
      "criterion_id": "crit-07",
      "severity": "medium",
      "source": "network",
      "message": "GET /api/user returned 404",
      "location": "/api/user",
      "raw": "{ status: 404, url: '/api/user', initiator: 'fetch' }",
      "screenshot": "screenshots/defect-03-network-404.png"
    }
  ],
  "screenshots": [
    {
      "id": "ss-01",
      "label": "initial-load",
      "path": "screenshots/initial-load.png",
      "timestamp": "2026-06-29T14:03:25Z",
      "criterion_id": null
    },
    {
      "id": "ss-02",
      "label": "defect-03-network-404",
      "path": "screenshots/defect-03-network-404.png",
      "timestamp": "2026-06-29T14:03:31Z",
      "criterion_id": "crit-07"
    }
  ],
  "driver_ladder": {
    "console": { "ran": true, "findings": 2 },
    "network": { "ran": true, "findings": 1 },
    "dom": { "ran": true, "findings": 0 },
    "vision": { "ran": false, "reason": "all criteria resolved by earlier drivers" }
  },
  "environment": {
    "port": 3101,
    "db_path": ".bgsd-tmp/bgsd-1751234567.db",
    "node_env": "test",
    "framework_detected": "nextjs"
  }
}
```

**Schema design rationale:**

- `verdict`: top-level `PASS | FAIL | ERROR` (ERROR = tester itself failed, not the app).
- `criteria[]`: one entry per acceptance criterion from the spec, each with `status: pass | fail | skip` and `driver` (which rung of the ladder caught/confirmed it).
- `defects[]`: independent of criteria — a defect may map to one criterion or be unattributed (orphan console error). Severity: `critical | high | medium | low`. Source: `console | network | dom | vision`.
- `screenshots[]`: sparse — only taken at initial load + when a defect warrants visual evidence. NOT one per criterion (expensive, slow, noisy).
- `driver_ladder`: audit trail showing which drivers ran and how many findings each produced. Key for diagnosing tester performance and confirming the console-first priority held.
- `environment`: captures isolation context so the report is self-contained and reproducible.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Files in GSD's own directories
**What:** Adding `commands/bgsd-verify.md` directly under `commands/` (alongside GSD's `commands/gsd/`).
**Why bad:** A GSD upstream update may add a file with a conflicting name; also violates the hard rule "never edit vendored GSD" by occupying GSD's namespace.
**Instead:** All bgsd files under `bgsd/` with bgsd's own manifest declaring that path.

### Anti-Pattern 2: Editing `.claude-plugin/plugin.json`
**What:** Adding bgsd commands to GSD's existing plugin manifest.
**Why bad:** That file is GSD's. Editing it means bgsd must track and re-apply the edit on every GSD merge — exactly the upgrade fragility the ACL design prevents.
**Instead:** Ship `bgsd/plugin.json` as a second manifest. Claude Code loads both.

### Anti-Pattern 3: Fixed port (e.g. always 3100)
**What:** Hardcoding `PORT=3100` in the isolation script.
**Why bad:** Collides immediately when the user's dev server is already on 3100 (the Next.js default), or when two bgsd verify runs overlap.
**Instead:** Hash-derived base + lsof collision check as described above.

### Anti-Pattern 4: Screenshots as primary verification
**What:** Taking a screenshot for every criterion and using vision to verify all of them.
**Why bad:** Expensive, slow, and misses the `<script>`-in-JSX class of console error entirely — the make-or-break test for v0.
**Instead:** Enforce the driver ladder: console → network → DOM (cheap/free, no model) before any vision call. Screenshots are supplemental evidence for defects that warrant them, not the primary oracle.

### Anti-Pattern 5: Monolithic `verification-report.json` embedded in stdout
**What:** Printing the full JSON report to stdout and having the command parse it.
**Why bad:** Large reports (many screenshots) overflow stdout; hard to reference later; can't be passed to Loop 1 by file path.
**Instead:** Write to `.bgsd/runs/<run-id>/verification-report.json`; stdout prints only the verdict line + report path.

---

## Scalability Considerations (v0 scope only)

| Concern | v0 (one instance) | v1+ (parallel) |
|---------|-------------------|----------------|
| Port allocation | hash + lsof check, deterministic | Same scheme, each worktree gets its own `.env.bgsd` |
| DB isolation | ephemeral SQLite per run | Per-worktree SQLite or per-worktree Postgres schema |
| Report storage | `.bgsd/runs/<run-id>/` | Same, one subdir per agent-id |
| Screenshot volume | sparse (defects only) | Same policy, aggregated into run subdir |

---

## Suggested Build Order (v0)

1. `bgsd/plugin.json` + `bgsd/commands/bgsd-verify.md` skeleton — establish the namespace and confirm Claude Code loads it alongside GSD without collision. (30 min)
2. `bgsd/scripts/runtime-isolate.sh` — port allocation + `.env.bgsd` write + SQLite ephemeral DB. Validate with a real Next.js app. (1–2 hrs)
3. `verification-report.json` schema as a TypeScript type + JSON Schema file at `bgsd/schemas/verification-report.v0.json`. (30 min)
4. `bgsd/agents/tester.md` — verification driver ladder, hardest piece. Spike first on the console-capture path (the make-or-break test: catch a `<script>`-in-JSX warning). (2–3 hrs)
5. Wire `bgsd-verify.md` → `runtime-isolate.sh` (optional boot) → Tester agent → report output. End-to-end test. (1 hr)
6. Docs: Quickstart + `/bgsd-verify` usage page (Part 14 of PRD).

---

## Sources

- Direct inspection: `/Users/filippofonseca/Developer/Projects/better-gsd/.claude-plugin/plugin.json` (GSD manifest structure)
- Direct inspection: `/Users/filippofonseca/Developer/Projects/better-gsd/agents/gsd-eval-planner.md` (agent frontmatter format)
- Direct inspection: `/Users/filippofonseca/Developer/Projects/better-gsd/commands/gsd/audit-fix.md` (command frontmatter format)
- PRD: `BETTER-GSD-DOCS/better-gsd-plan.md` Parts 2, 9, 10, 12 (hard rules, open risks, repo layout, ACL/upgrade design)
- `.planning/PROJECT.md` (v0 requirements, hard invariants)
- Confidence: HIGH — based on direct repo inspection; no speculative external sources needed for this architecture dimension.
