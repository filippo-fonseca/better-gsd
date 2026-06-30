#!/usr/bin/env node
/**
 * test-control.mjs — Unit tests for control.mjs (Phase 2: CTRL-01..04)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-control.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests use a temp directory; no real .bgsd/ runtime is touched.
 * All heartbeat/restart tests use an injected clock — zero Date.now() calls.
 *
 * Test groups:
 *
 *   C01 — createControlFile: creates a file with the full schema
 *   C02 — readControlFile: round-trips correctly
 *   C03 — updateControlFile: merges partial fields atomically
 *   C04 — validateControlFile: rejects a missing required field
 *   C05 — validateControlFile: rejects an invalid phase
 *   C06 — validateControlFile: rejects an invalid status
 *   C07 — validateControlFile: rejects a non-array "commits"
 *   C08 — readControlFile: throws on non-existent file
 *   C09 — readControlFile: throws on malformed JSON
 *   C10 — recordAssumption: appends assumption, file remains valid
 *   C11 — raiseBlocker: appends blocker, sets status=blocked, phase=blocked
 *   C12 — raiseBlocker: rejects missing question
 *   C13 — raiseBlocker: rejects invalid severity
 *   C14 — resolveBlocker: marks blocker resolved, resets status to running
 *   C15 — addEscalation: appends escalation, sets status=needs_input
 *   C16 — aggregateOpenBlockers: returns all unresolved blockers across agents
 *   C17 — aggregateEscalations: returns all unresolved escalations across agents
 *   C18 — readAllControlFiles: surfaces malformed files as errors (NFR-06)
 *   C19 — classifyHeartbeat: alive when heartbeat is within staleMs
 *   C20 — classifyHeartbeat: stale when heartbeat is between staleMs and deadMs
 *   C21 — classifyHeartbeat: dead when heartbeat is older than deadMs
 *   C22 — classifyHeartbeat: dead when heartbeat_at is null/missing
 *   C23 — computeRestartDecision: alive agent -> decision="alive"
 *   C24 — computeRestartDecision: stale agent -> decision="stale"
 *   C25 — computeRestartDecision: dead + restarts < max -> eligible_for_restart
 *   C26 — computeRestartDecision: dead + restarts >= max -> give_up
 *   C27 — runHeartbeatTick: dead agent under budget triggers restartFn (mocked)
 *   C28 — runHeartbeatTick: dead agent over budget -> give_up, no restartFn call
 *   C29 — runHeartbeatTick: alive agent -> no restart
 *   C30 — runHeartbeatTick: terminal agents are skipped
 *   C31 — touchHeartbeat: updates heartbeat_at with injected clock
 *   C32 — updateControlFile: atomic write survives (temp file cleaned up)
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
  validateControlFile,
  createControlFile,
  readControlFile,
  updateControlFile,
  updateContextUsage,
  touchHeartbeat,
  recordAssumption,
  raiseBlocker,
  resolveBlocker,
  addEscalation,
  aggregateOpenBlockers,
  aggregateEscalations,
  readAllControlFiles,
  classifyHeartbeat,
  computeRestartDecision,
  runHeartbeatTick,
  DEFAULT_STALE_MS,
  DEFAULT_DEAD_MS,
  DEFAULT_MAX_RESTARTS,
} from "./control.mjs";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n`);
    process.stdout.write(`        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n`);
    process.stdout.write(`        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp dir for each test that needs one. */
function makeTempDir() {
  const id = randomBytes(8).toString("hex");
  const p = join(tmpdir(), `bgsd-test-control-${id}`);
  mkdirSync(p, { recursive: true });
  return p;
}

/** Build a valid minimal control-file object (not yet written to disk). */
function makeControlObj(overrides = {}) {
  const now = new Date().toISOString();
  return {
    agent_id:      "agent-test-abc",
    run_id:        "bgsd-0001-test",
    worktree:      "/tmp/worktrees/agent-test-abc",
    branch:        "bgsd-0001-test/test-feature",
    unit_id:       "unit-001",
    phase:         "discuss",
    status:        "running",
    heartbeat_at:  now,
    started_at:    now,
    updated_at:    now,
    progress:      { iteration: 0, max_iterations: 5, note: "" },
    commits:       [],
    assumptions:   [],
    blockers:      [],
    escalations:   [],
    restart_count: 0,
    inbox_path:    null,
    ...overrides,
  };
}

/** Write a control file (agent-<id>.json) into a control dir. */
function writeControlFileRaw(controlDir, agentId, obj) {
  mkdirSync(controlDir, { recursive: true });
  const p = join(controlDir, `${agentId}.json`);
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// Tests: Control-File Create / Read / Update (CTRL-01)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- C01..C09  Control-File I/O ---\n");

test("C01 createControlFile: creates file with full schema", () => {
  const dir = makeTempDir();
  const controlPath = join(dir, "agent-abc.json");
  const data = createControlFile(controlPath, {
    agent_id: "agent-abc",
    run_id:   "bgsd-0001-test",
    worktree: "/tmp/w/agent-abc",
    branch:   "bgsd-0001-test/feat",
    unit_id:  "unit-001",
  });
  assert.equal(data.agent_id, "agent-abc");
  assert.equal(data.phase, "discuss");
  assert.equal(data.status, "running");
  assert.equal(data.restart_count, 0);
  assert.ok(Array.isArray(data.assumptions));
  assert.ok(Array.isArray(data.blockers));
  assert.ok(Array.isArray(data.escalations));
  assert.ok(existsSync(controlPath));
});

test("C02 readControlFile: round-trips correctly", () => {
  const dir = makeTempDir();
  const controlPath = join(dir, "agent-abc.json");
  const written = createControlFile(controlPath, {
    agent_id: "agent-abc",
    run_id:   "bgsd-0001-test",
    worktree: "/tmp/w/agent-abc",
    branch:   "bgsd-0001-test/feat",
    unit_id:  "unit-001",
  });
  const read = readControlFile(controlPath);
  assert.equal(read.agent_id, written.agent_id);
  assert.equal(read.run_id, written.run_id);
  assert.equal(read.phase, written.phase);
  assert.equal(read.status, written.status);
});

test("C03 updateControlFile: merges partial fields atomically", () => {
  const dir = makeTempDir();
  const controlPath = join(dir, "agent-abc.json");
  createControlFile(controlPath, {
    agent_id: "agent-abc",
    run_id:   "bgsd-0001-test",
    worktree: "/tmp/w/agent-abc",
    branch:   "bgsd-0001-test/feat",
    unit_id:  "unit-001",
  });
  const updated = updateControlFile(controlPath, { phase: "plan", status: "running" });
  assert.equal(updated.phase, "plan");
  assert.equal(updated.status, "running");
  // Other fields preserved
  assert.equal(updated.agent_id, "agent-abc");
  // Verify persisted
  const re = readControlFile(controlPath);
  assert.equal(re.phase, "plan");
});

test("C04 validateControlFile: rejects a missing required field", () => {
  const obj = makeControlObj();
  delete obj.agent_id;
  assert.throws(() => validateControlFile(obj), /missing required field.*agent_id/);
});

test("C05 validateControlFile: rejects an invalid phase", () => {
  const obj = makeControlObj({ phase: "not-a-phase" });
  assert.throws(() => validateControlFile(obj), /phase.*must be one of/);
});

test("C06 validateControlFile: rejects an invalid status", () => {
  const obj = makeControlObj({ status: "unknown-status" });
  assert.throws(() => validateControlFile(obj), /status.*must be one of/);
});

test("C07 validateControlFile: rejects a non-array 'commits'", () => {
  const obj = makeControlObj({ commits: "not-an-array" });
  assert.throws(() => validateControlFile(obj), /commits.*must be an array/);
});

test("C08 readControlFile: throws on non-existent file", () => {
  assert.throws(
    () => readControlFile("/tmp/bgsd-no-such-file-xyz.json"),
    /not found/
  );
});

test("C09 readControlFile: throws on malformed JSON", () => {
  const dir = makeTempDir();
  const p = join(dir, "bad.json");
  writeFileSync(p, "{ not valid json }", "utf8");
  assert.throws(() => readControlFile(p), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// Tests: Assumption / Blocker / Escalation (CTRL-03, CTRL-04)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- C10..C18  Assumption / Blocker / Escalation protocol ---\n");

test("C10 recordAssumption: appends assumption, file remains valid", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-x.json");
  createControlFile(p, {
    agent_id: "agent-x", run_id: "bgsd-0001", worktree: "/tmp/w", branch: "b", unit_id: "u1",
  });
  recordAssumption(p, { description: "API is stable", basis: "spec v2" });
  const cf = readControlFile(p);
  assert.equal(cf.assumptions.length, 1);
  assert.equal(cf.assumptions[0].description, "API is stable");
  assert.equal(cf.assumptions[0].basis, "spec v2");
  assert.ok(cf.assumptions[0].id.startsWith("assumption-"));
});

test("C11 raiseBlocker: appends blocker, sets status=blocked, phase=blocked", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-x.json");
  createControlFile(p, {
    agent_id: "agent-x", run_id: "bgsd-0001", worktree: "/tmp/w", branch: "b", unit_id: "u1",
  });
  raiseBlocker(p, { question: "Which DB to use?", severity: "high" });
  const cf = readControlFile(p);
  assert.equal(cf.status, "blocked");
  assert.equal(cf.phase, "blocked");
  assert.equal(cf.blockers.length, 1);
  assert.equal(cf.blockers[0].question, "Which DB to use?");
  assert.equal(cf.blockers[0].severity, "high");
  assert.equal(cf.blockers[0].resolved, false);
});

test("C12 raiseBlocker: rejects missing question", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-x.json");
  createControlFile(p, {
    agent_id: "agent-x", run_id: "bgsd-0001", worktree: "/tmp/w", branch: "b", unit_id: "u1",
  });
  assert.throws(() => raiseBlocker(p, { severity: "high" }), /question is required/);
});

test("C13 raiseBlocker: rejects invalid severity", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-x.json");
  createControlFile(p, {
    agent_id: "agent-x", run_id: "bgsd-0001", worktree: "/tmp/w", branch: "b", unit_id: "u1",
  });
  assert.throws(
    () => raiseBlocker(p, { question: "What?", severity: "critical" }),
    /severity must be one of/
  );
});

test("C14 resolveBlocker: marks blocker resolved, resets status to running", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-x.json");
  createControlFile(p, {
    agent_id: "agent-x", run_id: "bgsd-0001", worktree: "/tmp/w", branch: "b", unit_id: "u1",
  });
  raiseBlocker(p, { question: "Which DB?", severity: "medium" });
  const blocked = readControlFile(p);
  const blockerId = blocked.blockers[0].id;
  resolveBlocker(p, blockerId, { answer: "Use PostgreSQL", inboxPath: "/tmp/inbox.md" });
  const resolved = readControlFile(p);
  assert.equal(resolved.blockers[0].resolved, true);
  assert.equal(resolved.blockers[0].answer, "Use PostgreSQL");
  assert.equal(resolved.status, "running");
  assert.equal(resolved.inbox_path, "/tmp/inbox.md");
});

test("C15 addEscalation: appends escalation, sets status=needs_input", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-x.json");
  createControlFile(p, {
    agent_id: "agent-x", run_id: "bgsd-0001", worktree: "/tmp/w", branch: "b", unit_id: "u1",
  });
  addEscalation(p, { question: "Critical architecture decision?", severity: "high" });
  const cf = readControlFile(p);
  assert.equal(cf.status, "needs_input");
  assert.equal(cf.escalations.length, 1);
  assert.equal(cf.escalations[0].question, "Critical architecture decision?");
  assert.equal(cf.escalations[0].resolved, false);
});

test("C16 aggregateOpenBlockers: returns all unresolved blockers across agents", () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  // Agent A has 1 blocker
  const pA = join(controlDir, "agent-a.json");
  createControlFile(pA, { agent_id: "agent-a", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1" });
  raiseBlocker(pA, { question: "Q from A?", severity: "high" });

  // Agent B has 1 blocker
  const pB = join(controlDir, "agent-b.json");
  createControlFile(pB, { agent_id: "agent-b", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u2" });
  raiseBlocker(pB, { question: "Q from B?", severity: "low" });

  // Agent C has a resolved blocker (should not appear)
  const pC = join(controlDir, "agent-c.json");
  createControlFile(pC, { agent_id: "agent-c", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u3" });
  raiseBlocker(pC, { question: "Q from C?", severity: "medium" });
  const cfC = readControlFile(pC);
  resolveBlocker(pC, cfC.blockers[0].id, { answer: "Answered", inboxPath: null });

  const open = aggregateOpenBlockers(controlDir);
  assert.equal(open.length, 2);
  const agentIds = open.map((x) => x.agent_id).sort();
  assert.deepEqual(agentIds, ["agent-a", "agent-b"]);
});

test("C17 aggregateEscalations: returns all unresolved escalations across agents", () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  const pA = join(controlDir, "agent-a.json");
  createControlFile(pA, { agent_id: "agent-a", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1" });
  addEscalation(pA, { question: "Escalation from A?", severity: "high" });

  const pB = join(controlDir, "agent-b.json");
  createControlFile(pB, { agent_id: "agent-b", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u2" });
  // No escalation on B

  const escalations = aggregateEscalations(controlDir);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].agent_id, "agent-a");
});

test("C18 readAllControlFiles: surfaces malformed files as errors (NFR-06)", () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  // Good file
  const pGood = join(controlDir, "agent-good.json");
  createControlFile(pGood, { agent_id: "agent-good", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1" });

  // Malformed JSON file
  writeFileSync(join(controlDir, "agent-bad.json"), "{ corrupted }", "utf8");

  const { files, errors } = readAllControlFiles(controlDir);
  assert.equal(files.length, 1);
  assert.equal(files[0].agent_id, "agent-good");
  assert.equal(errors.length, 1);
  assert.ok(errors[0].path.includes("agent-bad.json"));
  assert.ok(errors[0].error.length > 0);
});

// ---------------------------------------------------------------------------
// Tests: Heartbeat classification with injected clock (CTRL-02)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- C19..C22  Heartbeat classification (injected clock) ---\n");

test("C19 classifyHeartbeat: alive when heartbeat is within staleMs", () => {
  const baseMs = 1_000_000_000_000;
  const heartbeat_at = new Date(baseMs - 30_000).toISOString(); // 30s ago
  const nowFn = () => baseMs;
  const result = classifyHeartbeat({ heartbeat_at, nowFn, staleMs: 60_000, deadMs: 120_000 });
  assert.equal(result, "alive");
});

test("C20 classifyHeartbeat: stale when heartbeat is between staleMs and deadMs", () => {
  const baseMs = 1_000_000_000_000;
  const heartbeat_at = new Date(baseMs - 90_000).toISOString(); // 90s ago
  const nowFn = () => baseMs;
  const result = classifyHeartbeat({ heartbeat_at, nowFn, staleMs: 60_000, deadMs: 120_000 });
  assert.equal(result, "stale");
});

test("C21 classifyHeartbeat: dead when heartbeat is older than deadMs", () => {
  const baseMs = 1_000_000_000_000;
  const heartbeat_at = new Date(baseMs - 200_000).toISOString(); // 200s ago
  const nowFn = () => baseMs;
  const result = classifyHeartbeat({ heartbeat_at, nowFn, staleMs: 60_000, deadMs: 120_000 });
  assert.equal(result, "dead");
});

test("C22 classifyHeartbeat: dead when heartbeat_at is null/missing", () => {
  const nowFn = () => Date.now();
  assert.equal(classifyHeartbeat({ heartbeat_at: null, nowFn }), "dead");
  assert.equal(classifyHeartbeat({ heartbeat_at: undefined, nowFn }), "dead");
  assert.equal(classifyHeartbeat({ heartbeat_at: "not-a-date", nowFn }), "dead");
});

// ---------------------------------------------------------------------------
// Tests: Restart decision state machine (CTRL-02)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- C23..C26  Restart decision state machine ---\n");

test("C23 computeRestartDecision: alive agent -> decision='alive'", () => {
  const baseMs = 1_000_000_000_000;
  const nowFn = () => baseMs;
  const heartbeat_at = new Date(baseMs - 30_000).toISOString(); // alive
  const { decision, vitality } = computeRestartDecision({
    heartbeat_at, restart_count: 0, nowFn, staleMs: 60_000, deadMs: 120_000,
  });
  assert.equal(vitality, "alive");
  assert.equal(decision, "alive");
});

test("C24 computeRestartDecision: stale agent -> decision='stale'", () => {
  const baseMs = 1_000_000_000_000;
  const nowFn = () => baseMs;
  const heartbeat_at = new Date(baseMs - 90_000).toISOString(); // stale
  const { decision, vitality } = computeRestartDecision({
    heartbeat_at, restart_count: 0, nowFn, staleMs: 60_000, deadMs: 120_000,
  });
  assert.equal(vitality, "stale");
  assert.equal(decision, "stale");
});

test("C25 computeRestartDecision: dead + restarts < max -> eligible_for_restart", () => {
  const baseMs = 1_000_000_000_000;
  const nowFn = () => baseMs;
  const heartbeat_at = new Date(baseMs - 300_000).toISOString(); // dead (5 min)
  const { decision, vitality } = computeRestartDecision({
    heartbeat_at, restart_count: 1, nowFn, staleMs: 60_000, deadMs: 120_000, maxRestarts: 3,
  });
  assert.equal(vitality, "dead");
  assert.equal(decision, "eligible_for_restart");
});

test("C26 computeRestartDecision: dead + restarts >= max -> give_up", () => {
  const baseMs = 1_000_000_000_000;
  const nowFn = () => baseMs;
  const heartbeat_at = new Date(baseMs - 300_000).toISOString(); // dead
  const { decision, vitality } = computeRestartDecision({
    heartbeat_at, restart_count: 3, nowFn, staleMs: 60_000, deadMs: 120_000, maxRestarts: 3,
  });
  assert.equal(vitality, "dead");
  assert.equal(decision, "give_up");
});

// ---------------------------------------------------------------------------
// Tests: runHeartbeatTick — mocked restartFn, no real process (CTRL-02)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- C27..C31  runHeartbeatTick (mocked restartFn) ---\n");

await testAsync("C27 runHeartbeatTick: dead agent under budget triggers restartFn (mocked)", async () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  const baseMs = 1_000_000_000_000;
  // Dead heartbeat: 300s ago
  const heartbeat_at = new Date(baseMs - 300_000).toISOString();

  const p = join(controlDir, "agent-dead.json");
  // Create with dead heartbeat manually
  const now = new Date(baseMs - 300_000).toISOString();
  writeFileSync(p, JSON.stringify({
    agent_id: "agent-dead", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
    phase: "execute", status: "running",
    heartbeat_at, started_at: now, updated_at: now,
    progress: { iteration: 0, max_iterations: 5, note: "" },
    commits: [], assumptions: [], blockers: [], escalations: [],
    restart_count: 0, inbox_path: null,
  }, null, 2), "utf8");

  const restartCalls = [];
  const restartFn = async (agentId, controlPath) => {
    restartCalls.push({ agentId, controlPath });
  };

  const summary = await runHeartbeatTick({
    runControlDir: controlDir,
    nowFn: () => baseMs,
    restartFn,
    staleMs: 60_000,
    deadMs: 120_000,
    maxRestarts: 3,
  });

  assert.equal(restartCalls.length, 1);
  assert.equal(restartCalls[0].agentId, "agent-dead");
  const agentEntry = summary.find((s) => s.agent_id === "agent-dead");
  assert.ok(agentEntry);
  assert.equal(agentEntry.decision, "eligible_for_restart");
  assert.equal(agentEntry.restarted, true);

  // restart_count incremented
  const cf = readControlFile(p);
  assert.equal(cf.restart_count, 1);
});

await testAsync("C28 runHeartbeatTick: dead agent over budget -> give_up, no restartFn call", async () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  const baseMs = 1_000_000_000_000;
  const heartbeat_at = new Date(baseMs - 300_000).toISOString();
  const now = new Date(baseMs - 300_000).toISOString();
  const p = join(controlDir, "agent-exhausted.json");
  writeFileSync(p, JSON.stringify({
    agent_id: "agent-exhausted", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
    phase: "execute", status: "running",
    heartbeat_at, started_at: now, updated_at: now,
    progress: { iteration: 0, max_iterations: 5, note: "" },
    commits: [], assumptions: [], blockers: [], escalations: [],
    restart_count: 3, inbox_path: null,
  }, null, 2), "utf8");

  const restartCalls = [];
  const restartFn = async (agentId) => { restartCalls.push(agentId); };

  const summary = await runHeartbeatTick({
    runControlDir: controlDir,
    nowFn: () => baseMs,
    restartFn,
    staleMs: 60_000,
    deadMs: 120_000,
    maxRestarts: 3,
  });

  assert.equal(restartCalls.length, 0);
  const entry = summary.find((s) => s.agent_id === "agent-exhausted");
  assert.equal(entry.decision, "give_up");
  assert.equal(entry.restarted, false);

  // status set to needs_input
  const cf = readControlFile(p);
  assert.equal(cf.status, "needs_input");
});

await testAsync("C29 runHeartbeatTick: alive agent -> no restart", async () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  const baseMs = 1_000_000_000_000;
  const heartbeat_at = new Date(baseMs - 10_000).toISOString(); // 10s ago = alive
  const p = join(controlDir, "agent-alive.json");
  createControlFile(p, {
    agent_id: "agent-alive", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  // Overwrite heartbeat_at to be "alive" relative to injected clock
  writeFileSync(p, JSON.stringify({
    ...readControlFile(p),
    heartbeat_at,
  }, null, 2), "utf8");

  const restartCalls = [];
  const restartFn = async (id) => { restartCalls.push(id); };

  const summary = await runHeartbeatTick({
    runControlDir: controlDir,
    nowFn: () => baseMs,
    restartFn,
    staleMs: 60_000,
    deadMs: 120_000,
  });

  assert.equal(restartCalls.length, 0);
  const entry = summary.find((s) => s.agent_id === "agent-alive");
  assert.equal(entry.decision, "alive");
  assert.equal(entry.restarted, false);
});

await testAsync("C30 runHeartbeatTick: terminal agents are skipped", async () => {
  const dir = makeTempDir();
  const controlDir = join(dir, "control");
  mkdirSync(controlDir, { recursive: true });

  const baseMs = 1_000_000_000_000;
  // Dead heartbeat but agent is terminal (done)
  const heartbeat_at = new Date(baseMs - 300_000).toISOString();
  const now = heartbeat_at;
  const p = join(controlDir, "agent-done.json");
  writeFileSync(p, JSON.stringify({
    agent_id: "agent-done", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
    phase: "done", status: "done",
    heartbeat_at, started_at: now, updated_at: now,
    progress: { iteration: 0, max_iterations: 5, note: "" },
    commits: [], assumptions: [], blockers: [], escalations: [],
    restart_count: 0, inbox_path: null,
  }, null, 2), "utf8");

  const restartCalls = [];
  const restartFn = async (id) => { restartCalls.push(id); };

  const summary = await runHeartbeatTick({
    runControlDir: controlDir,
    nowFn: () => baseMs,
    restartFn,
    staleMs: 60_000,
    deadMs: 120_000,
  });

  assert.equal(restartCalls.length, 0);
  const entry = summary.find((s) => s.agent_id === "agent-done");
  assert.equal(entry.decision, "terminal");
  assert.equal(entry.restarted, false);
});

test("C31 touchHeartbeat: updates heartbeat_at with injected clock", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-hb.json");
  createControlFile(p, {
    agent_id: "agent-hb", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  const fakeNow = 1_700_000_000_000; // arbitrary fixed timestamp
  const updated = touchHeartbeat(p, () => fakeNow);
  assert.equal(updated.heartbeat_at, new Date(fakeNow).toISOString());
  const re = readControlFile(p);
  assert.equal(re.heartbeat_at, new Date(fakeNow).toISOString());
});

test("C32 updateControlFile: atomic write (no leftover .tmp file)", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-atomic.json");
  createControlFile(p, {
    agent_id: "agent-atomic", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  updateControlFile(p, { phase: "execute" });
  // .tmp file must NOT exist after atomic write
  assert.equal(existsSync(p + ".tmp"), false);
  const cf = readControlFile(p);
  assert.equal(cf.phase, "execute");
});

// ---------------------------------------------------------------------------
// Tests: Context-pressure fields + updateContextUsage (CTX-02)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- C33..C39  Context-pressure plumbing ---\n");

test("C33 createControlFile: seeds context_bytes=0, context_pressure=null", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-ctx.json");
  const data = createControlFile(p, {
    agent_id: "agent-ctx", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  assert.equal(data.context_bytes, 0);
  assert.equal(data.context_pressure, null);
});

test("C34 updateContextUsage: records bytes + pressure, preserves other fields", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-ctx.json");
  createControlFile(p, {
    agent_id: "agent-ctx", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  const updated = updateContextUsage(p, { context_bytes: 123456, context_pressure: "elevated" });
  assert.equal(updated.context_bytes, 123456);
  assert.equal(updated.context_pressure, "elevated");
  // other fields preserved
  assert.equal(updated.agent_id, "agent-ctx");
  assert.equal(updated.status, "running");
  const re = readControlFile(p);
  assert.equal(re.context_bytes, 123456);
  assert.equal(re.context_pressure, "elevated");
});

test("C35 updateContextUsage: atomic write (no leftover .tmp file)", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-ctx.json");
  createControlFile(p, {
    agent_id: "agent-ctx", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  updateContextUsage(p, { context_bytes: 1, context_pressure: "normal" });
  assert.equal(existsSync(p + ".tmp"), false);
});

test("C36 updateContextUsage: rejects negative context_bytes", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-ctx.json");
  createControlFile(p, {
    agent_id: "agent-ctx", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  assert.throws(
    () => updateContextUsage(p, { context_bytes: -5 }),
    /context_bytes must be a non-negative number/
  );
});

test("C37 updateContextUsage: rejects unknown context_pressure", () => {
  const dir = makeTempDir();
  const p = join(dir, "agent-ctx.json");
  createControlFile(p, {
    agent_id: "agent-ctx", run_id: "r1", worktree: "/w", branch: "b", unit_id: "u1",
  });
  assert.throws(
    () => updateContextUsage(p, { context_bytes: 10, context_pressure: "exploded" }),
    /context_pressure must be one of/
  );
});

test("C38 validateControlFile: rejects negative context_bytes", () => {
  const obj = makeControlObj({ context_bytes: -1 });
  assert.throws(() => validateControlFile(obj), /context_bytes.*must be a non-negative number/);
});

test("C39 validateControlFile: rejects invalid context_pressure", () => {
  const obj = makeControlObj({ context_pressure: "huge" });
  assert.throws(() => validateControlFile(obj), /context_pressure.*must be one of/);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${"─".repeat(60)}\n`);
process.stdout.write(`test-control: ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const f of failures) {
    process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  }
}

process.stdout.write(`${"─".repeat(60)}\n\n`);

// Non-zero exit on any failure (no silent green — NFR-06)
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
