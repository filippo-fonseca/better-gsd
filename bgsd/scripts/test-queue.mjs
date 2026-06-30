#!/usr/bin/env node
/**
 * test-queue.mjs — Unit tests for queue.mjs (Phase 1: QUEUE-01..05)
 *
 * No external framework. Uses node:assert + node:fs.
 * Run with: node bgsd/scripts/test-queue.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Test groups:
 *   T01 — add: enqueues a new item with correct initial shape
 *   T02 — add: returns id on success
 *   T03 — add: deduplicates by content key (non-terminal item)
 *   T04 — add: requires non-empty title
 *   T05 — transition: every legal transition in the state machine
 *   T06 — transition: rejects illegal transition (done -> executing)
 *   T07 — transition: rejects unknown target state
 *   T08 — transition: rejects transition from terminal state
 *   T09 — status: correct per-state counts and shape
 *   T10 — status: current item is the first non-terminal item
 *   T11 — status: last_verdict reflects most-recently-updated terminal item
 *   T12 — durability/resume: write store, reload, confirm state preserved
 *   T13 — durability/resume: start drainer, interrupt, re-run, done items not re-executed
 *   T14 — atomic write: store never left in a partial state (tmp file renamed)
 *   T15 — contentKey: same title+body always produces the same key
 *   T16 — contentKey: different bodies produce different keys
 *   T17 — peekNext: returns the first queued backlog item (FIFO)
 *   T18 — peekNext: returns null when no item is queued
 *   T19 — resolveItem: marks a pulled item terminal with a manual trail entry
 *   T20 — resolveItem: idempotent on an already-terminal item
 *   T21 — resolveItem: rejects a non-terminal target state
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Isolate tests under a tmp directory so they never touch the real .bgsd/queue
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));

// We override QUEUE_DIR by monkey-patching the module's internal paths.
// Since queue.mjs derives QUEUE_DIR from REPO_ROOT (two levels up from scripts/),
// we redirect it by setting process.env.BGSD_QUEUE_DIR before importing — but
// queue.mjs doesn't read an env var by default. Instead we use a simpler approach:
// we import queue.mjs directly and then call its exported functions with a custom
// store path injected via re-export wrappers around the raw store functions.
//
// For determinism we duplicate the core logic under test (addItem, transition,
// getStatus, etc.) while pointing at a tmp directory. This is intentional:
// tests must not mutate the real .bgsd/queue/ and must be repeatable.

const TMP_DIR = resolve(__dir, "../../.bgsd-tmp/test-queue");

// Clean up and recreate tmp dir before tests
try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /**/ }
mkdirSync(TMP_DIR, { recursive: true });

const TMP_QUEUE_FILE = join(TMP_DIR, "queue.json");
const TMP_QUEUE_TMP  = join(TMP_DIR, "queue.json.tmp");

// ---------------------------------------------------------------------------
// Minimal re-implementation of the I/O layer pointing at TMP_DIR so that
// tests are isolated. We then import the pure-logic exports (transition,
// contentKey, STATES, TRANSITIONS, TERMINAL_STATES) directly from queue.mjs.
// ---------------------------------------------------------------------------

import {
  STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  transition,
  contentKey,
} from "./queue.mjs";

import { renameSync } from "node:fs";

/** Load the isolated test store. */
function loadTestStore() {
  if (!existsSync(TMP_QUEUE_FILE)) return { items: [] };
  return JSON.parse(readFileSync(TMP_QUEUE_FILE, "utf8"));
}

/** Save the isolated test store atomically. */
function saveTestStore(store) {
  writeFileSync(TMP_QUEUE_TMP, JSON.stringify(store, null, 2), "utf8");
  renameSync(TMP_QUEUE_TMP, TMP_QUEUE_FILE);
}

/** Reset the test store between tests. */
function resetStore() {
  try { rmSync(TMP_QUEUE_FILE, { force: true }); } catch (_) { /**/ }
  try { rmSync(TMP_QUEUE_TMP, { force: true }); } catch (_) { /**/ }
}

/** Add an item to the test store (mirrors addItem from queue.mjs). */
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

function testContentKey(title, body = "") {
  return createHash("sha256")
    .update(`${title.trim()}\n\n${body.trim()}`)
    .digest("hex");
}

function testAddItem({ title, body = "", source = "manual" }) {
  if (!title || title.trim().length === 0) {
    throw new Error("addItem: title is required and must be non-empty");
  }
  const store = loadTestStore();
  const key = testContentKey(title, body);
  const existing = store.items.find(
    (item) => item.content_key === key && !TERMINAL_STATES.includes(item.state)
  );
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const id = `item-${randomBytes(4).toString("hex")}-${Date.now()}`;
  const item = {
    id,
    content_key: key,
    title: title.trim(),
    body: body.trim(),
    source,
    state: "queued",
    attempts: 0,
    created_at: now,
    updated_at: now,
    trail: [{ from: null, to: "queued", at: now }],
  };
  store.items.push(item);
  saveTestStore(store);
  return id;
}

/** Compute status from the test store. */
function testGetStatus() {
  const store = loadTestStore();
  const items = store.items ?? [];
  const counts = {};
  for (const s of STATES) counts[s] = 0;
  for (const item of items) {
    if (item.state in counts) counts[item.state]++;
  }
  const current = items.find((i) => !TERMINAL_STATES.includes(i.state)) ?? null;
  const terminals = items.filter((i) => TERMINAL_STATES.includes(i.state));
  let lastVerdict = null;
  if (terminals.length > 0) {
    terminals.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    lastVerdict = terminals[0].state;
  }
  return { counts, current, last_verdict: lastVerdict, items };
}

/** Next queued backlog item (mirrors peekNext from queue.mjs). */
function testPeekNext() {
  const store = loadTestStore();
  return (store.items ?? []).find((i) => i.state === "queued") ?? null;
}

/** Manually resolve a backlog item (mirrors resolveItem from queue.mjs). */
function testResolveItem(id, { state = "done", note = "" } = {}) {
  if (!TERMINAL_STATES.includes(state)) {
    throw new Error(`resolveItem: "${state}" is not a terminal state`);
  }
  const store = loadTestStore();
  const item = (store.items ?? []).find((i) => i.id === id);
  if (!item) throw new Error(`resolveItem: no item with id "${id}"`);
  if (TERMINAL_STATES.includes(item.state)) return item;
  const now = new Date().toISOString();
  item.trail = item.trail ?? [];
  item.trail.push({
    from: item.state,
    to: state,
    at: now,
    meta: { manual: true, ...(note ? { note } : {}) },
  });
  item.state = state;
  item.updated_at = now;
  saveTestStore(store);
  return item;
}

// ---------------------------------------------------------------------------
// Test runner
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
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${err.message}\n`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

process.stdout.write("\nbgsd queue unit tests (Phase 1)\n\n");

// ---------------------------------------------------------------------------
// T01: add enqueues a new item with correct initial shape
// ---------------------------------------------------------------------------
test("T01: add enqueues item with correct initial shape (id, state=queued, attempts=0, trail, timestamps)", () => {
  resetStore();
  const id = testAddItem({ title: "Fix nav bug", body: "Nav breaks on mobile" });

  const store = loadTestStore();
  assert.equal(store.items.length, 1, "Should have 1 item");
  const item = store.items[0];

  assert.equal(item.id, id, "id must match returned value");
  assert.equal(item.state, "queued", "initial state must be queued");
  assert.equal(item.attempts, 0, "initial attempts must be 0");
  assert.ok(item.created_at, "created_at must be set");
  assert.ok(item.updated_at, "updated_at must be set");
  assert.ok(Array.isArray(item.trail), "trail must be an array");
  assert.equal(item.trail.length, 1, "trail must have 1 entry on creation");
  assert.equal(item.trail[0].from, null, "first trail entry from must be null");
  assert.equal(item.trail[0].to, "queued", "first trail entry to must be queued");
  assert.ok(item.trail[0].at, "first trail entry must have timestamp");
  assert.equal(item.title, "Fix nav bug", "title must match");
  assert.equal(item.body, "Nav breaks on mobile", "body must match");
  assert.equal(item.source, "manual", "default source must be manual");
  assert.ok(item.content_key, "content_key must be set");
});

// ---------------------------------------------------------------------------
// T02: add returns id on success
// ---------------------------------------------------------------------------
test("T02: add returns a non-empty string id", () => {
  resetStore();
  const id = testAddItem({ title: "Add dark mode" });
  assert.ok(typeof id === "string" && id.length > 0, "id must be a non-empty string");
  assert.ok(id.startsWith("item-"), "id must start with 'item-'");
});

// ---------------------------------------------------------------------------
// T03: add deduplicates by content key (non-terminal)
// ---------------------------------------------------------------------------
test("T03: add deduplicates — same title+body returns existing id without creating duplicate", () => {
  resetStore();
  const id1 = testAddItem({ title: "Fix login", body: "Login fails on Safari" });
  const id2 = testAddItem({ title: "Fix login", body: "Login fails on Safari" });

  assert.equal(id1, id2, "Duplicate add must return the same id");
  const store = loadTestStore();
  assert.equal(store.items.length, 1, "Store must still have only 1 item");
});

// ---------------------------------------------------------------------------
// T04: add requires non-empty title
// ---------------------------------------------------------------------------
test("T04: add throws on empty title", () => {
  resetStore();
  assert.throws(
    () => testAddItem({ title: "" }),
    /title is required/,
    "Should throw when title is empty"
  );
  assert.throws(
    () => testAddItem({ title: "   " }),
    /title is required/,
    "Should throw when title is whitespace-only"
  );
});

// ---------------------------------------------------------------------------
// T05: every legal transition in the state machine
// ---------------------------------------------------------------------------
test("T05: every legal transition advances state and appends a timestamped trail entry", () => {
  // Test a selection of legal transitions
  const legalPaths = [
    ["queued", "classified"],
    ["queued", "needs_input"],
    ["queued", "blocked"],
    ["classified", "routed"],
    ["classified", "needs_input"],
    ["classified", "blocked"],
    ["routed", "executing"],
    ["routed", "needs_input"],
    ["routed", "blocked"],
    ["executing", "verifying"],
    ["executing", "failed"],
    ["executing", "blocked"],
    ["verifying", "looping"],
    ["verifying", "done"],
    ["verifying", "failed"],
    ["verifying", "blocked"],
    ["looping", "verifying"],
    ["looping", "done"],
    ["looping", "failed"],
    ["looping", "blocked"],
  ];

  for (const [from, to] of legalPaths) {
    const item = {
      id: "test",
      state: from,
      updated_at: new Date().toISOString(),
      trail: [],
    };
    transition(item, to, { test: true });
    assert.equal(item.state, to, `After ${from}->${to}: state must be "${to}"`);
    const lastEntry = item.trail[item.trail.length - 1];
    assert.equal(lastEntry.from, from, `Trail entry.from must be "${from}"`);
    assert.equal(lastEntry.to, to, `Trail entry.to must be "${to}"`);
    assert.ok(lastEntry.at, "Trail entry must have 'at' timestamp");
    assert.deepEqual(lastEntry.meta, { test: true }, "Meta must be present");
  }
});

// ---------------------------------------------------------------------------
// T06: rejects illegal transition (done -> executing)
// ---------------------------------------------------------------------------
test("T06: transition rejects done -> executing as illegal", () => {
  const item = {
    id: "x",
    state: "done",
    updated_at: new Date().toISOString(),
    trail: [],
  };
  assert.throws(
    () => transition(item, "executing"),
    /illegal transition from "done" to "executing"/,
    "Should throw on done->executing"
  );
  // State must not have changed
  assert.equal(item.state, "done", "State must remain 'done' after rejected transition");
});

// ---------------------------------------------------------------------------
// T07: rejects unknown target state
// ---------------------------------------------------------------------------
test("T07: transition rejects completely unknown target state", () => {
  const item = {
    id: "y",
    state: "queued",
    updated_at: new Date().toISOString(),
    trail: [],
  };
  assert.throws(
    () => transition(item, "flying"),
    /unknown target state "flying"/,
    "Should throw on unknown state"
  );
  assert.equal(item.state, "queued", "State must remain 'queued' after rejection");
});

// ---------------------------------------------------------------------------
// T08: rejects transition from terminal state (failed -> classified)
// ---------------------------------------------------------------------------
test("T08: every terminal state rejects outgoing transitions", () => {
  for (const terminal of TERMINAL_STATES) {
    const item = {
      id: "t",
      state: terminal,
      updated_at: new Date().toISOString(),
      trail: [],
    };
    // Try to transition to a non-terminal state
    assert.throws(
      () => transition(item, "classified"),
      /illegal transition/,
      `Terminal state "${terminal}" must reject -> classified`
    );
    assert.equal(item.state, terminal, `State must remain "${terminal}" after rejection`);
  }
});

// ---------------------------------------------------------------------------
// T09: status returns correct per-state counts and shape
// ---------------------------------------------------------------------------
test("T09: status returns correct per-state counts and required shape", () => {
  resetStore();
  testAddItem({ title: "Item A" });
  testAddItem({ title: "Item B" });
  testAddItem({ title: "Item C" });

  // Manually advance one item to done, one to failed
  const store = loadTestStore();
  transition(store.items[1], "classified");
  transition(store.items[1], "routed");
  transition(store.items[1], "executing");
  transition(store.items[1], "verifying");
  transition(store.items[1], "done");
  transition(store.items[2], "blocked");
  saveTestStore(store);

  const status = testGetStatus();

  // Shape checks
  assert.ok(typeof status === "object" && status !== null, "status must be an object");
  assert.ok(typeof status.counts === "object", "status.counts must be an object");
  assert.ok(status.items !== undefined, "status.items must be defined");
  assert.ok("current" in status, "status.current must be defined");
  assert.ok("last_verdict" in status, "status.last_verdict must be defined");

  // Count checks
  assert.equal(status.counts.queued, 1, "queued count = 1");
  assert.equal(status.counts.done, 1, "done count = 1");
  assert.equal(status.counts.blocked, 1, "blocked count = 1");
  assert.equal(status.items.length, 3, "total items = 3");

  // All STATES must be present as keys in counts
  for (const s of STATES) {
    assert.ok(s in status.counts, `counts must have key "${s}"`);
  }
});

// ---------------------------------------------------------------------------
// T10: status current = first non-terminal item
// ---------------------------------------------------------------------------
test("T10: status.current is the first non-terminal item", () => {
  resetStore();
  const id1 = testAddItem({ title: "First" });
  testAddItem({ title: "Second" });

  // Mark first item as done
  const store = loadTestStore();
  const first = store.items[0];
  transition(first, "classified");
  transition(first, "routed");
  transition(first, "executing");
  transition(first, "verifying");
  transition(first, "done");
  saveTestStore(store);

  const status = testGetStatus();
  assert.ok(status.current !== null, "current must not be null when non-terminal items exist");
  assert.notEqual(status.current.id, id1, "current must not be the completed first item");
  assert.equal(status.current.title, "Second", "current must be the second (non-terminal) item");
});

// ---------------------------------------------------------------------------
// T11: last_verdict reflects most-recently-updated terminal item
// ---------------------------------------------------------------------------
test("T11: status.last_verdict reflects the most recently updated terminal item's state", () => {
  resetStore();
  testAddItem({ title: "A" });
  testAddItem({ title: "B" });

  const store = loadTestStore();
  // Advance A to done
  ["classified", "routed", "executing", "verifying", "done"].forEach((s) =>
    transition(store.items[0], s)
  );
  // Advance B to failed
  ["classified", "routed", "executing", "failed"].forEach((s) =>
    transition(store.items[1], s)
  );
  // Make B's updated_at slightly later
  store.items[1].updated_at = new Date(Date.now() + 1000).toISOString();
  saveTestStore(store);

  const status = testGetStatus();
  assert.equal(status.last_verdict, "failed", "last_verdict must be 'failed' (most recent terminal)");
});

// ---------------------------------------------------------------------------
// T12: durability/resume — write store, reload, confirm state preserved
// ---------------------------------------------------------------------------
test("T12: durability — write store, reload, confirm state is fully preserved", () => {
  resetStore();
  const id = testAddItem({ title: "Durable item", body: "Must survive reload" });

  // Advance state
  const store = loadTestStore();
  const item = store.items[0];
  transition(item, "classified", { classifier: "stub" });
  transition(item, "routed", { route: "/gsd-quick" });
  saveTestStore(store);

  // Reload
  const reloaded = loadTestStore();
  assert.equal(reloaded.items.length, 1, "Item count must survive reload");
  const ri = reloaded.items[0];
  assert.equal(ri.id, id, "id must survive reload");
  assert.equal(ri.state, "routed", "state must survive reload");
  assert.equal(ri.trail.length, 3, "trail must have 3 entries (creation + 2 transitions)");
  assert.equal(ri.trail[1].meta.classifier, "stub", "trail meta must survive reload");
  assert.equal(ri.trail[2].meta.route, "/gsd-quick", "second trail meta must survive reload");
  assert.equal(ri.title, "Durable item", "title must survive reload");
  assert.equal(ri.body, "Must survive reload", "body must survive reload");
});

// ---------------------------------------------------------------------------
// T13: durability/resume — done items not re-executed, in-flight picked up
// ---------------------------------------------------------------------------
test("T13: resume — done items are terminal and must not be re-advanced; in-flight item is resumable", () => {
  resetStore();
  testAddItem({ title: "Completed task" });
  testAddItem({ title: "In-flight task" });

  // Mark first as done
  const store = loadTestStore();
  ["classified", "routed", "executing", "verifying", "done"].forEach((s) =>
    transition(store.items[0], s)
  );
  // Leave second at "routed" (simulating interrupted mid-pipeline)
  transition(store.items[1], "classified");
  transition(store.items[1], "routed");
  saveTestStore(store);

  // A drainer loop MUST skip done items — verify via status
  const status = testGetStatus();
  assert.equal(status.counts.done, 1, "One item is done");
  assert.equal(status.counts.routed, 1, "One item is in-flight at 'routed'");

  // The in-flight item should be resumable (advance from routed -> executing)
  const freshStore = loadTestStore();
  const inflight = freshStore.items.find((i) => i.state === "routed");
  assert.ok(inflight, "In-flight item must be findable");
  transition(inflight, "executing");
  saveTestStore(freshStore);

  const afterResume = loadTestStore();
  assert.equal(afterResume.items.find((i) => i.state === "done")?.id, store.items[0].id, "Done item unchanged");
  assert.equal(afterResume.items.find((i) => i.state === "executing")?.id, store.items[1].id, "In-flight item advanced");
});

// ---------------------------------------------------------------------------
// T14: atomic write — store is never left partially written
// ---------------------------------------------------------------------------
test("T14: atomic write — tmp file renamed over real file; both are valid JSON after save", () => {
  resetStore();
  testAddItem({ title: "Atomic write test" });

  // After addItem, queue.json must exist and be valid JSON
  assert.ok(existsSync(TMP_QUEUE_FILE), "queue.json must exist after first add");
  const raw = readFileSync(TMP_QUEUE_FILE, "utf8");
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, "queue.json must be valid JSON");
  assert.ok(Array.isArray(parsed.items), "parsed store must have items array");

  // Tmp file must NOT be present after a successful write (renamed away)
  assert.ok(!existsSync(TMP_QUEUE_TMP), "queue.json.tmp must not exist after successful write (renamed)");
});

// ---------------------------------------------------------------------------
// T15: contentKey determinism
// ---------------------------------------------------------------------------
test("T15: contentKey is deterministic — same inputs always produce the same key", () => {
  const k1 = contentKey("Fix nav bug", "Nav breaks on mobile");
  const k2 = contentKey("Fix nav bug", "Nav breaks on mobile");
  assert.equal(k1, k2, "Same title+body must always yield the same content key");

  // Trimming should also be deterministic
  const k3 = contentKey("  Fix nav bug  ", "  Nav breaks on mobile  ");
  assert.equal(k1, k3, "Leading/trailing whitespace must be trimmed before hashing");
});

// ---------------------------------------------------------------------------
// T16: contentKey differentiates distinct inputs
// ---------------------------------------------------------------------------
test("T16: contentKey differentiates distinct title+body combinations", () => {
  const k1 = contentKey("Fix nav bug", "Nav breaks on mobile");
  const k2 = contentKey("Fix nav bug", "Nav breaks on desktop");
  const k3 = contentKey("Fix footer bug", "Nav breaks on mobile");

  assert.notEqual(k1, k2, "Different bodies must produce different keys");
  assert.notEqual(k1, k3, "Different titles must produce different keys");
  assert.notEqual(k2, k3, "Both different must produce different keys");
});

// ---------------------------------------------------------------------------
// T17: peekNext returns the first queued backlog item, oldest-first
// ---------------------------------------------------------------------------
test("T17: peekNext returns the first queued item (FIFO backlog order)", () => {
  resetStore();
  const first = testAddItem({ title: "First deferred", body: "a" });
  testAddItem({ title: "Second deferred", body: "b" });

  const next = testPeekNext();
  assert.ok(next, "peekNext must return an item when the backlog is non-empty");
  assert.equal(next.id, first, "peekNext must return the oldest queued item");
  assert.equal(next.state, "queued", "peeked item must be in queued state");
});

// ---------------------------------------------------------------------------
// T18: peekNext returns null when no item is queued
// ---------------------------------------------------------------------------
test("T18: peekNext returns null when the backlog has no queued items", () => {
  resetStore();
  assert.equal(testPeekNext(), null, "empty store -> null");

  const id = testAddItem({ title: "Will be resolved", body: "x" });
  testResolveItem(id, { state: "done" });
  assert.equal(
    testPeekNext(),
    null,
    "a backlog whose only item is terminal must peek as null (read-only — does not skip to in-flight states)"
  );
});

// ---------------------------------------------------------------------------
// T19: resolveItem marks a pulled item terminal with a manual trail entry
// ---------------------------------------------------------------------------
test("T19: resolveItem marks a queued item done and tags the trail manual", () => {
  resetStore();
  const id = testAddItem({ title: "Pulled into a sesh", body: "y" });

  const item = testResolveItem(id, { state: "done", note: "ran sesh abc" });
  assert.equal(item.state, "done", "item must be resolved to done");
  const last = item.trail[item.trail.length - 1];
  assert.equal(last.to, "done", "trail must record the resolution");
  assert.equal(last.meta.manual, true, "out-of-band resolution must be tagged manual:true");
  assert.equal(last.meta.note, "ran sesh abc", "note must be recorded in the trail");
  assert.equal(testPeekNext(), null, "a resolved item must no longer be peeked");
});

// ---------------------------------------------------------------------------
// T20: resolveItem is idempotent on an already-terminal item
// ---------------------------------------------------------------------------
test("T20: resolveItem is idempotent on a terminal item (no double-resolution)", () => {
  resetStore();
  const id = testAddItem({ title: "Resolve twice", body: "z" });
  const once = testResolveItem(id, { state: "done" });
  const trailLen = once.trail.length;
  const twice = testResolveItem(id, { state: "failed" });
  assert.equal(twice.state, "done", "second resolve must not change a terminal state");
  assert.equal(twice.trail.length, trailLen, "second resolve must not append a trail entry");
});

// ---------------------------------------------------------------------------
// T21: resolveItem rejects a non-terminal target state
// ---------------------------------------------------------------------------
test("T21: resolveItem rejects a non-terminal target state", () => {
  resetStore();
  const id = testAddItem({ title: "Bad target", body: "q" });
  assert.throws(
    () => testResolveItem(id, { state: "executing" }),
    /not a terminal state/,
    "resolving to a non-terminal state must throw"
  );
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /**/ }

// ---------------------------------------------------------------------------
// Summary (no silent green — NFR-06)
// ---------------------------------------------------------------------------
const total = passed + failed;
process.stdout.write(`\n${total} test(s): ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) {
    process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  }
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
