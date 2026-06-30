#!/usr/bin/env node
/**
 * test-intake.mjs — Unit tests for intake.mjs (Phase E1: INTAKE-01..04)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-intake.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully mocked:
 *   - No real model / Haiku calls (expandFn is always a deterministic mock).
 *   - Filesystem I/O uses OS temp directories, cleaned up after each test.
 *   - Zero real network I/O.
 *
 * Test groups:
 *
 * --- INTAKE-01: generateIntakeId ---
 *   I01 — generateIntakeId: produces "intake-<slug>-<4hex>" format
 *   I02 — generateIntakeId: slugifies special chars and limits length
 *   I03 — generateIntakeId: empty string falls back to "intake-project-<hex>"
 *
 * --- INTAKE-04: validateSpec ---
 *   I04 — validateSpec: valid spec with all required sections passes
 *   I05 — validateSpec: empty string fails validation
 *   I06 — validateSpec: missing "## Goals" fails
 *   I07 — validateSpec: missing "## Open Questions" fails
 *   I08 — validateSpec: empty "## Open Questions" fails (NFR-06 degenerate check)
 *   I09 — validateSpec: non-empty "## Open Questions" among all required sections passes
 *
 * --- INTAKE-02: chunkSpec + buildIndex ---
 *   I10 — chunkSpec: single section spec produces one chunk
 *   I11 — chunkSpec: multi-section spec produces correct chunk per ## heading
 *   I12 — chunkSpec: chunk ids are stable "<intake-id>/<heading-slug>"
 *   I13 — chunkSpec: startLine / endLine are 1-indexed and correct
 *   I14 — chunkSpec: summary is first sentence of body text
 *   I15 — buildIndex: produces correct index shape (intake_id, generated_at, chunks)
 *   I16 — buildIndex: index chunks omit full content (NFR-09 pointer-not-blob)
 *   I17 — buildIndex: all chunk fields present (id, heading, anchor, startLine, endLine, summary)
 *
 * --- INTAKE-03: writeGsdFeed ---
 *   I18 — writeGsdFeed: creates gsd-feed/INTENT.md with the spec content
 *   I19 — writeGsdFeed: creates gsd-feed/seam.json with correct seam descriptor
 *   I20 — writeGsdFeed: seam.json references the correct at_reference path
 *
 * --- INTAKE-01..04: generateIntentSpec (full integration, mocked expandFn) ---
 *   I21 — generateIntentSpec: throws if nlInput is empty
 *   I22 — generateIntentSpec: throws if expandFn is not a function
 *   I23 — generateIntentSpec: valid flow creates all artifacts under .bgsd/intake/<id>/
 *   I24 — generateIntentSpec: SPEC.md content matches expandFn output
 *   I25 — generateIntentSpec: index.json is valid JSON with correct chunk count
 *   I26 — generateIntentSpec: provenance.json records raw_input, model, generated_at
 *   I27 — generateIntentSpec: gsd-feed/INTENT.md and seam.json are created
 *   I28 — generateIntentSpec: throws on degenerate spec (empty Open Questions — NFR-06)
 *   I29 — generateIntentSpec: chunks are returned and match index chunk count
 *   I30 — generateIntentSpec: validation.valid is true for good spec
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  generateIntakeId,
  validateSpec,
  chunkSpec,
  buildIndex,
  writeGsdFeed,
  generateIntentSpec,
} from "./intake.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors the style used in test-run.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // async test — we handle this synchronously by wrapping in a promise
      return result
        .then(() => {
          passed++;
          process.stdout.write(`  PASS  ${name}\n`);
        })
        .catch((err) => {
          failed++;
          failures.push({ name, err });
          process.stdout.write(`  FAIL  ${name}: ${err.message}\n`);
        });
    }
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}: ${err.message}\n`);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_SPEC = `# Intent Spec

## Goals

Build a Pomodoro timer application that helps users manage their focus sessions.

## Scope

MVP scope: core timer, session history, notifications. No social features.

## Surfaces

Web app (React) and a CLI companion tool.

## Constraints

Node 18+, no external runtime deps, WASM-free.

## Glossary

**Pomodoro:** A 25-minute focused work session followed by a short break.

## Open Questions

- What is the primary user persona (developer vs. general knowledge worker)?
- Should the timer be configurable per session or fixed at 25 min?
- Offline-first or online-first persistence model?
`;

const DEGENERATE_SPEC_EMPTY_OQ = `## Goals

Build something.

## Scope

All the things.

## Surfaces

Web only.

## Constraints

None.

## Open Questions

`;

const MISSING_GOALS_SPEC = `## Scope

All the things.

## Surfaces

Web only.

## Constraints

None.

## Open Questions

- Some question?
`;

// Deterministic mock expandFn — no real model call
const mockExpandFn = async (_nlInput) => GOOD_SPEC;

// ---------------------------------------------------------------------------
// Tests: generateIntakeId (INTAKE-01)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- INTAKE-01: generateIntakeId ---\n");

await test("I01 — generateIntakeId: produces intake-<slug>-<4hex> format", () => {
  const id = generateIntakeId("Build a Pomodoro app");
  assert.match(id, /^intake-[a-z0-9-]+-[0-9a-f]{4}$/, "id must match pattern");
});

await test("I02 — generateIntakeId: slugifies special chars and limits length", () => {
  const id = generateIntakeId("Build an AI-Powered $$$$ Super-App!!! (v2)");
  assert.match(id, /^intake-[a-z0-9-]+-[0-9a-f]{4}$/, "id must match pattern");
  // slug segment should not contain special chars
  const slug = id.replace(/^intake-/, "").replace(/-[0-9a-f]{4}$/, "");
  assert.ok(!/[^a-z0-9-]/.test(slug), "slug must only contain a-z 0-9 -");
});

await test("I03 — generateIntakeId: empty string falls back to intake-project-<hex>", () => {
  const id = generateIntakeId("");
  assert.match(id, /^intake-project-[0-9a-f]{4}$/, "empty input should produce intake-project-<hex>");
});

// ---------------------------------------------------------------------------
// Tests: validateSpec (INTAKE-04)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- INTAKE-04: validateSpec ---\n");

await test("I04 — validateSpec: valid spec with all required sections passes", () => {
  const result = validateSpec(GOOD_SPEC);
  assert.equal(result.valid, true, "good spec must be valid");
  assert.equal(result.reason, undefined, "no reason for a valid spec");
});

await test("I05 — validateSpec: empty string fails validation", () => {
  const result = validateSpec("");
  assert.equal(result.valid, false);
  assert.ok(result.reason, "reason must be set");
});

await test("I06 — validateSpec: missing ## Goals fails", () => {
  const result = validateSpec(MISSING_GOALS_SPEC);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("Goals"), `reason should mention Goals, got: ${result.reason}`);
});

await test("I07 — validateSpec: missing ## Open Questions fails", () => {
  const noOq = GOOD_SPEC.replace("## Open Questions", "## Other");
  const result = validateSpec(noOq);
  assert.equal(result.valid, false);
  assert.ok(result.reason.toLowerCase().includes("open questions"), `reason should mention Open Questions`);
});

await test("I08 — validateSpec: empty ## Open Questions fails (NFR-06 degenerate check)", () => {
  const result = validateSpec(DEGENERATE_SPEC_EMPTY_OQ);
  assert.equal(result.valid, false);
  assert.ok(result.reason.toLowerCase().includes("empty") || result.reason.toLowerCase().includes("degenerate"),
    `reason should mention empty/degenerate, got: ${result.reason}`);
});

await test("I09 — validateSpec: non-empty Open Questions among all required sections passes", () => {
  const result = validateSpec(GOOD_SPEC);
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// Tests: chunkSpec + buildIndex (INTAKE-02)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- INTAKE-02: chunkSpec + buildIndex ---\n");

await test("I10 — chunkSpec: single section spec produces one chunk", () => {
  const spec = "## Goals\n\nBuild something cool.\n";
  const intakeId = "intake-test-0001";
  const { chunks } = chunkSpec(spec, intakeId);
  assert.equal(chunks.length, 1, "one ## heading → one chunk");
  assert.equal(chunks[0].heading, "Goals");
});

await test("I11 — chunkSpec: multi-section spec produces correct chunk per ## heading", () => {
  const { chunks } = chunkSpec(GOOD_SPEC, "intake-test-0002");
  // GOOD_SPEC has: Goals, Scope, Surfaces, Constraints, Glossary, Open Questions
  assert.ok(chunks.length >= 5, `should have at least 5 chunks, got ${chunks.length}`);
  const headings = chunks.map((c) => c.heading);
  assert.ok(headings.includes("Goals"), "should include Goals");
  assert.ok(headings.includes("Open Questions"), "should include Open Questions");
});

await test("I12 — chunkSpec: chunk ids are stable <intake-id>/<heading-slug>", () => {
  const intakeId = "intake-test-0003";
  const { chunks } = chunkSpec(GOOD_SPEC, intakeId);
  for (const chunk of chunks) {
    assert.ok(
      chunk.id.startsWith(`${intakeId}/`),
      `chunk.id "${chunk.id}" must start with "${intakeId}/"`
    );
    assert.match(chunk.id, /^intake-test-0003\/[a-z0-9-]+$/, "id must be slug-safe");
  }
});

await test("I13 — chunkSpec: startLine / endLine are 1-indexed and correct", () => {
  const spec = "## Goals\n\nLine 3.\n\n## Scope\n\nLine 6.\n";
  //            Line 1         2    3   4    5          6    7
  const { chunks } = chunkSpec(spec, "intake-test-0004");
  assert.ok(chunks.length >= 2, "should have Goals and Scope chunks");
  assert.equal(chunks[0].startLine, 1, "Goals starts at line 1");
  assert.equal(chunks[1].startLine, 5, "Scope starts at line 5");
  // Goals endLine should be the line before Scope's heading
  assert.ok(chunks[0].endLine < chunks[1].startLine, "Goals ends before Scope starts");
});

await test("I14 — chunkSpec: summary is first sentence of body text", () => {
  const spec = "## Goals\n\nBuild a timer. It should beep. And buzz.\n";
  const { chunks } = chunkSpec(spec, "intake-test-0005");
  assert.ok(chunks[0].summary.length > 0, "summary should not be empty");
  // Should be just the first sentence
  assert.ok(chunks[0].summary.includes("Build a timer"), `summary should start with first sentence, got: "${chunks[0].summary}"`);
});

await test("I15 — buildIndex: produces correct index shape (intake_id, generated_at, chunks)", () => {
  const intakeId = "intake-test-0006";
  const { chunks } = chunkSpec(GOOD_SPEC, intakeId);
  const ts = new Date().toISOString();
  const index = buildIndex(chunks, intakeId, ts);
  assert.equal(index.intake_id, intakeId);
  assert.equal(index.generated_at, ts);
  assert.ok(Array.isArray(index.chunks), "index.chunks must be an array");
  assert.equal(index.chunks.length, chunks.length, "index chunk count must match");
});

await test("I16 — buildIndex: index chunks omit full content (NFR-09 pointer-not-blob)", () => {
  const intakeId = "intake-test-0007";
  const { chunks } = chunkSpec(GOOD_SPEC, intakeId);
  const index = buildIndex(chunks, intakeId, new Date().toISOString());
  for (const ic of index.chunks) {
    assert.equal(ic.content, undefined, "index chunks must NOT include content field (NFR-09)");
  }
});

await test("I17 — buildIndex: all chunk fields present (id, heading, anchor, startLine, endLine, summary)", () => {
  const intakeId = "intake-test-0008";
  const { chunks } = chunkSpec(GOOD_SPEC, intakeId);
  const index = buildIndex(chunks, intakeId, new Date().toISOString());
  for (const ic of index.chunks) {
    assert.ok(ic.id,        "chunk must have id");
    assert.ok(ic.heading,   "chunk must have heading");
    assert.ok(ic.anchor,    "chunk must have anchor");
    assert.ok(typeof ic.startLine === "number", "chunk must have numeric startLine");
    assert.ok(typeof ic.endLine === "number",   "chunk must have numeric endLine");
    assert.ok(typeof ic.summary === "string",   "chunk must have string summary");
  }
});

// ---------------------------------------------------------------------------
// Tests: writeGsdFeed (INTAKE-03)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- INTAKE-03: writeGsdFeed ---\n");

let tmpGsdFeedDir;

await test("I18 — writeGsdFeed: creates gsd-feed/INTENT.md with the spec content", () => {
  tmpGsdFeedDir = mkdtempSync(join(tmpdir(), "bgsd-test-feed-"));
  const feedDir = join(tmpGsdFeedDir, "gsd-feed");
  const intentPath = join(feedDir, "INTENT.md");
  writeGsdFeed(feedDir, GOOD_SPEC, "intake-test-0009", intentPath);
  const written = readFileSync(join(feedDir, "INTENT.md"), "utf8");
  assert.equal(written, GOOD_SPEC, "INTENT.md must contain the spec verbatim");
});

await test("I19 — writeGsdFeed: creates gsd-feed/seam.json with correct seam descriptor", () => {
  const feedDir = join(tmpGsdFeedDir, "gsd-feed");
  const seamPath = join(feedDir, "seam.json");
  assert.ok(existsSync(seamPath), "seam.json must exist");
  const seam = JSON.parse(readFileSync(seamPath, "utf8"));
  assert.equal(seam.seam, "gsd-new-project --auto", "seam must reference gsd-new-project --auto");
  assert.ok(seam.description.includes("NFR-03/04"), "seam must document NFR constraint");
});

await test("I20 — writeGsdFeed: seam.json references the correct at_reference path", () => {
  const feedDir = join(tmpGsdFeedDir, "gsd-feed");
  const seamPath = join(feedDir, "seam.json");
  const seam = JSON.parse(readFileSync(seamPath, "utf8"));
  assert.ok(seam.at_reference.endsWith("INTENT.md"), "at_reference must point to INTENT.md");
  assert.ok(seam.at_reference.startsWith("@"), "at_reference must start with @");
});

// Cleanup
rmSync(tmpGsdFeedDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Tests: generateIntentSpec (INTAKE-01..04 integration, mocked expandFn)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- INTAKE-01..04: generateIntentSpec (full integration, mocked expandFn) ---\n");

let tmpBgsdDir;

await test("I21 — generateIntentSpec: throws if nlInput is empty", async () => {
  await assert.rejects(
    () => generateIntentSpec({ nlInput: "", expandFn: mockExpandFn }),
    /nlInput must be a non-empty string/
  );
});

await test("I22 — generateIntentSpec: throws if expandFn is not a function", async () => {
  await assert.rejects(
    () => generateIntentSpec({ nlInput: "Build something", expandFn: null }),
    /expandFn must be a function/
  );
});

await test("I23 — generateIntentSpec: valid flow creates all artifacts under .bgsd/intake/<id>/", async () => {
  tmpBgsdDir = mkdtempSync(join(tmpdir(), "bgsd-test-intake-"));
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  assert.ok(existsSync(result.intakeDir), "intakeDir must exist");
  assert.ok(existsSync(result.specPath), "SPEC.md must exist");
  assert.ok(existsSync(result.indexPath), "index.json must exist");
  assert.ok(existsSync(result.provenancePath), "provenance.json must exist");
  assert.ok(existsSync(join(result.feedDir, "INTENT.md")), "gsd-feed/INTENT.md must exist");
  assert.ok(existsSync(join(result.feedDir, "seam.json")), "gsd-feed/seam.json must exist");
});

await test("I24 — generateIntentSpec: SPEC.md content matches expandFn output", async () => {
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  const written = readFileSync(result.specPath, "utf8");
  assert.equal(written, GOOD_SPEC, "SPEC.md must match expandFn output exactly");
});

await test("I25 — generateIntentSpec: index.json is valid JSON with correct chunk count", async () => {
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  const indexRaw = readFileSync(result.indexPath, "utf8");
  const index = JSON.parse(indexRaw);
  assert.equal(Array.isArray(index.chunks), true, "index.chunks must be an array");
  assert.equal(index.chunks.length, result.chunks.length, "index chunk count must match result.chunks length");
  assert.ok(index.chunks.length > 0, "index must have at least one chunk");
});

await test("I26 — generateIntentSpec: provenance.json records raw_input, model, generated_at", async () => {
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  const prov = JSON.parse(readFileSync(result.provenancePath, "utf8"));
  assert.equal(prov.raw_input, "Build a Pomodoro timer app");
  assert.equal(prov.model, "haiku", "provenance must record haiku as the model");
  assert.ok(prov.generated_at, "generated_at must be set");
  assert.ok(prov.intake_id, "intake_id must be set");
});

await test("I27 — generateIntentSpec: gsd-feed/INTENT.md and seam.json are created", async () => {
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  const intentMd = readFileSync(join(result.feedDir, "INTENT.md"), "utf8");
  assert.equal(intentMd, GOOD_SPEC, "INTENT.md must match the spec");
  const seam = JSON.parse(readFileSync(join(result.feedDir, "seam.json"), "utf8"));
  assert.equal(seam.seam, "gsd-new-project --auto");
});

await test("I28 — generateIntentSpec: throws on degenerate spec (empty Open Questions — NFR-06)", async () => {
  const degenerateExpandFn = async () => DEGENERATE_SPEC_EMPTY_OQ;
  await assert.rejects(
    () => generateIntentSpec({
      nlInput: "Build something",
      expandFn: degenerateExpandFn,
      bgsdDir: tmpBgsdDir,
    }),
    /spec validation failed/
  );
});

await test("I29 — generateIntentSpec: chunks are returned and match index chunk count", async () => {
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  assert.ok(Array.isArray(result.chunks), "chunks must be an array");
  assert.ok(result.chunks.length > 0, "chunks must not be empty");
  assert.equal(result.chunks.length, result.index.chunks.length,
    "result.chunks length must match result.index.chunks length");
});

await test("I30 — generateIntentSpec: validation.valid is true for good spec", async () => {
  const result = await generateIntentSpec({
    nlInput: "Build a Pomodoro timer app",
    expandFn: mockExpandFn,
    bgsdDir: tmpBgsdDir,
  });
  assert.equal(result.validation.valid, true, "validation must pass for a well-formed spec");
});

// Cleanup temp dir
if (tmpBgsdDir) {
  rmSync(tmpBgsdDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${"=".repeat(60)}\n`);
process.stdout.write(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);

if (failures.length > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const f of failures) {
    process.stdout.write(`  FAIL  ${f.name}\n`);
    if (f.err?.stack) {
      process.stdout.write(`        ${f.err.stack.split("\n").slice(0, 3).join("\n        ")}\n`);
    }
  }
  process.exit(1);
}

process.stdout.write("All tests passed.\n");
process.exit(0);
