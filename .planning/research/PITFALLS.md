# Domain Pitfalls: App Verification Agents

**Domain:** Standalone Tester / `/bgsd-verify` (v0 only)
**Researched:** 2026-06-29
**Scope:** What makes app-verification agents unreliable, and how to mitigate each in v0

---

## Critical Pitfalls

Mistakes that cause the make-or-break test to fail silently or the defect report to be unreliable.

---

### Pitfall 1: Console Listener Attached After Navigation (The Make-or-Break False Negative)

**What goes wrong:** The Tester agent registers its `page.on('console')` handler AFTER calling `page.goto()`. React's `validateDOMNesting` warnings (`Warning: validateDOMNesting(...)`) and hydration mismatches fire during the initial render — before the DOM settles. If the listener isn't attached first, those messages are gone. The tester reports green. The bug ships.

**Why it happens:** It feels natural to navigate first, then set up assertions. Most tutorial code follows this pattern. But console events during page load are not buffered or replayable — they fire exactly once, during initialization.

**Consequences:** The entire premise of v0 — catching a console-level error a screenshot would miss — fails silently. The `<script>`-in-JSX warning (or any hydration mismatch) goes uncaught. The verification report says PASS when it should say FAIL.

**Prevention:**
1. In any Playwright-backed Tester: attach `page.on('console', msg => consoleMessages.push(msg))` and `page.on('pageerror', err => pageErrors.push(err))` BEFORE the `page.goto()` call. This is non-negotiable and must be enforced in the Tester agent's prompt/instructions.
2. At navigation: use `waitUntil: 'domcontentloaded'` (not `networkidle`) to ensure the framework render cycle has started before assertions run, but not so late that the listener is set up after load.
3. In script-only mode (per the "capture-then-summarize" doctrine): use a Playwright Node.js script that pre-attaches the listener, navigates, waits for `domcontentloaded`, and then dumps the full collected message array to a file. The model only sees the filtered/failing slice.

**Detection:** Run a canary test: intentionally introduce a `<script>` tag inside JSX (which triggers `validateDOMNesting`) and confirm the Tester catches it. If the report says PASS, the listener timing is wrong. This IS the make-or-break test for v0.

**V0 phase:** Phase 1 (Tester core). The console listener ordering is the first thing to get right before any other verification capability is built.

---

### Pitfall 2: React Warnings Silenced in Production Builds (Dev vs. Prod Mode Gap)

**What goes wrong:** React's `validateDOMNesting`, `Warning: Each child in a list should have a unique "key"`, and hydration mismatch warnings are only emitted in development builds. The production build of React strips these entirely — `console.error` calls inside React's validation code are guarded by `__DEV__` conditions. If the Tester boots a production bundle, these warnings never appear, and the console capture returns a clean (but meaningless) log.

**Why it happens:** CI/staging environments often serve the production bundle for "realism." bgsd's runtime isolation will likely boot the app with `next dev` or a dev-mode equivalent, but there is no guarantee the target app is running in dev mode.

**Consequences:** The entire class of DOM-nesting and hydration warnings becomes invisible. The Tester misses the most common category of "bugs a screenshot would miss."

**Prevention:**
1. `runtime-isolate.sh` must boot the app in dev mode (`NODE_ENV=development`, `next dev`, etc.), never `next start`. This must be documented as a hard constraint.
2. The verification report's metadata block should record `node_env` and `react_build_mode` (readable from `window.__NEXT_DATA__` or from the `process.env.NODE_ENV` log emitted by the dev server). If the mode is not `development`, the report must emit a `build_mode_warning` field and flag all console assertions as `UNRELIABLE`.
3. For the make-or-break test: the canary page must be served via `next dev`, not `next build && next start`.

**Detection warning sign:** Console capture returns zero warnings during an app render. Either the app is unusually clean (good), or it's running a production build (silent failure). Check the dev-server boot output.

**V0 phase:** Phase 1 (runtime-isolate.sh). Gate on this before the first Tester run.

---

### Pitfall 3: MCP Tool Unavailability (Playwright MCP / Chrome DevTools MCP Not Installed or Not Exposed)

**What goes wrong:** Multiple distinct failure modes, each silent in different ways:

- **Not installed:** The user has not configured `@playwright/mcp` in their Claude Code MCP settings. The Tester agent's tool calls fail with `No such tool available: browser_navigate`. Without a detection check, the agent either hallucinates results or errors out with no structured output.
- **Version mismatch:** Recent versions of `@playwright/mcp` have a known bug where Claude Code fails to expose tools to AI sessions (30-second timeout during `tools/list`). Downgrading to `@playwright/mcp@0.0.41` resolves it, but users won't know to do this.
- **Background subagent blackhole:** When a Tester is spawned as a background subagent (`run_in_background: true`), MCP tools are NOT available — confirmed in issue #13254. The tools work in the primary session but silently fail in background subagents.
- **Custom plugin agent blackhole:** Custom plugin-defined subagents (e.g., `bgsd:tester`) do not receive MCP tools even when the `tools` field explicitly lists them (issue #13605). Built-in `general-purpose` agents DO receive MCP tools. This means the `agents/tester.md` plugin agent cannot currently use Playwright MCP tools directly.

**Why it happens:** MCP tool availability in Claude Code depends on: (1) server registration in `~/.claude/mcp_settings.json` vs. project `.mcp.json`, (2) stdio protocol version compatibility, (3) the specific subagent invocation mode (foreground vs. background vs. built-in vs. custom plugin).

**Consequences:**
- No graceful fallback = the agent either crashes or hallucinates a green report with no actual browser testing performed.
- Custom plugin agent issue means the cleanly-named `bgsd:tester` subagent cannot be used; must delegate to `general-purpose`.

**Prevention:**
1. **Pre-flight check:** At `/bgsd-verify` invocation, before launching the Tester, run a tool-availability probe: attempt a no-op `browser_snapshot` call. If it fails, emit a structured `BLOCKED: mcp_unavailable` verdict with install instructions. Never proceed silently.
2. **Subagent invocation:** Use `subagent_type: "general-purpose"` with `run_in_background: false` for the Tester, not a custom plugin agent type. This is the only confirmed-working path for MCP tools in plugin subagents as of June 2026.
3. **Version pin:** Document `@playwright/mcp@0.0.41` (or the latest verified version) in the plugin's `README` / install instructions. Include a `bgsd doctor` check that probes the MCP version.
4. **Graceful fallback ladder:** If Playwright MCP is unavailable, fall back in order: (a) attempt a raw Playwright Node.js script via `Bash` tool (no MCP), (b) fall back to `curl`-based HTTP checks (network only), (c) emit `PARTIAL: browser_unavailable` verdict flagging which criteria couldn't be checked.

**Detection warning sign:** The Tester's output contains no browser session ID, no screenshot paths, and no console message array. Any report without these fields was produced without a real browser session.

**V0 phase:** Phase 0 (plugin skeleton and `/bgsd-verify` command). The pre-flight check must exist before any real testing capability, because without it a missing MCP silently corrupts every report.

---

### Pitfall 4: The Oracle Problem — Not Knowing What "Correct" Looks Like

**What goes wrong:** The Tester captures console messages, DOM state, and screenshots, but has no systematic way to decide whether what it sees is a PASS or FAIL. A vision model sees "there's a button" but doesn't know if that button should be blue or green. A console capture finds warnings but doesn't know which warnings are expected (e.g., a third-party lib that always warns).

**Why it happens:** Testing requires a specification (the oracle) to compare against. Without a precise oracle, the Tester makes judgment calls, and those judgment calls are inconsistent across runs.

**Consequences:**
- False positives: known/expected warnings flagged as defects, creating noise and alert fatigue.
- False negatives: actual regressions missed because the Tester had nothing specific to check against.
- Non-reproducible verdicts: two Tester runs on identical app state return different verdicts because the model's judgment drifted.

**Prevention:**
1. **GSD acceptance criteria as the oracle.** Every criterion in `UI-SPEC.md` or the GSD acceptance file maps 1:1 to a Tester check. The Tester does not freestyle — it iterates through each criterion, executes the specific check (DOM assertion, console scan, network check, or screenshot), and records pass/fail per-criterion. No check exists without a criterion, and no criterion goes unchecked.
2. **Console allowlist.** The `verification-report.json` schema includes a `console_allowlist` field (regex patterns for known/expected warnings, e.g., from a specific third-party lib). Warnings matching allowlist entries are tagged `EXPECTED`, not `DEFECT`. Allowlist entries must be sourced from the project's `UI-SPEC.md` or a `bgsd-verify.config.json`, not hallucinated by the Tester.
3. **Deterministic checks first.** DOM assertion (`expect(selector).toBeVisible()`), console exact-match (`message.text().includes('validateDOMNesting')`), and HTTP status (`response.status() === 200`) are binary and model-independent. Vision ("does this look right?") is used only as a fallback for criteria that cannot be expressed deterministically.
4. **Structured output contract.** `verification-report.json` must include: `criterion_id`, `criterion_text`, `result` (PASS/FAIL/SKIP), `check_method` (dom|console|network|vision), `evidence` (selector, message text, or screenshot path), and `confidence` (HIGH for deterministic, MEDIUM/LOW for vision). No free-form prose in the report body.

**Detection warning sign:** The Tester report has a `result: PASS` for all criteria without any `evidence` field populated. This means no actual checks ran; the agent generated the report from inference.

**V0 phase:** Phase 1 (Tester core) and Phase 2 (report schema). The acceptance-criteria-as-oracle pattern must be the first design decision in the Tester agent prompt.

---

## Moderate Pitfalls

---

### Pitfall 5: Flaky Selectors and Timing (The Standard E2E Trap)

**What goes wrong:** The Tester uses CSS selectors or XPaths that break when the app's internal structure changes (e.g., a generated class name like `.sc-abc123`). Navigation asserts element presence before the framework has finished rendering (hydration lag in Next.js SSR). `networkidle` is used as the ready signal, which hangs when the app has background polling or analytics requests.

**Prevention:**
- Prefer semantic selectors: `role`, `aria-label`, `data-testid`, `text content`. Never generated class names.
- Use `domcontentloaded` as the navigation wait state, then wait for a specific element to appear (`waitForSelector`) rather than waiting for network quiet.
- Never use `networkidle` as a primary wait strategy. Background analytics and polling make it timeout-prone.
- The Tester's selector strategy must be documented in its agent prompt as a hard rule, not a suggestion.

**V0 phase:** Phase 1 (Tester core). Include selector discipline in the Tester agent's system instructions.

---

### Pitfall 6: Authentication and Seed State Leakage

**What goes wrong:** Two verification runs share a dev server that wasn't fully reset between runs. State from run N (e.g., a created user, a changed setting) bleeds into run N+1. The Tester's checks pass or fail based on residual state, not on the code under test. This is especially dangerous for acceptance criteria that check "initial state" or "empty state" of a feature.

**Prevention:**
1. `runtime-isolate.sh` should support a `--reset-seed` flag that: (a) drops and re-seeds the dev database before the verification run, (b) clears any persisted localStorage/cookies via Playwright's `browserContext.clearCookies()` and `browserContext.addInitScript(() => localStorage.clear())`.
2. For the make-or-break test in v0, the canary Next.js page must be stateless (no DB, no auth) to eliminate this variable entirely. Prove console capture works before adding state complexity.
3. Each verification run should use a fresh Playwright browser context (`browser.newContext()`, not a reused page), ensuring no cookie or storage bleed.

**V0 phase:** Phase 1 (runtime-isolate.sh) for the reset-seed flag. Phase 2 for stateful-app support.

---

### Pitfall 7: Console Signal Level Confusion (error vs. warn vs. log)

**What goes wrong:** React's `validateDOMNesting` fires at `console.error` level. React hydration warnings also fire at `console.error`. However, many developers (and verification agents) conflate "console.error" with "uncaught exception" and miss `console.warn` from other libraries. Conversely, noisy `console.log` from debug instrumentation creates false positives if the Tester doesn't filter by level.

**The exact signal map for the make-or-break test:**
- `validateDOMNesting` (e.g., `<script>` rendered in JSX): `console.error`, text contains `"Warning: validateDOMNesting"`. Fired in React dev build only.
- Hydration mismatch: `console.error`, text contains one of: `"Hydration failed"`, `"hydration completed but contains mismatches"`, `"Text content did not match"`, `"Expected server HTML to contain"`.
- Missing `key` prop: `console.error`, text contains `"Warning: Each child in a list should have a unique"`.
- General uncaught JS errors: `page.on('pageerror')` — separate event, not `page.on('console')`.
- Third-party warnings (e.g., React Router deprecations): `console.warn`.

**Prevention:**
- Capture ALL three: `page.on('console')` for `error` and `warn` level messages, AND `page.on('pageerror')` for uncaught exceptions.
- In `verification-report.json`, bucket console messages by type: `{ errors: [], warnings: [], pageErrors: [] }`.
- Per-criterion, specify which bucket to check. Console-level errors (the make-or-break class) map to the `errors` bucket.
- Filter `log`-level messages by default; include them only in verbose mode (`bgsd-verify --verbose`).

**V0 phase:** Phase 1 (Tester core). The three-bucket capture model must be in the Tester script from the start.

---

## Minor Pitfalls

---

### Pitfall 8: Port Collision Between Dev Server and Other Local Services

**What goes wrong:** `runtime-isolate.sh` starts the app on port 3000, which is already occupied by another process. The dev server fails silently (or prints a warning that goes unchecked), and the Tester connects to whatever happens to be running on 3000 — often a completely different app — and tests the wrong thing.

**Prevention:**
- Port assignment must probe availability before binding: `lsof -ti:$PORT` or `ss -ltn sport = :$PORT`. If occupied, increment until free.
- Use a hash of the git branch name to generate a deterministic base port offset (avoiding the common range and ports above 57000 used by Spotify's P2P). Example: `BASE_PORT=$((3100 + (hash(branch_name) % 200)))`.
- The verification report must include the `target_url` and `port` the Tester connected to. A report without this is untrustworthy.

**V0 phase:** Phase 1 (runtime-isolate.sh).

---

### Pitfall 9: Dev Server Boot Race (Tester Connects Before Server Is Ready)

**What goes wrong:** `runtime-isolate.sh` starts the dev server and immediately signals "ready." The Tester navigates before the server has compiled and is actually serving requests. The first navigation gets `ECONNREFUSED` or a 503, which the Tester may log as a network error and continue, producing a partial/corrupt report.

**Prevention:**
- `runtime-isolate.sh` must poll the health endpoint (`curl -sf http://localhost:$PORT` or a framework-specific readiness check like Next.js's `/_next/static/...` head request) with a timeout-and-retry loop before signaling ready.
- The Tester script should independently verify the server responds to HTTP before beginning browser navigation. A `ECONNREFUSED` at navigation time is a hard `BLOCKED` result, not a FAIL.

**V0 phase:** Phase 1 (runtime-isolate.sh).

---

### Pitfall 10: Screenshot-Only Vision as a Crutch (Masking Unfired Checks)

**What goes wrong:** When DOM assertions and console checks are hard to implement, the Tester falls back to vision ("does this look right?") for everything. Vision checks are expensive, slow, non-deterministic, and miss console-level errors entirely. A verification report full of `PASS (vision)` entries is not reliable.

**Prevention:**
- Enforce the verification driver ladder in the Tester's prompt: console checks and DOM assertions run first and are mandatory for any criterion that can be expressed deterministically. Vision is only allowed when the criterion is explicitly "visual/aesthetic" in nature (e.g., "the chart renders with correct colors").
- The report schema enforces `check_method` — any criterion resolved via `vision` where a DOM check was feasible should be flagged in a `review_suggested: true` field so humans can audit.

**V0 phase:** Phase 2 (report schema and Tester agent prompt review).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|---|---|---|
| Console listener setup (make-or-break) | Listener attached after navigation — warning already fired | Attach `page.on('console')` BEFORE `page.goto()`, always |
| Dev vs. prod build | React warnings silenced in prod bundle | Force `NODE_ENV=development` in `runtime-isolate.sh` |
| MCP availability | Playwright MCP not installed or not exposed to plugin subagent | Pre-flight probe + `general-purpose` subagent fallback |
| Tester oracle | No acceptance criteria = no basis for PASS/FAIL | GSD `UI-SPEC.md` criterion loop is mandatory, not optional |
| Browser context reuse | State bleed between verification runs | `browser.newContext()` per run + `--reset-seed` on the dev server |
| Port allocation | Collision with existing local service | Hash-based deterministic port + availability probe |
| Console level filtering | Mixing `warn`, `error`, `pageerror` | Three-bucket capture; hydration/nesting checks target `error` bucket |
| Network idle wait | `networkidle` hangs on analytics / polling | Use `domcontentloaded` + element-visible wait instead |
| Custom plugin agent | MCP tools not available to `bgsd:tester` subagent type | Invoke via `general-purpose` subagent type until bug is fixed upstream |

---

## The Make-or-Break Test: Exact Design

v0 is validated by one specific test: a Next.js page that renders a `<script>` tag inside JSX (triggering `validateDOMNesting`), where a screenshot looks perfectly normal. The Tester must:

1. Boot the page via `runtime-isolate.sh` in dev mode.
2. Attach `page.on('console')` BEFORE navigation.
3. Navigate to the page.
4. Wait for `domcontentloaded`.
5. Check the `errors` bucket for a message matching `/validateDOMNesting/`.
6. Map that message to the acceptance criterion "No React DOM-nesting violations."
7. Emit `result: FAIL` with `evidence: { message: "Warning: validateDOMNesting...", level: "error" }`.

If step 6 finds the message and step 7 emits FAIL, v0's core bet is proven. If the report shows PASS, a pitfall from this document was hit (most likely Pitfall 1 or Pitfall 2).

---

## Sources

- [Playwright: How to Catch Hydration Errors in Tests](https://alexop.dev/posts/catch-hydration-errors-playwright-tests/)
- [Playwright Console Monitoring (Checkly)](https://www.checklyhq.com/blog/how-to-monitor-javascript-logs-and-exceptions-with-playwright/)
- [Playwright Events — page.on('console')](https://playwright.dev/docs/events)
- [Claude Code: Background Subagents Cannot Access MCP Tools — Issue #13254](https://github.com/anthropics/claude-code/issues/13254)
- [Claude Code: Custom Plugin Subagents Cannot Access MCP Tools — Issue #13605](https://github.com/anthropics/claude-code/issues/13605)
- [Claude Code: Playwright MCP Tools Not Exposed — Issue #3426](https://github.com/anthropics/claude-code/issues/3426)
- [Playwright MCP Bug: Recent Versions Inaccessible to Claude Code — Issue #1359](https://github.com/microsoft/playwright-mcp/issues/1359)
- [Steve Kinney: Runtime Tools Compared (Playwright MCP vs. Chrome DevTools MCP)](https://stevekinney.com/courses/self-testing-ai-agents/runtime-tools-compared)
- [Barnacle: Isolated Worktree Databases for Claude Code](https://www.barnacle.ai/blog/2026-02-07-the-missing-piece-of-the-claude-code-workflow-isol)
- [React validateDOMNesting — dhiwise](https://www.dhiwise.com/post/mastering-validatedomnesting-best-practices)
- [networkidle Flakiness — WebCrawlerAPI](https://webcrawlerapi.com/glossary/playwright/how-to-fix-playwright-networkidle-misuse)
- [BrowserStack: waitForLoadState Guide](https://www.browserstack.com/guide/playwright-waitforloadstate)
