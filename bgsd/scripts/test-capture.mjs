#!/usr/bin/env node
/**
 * test-capture.mjs — Unit tests for Phase 4: capture.mjs + capture-live.mjs (CAPTURE-01..04)
 *
 * No external framework. Uses node:assert + node:fs.
 * Run with: node bgsd/scripts/test-capture.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Test groups:
 *
 *   M01 — mockSource returns a non-empty array of raw items with required fields
 *   M02 — mockSource is deterministic (same result on repeated calls)
 *
 *   N01 — normaliseItem returns correct { title, body, source } shape
 *   N02 — normaliseItem trims whitespace on title and body
 *   N03 — normaliseItem defaults body to "" when absent
 *   N04 — normaliseItem throws on missing/empty title
 *
 *   C01 — (dry-run) captureToQueue reports items, writes nothing to store
 *   C02 — (real-enqueue) captureToQueue enqueues items into the isolated store
 *   C03 — (idempotency) running real-enqueue twice does NOT duplicate items (content-key dedup)
 *   C04 — (live seam) capture-live.mjs refuses without --live flag
 *   C05 — (dry-run dedup flag) dry-run marks already-present items as already_exists=true
 *   C06 — captureToQueue propagates normaliseItem errors into the errors array without throwing
 *   C07 — captureToQueue sets source="hyperpolymath" on every enqueued item
 *   C08 — captureToQueue throws when source is not a function
 *   C09 — captureToQueue throws when source() returns a non-array
 *   C10 — captureToQueue returns correct fetched count equal to items returned by source
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
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { renameSync } from "node:fs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Isolated queue store for tests — mirrors test-queue.mjs approach
// ---------------------------------------------------------------------------

const TMP_DIR = resolve(__dir, "../../.bgsd-tmp/test-capture");
try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /**/ }
mkdirSync(TMP_DIR, { recursive: true });

const TMP_QUEUE_FILE = join(TMP_DIR, "queue.json");
const TMP_QUEUE_TMP  = join(TMP_DIR, "queue.json.tmp");

/** Compute content key (mirrors queue.mjs) */
function contentKey(title, body = "") {
  return createHash("sha256")
    .update(`${title.trim()}\n\n${body.trim()}`)
    .digest("hex");
}

const TERMINAL_STATES = ["done", "failed", "blocked", "needs_input"];

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

/** Reset the isolated test store. */
function resetStore() {
  try { rmSync(TMP_QUEUE_FILE, { force: true }); } catch (_) { /**/ }
  try { rmSync(TMP_QUEUE_TMP, { force: true }); } catch (_) { /**/ }
}

/**
 * Minimal isolated addItem for tests — mirrors queue.mjs addItem but writes
 * to TMP_QUEUE_FILE. Returns id (new or existing if dedup).
 */
function testAddItem({ title, body = "", source = "manual" }) {
  if (!title || title.trim().length === 0) {
    throw new Error("addItem: title is required and must be non-empty");
  }
  const store = loadTestStore();
  const key = contentKey(title, body);
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

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import { mockSource } from "./__fixtures__/hyperpolymath-mock.mjs";
import { normaliseItem, captureToQueue, printCaptureResult } from "./capture.mjs";
import { isLiveFlagSet } from "./capture-live.mjs";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    // Support async tests
    if (r && typeof r.then === "function") {
      return r.then(() => {
        process.stdout.write(`  PASS  ${name}\n`);
        passed++;
      }).catch((err) => {
        process.stderr.write(`  FAIL  ${name}\n`);
        process.stderr.write(`        ${err.message}\n`);
        failed++;
        failures.push({ name, error: err.message });
      });
    }
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
    return Promise.resolve();
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${err.message}\n`);
    failed++;
    failures.push({ name, error: err.message });
    return Promise.resolve();
  }
}

// We need to run async tests sequentially. Collect promises in order.
const testQueue = [];
function t(name, fn) {
  testQueue.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

process.stdout.write("\nbgsd capture unit tests (Phase 4: CAPTURE-01..04)\n\n");
process.stdout.write("--- Mock source tests (M01..M02) ---\n");

// ---------------------------------------------------------------------------
// M01 — mockSource returns a non-empty array of raw items with required fields
// ---------------------------------------------------------------------------
t("M01: mockSource() returns a non-empty array of raw items with id/title/body/created_at", async () => {
  const items = await mockSource();
  assert.ok(Array.isArray(items), "mockSource must return an array");
  assert.ok(items.length > 0, "mockSource must return at least one item");
  for (const item of items) {
    assert.ok(typeof item.id === "string" && item.id.length > 0, `item.id must be a non-empty string (got ${JSON.stringify(item.id)})`);
    assert.ok(typeof item.title === "string" && item.title.length > 0, `item.title must be a non-empty string (got ${JSON.stringify(item.title)})`);
    assert.ok(typeof item.body === "string", `item.body must be a string (got ${typeof item.body})`);
    assert.ok(typeof item.created_at === "string" && item.created_at.length > 0, `item.created_at must be a non-empty string`);
  }
});

// ---------------------------------------------------------------------------
// M02 — mockSource is deterministic (same result on repeated calls)
// ---------------------------------------------------------------------------
t("M02: mockSource() is deterministic — same items returned on repeated calls", async () => {
  const a = await mockSource();
  const b = await mockSource();
  assert.equal(a.length, b.length, "Length must be the same on repeated calls");
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].id, b[i].id, `items[${i}].id must be stable`);
    assert.equal(a[i].title, b[i].title, `items[${i}].title must be stable`);
    assert.equal(a[i].body, b[i].body, `items[${i}].body must be stable`);
  }
});

// ---------------------------------------------------------------------------
// N01..N04 — normaliseItem
// ---------------------------------------------------------------------------
process.stdout.write("\n--- normaliseItem tests (N01..N04) ---\n");

t("N01: normaliseItem returns { title, body, source='hyperpolymath' } for a valid raw item", async () => {
  const raw = { id: "hp-001", title: "Fix login crash", body: "Crashes on Safari", created_at: "2026-06-29T00:00:00Z" };
  const normalised = normaliseItem(raw);
  assert.equal(normalised.title, "Fix login crash");
  assert.equal(normalised.body, "Crashes on Safari");
  assert.equal(normalised.source, "hyperpolymath");
  // Must not carry id or created_at
  assert.ok(!("id" in normalised), "normalised must not carry raw id");
  assert.ok(!("created_at" in normalised), "normalised must not carry created_at");
});

t("N02: normaliseItem trims whitespace from title and body", async () => {
  const normalised = normaliseItem({ title: "  Fix crash  ", body: "  Details  " });
  assert.equal(normalised.title, "Fix crash");
  assert.equal(normalised.body, "Details");
});

t("N03: normaliseItem defaults body to '' when body is absent", async () => {
  const normalised = normaliseItem({ title: "Fix crash" });
  assert.equal(normalised.body, "");
});

t("N04: normaliseItem throws on missing or empty title", async () => {
  assert.throws(() => normaliseItem({ title: "" }), /title/);
  assert.throws(() => normaliseItem({ title: "   " }), /title/);
  assert.throws(() => normaliseItem({}), /title/);
  assert.throws(() => normaliseItem(null), /title/);
});

// ---------------------------------------------------------------------------
// C01 — dry-run: reports items, writes nothing to the store
// ---------------------------------------------------------------------------
process.stdout.write("\n--- captureToQueue tests (C01..C10) ---\n");

t("C01: (dry-run) captureToQueue reports would-enqueue items without writing to store", async () => {
  resetStore();

  const result = await captureToQueue({
    source: mockSource,
    dryRun: true,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  assert.equal(result.dryRun, true, "result.dryRun must be true");
  assert.ok(result.fetched > 0, "fetched must be > 0");
  assert.ok(Array.isArray(result.wouldEnqueue), "wouldEnqueue must be an array");
  assert.equal(result.wouldEnqueue.length, result.fetched, "wouldEnqueue.length must equal fetched (all items preview)");
  assert.equal(result.enqueued.length, 0, "enqueued must be empty in dry-run mode");
  assert.equal(result.errors.length, 0, "errors must be empty for valid mock items");

  // No writes: store must still be empty
  const store = loadTestStore();
  assert.equal(store.items.length, 0, "No items must have been written to the store in dry-run mode");
});

// ---------------------------------------------------------------------------
// C02 — real-enqueue: items land in the isolated store
// ---------------------------------------------------------------------------
t("C02: (real-enqueue) captureToQueue enqueues items into the isolated store", async () => {
  resetStore();

  const result = await captureToQueue({
    source: mockSource,
    dryRun: false,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  assert.equal(result.dryRun, false, "result.dryRun must be false");
  assert.ok(result.fetched > 0, "fetched must be > 0");
  assert.equal(result.enqueued.length, result.fetched, "all fetched items must be enqueued");
  assert.equal(result.wouldEnqueue.length, 0, "wouldEnqueue must be empty in real-enqueue mode");
  assert.equal(result.errors.length, 0, "no errors expected for valid mock items");

  // Store must now have items
  const store = loadTestStore();
  assert.equal(store.items.length, result.fetched, `store must have ${result.fetched} items`);

  // Each item must have source="hyperpolymath"
  for (const item of store.items) {
    assert.equal(item.source, "hyperpolymath", `item.source must be "hyperpolymath", got "${item.source}"`);
    assert.equal(item.state, "queued", `item must start in state "queued", got "${item.state}"`);
  }
});

// ---------------------------------------------------------------------------
// C03 — idempotency: running capture twice does NOT duplicate items
// ---------------------------------------------------------------------------
t("C03: (idempotency) running real-enqueue twice does NOT create duplicate items (content-key dedup)", async () => {
  resetStore();

  // First pass
  const r1 = await captureToQueue({
    source: mockSource,
    dryRun: false,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  const afterFirst = loadTestStore();
  const countAfterFirst = afterFirst.items.length;
  assert.equal(countAfterFirst, r1.fetched, "First pass must enqueue all items");

  // Second pass — must NOT add duplicates
  const r2 = await captureToQueue({
    source: mockSource,
    dryRun: false,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  const afterSecond = loadTestStore();
  assert.equal(
    afterSecond.items.length,
    countAfterFirst,
    `Second pass must NOT create duplicates: store should still have ${countAfterFirst} items, got ${afterSecond.items.length}`
  );

  // enqueued list from second pass must return the SAME ids (existing items)
  assert.equal(r2.enqueued.length, r1.fetched, "enqueued must still list all items (returning existing ids)");

  // Verify each item appears exactly once in the store
  const seenIds = new Set(afterSecond.items.map((i) => i.id));
  assert.equal(seenIds.size, afterSecond.items.length, "Every item in the store must have a unique id (no duplicate ids)");
});

// ---------------------------------------------------------------------------
// C04 — live seam refuses without --live
// ---------------------------------------------------------------------------
t("C04: capture-live.mjs isLiveFlagSet() returns false when --live is absent from process.argv", async () => {
  // process.argv does NOT contain --live in this test run (never passed by tests)
  const hasLive = process.argv.includes("--live");
  // If this test somehow runs with --live in argv, skip the refusal check
  if (hasLive) {
    // The flag is set — we can't test the refusal, but we confirm isLiveFlagSet is true
    assert.equal(isLiveFlagSet(), true, "isLiveFlagSet must return true when --live is in argv");
    return; // Can't test refusal path
  }

  assert.equal(isLiveFlagSet(), false, "isLiveFlagSet() must return false when --live is not in process.argv");

  // Attempting to import and call liveCaptureSource() without --live must throw.
  // We do this by importing and calling it inside a try/catch.
  let threw = false;
  let errorMsg = "";
  try {
    const { liveCaptureSource } = await import(`file://${resolve(__dir, "capture-live.mjs")}`);
    await liveCaptureSource();
  } catch (err) {
    threw = true;
    errorMsg = err.message;
  }
  assert.ok(threw, "liveCaptureSource() must throw when --live is absent");
  assert.ok(
    errorMsg.includes("HUMAN-GATED") || errorMsg.includes("--live"),
    `Error message must mention HUMAN-GATED or --live, got: ${errorMsg.slice(0, 200)}`
  );
});

// ---------------------------------------------------------------------------
// C05 — dry-run dedup flag: already-present items flagged as already_exists
// ---------------------------------------------------------------------------
t("C05: dry-run marks already-queued items as already_exists=true", async () => {
  resetStore();

  // First real-enqueue to populate the store
  await captureToQueue({
    source: mockSource,
    dryRun: false,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  // Now dry-run: items are already in the store
  const result = await captureToQueue({
    source: mockSource,
    dryRun: true,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  assert.equal(result.dryRun, true);
  assert.ok(result.wouldEnqueue.length > 0, "wouldEnqueue must be non-empty");
  // All items should be flagged as already_exists since we just enqueued them
  for (const item of result.wouldEnqueue) {
    assert.equal(
      item.already_exists,
      true,
      `Item "${item.title}" must have already_exists=true after being enqueued`
    );
  }
});

// ---------------------------------------------------------------------------
// C06 — normalisation errors land in errors[], no throw
// ---------------------------------------------------------------------------
t("C06: captureToQueue propagates normaliseItem errors into errors[] without throwing", async () => {
  resetStore();

  // Source that returns one valid item and one invalid (missing title)
  const mixedSource = async () => [
    { id: "good", title: "Fix crash", body: "Details" },
    { id: "bad",  title: "",          body: "No title" },   // empty title — must error
  ];

  const result = await captureToQueue({
    source: mixedSource,
    dryRun: false,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  assert.equal(result.fetched, 2, "fetched must be 2");
  assert.equal(result.enqueued.length, 1, "Only the valid item must be enqueued");
  assert.equal(result.errors.length, 1, "The invalid item must produce one error");
  assert.ok(result.errors[0].error, "Error entry must have an error message");
});

// ---------------------------------------------------------------------------
// C07 — source="hyperpolymath" on every enqueued item
// ---------------------------------------------------------------------------
t("C07: captureToQueue sets source='hyperpolymath' on every enqueued item", async () => {
  resetStore();

  const result = await captureToQueue({
    source: mockSource,
    dryRun: false,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  for (const item of result.enqueued) {
    assert.equal(
      item.source,
      "hyperpolymath",
      `Enqueued item "${item.title}" must have source="hyperpolymath", got "${item.source}"`
    );
  }

  // Confirm in the actual store records
  const store = loadTestStore();
  for (const storeItem of store.items) {
    assert.equal(storeItem.source, "hyperpolymath");
  }
});

// ---------------------------------------------------------------------------
// C08 — captureToQueue throws when source is not a function
// ---------------------------------------------------------------------------
t("C08: captureToQueue throws when source is not a function", async () => {
  let threw = false;
  try {
    await captureToQueue({ source: "not a function", dryRun: true });
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("source"), `Error must mention 'source', got: ${err.message}`);
  }
  assert.ok(threw, "Must throw when source is not a function");
});

// ---------------------------------------------------------------------------
// C09 — captureToQueue throws when source() returns a non-array
// ---------------------------------------------------------------------------
t("C09: captureToQueue throws when source() returns a non-array", async () => {
  let threw = false;
  try {
    await captureToQueue({ source: async () => ({ not: "an array" }), dryRun: true });
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("array"), `Error must mention 'array', got: ${err.message}`);
  }
  assert.ok(threw, "Must throw when source() returns a non-array");
});

// ---------------------------------------------------------------------------
// C10 — fetched count equals items returned by source
// ---------------------------------------------------------------------------
t("C10: captureToQueue result.fetched equals the number of items returned by source()", async () => {
  resetStore();

  const items = await mockSource();
  const result = await captureToQueue({
    source: mockSource,
    dryRun: true,
    _addItem: testAddItem,
    _loadStore: loadTestStore,
  });

  assert.equal(result.fetched, items.length, "fetched must equal the number of items returned by source()");
});

// ---------------------------------------------------------------------------
// Run all tests (in order, await each)
// ---------------------------------------------------------------------------

for (const { name, fn } of testQueue) {
  await test(name, fn);
}

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
