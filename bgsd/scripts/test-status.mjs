#!/usr/bin/env node
/**
 * test-status.mjs — Unit tests for status.mjs (Phase 7: STATUS-01..04)
 *
 * No external framework. Uses node:assert.
 * Run with: NO_COLOR=1 node bgsd/scripts/test-status.mjs
 *
 * All assertions run with NO_COLOR=1 so output is deterministic plain text.
 * Exit 0 = all pass. Non-zero = failure (no silent green — NFR-06).
 *
 * Test groups:
 *
 *   S01 — renderStatus: full run snapshot includes expected badges (STATUS-01)
 *   S02 — renderStatus: needs-input agent surfaced prominently (STATUS-01)
 *   S03 — renderStatus: blocked agent shows blocker question (STATUS-01)
 *   S04 — renderStatus: current run stage and wave rendered (STATUS-01)
 *   S05 — renderStatus: Loop 1 iteration counts rendered per agent (STATUS-01)
 *   S06 — renderStatus: merge state (checkpoint) rendered (STATUS-01)
 *   S07 — renderStatus: 🔒 main-protected indicator present (STATUS-02)
 *   S08 — renderStatus: Kiwi identity in banner (STATUS-02)
 *   S09 — renderStatus: budget telemetry rendered (STATUS-03)
 *   S10 — renderStatus: downshift indicator surfaced (STATUS-03)
 *   S11 — renderStatus: empty-run edge case (no run) renders gracefully (STATUS-01/04)
 *   S12 — renderStatus: empty agents array renders gracefully (STATUS-01)
 *   S13 — renderStatus: NO_COLOR / non-TTY plain output — no ANSI sequences (STATUS-04)
 *   S14 — renderStatus: done agent badge rendered (STATUS-01)
 *   S15 — renderStatus: failed agent badge rendered (STATUS-01)
 *   S16 — renderStatus: restart_count > 0 surfaced (STATUS-01)
 *   S17 — renderStatus: multiple agents sorted (needs_input first) (STATUS-01)
 *   S18 — renderStatus: context-pressure CRITICAL rendered with right label (STATUS-03)
 *   S19 — renderStatus: run in "checkpoint" state shows awaiting-go narration (STATUS-02)
 *   S20 — renderStatus: token progress bar rendered (STATUS-03)
 */

import assert from "node:assert/strict";

// Force NO_COLOR before importing status.mjs so COLOR_OK is false
// (process.env is live; status.mjs reads it at module-evaluation time)
process.env["NO_COLOR"] = "1";

const __dir = new URL(".", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { renderStatus } from "./status.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid run.json object for tests.
 */
function makeRun(overrides = {}) {
  return {
    run_id:     "bgsd-0001-test-status-run",
    prompt:     "Build a new authentication flow with OAuth",
    state:      "executing",
    created_at: "2026-06-29T10:00:00.000Z",
    updated_at: "2026-06-29T10:05:00.000Z",
    transitions: [],
    checkpoints: [],
    units:  ["unit-auth", "unit-oauth", "unit-session"],
    waves:  [
      { wave: 0, units: ["unit-auth"] },
      { wave: 1, units: ["unit-oauth", "unit-session"] },
    ],
    scheduler_result: null,
    abort_reason: null,
    error: null,
    ...overrides,
  };
}

/**
 * Build a minimal valid control-file object for tests.
 */
function makeAgent(overrides = {}) {
  return {
    agent_id:     "agent-abc123",
    run_id:       "bgsd-0001-test-status-run",
    worktree:     "/tmp/.bgsd/worktrees/agent-abc123",
    branch:       "bgsd-0001-test-status-run/unit-auth",
    unit_id:      "unit-auth",
    phase:        "execute",
    status:       "running",
    heartbeat_at: "2026-06-29T10:04:55.000Z",
    started_at:   "2026-06-29T10:00:05.000Z",
    updated_at:   "2026-06-29T10:04:55.000Z",
    progress:     { iteration: 2, max_iterations: 5, note: "Running GSD execute phase" },
    commits:      ["abc1234", "def5678"],
    assumptions:  [],
    blockers:     [],
    escalations:  [],
    restart_count: 0,
    inbox_path:   null,
    ...overrides,
  };
}

function makeTelemetry(overrides = {}) {
  return {
    tokensUsed:       45_000,
    tokenCap:         200_000,
    costUsdCents:     12,
    costCapUsdCents:  500,
    parallelism:      3,
    fanOutMultiplier: 6,
    contextPressure:  "normal",
    downshiftActive:  false,
    downshiftReason:  null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${label}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${label}\n`);
    process.stdout.write(`         ${err.message}\n`);
    failures.push({ label, message: err.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

process.stdout.write("\n[test-status.mjs] Running STATUS-01..04 tests (NO_COLOR=1)\n\n");

// S01 — Full snapshot: known badge states present
test("S01 — renderStatus: running badge present in full snapshot", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [makeAgent({ status: "running" })],
    telemetry: makeTelemetry(),
  });
  assert.ok(out.includes("[⟳ RUNNING]"), "expected [⟳ RUNNING] badge");
});

// S02 — needs-input agent surfaced prominently
test("S02 — renderStatus: needs_input agent shows NEEDS INPUT badge and question", () => {
  const agent = makeAgent({
    status: "needs_input",
    escalations: [{
      id:          "esc-001",
      question:    "Should we use PKCE or implicit grant?",
      severity:    "high",
      context:     null,
      raised_at:   "2026-06-29T10:03:00.000Z",
      resolved:    false,
      user_answer: null,
    }],
  });
  const out = renderStatus({ run: makeRun(), agents: [agent], telemetry: null });
  assert.ok(out.includes("[? NEEDS INPUT]"), "expected [? NEEDS INPUT] badge");
  assert.ok(out.includes("PKCE or implicit grant"), "expected escalation question text");
  assert.ok(out.includes("NEEDS YOUR INPUT"), "expected 'NEEDS YOUR INPUT' call-out");
});

// S03 — blocked agent shows blocker question
test("S03 — renderStatus: blocked agent shows blocker question", () => {
  const agent = makeAgent({
    status: "blocked",
    phase:  "blocked",
    blockers: [{
      id:          "blocker-001",
      question:    "Which database should the session store use?",
      severity:    "medium",
      context:     null,
      raised_at:   "2026-06-29T10:02:00.000Z",
      resolved:    false,
      answer:      null,
      answered_at: null,
    }],
  });
  const out = renderStatus({ run: makeRun(), agents: [agent], telemetry: null });
  assert.ok(out.includes("[⏸ BLOCKED]"), "expected [⏸ BLOCKED] badge");
  assert.ok(out.includes("session store use"), "expected blocker question text");
  assert.ok(out.includes("BLOCKED:"), "expected BLOCKED: label");
});

// S04 — run stage and wave rendered
test("S04 — renderStatus: run stage and wave count rendered", () => {
  const out = renderStatus({
    run:    makeRun({ state: "executing" }),
    agents: [],
    telemetry: null,
  });
  assert.ok(out.includes("executing"), "expected 'executing' state");
  assert.ok(out.includes("bgsd-0001-test-status-run"), "expected run-id");
  assert.ok(out.includes("2 wave"), "expected wave count");
});

// S05 — Loop 1 iteration counts
test("S05 — renderStatus: Loop 1 iteration counts rendered per agent", () => {
  const agent = makeAgent({ progress: { iteration: 3, max_iterations: 5, note: "" } });
  const out = renderStatus({ run: makeRun(), agents: [agent], telemetry: null });
  assert.ok(out.includes("iter 3/5"), "expected 'iter 3/5' iteration count");
});

// S06 — merge state (checkpoint) rendered
test("S06 — renderStatus: merge checkpoint state rendered", () => {
  const run = makeRun({
    state: "checkpoint",
    checkpoints: [{
      checkpoint_id:  "ckpt-12345678-ab12",
      wave_index:     0,
      merged:         ["unit-auth"],
      held:           [],
      blockers:       [],
      recorded_at:    "2026-06-29T10:05:00.000Z",
      resumed_at:     null,
      go:             null,
    }],
  });
  const out = renderStatus({ run, agents: [], telemetry: null });
  assert.ok(out.includes("Merge State"), "expected Merge State section");
  assert.ok(out.includes("1 merged"), "expected 1 merged");
  assert.ok(out.includes("pending"), "expected pending checkpoint status");
  assert.ok(out.includes("Awaiting go/no-go"), "expected go/no-go prompt");
});

// S07 — 🔒 main-protected indicator
test("S07 — renderStatus: 🔒 main-protected indicator present in output", () => {
  const out = renderStatus({ run: makeRun(), agents: [], telemetry: null });
  assert.ok(out.includes("🔒"), "expected 🔒 emoji in output");
  assert.ok(out.includes("main-protected"), "expected 'main-protected' text");
  // Must appear in BOTH banner and footer
  const firstIdx  = out.indexOf("main-protected");
  const secondIdx = out.indexOf("main-protected", firstIdx + 1);
  assert.ok(secondIdx !== -1, "expected 'main-protected' to appear at least twice (banner + footer)");
});

// S08 — Kiwi identity in banner
test("S08 — renderStatus: Kiwi identity in banner heading", () => {
  const out = renderStatus({ run: makeRun(), agents: [], telemetry: null });
  assert.ok(out.includes("Kiwi"), "expected 'Kiwi' in banner");
  assert.ok(out.includes("bgsd"), "expected 'bgsd' in banner");
  assert.ok(out.includes("/bgsd-status"), "expected '/bgsd-status' in banner");
});

// S09 — budget telemetry rendered
test("S09 — renderStatus: budget telemetry rendered (tokens, cost, parallelism)", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [],
    telemetry: makeTelemetry({
      tokensUsed:       50_000,
      tokenCap:         200_000,
      costUsdCents:     15,
      parallelism:      2,
      fanOutMultiplier: 4,
    }),
  });
  assert.ok(out.includes("Tokens:"), "expected Tokens section");
  assert.ok(out.includes("50,000"), "expected token count");
  assert.ok(out.includes("200,000"), "expected token cap");
  assert.ok(out.includes("Cost:"),   "expected Cost section");
  assert.ok(out.includes("Workers:"), "expected Workers section");
  assert.ok(out.includes("fan-out:"), "expected fan-out label");
});

// S10 — downshift indicator surfaced
test("S10 — renderStatus: downshift indicator surfaced when active", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [],
    telemetry: makeTelemetry({
      downshiftActive: true,
      downshiftReason: "token cap 80% reached",
    }),
  });
  assert.ok(out.includes("Downshift active"), "expected 'Downshift active' label");
  assert.ok(out.includes("token cap 80% reached"), "expected downshift reason");
});

// S11 — empty-run edge case (no run)
test("S11 — renderStatus: empty-run (null run) renders gracefully without throwing", () => {
  let out;
  assert.doesNotThrow(() => {
    out = renderStatus({ run: null, agents: [], telemetry: null });
  });
  assert.ok(out.includes("No active run"), "expected 'No active run' message");
  assert.ok(out.includes("🔒"), "expected 🔒 even with null run");
  assert.ok(out.includes("main-protected"), "expected main-protected even with null run");
});

// S12 — empty agents array
test("S12 — renderStatus: empty agents array renders without error", () => {
  let out;
  assert.doesNotThrow(() => {
    out = renderStatus({ run: makeRun(), agents: [], telemetry: null });
  });
  assert.ok(out.includes("No active workers"), "expected 'No active workers' message");
});

// S13 — NO_COLOR / non-TTY: no ANSI sequences
test("S13 — renderStatus: NO_COLOR=1 output contains no ANSI escape sequences", () => {
  const out = renderStatus({ run: makeRun(), agents: [makeAgent()], telemetry: makeTelemetry() });
  // ANSI escape sequences start with \x1b[
  assert.ok(!out.includes("\x1b["), "expected no ANSI sequences in NO_COLOR mode");
  // But structured content must still be present
  assert.ok(out.includes("RUNNING"), "expected RUNNING badge label in plain output");
  assert.ok(out.includes("main-protected"), "expected main-protected in plain output");
});

// S14 — done agent badge
test("S14 — renderStatus: done agent badge rendered", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [makeAgent({ status: "done", phase: "done" })],
    telemetry: null,
  });
  assert.ok(out.includes("[✓ DONE]"), "expected [✓ DONE] badge");
});

// S15 — failed agent badge
test("S15 — renderStatus: failed agent badge rendered", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [makeAgent({ status: "failed", phase: "failed" })],
    telemetry: null,
  });
  assert.ok(out.includes("[✗ FAILED]"), "expected [✗ FAILED] badge");
});

// S16 — restart_count surfaced
test("S16 — renderStatus: restart_count > 0 surfaced in output", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [makeAgent({ restart_count: 2 })],
    telemetry: null,
  });
  assert.ok(out.includes("restarted"), "expected 'restarted' indicator");
  assert.ok(out.includes("×2"), "expected restart count ×2");
});

// S17 — needs_input agents sorted first
test("S17 — renderStatus: needs_input agent appears before running agent in output", () => {
  const running = makeAgent({ agent_id: "agent-alpha", status: "running" });
  const needsInput = makeAgent({
    agent_id: "agent-beta",
    status: "needs_input",
    escalations: [{
      id: "esc-002", question: "Which CDN?", severity: "high",
      context: null, raised_at: "2026-06-29T10:01:00.000Z",
      resolved: false, user_answer: null,
    }],
  });
  const out = renderStatus({
    run:    makeRun(),
    agents: [running, needsInput],  // needs_input is second in input array
    telemetry: null,
  });
  const idxNeedsInput = out.indexOf("agent-beta");
  const idxRunning    = out.indexOf("agent-alpha");
  assert.ok(idxNeedsInput < idxRunning, "expected needs_input agent to appear before running agent");
});

// S18 — context-pressure CRITICAL
test("S18 — renderStatus: context-pressure CRITICAL rendered", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [],
    telemetry: makeTelemetry({ contextPressure: "critical" }),
  });
  assert.ok(out.includes("CRITICAL"), "expected CRITICAL context pressure label");
});

// S19 — run in "checkpoint" state shows awaiting-go narration
test("S19 — renderStatus: checkpoint state shows go/no-go narration", () => {
  const out = renderStatus({
    run:    makeRun({ state: "checkpoint" }),
    agents: [],
    telemetry: null,
  });
  assert.ok(out.includes("go/no-go"), "expected 'go/no-go' in narration for checkpoint state");
});

// S20 — token progress bar rendered in plain mode
test("S20 — renderStatus: token progress bar rendered (even in NO_COLOR mode)", () => {
  const out = renderStatus({
    run:    makeRun(),
    agents: [],
    telemetry: makeTelemetry({ tokensUsed: 160_000, tokenCap: 200_000 }),
  });
  // Progress bar uses block chars; in NO_COLOR mode they still appear
  assert.ok(out.includes("█") || out.includes("░") || out.includes("%"),
    "expected progress bar or percentage in telemetry output");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write("\n" + "─".repeat(52) + "\n");
process.stdout.write(`  ${passed} passed, ${failed} failed\n`);
process.stdout.write("─".repeat(52) + "\n\n");

if (failed > 0) {
  process.stdout.write("FAILURES:\n");
  for (const f of failures) {
    process.stdout.write(`  [${f.label}] ${f.message}\n`);
  }
  process.stdout.write("\n");
  process.exit(1);
}

process.stdout.write("All tests passed.\n\n");
process.exit(0);
