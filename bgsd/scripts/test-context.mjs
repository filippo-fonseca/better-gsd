#!/usr/bin/env node
/**
 * test-context.mjs — Unit tests for context.mjs (Phase 8: CTX-01..03)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-context.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests use OS temp directories; no real .bgsd/ runtime is touched.
 * All size-based tests use injected byte counts — zero filesystem I/O in
 * the pressure-estimation path.
 *
 * Test groups:
 *
 * --- CTX-02: pressure classification ---
 *   X01 — estimatePressure: "normal" when accumulatedBytes is below elevatedFraction
 *   X02 — estimatePressure: "normal" exactly at elevatedFraction - 1 byte (boundary)
 *   X03 — estimatePressure: "elevated" exactly at elevatedFraction (boundary)
 *   X04 — estimatePressure: "elevated" between elevatedFraction and criticalFraction
 *   X05 — estimatePressure: "critical" exactly at criticalFraction (boundary)
 *   X06 — estimatePressure: "critical" above criticalFraction
 *   X07 — estimatePressure: "critical" at exactly windowBytes (100% full)
 *   X08 — estimatePressure: "critical" above windowBytes (overflow proxy)
 *   X09 — estimatePressure: throws on negative accumulatedBytes
 *   X10 — estimatePressure: custom thresholds (large 1M-window model)
 *   X11 — makeThresholds: produces correct windowBytes for 1M-token model
 *   X12 — makeThresholds: throws on non-positive contextTokens
 *   X13 — makeThresholds: throws when criticalFraction <= elevatedFraction
 *
 * --- CTX-02: decision function ---
 *   X14 — pressureDecision: "normal"   → "continue"
 *   X15 — pressureDecision: "elevated" → "compact"
 *   X16 — pressureDecision: "critical" → "clear+relaunch"
 *   X17 — pressureDecision: throws on unknown level
 *
 * --- CTX-01: pointers-not-blobs handoff ---
 *   X18 — writeHandoffManifest: creates JSON file with pointers (not blobs)
 *   X19 — writeHandoffManifest: atomic write (no tmp file left behind)
 *   X20 — readHandoffManifest: round-trips the written manifest
 *   X21 — readHandoffManifest: pointer values are short file paths, not blobs
 *   X22 — readHandoffManifest: throws on missing file
 *   X23 — readHandoffManifest: throws on invalid JSON
 *   X24 — readHandoffManifest: throws when "pointers" field is missing
 *   X25 — writeHandoffManifest: throws when a pointer value is not a string
 *   X26 — writeHandoffManifest: creates parent directory if it does not exist
 *
 * --- CTX-03: shared research / prompt cache ---
 *   X27 — cacheKey: same key always produces the same SHA-256 hash
 *   X28 — cacheKey: different keys produce different hashes
 *   X29 — cacheKey: throws on empty string
 *   X30 — cacheHas: returns false for a key not yet cached
 *   X31 — cachePut: writes a new entry and returns written=true
 *   X32 — cacheGet: returns the entry on a cache hit
 *   X33 — cacheHas: returns true after cachePut
 *   X34 — cachePut: first-writer-wins — second cachePut returns written=false
 *   X35 — cacheGet: second put does NOT overwrite the first result (dedup)
 *   X36 — cacheGet: returns null on a cache miss
 *   X37 — cachePut: atomic write (tmp file not left behind)
 *   X38 — cachePut: creates cache directory if it does not exist
 *
 * --- Live boundary guard (CTX-02) ---
 *   X39 — isLiveFlagSet: returns false in test context (--live not in argv)
 *   X40 — requireLiveFlag: throws without --live
 *   X41 — liveCompact: throws without --live
 *   X42 — liveRelaunch: throws without --live
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
  estimatePressure,
  pressureDecision,
  DEFAULT_CONTEXT_THRESHOLDS,
  makeThresholds,
  writeHandoffManifest,
  readHandoffManifest,
  cacheKey,
  cacheGet,
  cachePut,
  cacheHas,
  isLiveFlagSet,
  requireLiveFlag,
  liveCompact,
  liveRelaunch,
} from "./context.mjs";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {string} id
 * @param {string} description
 * @param {() => void | Promise<void>} fn
 */
async function test(id, description, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${id} — ${description}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${id} — ${description}\n`);
    process.stdout.write(`        ${err.message}\n`);
    failures.push({ id, description, error: err });
    failed++;
  }
}

/** Create a unique temp directory for a test. Cleaned up after each test. */
function makeTmpDir() {
  const dir = join(tmpdir(), `test-context-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpDir(dir) {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tests: CTX-02 pressure classification
// ---------------------------------------------------------------------------

process.stdout.write("\n=== test-context.mjs — Phase 8: CTX-01..03 ===\n\n");
process.stdout.write("CTX-02: pressure classification\n");

// ── X01 ────────────────────────────────────────────────────────────────────
await test("X01", '"normal" well below elevatedFraction', () => {
  const { windowBytes } = DEFAULT_CONTEXT_THRESHOLDS;
  // 50% of window — well below 70% elevated threshold
  const bytes = Math.round(windowBytes * 0.50);
  assert.equal(estimatePressure({ accumulatedBytes: bytes }), "normal");
});

// ── X02 ────────────────────────────────────────────────────────────────────
await test("X02", '"normal" at elevatedFraction - 1 byte (boundary)', () => {
  const { windowBytes, elevatedFraction } = DEFAULT_CONTEXT_THRESHOLDS;
  const bytes = Math.ceil(windowBytes * elevatedFraction) - 1;
  assert.equal(estimatePressure({ accumulatedBytes: bytes }), "normal");
});

// ── X03 ────────────────────────────────────────────────────────────────────
await test("X03", '"elevated" exactly at elevatedFraction (boundary)', () => {
  const { windowBytes, elevatedFraction } = DEFAULT_CONTEXT_THRESHOLDS;
  // fraction === elevatedFraction → elevated (criticalFraction is 0.90, so 0.70 is elevated)
  const bytes = Math.round(windowBytes * elevatedFraction);
  const level = estimatePressure({ accumulatedBytes: bytes });
  assert.equal(level, "elevated", `expected "elevated" at ${bytes} bytes`);
});

// ── X04 ────────────────────────────────────────────────────────────────────
await test("X04", '"elevated" between elevated and critical fractions (80%)', () => {
  const { windowBytes } = DEFAULT_CONTEXT_THRESHOLDS;
  const bytes = Math.round(windowBytes * 0.80);
  assert.equal(estimatePressure({ accumulatedBytes: bytes }), "elevated");
});

// ── X05 ────────────────────────────────────────────────────────────────────
await test("X05", '"critical" exactly at criticalFraction (boundary)', () => {
  const { windowBytes, criticalFraction } = DEFAULT_CONTEXT_THRESHOLDS;
  const bytes = Math.round(windowBytes * criticalFraction);
  assert.equal(estimatePressure({ accumulatedBytes: bytes }), "critical");
});

// ── X06 ────────────────────────────────────────────────────────────────────
await test("X06", '"critical" above criticalFraction (95%)', () => {
  const { windowBytes } = DEFAULT_CONTEXT_THRESHOLDS;
  const bytes = Math.round(windowBytes * 0.95);
  assert.equal(estimatePressure({ accumulatedBytes: bytes }), "critical");
});

// ── X07 ────────────────────────────────────────────────────────────────────
await test("X07", '"critical" at exactly windowBytes (100%)', () => {
  const { windowBytes } = DEFAULT_CONTEXT_THRESHOLDS;
  assert.equal(estimatePressure({ accumulatedBytes: windowBytes }), "critical");
});

// ── X08 ────────────────────────────────────────────────────────────────────
await test("X08", '"critical" above windowBytes (overflow proxy, 200%)', () => {
  const { windowBytes } = DEFAULT_CONTEXT_THRESHOLDS;
  assert.equal(estimatePressure({ accumulatedBytes: windowBytes * 2 }), "critical");
});

// ── X09 ────────────────────────────────────────────────────────────────────
await test("X09", "estimatePressure: throws on negative accumulatedBytes", () => {
  assert.throws(
    () => estimatePressure({ accumulatedBytes: -1 }),
    /accumulatedBytes must be a non-negative number/
  );
});

// ── X10 ────────────────────────────────────────────────────────────────────
await test("X10", "custom thresholds for a large 1M-window model", () => {
  const thresholds = makeThresholds({ contextTokens: 1_000_000 });
  // 50% of 3MB proxy window → normal
  const bytes50 = Math.round(thresholds.windowBytes * 0.50);
  assert.equal(estimatePressure({ accumulatedBytes: bytes50, thresholds }), "normal");
  // 75% → elevated
  const bytes75 = Math.round(thresholds.windowBytes * 0.75);
  assert.equal(estimatePressure({ accumulatedBytes: bytes75, thresholds }), "elevated");
  // 92% → critical
  const bytes92 = Math.round(thresholds.windowBytes * 0.92);
  assert.equal(estimatePressure({ accumulatedBytes: bytes92, thresholds }), "critical");
});

// ── X11 ────────────────────────────────────────────────────────────────────
await test("X11", "makeThresholds: correct windowBytes for 1M-token model (3 bytes/token)", () => {
  const t = makeThresholds({ contextTokens: 1_000_000, bytesPerToken: 3 });
  assert.equal(t.windowBytes, 3_000_000);
  assert.equal(t.elevatedFraction, 0.70);
  assert.equal(t.criticalFraction, 0.90);
});

// ── X12 ────────────────────────────────────────────────────────────────────
await test("X12", "makeThresholds: throws on non-positive contextTokens", () => {
  assert.throws(
    () => makeThresholds({ contextTokens: 0 }),
    /contextTokens must be a positive number/
  );
  assert.throws(
    () => makeThresholds({ contextTokens: -1000 }),
    /contextTokens must be a positive number/
  );
});

// ── X13 ────────────────────────────────────────────────────────────────────
await test("X13", "makeThresholds: throws when criticalFraction <= elevatedFraction", () => {
  assert.throws(
    () => makeThresholds({ contextTokens: 200_000, elevatedFraction: 0.80, criticalFraction: 0.75 }),
    /criticalFraction must be in \(elevatedFraction, 1\)/
  );
  // equal fractions also rejected
  assert.throws(
    () => makeThresholds({ contextTokens: 200_000, elevatedFraction: 0.80, criticalFraction: 0.80 }),
    /criticalFraction must be in \(elevatedFraction, 1\)/
  );
});

// ---------------------------------------------------------------------------
// Tests: CTX-02 decision function
// ---------------------------------------------------------------------------

process.stdout.write("\nCTX-02: decision function\n");

// ── X14 ────────────────────────────────────────────────────────────────────
await test("X14", '"normal" → "continue"', () => {
  assert.equal(pressureDecision("normal"), "continue");
});

// ── X15 ────────────────────────────────────────────────────────────────────
await test("X15", '"elevated" → "compact"', () => {
  assert.equal(pressureDecision("elevated"), "compact");
});

// ── X16 ────────────────────────────────────────────────────────────────────
await test("X16", '"critical" → "clear+relaunch"', () => {
  assert.equal(pressureDecision("critical"), "clear+relaunch");
});

// ── X17 ────────────────────────────────────────────────────────────────────
await test("X17", "pressureDecision: throws on unknown level", () => {
  assert.throws(
    () => pressureDecision("exploded"),
    /unknown pressure level "exploded"/
  );
});

// ---------------------------------------------------------------------------
// Tests: CTX-01 pointers-not-blobs handoff
// ---------------------------------------------------------------------------

process.stdout.write("\nCTX-01: pointers-not-blobs handoff\n");

// ── X18 ────────────────────────────────────────────────────────────────────
await test("X18", "writeHandoffManifest: creates JSON file with pointers (not blobs)", () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "handoff.json");
    const pointers = {
      control:      "/fake/runs/r1/control/agent-1.json",
      plan:         "/fake/runs/r1/plan.md",
      requirements: "/fake/.planning/REQUIREMENTS.md",
    };
    writeHandoffManifest(manifestPath, pointers, { agent_id: "agent-1", run_id: "r1" });
    assert.ok(existsSync(manifestPath), "manifest file should exist");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(raw.pointers, pointers);
    assert.equal(raw.schema_version, 1);
    assert.ok(raw.written_at, "should have a written_at timestamp");
    assert.equal(raw.meta.agent_id, "agent-1");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X19 ────────────────────────────────────────────────────────────────────
await test("X19", "writeHandoffManifest: atomic write (no tmp file left behind)", () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "handoff.json");
    writeHandoffManifest(manifestPath, { control: "/fake/control.json" });
    assert.ok(!existsSync(manifestPath + ".tmp"), "tmp file must not exist after atomic write");
    assert.ok(existsSync(manifestPath), "final file should exist");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X20 ────────────────────────────────────────────────────────────────────
await test("X20", "readHandoffManifest: round-trips the written manifest", () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "handoff.json");
    const pointers = {
      control: "/fake/runs/r1/control/agent-2.json",
      inbox:   "/fake/runs/r1/control/agent-2.inbox.md",
    };
    const meta = { agent_id: "agent-2", run_id: "bgsd-0001-my-run" };
    writeHandoffManifest(manifestPath, pointers, meta);
    const read = readHandoffManifest(manifestPath);
    assert.deepEqual(read.pointers, pointers);
    assert.deepEqual(read.meta, meta);
    assert.equal(read.schema_version, 1);
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X21 ────────────────────────────────────────────────────────────────────
await test("X21", "readHandoffManifest: pointer values are short file paths, not blobs", () => {
  // Core CTX-01 assertion: pointer values must be short path strings, never multi-KB blobs.
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "handoff.json");
    const pointers = {
      control:      "/very/long/but/still/a/path/agent-1.json",
      plan:         "/another/long/path/plan-unit-1.md",
      requirements: "/.planning/REQUIREMENTS.md",
    };
    writeHandoffManifest(manifestPath, pointers);
    const read = readHandoffManifest(manifestPath);
    for (const [key, val] of Object.entries(read.pointers)) {
      assert.ok(
        typeof val === "string" && val.length <= 512,
        `pointer "${key}" must be a short file-path string, got length ${val.length}`
      );
      // Must not contain newlines (inlined file content would have them)
      assert.ok(!val.includes("\n"), `pointer "${key}" must not contain newlines (not a blob)`);
    }
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X22 ────────────────────────────────────────────────────────────────────
await test("X22", "readHandoffManifest: throws on missing file", () => {
  assert.throws(
    () => readHandoffManifest("/tmp/nonexistent-bgsd-manifest-xyz-99.json"),
    /handoff manifest not found/
  );
});

// ── X23 ────────────────────────────────────────────────────────────────────
await test("X23", "readHandoffManifest: throws on invalid JSON", () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "bad.json");
    writeFileSync(manifestPath, "{ not: valid json }", "utf8");
    assert.throws(
      () => readHandoffManifest(manifestPath),
      /handoff manifest is not valid JSON/
    );
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X24 ────────────────────────────────────────────────────────────────────
await test("X24", 'readHandoffManifest: throws when "pointers" field is missing', () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "noptrs.json");
    writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, meta: {} }), "utf8");
    assert.throws(
      () => readHandoffManifest(manifestPath),
      /missing "pointers" object/
    );
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X25 ────────────────────────────────────────────────────────────────────
await test("X25", "writeHandoffManifest: throws when a pointer value is not a string", () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "handoff.json");
    assert.throws(
      () => writeHandoffManifest(manifestPath, { control: 42 }),
      /pointer "control" must be a string/
    );
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X26 ────────────────────────────────────────────────────────────────────
await test("X26", "writeHandoffManifest: creates parent directory if it does not exist", () => {
  const dir = makeTmpDir();
  try {
    const manifestPath = join(dir, "nested", "deep", "handoff.json");
    writeHandoffManifest(manifestPath, { control: "/fake/control.json" });
    assert.ok(existsSync(manifestPath), "manifest should be created in nested dir");
  } finally {
    cleanTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Tests: CTX-03 shared research / prompt cache
// ---------------------------------------------------------------------------

process.stdout.write("\nCTX-03: shared research / prompt cache\n");

// ── X27 ────────────────────────────────────────────────────────────────────
await test("X27", "cacheKey: same key always produces the same SHA-256 hash", () => {
  const key = "What version of Node.js does this project require?";
  const h1 = cacheKey(key);
  const h2 = cacheKey(key);
  assert.equal(h1, h2, "same key must always produce the same hash");
  assert.equal(h1.length, 64, "SHA-256 hex digest must be 64 chars");
  assert.match(h1, /^[0-9a-f]{64}$/, "hash must be lowercase hex");
});

// ── X28 ────────────────────────────────────────────────────────────────────
await test("X28", "cacheKey: different keys produce different hashes", () => {
  const h1 = cacheKey("key one");
  const h2 = cacheKey("key two");
  assert.notEqual(h1, h2, "different keys must produce different hashes");
});

// ── X29 ────────────────────────────────────────────────────────────────────
await test("X29", "cacheKey: throws on empty or whitespace-only string", () => {
  assert.throws(() => cacheKey(""),    /key must be a non-empty string/);
  assert.throws(() => cacheKey("   "), /key must be a non-empty string/);
});

// ── X30 ────────────────────────────────────────────────────────────────────
await test("X30", "cacheHas: returns false for a key not yet cached", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    assert.equal(cacheHas(cacheDir, "research: does PostgreSQL support JSONB?"), false);
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X31 ────────────────────────────────────────────────────────────────────
await test("X31", "cachePut: writes a new entry and returns written=true", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const key = "What test framework does bgsd use?";
    const result = { answer: "node:assert (no external deps)" };
    const { written, hash, entryPath } = cachePut(cacheDir, key, result);
    assert.equal(written, true, "first put should return written=true");
    assert.equal(hash.length, 64, "hash should be a 64-char hex string");
    assert.ok(existsSync(entryPath), "cache entry file should exist");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X32 ────────────────────────────────────────────────────────────────────
await test("X32", "cacheGet: returns the entry on a cache hit", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const key = "How many phases are in bgsd v2?";
    const result = { answer: "9 phases" };
    cachePut(cacheDir, key, result);
    const entry = cacheGet(cacheDir, key);
    assert.ok(entry !== null, "cacheGet must return an entry on a hit");
    assert.deepEqual(entry.result, result);
    assert.equal(entry.key, key);
    assert.equal(entry.hash, cacheKey(key));
    assert.ok(entry.cached_at, "entry should have cached_at timestamp");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X33 ────────────────────────────────────────────────────────────────────
await test("X33", "cacheHas: returns true after cachePut", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const key = "Is bgsd additive over GSD?";
    assert.equal(cacheHas(cacheDir, key), false, "should be false before put");
    cachePut(cacheDir, key, { answer: "yes — zero edits to vendored GSD (NFR-03)" });
    assert.equal(cacheHas(cacheDir, key), true, "should be true after put");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X34 ────────────────────────────────────────────────────────────────────
await test("X34", "cachePut: first-writer-wins — second put returns written=false", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const key = "What is the Conductor context guarantee?";
    const r1 = cachePut(cacheDir, key, { answer: "first result" });
    const r2 = cachePut(cacheDir, key, { answer: "second result — should be ignored" });
    assert.equal(r1.written, true,  "first put: written=true");
    assert.equal(r2.written, false, "second put: written=false (first-writer-wins)");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X35 ────────────────────────────────────────────────────────────────────
await test("X35", "cacheGet: second put does NOT overwrite first result (dedup guarantee)", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const key = "dedup test key";
    cachePut(cacheDir, key, { answer: "original answer" });
    cachePut(cacheDir, key, { answer: "should not overwrite" });
    const entry = cacheGet(cacheDir, key);
    assert.equal(entry.result.answer, "original answer", "cacheGet must return the FIRST result");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X36 ────────────────────────────────────────────────────────────────────
await test("X36", "cacheGet: returns null on a cache miss", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const result = cacheGet(cacheDir, "this key was never cached");
    assert.equal(result, null, "cacheGet should return null on a miss");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X37 ────────────────────────────────────────────────────────────────────
await test("X37", "cachePut: atomic write — tmp file not left behind after put", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "cache");
    const key = "atomic write test";
    const { entryPath } = cachePut(cacheDir, key, { answer: "atomic" });
    assert.ok(!existsSync(entryPath + ".tmp"), "tmp file must not exist after atomic write");
    assert.ok(existsSync(entryPath), "final entry file must exist");
  } finally {
    cleanTmpDir(dir);
  }
});

// ── X38 ────────────────────────────────────────────────────────────────────
await test("X38", "cachePut: creates cache directory if it does not exist", () => {
  const dir = makeTmpDir();
  try {
    const cacheDir = join(dir, "deeply", "nested", "cache");
    assert.ok(!existsSync(cacheDir), "cache dir should not exist before first put");
    cachePut(cacheDir, "some research key", { answer: "created" });
    assert.ok(existsSync(cacheDir), "cache dir should be created by cachePut");
  } finally {
    cleanTmpDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Tests: Live boundary guard (CTX-02)
// ---------------------------------------------------------------------------

process.stdout.write("\nLive boundary guard (CTX-02)\n");

// ── X39 ────────────────────────────────────────────────────────────────────
await test("X39", "isLiveFlagSet: returns false in test context (--live not in argv)", () => {
  // In this test run, --live is NOT in process.argv
  assert.equal(isLiveFlagSet(), false);
});

// ── X40 ────────────────────────────────────────────────────────────────────
await test("X40", "requireLiveFlag: throws without --live", () => {
  assert.throws(
    () => requireLiveFlag(),
    /HUMAN-GATED: context\.mjs live boundary refused to run/
  );
});

// ── X41 ────────────────────────────────────────────────────────────────────
await test("X41", "liveCompact: throws without --live", async () => {
  await assert.rejects(
    () => liveCompact({ agentId: "agent-1", controlPath: "/fake/control.json" }),
    /HUMAN-GATED: context\.mjs live boundary refused to run/
  );
});

// ── X42 ────────────────────────────────────────────────────────────────────
await test("X42", "liveRelaunch: throws without --live", async () => {
  await assert.rejects(
    () => liveRelaunch({
      agentId:      "agent-1",
      manifestPath: "/fake/manifest.json",
      worktreePath: "/fake/wt",
    }),
    /HUMAN-GATED: context\.mjs live boundary refused to run/
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${"─".repeat(60)}\n`);
process.stdout.write(`Tests: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}\n`);

if (failures.length > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const f of failures) {
    process.stdout.write(`  ${f.id} — ${f.description}\n`);
    process.stdout.write(`    ${f.error.message}\n`);
  }
  process.stdout.write("\n");
}

process.exit(failed > 0 ? 1 : 0);
