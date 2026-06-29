# Technology Stack: better-gsd v0 — Standalone Tester

**Project:** better-gsd (`/bgsd-verify`)
**Scope:** v0 ONLY — Standalone Tester. Conductor/parallelism out of scope.
**Researched:** 2026-06-29
**Overall confidence:** HIGH (tool names verified against live GitHub repos and official docs)

---

## Recommended Verification-Driver Stack

### Primary: `@playwright/mcp` (Microsoft Playwright MCP)

| Attribute | Value |
|-----------|-------|
| npm package | `@playwright/mcp` |
| Version (as of 2026-06-29) | v0.0.76 |
| Install (Claude Code) | `claude mcp add playwright npx @playwright/mcp@latest` |
| Stars / ecosystem signal | 7,331 stars; Microsoft-maintained; dominant |
| Headless | Yes (default) |
| Browsers | Chromium, Firefox, WebKit |

**This is the primary driver for all four data channels.** Use it in snapshot mode (accessibility-tree, not pixels) as the default; fall back to vision only when pixel-level check is required.

---

## The Verification-Driver Ladder (in execution order)

> Run cheapest/most reliable channels first. Vision is the last resort — not the default.

### Rung 1 — Console messages (catches `<script>`-in-JSX class of bug)

**Tool:** `browser_console_messages`
**Provider:** `@playwright/mcp`
**What it returns:** All browser console output since page load, filterable by level (`error`, `warning`, `log`, `info`).
**Invocation pattern:**
```
browser_console_messages  →  { level: "error|warning", messages: [...] }
```
**Script discipline (Part 13 rule zero):** Capture raw console output to a file via the MCP tool call; pass only failing lines to the model for interpretation. Never pay a model to poll or babysit.

**This is the make-or-break test for v0.** A React `<script>`-in-JSX warning appears only in the console. `browser_console_messages` catches it deterministically; a screenshot misses it entirely.

---

### Rung 2 — Network requests / failures

**Tool:** `browser_network_requests` (list), `browser_network_request` (full detail: headers, body)
**Provider:** `@playwright/mcp`
**What it returns:** All HTTP requests made since page load; individual request has status code, headers, body.
**Invocation pattern:**
```
browser_network_requests  →  [ { url, method, status, ... }, ... ]
browser_network_request { id }  →  { headers, body, timing }
```
**Use for:** 4xx/5xx API errors, missing assets, failed fetches that produce silent UI failures.

---

### Rung 3 — Rendered DOM / accessibility snapshot

**Tool:** `browser_snapshot`
**Provider:** `@playwright/mcp`
**What it returns:** Accessibility tree as structured YAML — every element by role, name, and state. No pixels; LLM-friendly and cheap.
**Invocation pattern:**
```
browser_snapshot  →  YAML accessibility tree
```
**Use for:** Verifying element presence, text content, interactive state (disabled buttons, aria states), form values. Prefer this over screenshot for any DOM-checkable criterion.

**Note:** The Playwright MCP docs explicitly state "snapshots are better than screenshots" for action-taking and state-reading. Snapshot mode is the default; `--caps=vision` enables coordinate-based interaction only when needed.

---

### Rung 4 — Screenshot / vision (fallback only)

**Tool:** `browser_take_screenshot`
**Provider:** `@playwright/mcp`
**When to use:** Visual-only checks (layout, color, pixel rendering), or when DOM/console/network have not flagged an issue but the criterion is inherently visual ("the hero image renders correctly at mobile breakpoint").
**Model cost:** Vision calls are expensive; scope them narrowly. Per Part 13: most bugs die on rungs 1–3.

---

## Alternative: `chrome-devtools-mcp` (ChromeDevTools/chrome-devtools-mcp)

| Attribute | Value |
|-----------|-------|
| npm package | `chrome-devtools-mcp` |
| Version (as of 2026-06-29) | v1.4.0 |
| Install (Claude Code) | `claude mcp add chrome-devtools npx chrome-devtools-mcp@latest` |
| Also available as plugin | `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp` |
| License | Apache-2.0 |
| Maintained by | Chrome DevTools team (Google) |

**Tool names differ from Playwright MCP:**

| Capability | chrome-devtools-mcp tool | @playwright/mcp tool |
|------------|--------------------------|----------------------|
| Console logs | `list_console_messages` / `get_console_message` | `browser_console_messages` |
| Network | `list_network_requests` / `get_network_request` | `browser_network_requests` / `browser_network_request` |
| DOM | `take_snapshot` / `evaluate_script` | `browser_snapshot` |
| Screenshot | `take_screenshot` | `browser_take_screenshot` |
| Performance | `performance_start_trace` / `performance_stop_trace` | not built-in |
| Memory | heap snapshot tools (9) | not built-in |

**Verdict: Do NOT use as primary for v0.** Reasons:
1. Requires a running Chrome instance (not headless-first); `@playwright/mcp` works headless out of the box.
2. Smaller ecosystem footprint; less community testing.
3. Tool names diverge from what Playwright MCP exposes; the tester agent must speak to one tool vocabulary — pick one.
4. The performance/memory tooling is valuable for later milestones (profiling, Core Web Vitals) but out of scope for v0's correctness checks.

**When to reach for it:** If a v0+ criterion requires real Chrome-specific DevTools features (heap snapshots, CDP-level performance traces, source-mapped stack traces for complex apps). Add as a secondary driver, never replace Playwright MCP.

---

## Server Boot & Readiness Detection (Next.js)

**Pattern:** Shell script (`runtime-isolate.sh`), not a model.

```bash
# 1. Assign an isolated port (offset from base)
PORT=$((3000 + AGENT_OFFSET))

# 2. Boot dev server in background, redirect stdout/stderr to log file
npx next dev --port $PORT > /tmp/bgsd-next-$PORT.log 2>&1 &
SERVER_PID=$!

# 3. Poll for readiness — detect "Ready" in log output
# Next.js prints "Ready in Xs" (or "compiled successfully") to stdout when the
# dev server is up. Poll the log file; do not sleep blindly.
until grep -qE "(Ready in|compiled successfully|ready started server)" /tmp/bgsd-next-$PORT.log; do
  sleep 0.5
  # Timeout guard: kill and fail if server hasn't started in 60s
  if [ $(($(date +%s) - START_TIME)) -gt 60 ]; then
    kill $SERVER_PID; exit 1
  fi
done

# 4. Optionally confirm with an HTTP probe
curl -sf http://localhost:$PORT/ > /dev/null || exit 1

echo "SERVER_READY port=$PORT pid=$SERVER_PID"
```

**Readiness string to match:** Next.js 14+ prints `✓ Ready in Xs` on the dev server stdout. Next.js 15+ may print `ready started server on [::]:PORT`. Match both with a regex.

**Important:** Next.js 16+ includes a built-in MCP endpoint at `/_next/mcp` for dev tooling — this is separate from the tester's browser driver and does not replace `@playwright/mcp`. Do not conflate them.

---

## Supporting Tooling

### Runtime isolation helper

```bash
# scripts/runtime-isolate.sh
# Assigns port, boots server, exports SERVER_URL and SERVER_PID
# Called by the tester agent before driving the browser
```

No additional npm packages needed for port isolation — pure shell arithmetic (`BASE_PORT + AGENT_INDEX`).

### Structured output

Tester emits `verification-report.json`:
```json
{
  "verdict": "fail",
  "criteria": [
    { "id": "cr-001", "description": "...", "status": "pass" },
    { "id": "cr-002", "description": "No console errors", "status": "fail",
      "defects": [{ "channel": "console", "level": "error", "message": "..." }] }
  ],
  "screenshots": ["./screenshots/cr-002-fail.png"],
  "summary": "1/2 criteria passed"
}
```

Model call for interpretation receives only the failing slice of console/network/DOM output, not the full raw log.

---

## Alternatives Considered and Rejected

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Primary browser driver | `@playwright/mcp` v0.0.76 | `chrome-devtools-mcp` v1.4.0 | Requires live Chrome; not headless-first; tool vocabulary diverges; ecosystem smaller |
| Browser driver | `@playwright/mcp` | Puppeteer MCP variants | No official Microsoft/Google backing; smaller ecosystem; Playwright MCP supersedes |
| Screenshot-only verification | (rejected pattern) | Any vision-only driver | Misses console errors entirely — fails the v0 make-or-break test |
| Next.js /_next/mcp endpoint | Not used in v0 | next-devtools-mcp | Dev tooling integration, not browser verification; out of scope for v0 correctness checks |

---

## Installation

```bash
# Primary: Playwright MCP (add to Claude Code MCP config)
claude mcp add playwright npx @playwright/mcp@latest

# Secondary (optional, v0+): Chrome DevTools MCP
claude mcp add chrome-devtools npx chrome-devtools-mcp@latest

# OR as a bundled plugin with skills
# /plugin marketplace add ChromeDevTools/chrome-devtools-mcp
```

No additional Node packages are required for v0 beyond what Next.js and the MCP servers provide.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| `@playwright/mcp` tool names | HIGH | Verified against microsoft/playwright-mcp GitHub + playwright.dev/mcp docs; v0.0.76 confirmed |
| `browser_console_messages` capability | HIGH | Explicitly listed in official Playwright MCP tool reference |
| `browser_network_requests` capability | HIGH | Confirmed in official docs and issue tracker |
| `browser_snapshot` as DOM channel | HIGH | Documented as the preferred alternative to screenshot |
| `chrome-devtools-mcp` tool names | HIGH | Verified against ChromeDevTools/chrome-devtools-mcp GitHub; v1.4.0 confirmed |
| Next.js readiness strings | MEDIUM | `Ready in Xs` is stable across Next 14–15; Next 16 format unverified — add regex fallback |
| `@playwright/mcp` --caps=devtools scope | MEDIUM | Some flag descriptions differ between README and playwright.dev/mcp docs; test at integration time |

---

## Sources

- [microsoft/playwright-mcp — GitHub](https://github.com/microsoft/playwright-mcp)
- [Playwright MCP — Official Docs](https://playwright.dev/mcp/introduction)
- [ChromeDevTools/chrome-devtools-mcp — GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Chrome DevTools MCP — Claude Plugin listing](https://claude.com/plugins/chrome-devtools-mcp)
- [Chrome DevTools for agents — Chrome for Developers](https://developer.chrome.com/docs/devtools/agents)
- [MCP Browser Automation 2026 — AgentSkillsHub](https://agentskillshub.dev/scenarios/mcp-browser-automation/)
- [Chrome DevTools vs Playwright vs Puppeteer MCP (2026) — MCP.Directory](https://mcp.directory/blog/chrome-devtools-mcp-vs-playwright-mcp-2026)
- [Console Logging in mcp-playwright — DeepWiki](https://deepwiki.com/executeautomation/mcp-playwright/3.3-console-logging-and-monitoring)
