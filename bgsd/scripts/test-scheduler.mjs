#!/usr/bin/env node
/**
 * test-scheduler.mjs — Unit tests for worktree.mjs + scheduler.mjs
 *                       (Phase 3: SPAWN-01, SPAWN-02, SPAWN-03)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-scheduler.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully mocked: no real git worktree add, no real process spawn,
 * no real filesystem reads beyond temp dirs created here. The real
 * spawnWorktreeReal stub is imported but verified to throw rather than spawn.
 *
 * Test groups:
 *
 * --- worktree.mjs (SPAWN-01) ---
 *   W01 — worktreePath: builds the correct nested path
 *   W02 — worktreePath: throws when args are missing
 *   W03 — branchName: produces <run-id>/<slug>
 *   W04 — branchName: sanitizes non-safe characters in unit id
 *   W05 — isolatedPort: returns a number in [3100, 3999]
 *   W06 — isolatedPort: distinct paths produce distinct ports (no collision)
 *   W07 — dbPath: builds the correct .sqlite path
 *   W08 — planWorktrees: returns a Map with one entry per unit
 *   W09 — planWorktrees: each unit gets a unique path, branch, port, db
 *   W10 — planWorktrees: detects a port collision and throws (collision guard)
 *   W11 — spawnWorktreeReal: throws (is the live stub — NOT called in tests)
 *   W12 — dryRunPlan: emits output to stdout without throwing
 *
 * --- scheduler.mjs (SPAWN-02, SPAWN-03) ---
 *   S01 — runScheduler: throws when spawnFn is not injected
 *   S02 — runScheduler: throws when readStatusFn is not injected
 *   S03 — single wave, 2 units — both dispatched and complete (no deps)
 *   S04 — 3-wave graph — units dispatched in correct topological order
 *   S05 — maxConcurrency cap — never more than N units in flight at once
 *   S06 — a unit is not dispatched until all its graph deps are done
 *   S07 — a failed worker blocks all its direct dependents (NFR-06)
 *   S08 — a failed worker blocks transitive dependents (NFR-06)
 *   S09 — failure is surfaced in the result, not silently passed (NFR-06)
 *   S10 — distinct port per unit — no two worktrees share a port
 *   S11 — distinct worktree path per unit — no two paths collide
 *   S12 — done list contains only units that succeeded
 *   S13 — all-pass run: dispatched == done, failed == [], blocked == []
 *   S14 — waves count returned matches wave input length
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  worktreePath,
  branchName,
  isolatedPort,
  dbPath,
  planWorktrees,
  spawnWorktreeReal,
  dryRunPlan,
  PORT_BASE,
  PORT_RANGE,
} from "./worktree.mjs";

import {
  runScheduler,
  DEFAULT_MAX_CONCURRENCY,
} from "./scheduler.mjs";

// ---------------------------------------------------------------------------
// Test runner helpers
// ---------------------------------------------------------------------------

let total   = 0;
let passed  = 0;
let failed  = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // async test — handled in runAll()
      return { name, promise: result };
    }
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
    return null;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n         ${err.message}\n`);
    failed++;
    return null;
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n         ${err.message}\n`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = "/fake/repo";
const RUN_ID    = "bgsd-0001-test";

/** Build a minimal unit object. */
function makeUnit(id, deps = []) {
  return { id, deps, title: `Unit ${id}`, touched: [] };
}

/**
 * Build a minimal graph structure matching what graph.mjs produces.
 * edges:        unitId -> Set of dep ids (the ids this unit depends ON)
 * reverseEdges: depId  -> Set of unitIds that depend ON this dep
 */
function makeGraph(units) {
  const edges        = new Map();
  const reverseEdges = new Map();

  for (const u of units) {
    edges.set(u.id, new Set(u.deps ?? []));
    if (!reverseEdges.has(u.id)) reverseEdges.set(u.id, new Set());
    for (const dep of (u.deps ?? [])) {
      if (!reverseEdges.has(dep)) reverseEdges.set(dep, new Set());
      reverseEdges.get(dep).add(u.id);
    }
  }

  return { edges, reverseEdges };
}

/**
 * Build a mock scheduler environment:
 *   - spawnFn:      records dispatched units; immediately sets status to "running"
 *   - setStatus:    test helper to push a unit into a terminal state
 *   - readStatusFn: returns current status from a shared map
 *   - statuses:     the shared map (unitId -> status string)
 */
function makeMockEnv(initialStatuses = {}) {
  const statuses = { ...initialStatuses };
  const dispatchLog = [];

  const spawnFn = async (unitId, _plan) => {
    dispatchLog.push(unitId);
    if (!statuses[unitId]) {
      statuses[unitId] = "running";
    }
  };

  const readStatusFn = async (unitId) => {
    return statuses[unitId] ?? "running";
  };

  const setStatus = (unitId, status) => {
    statuses[unitId] = status;
  };

  return { spawnFn, readStatusFn, setStatus, statuses, dispatchLog };
}

// ---------------------------------------------------------------------------
// worktree.mjs tests
// ---------------------------------------------------------------------------

process.stdout.write("\n--- worktree.mjs (SPAWN-01) ---\n");

test("W01 — worktreePath: builds the correct nested path", () => {
  const p = worktreePath("/repo", "bgsd-0001-foo", "unit-abc");
  assert.equal(p, "/repo/.bgsd/runs/bgsd-0001-foo/worktrees/unit-abc");
});

test("W02 — worktreePath: throws when args are missing", () => {
  assert.throws(() => worktreePath("", "run", "unit"), /required/);
  assert.throws(() => worktreePath("/repo", "", "unit"), /required/);
  assert.throws(() => worktreePath("/repo", "run", ""),  /required/);
});

test("W03 — branchName: produces <run-id>/<slug>", () => {
  const b = branchName("bgsd-0001-foo", "unit-abc");
  assert.equal(b, "bgsd-0001-foo/unit-abc");
});

test("W04 — branchName: sanitizes non-safe characters in unit id", () => {
  const b = branchName("run-001", "unit abc#$%");
  // All non-safe chars replaced with hyphens, leading/trailing stripped
  assert.match(b, /^run-001\/unit-abc/);
  assert.doesNotMatch(b, /[#$% ]/);
});

test("W05 — isolatedPort: returns a number in [3100, 3999]", () => {
  const port = isolatedPort("/some/worktree/path");
  assert.ok(typeof port === "number", "port is a number");
  assert.ok(port >= PORT_BASE, `port ${port} >= ${PORT_BASE}`);
  assert.ok(port < PORT_BASE + PORT_RANGE, `port ${port} < ${PORT_BASE + PORT_RANGE}`);
});

test("W06 — isolatedPort: distinct paths produce distinct ports (no collision)", () => {
  // Generate 10 distinct paths and check all ports are different
  const paths = Array.from({ length: 10 }, (_, i) =>
    `/repo/.bgsd/runs/bgsd-0001/worktrees/unit-${i.toString().padStart(3, "0")}`
  );
  const ports = paths.map(isolatedPort);
  const unique = new Set(ports);
  assert.equal(unique.size, ports.length,
    `Expected ${ports.length} distinct ports, got ${unique.size}: [${ports.join(", ")}]`);
});

test("W07 — dbPath: builds the correct .sqlite path", () => {
  const p = dbPath("/repo", "bgsd-0001-foo", "unit-abc");
  assert.equal(p, "/repo/.bgsd/runs/bgsd-0001-foo/dbs/unit-abc.sqlite");
});

test("W08 — planWorktrees: returns a Map with one entry per unit", () => {
  const units = [makeUnit("u1"), makeUnit("u2"), makeUnit("u3")];
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  assert.ok(plans instanceof Map, "returns a Map");
  assert.equal(plans.size, 3);
  assert.ok(plans.has("u1"));
  assert.ok(plans.has("u2"));
  assert.ok(plans.has("u3"));
});

test("W09 — planWorktrees: each unit gets a unique path, branch, port, db", () => {
  const units = [makeUnit("alpha"), makeUnit("beta"), makeUnit("gamma")];
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);

  const paths   = [...plans.values()].map((p) => p.path);
  const branches = [...plans.values()].map((p) => p.branch);
  const ports    = [...plans.values()].map((p) => p.port);
  const dbs      = [...plans.values()].map((p) => p.db);

  assert.equal(new Set(paths).size,    paths.length,    "all paths unique");
  assert.equal(new Set(branches).size, branches.length, "all branches unique");
  assert.equal(new Set(ports).size,    ports.length,    "all ports unique");
  assert.equal(new Set(dbs).size,      dbs.length,      "all db paths unique");
});

test("W10 — planWorktrees: detects a port collision and throws (collision guard)", () => {
  // Force a collision by monkey-patching: two units whose worktree paths
  // produce the same port. We find two path strings that actually hash to
  // the same 4-hex-digit prefix modulo PORT_RANGE.
  // Instead of brute-force search, we verify the collision detection mechanism
  // itself by constructing a synthetic scenario using the worktree module.

  // The simplest way: planWorktrees uses worktreePath internally, and each unit
  // gets a path like .../worktrees/<unitId>. Ports collide when two paths share
  // the same sha256 slice modulo 900. We rely on the test above (W06) to show
  // 10 distinct unit ids give 10 distinct ports. For the collision test we need
  // to force it — we can't easily manufacture a collision via unit ids alone.
  //
  // We verify the guard is wired by directly testing planWorktrees with a stub:
  // if planWorktrees uses isolatedPort per path and checks for duplicate ports,
  // a true collision (same port from two different paths) would throw.
  // Since we cannot reliably find two real collisions, we verify the mechanism
  // by running planWorktrees on a single unit (no collision possible) and
  // confirming it succeeds, then testing that the guard code exists and is
  // exercised by passing units whose computed paths DO produce the same port.

  // Find a real collision by exhaustive search over unit id strings.
  // We hash paths and look for two unit ids that map to the same port.
  const repoRoot = "/test/collision";
  const runId    = "bgsd-9999-col";

  function portForUnit(uid) {
    const p = worktreePath(repoRoot, runId, uid);
    return isolatedPort(p);
  }

  // Scan enough candidates to find a collision (birthday bound: with 900 slots
  // and random sha256 input we expect a collision within ~40 tries on average).
  const portMap = new Map(); // port -> uid
  let collisionA = null;
  let collisionB = null;
  outer: for (let i = 0; i < 2000; i++) {
    const uid  = `unit-col-${i}`;
    const port = portForUnit(uid);
    if (portMap.has(port)) {
      collisionA = portMap.get(port);
      collisionB = uid;
      break outer;
    }
    portMap.set(port, uid);
  }

  assert.ok(
    collisionA !== null,
    "Could not find a port collision in 2000 candidates — birthday bound should guarantee one; increase search if this fires"
  );

  // Now verify planWorktrees rejects the pair
  const units = [makeUnit(collisionA), makeUnit(collisionB)];
  assert.throws(
    () => planWorktrees(repoRoot, runId, units),
    /port collision/i,
    "planWorktrees must throw on port collision"
  );
});

await testAsync("W11 — spawnWorktreeReal: throws (is the live stub — NOT called in tests)", async () => {
  await assert.rejects(
    () => spawnWorktreeReal({ unitId: "u1" }, "HEAD"),
    /spawnWorktreeReal is the live stub/i
  );
});

test("W12 — dryRunPlan: emits output to stdout without throwing", () => {
  const units = [makeUnit("u1"), makeUnit("u2")];
  const waves = [["u1", "u2"]];
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);

  // Capture stdout
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    dryRunPlan(RUN_ID, waves, plans);
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = chunks.join("");
  assert.match(output, /dry-run/i, "output mentions dry-run");
  assert.match(output, /u1/, "output mentions unit u1");
  assert.match(output, /u2/, "output mentions unit u2");
  assert.match(output, /No worktrees or processes were created/i);
});

// ---------------------------------------------------------------------------
// scheduler.mjs tests
// ---------------------------------------------------------------------------

process.stdout.write("\n--- scheduler.mjs (SPAWN-02, SPAWN-03) ---\n");

await testAsync("S01 — runScheduler: throws when spawnFn is not injected", async () => {
  await assert.rejects(
    () => runScheduler({
      waves: [["u1"]],
      graph: makeGraph([makeUnit("u1")]),
      plans: new Map(),
      spawnFn: "not-a-function",  // wrong type
      readStatusFn: async () => "done",
    }),
    /spawnFn must be a function/i
  );
});

await testAsync("S02 — runScheduler: throws when readStatusFn is not injected", async () => {
  await assert.rejects(
    () => runScheduler({
      waves: [["u1"]],
      graph: makeGraph([makeUnit("u1")]),
      plans: new Map(),
      spawnFn: async () => {},
      readStatusFn: null,  // missing
    }),
    /readStatusFn must be a function/i
  );
});

await testAsync("S03 — single wave, 2 units — both dispatched and complete", async () => {
  const units  = [makeUnit("u1"), makeUnit("u2")];
  const graph  = makeGraph(units);
  const plans  = planWorktrees(REPO_ROOT, RUN_ID, units);
  const { spawnFn, readStatusFn, setStatus, dispatchLog } = makeMockEnv();

  // Units complete immediately when polled
  const spawnAndDone = async (uid, plan) => {
    dispatchLog.push(uid);
    setStatus(uid, "done");
  };

  const result = await runScheduler({
    waves: [["u1", "u2"]],
    graph,
    plans,
    spawnFn: spawnAndDone,
    readStatusFn,
    pollIntervalMs: 0,
  });

  assert.deepEqual(result.dispatched.sort(), ["u1", "u2"]);
  assert.deepEqual(result.done.sort(),       ["u1", "u2"]);
  assert.deepEqual(result.failed,            []);
  assert.deepEqual(result.blocked,           []);
});

await testAsync("S04 — 3-wave graph — units dispatched in correct topological order", async () => {
  // Wave 0: u1, u2 (independent)
  // Wave 1: u3 (depends on u1 and u2)
  // Wave 2: u4 (depends on u3)
  const units = [
    makeUnit("u1"),
    makeUnit("u2"),
    makeUnit("u3", ["u1", "u2"]),
    makeUnit("u4", ["u3"]),
  ];
  const graph = makeGraph(units);
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves = [["u1", "u2"], ["u3"], ["u4"]];

  const dispatchOrder = [];
  const statuses      = {};

  const spawnFn = async (uid) => {
    dispatchOrder.push(uid);
    statuses[uid] = "done";
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  // u1 and u2 must appear before u3, u3 before u4
  const idxU1 = dispatchOrder.indexOf("u1");
  const idxU2 = dispatchOrder.indexOf("u2");
  const idxU3 = dispatchOrder.indexOf("u3");
  const idxU4 = dispatchOrder.indexOf("u4");

  assert.ok(idxU1 >= 0 && idxU2 >= 0 && idxU3 >= 0 && idxU4 >= 0,
    "all units were dispatched");
  assert.ok(idxU1 < idxU3, "u1 dispatched before u3");
  assert.ok(idxU2 < idxU3, "u2 dispatched before u3");
  assert.ok(idxU3 < idxU4, "u3 dispatched before u4");

  assert.equal(result.waves, 3);
  assert.deepEqual(result.done.sort(), ["u1", "u2", "u3", "u4"]);
});

await testAsync("S05 — maxConcurrency cap — never more than N units in flight at once", async () => {
  const MAX = 2;
  // 4 independent units in one wave — only 2 may be in-flight at a time
  const units = [makeUnit("u1"), makeUnit("u2"), makeUnit("u3"), makeUnit("u4")];
  const graph = makeGraph(units);
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves = [["u1", "u2", "u3", "u4"]]; // all in wave 0

  let inFlight = 0;
  let maxObserved = 0;
  const statuses = {};

  const spawnFn = async (uid) => {
    inFlight++;
    maxObserved = Math.max(maxObserved, inFlight);
    // Simulate some async work before completing
    await Promise.resolve();
    statuses[uid] = "done";
    inFlight--;
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn,
    maxConcurrency: MAX,
    pollIntervalMs: 0,
  });

  assert.ok(
    maxObserved <= MAX,
    `maxConcurrency=${MAX} violated: max ${maxObserved} units were in-flight simultaneously`
  );
});

await testAsync("S06 — a unit is not dispatched until all its graph deps are done", async () => {
  // u2 depends on u1; they are in separate waves
  const units = [makeUnit("u1"), makeUnit("u2", ["u1"])];
  const graph = makeGraph(units);
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves = [["u1"], ["u2"]];

  const dispatchOrder = [];
  const statuses      = {};

  const spawnFn = async (uid) => {
    // Record timestamp-ordered dispatch
    dispatchOrder.push({ uid, at: Date.now() });
    statuses[uid] = "done";
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  const u1Idx = dispatchOrder.findIndex((e) => e.uid === "u1");
  const u2Idx = dispatchOrder.findIndex((e) => e.uid === "u2");

  assert.ok(u1Idx >= 0, "u1 was dispatched");
  assert.ok(u2Idx >= 0, "u2 was dispatched");
  assert.ok(u1Idx < u2Idx, "u1 was dispatched before u2 (dep ordering)");
  assert.deepEqual(result.blocked, [], "no units were blocked");
});

await testAsync("S07 — a failed worker blocks all its direct dependents (NFR-06)", async () => {
  // u1 fails; u2 and u3 depend on u1 and must not be dispatched
  const units = [makeUnit("u1"), makeUnit("u2", ["u1"]), makeUnit("u3", ["u1"])];
  const graph = makeGraph(units);
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves = [["u1"], ["u2", "u3"]];

  const dispatched = [];
  const statuses   = { u1: "failed" };

  const spawnFn = async (uid) => {
    dispatched.push(uid);
    // u1 is already set to failed before spawn; u2/u3 should never be spawned
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  // Override spawn for u1 to mark failed immediately
  const realSpawn = async (uid) => {
    dispatched.push(uid);
    statuses[uid] = "failed";
  };

  const result = await runScheduler({
    waves, graph, plans,
    spawnFn: realSpawn,
    readStatusFn,
    pollIntervalMs: 0,
  });

  assert.ok(dispatched.includes("u1"),  "u1 was dispatched");
  assert.ok(!dispatched.includes("u2"), "u2 was NOT dispatched (blocked by failed u1)");
  assert.ok(!dispatched.includes("u3"), "u3 was NOT dispatched (blocked by failed u1)");
  assert.ok(result.blocked.includes("u2") || result.failed.includes("u2"),
    "u2 is in blocked or failed list");
  assert.ok(result.blocked.includes("u3") || result.failed.includes("u3"),
    "u3 is in blocked or failed list");
});

await testAsync("S08 — a failed worker blocks transitive dependents (NFR-06)", async () => {
  // u1 fails; u2 depends on u1, u3 depends on u2 — both must be blocked
  const units = [
    makeUnit("u1"),
    makeUnit("u2", ["u1"]),
    makeUnit("u3", ["u2"]),
  ];
  const graph  = makeGraph(units);
  const plans  = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves  = [["u1"], ["u2"], ["u3"]];
  const statuses = {};

  const spawnFn = async (uid) => {
    statuses[uid] = "failed"; // u1 fails on spawn; u2/u3 should never run
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  // u2 and u3 must not be in done
  assert.ok(!result.done.includes("u2"), "u2 not in done (transitively blocked)");
  assert.ok(!result.done.includes("u3"), "u3 not in done (transitively blocked)");

  // Both must be in failed or blocked
  const nonDone = [...result.failed, ...result.blocked];
  assert.ok(nonDone.includes("u2") || !result.dispatched.includes("u2"),
    "u2 is either blocked or never dispatched");
  assert.ok(nonDone.includes("u3") || !result.dispatched.includes("u3"),
    "u3 is either blocked or never dispatched");
});

await testAsync("S09 — failure is surfaced in the result, not silently passed (NFR-06)", async () => {
  // u1 fails — it must appear in result.failed, not result.done
  const units = [makeUnit("u1"), makeUnit("u2")];
  const graph = makeGraph(units);
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves = [["u1", "u2"]];
  const statuses = {};

  const spawnFn = async (uid) => {
    statuses[uid] = uid === "u1" ? "failed" : "done";
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  assert.ok(result.failed.includes("u1"),  "u1 is in failed list");
  assert.ok(!result.done.includes("u1"),   "u1 is NOT in done list (no silent green)");
  assert.ok(result.done.includes("u2"),    "u2 is in done (succeeded)");
  assert.ok(!result.failed.includes("u2"), "u2 is NOT in failed list");
});

await testAsync("S10 — distinct port per unit — no two worktrees share a port", async () => {
  const units = [
    makeUnit("unit-aaa"), makeUnit("unit-bbb"), makeUnit("unit-ccc"),
  ];
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const ports = [...plans.values()].map((p) => p.port);
  assert.equal(new Set(ports).size, ports.length,
    `Expected ${ports.length} distinct ports, got ${new Set(ports).size}: [${ports.join(", ")}]`);
});

await testAsync("S11 — distinct worktree path per unit — no two paths collide", async () => {
  const units = [
    makeUnit("unit-x"), makeUnit("unit-y"), makeUnit("unit-z"),
  ];
  const plans = planWorktrees(REPO_ROOT, RUN_ID, units);
  const paths = [...plans.values()].map((p) => p.path);
  assert.equal(new Set(paths).size, paths.length,
    `Expected ${paths.length} distinct paths, got ${new Set(paths).size}`);
});

await testAsync("S12 — done list contains only units that succeeded", async () => {
  const units  = [makeUnit("u1"), makeUnit("u2"), makeUnit("u3")];
  const graph  = makeGraph(units);
  const plans  = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves  = [["u1", "u2", "u3"]];
  const statuses = {};

  const spawnFn = async (uid) => {
    // u2 fails, u1 and u3 succeed
    statuses[uid] = uid === "u2" ? "failed" : "done";
  };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  assert.deepEqual(result.done.sort(), ["u1", "u3"],
    "done contains only the two successful units");
  assert.ok(result.failed.includes("u2"), "u2 is in failed");
});

await testAsync("S13 — all-pass run: dispatched == done, failed == [], blocked == []", async () => {
  const units = [
    makeUnit("a"), makeUnit("b"), makeUnit("c", ["a", "b"]), makeUnit("d", ["c"]),
  ];
  const graph  = makeGraph(units);
  const plans  = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves  = [["a", "b"], ["c"], ["d"]];
  const statuses = {};

  const spawnFn = async (uid) => { statuses[uid] = "done"; };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  assert.deepEqual(result.dispatched.sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(result.done.sort(),       ["a", "b", "c", "d"]);
  assert.deepEqual(result.failed,            []);
  assert.deepEqual(result.blocked,           []);
});

await testAsync("S14 — waves count returned matches wave input length", async () => {
  const units = [makeUnit("u1"), makeUnit("u2", ["u1"])];
  const graph  = makeGraph(units);
  const plans  = planWorktrees(REPO_ROOT, RUN_ID, units);
  const waves  = [["u1"], ["u2"]];
  const statuses = {};

  const spawnFn = async (uid) => { statuses[uid] = "done"; };
  const readStatusFn = async (uid) => statuses[uid] ?? "running";

  const result = await runScheduler({
    waves, graph, plans, spawnFn, readStatusFn, pollIntervalMs: 0,
  });

  assert.equal(result.waves, waves.length, "waves count matches input");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${total} test(s) defined: ${passed} passed, ${failed} failed\n\n`);

if (failed > 0) {
  process.stderr.write(`${failed} test(s) FAILED.\n`);
  process.exit(1);
}

process.stdout.write("All tests PASSED.\n");
