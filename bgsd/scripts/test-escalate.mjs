#!/usr/bin/env node
/**
 * test-escalate.mjs — Unit tests for escalate.mjs (Phase E5: ESCALATE-01..04)
 *
 * No external framework.  Uses node:assert.
 * Run with: node bgsd/scripts/test-escalate.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully deterministic:
 *   - No real model / API calls.
 *   - Filesystem I/O uses OS temp directories, cleaned up after tests.
 *   - promptFn is always injected (mocked).
 *
 * Test groups:
 *
 * --- ESCALATE-01 (confidence-gated routing) ---
 *   E01 — buildEscalationBatch: escalations consolidate into ONE batch
 *   E02 — buildEscalationBatch: every item has ≥2 options + freeText id:"other" (NFR-10)
 *   E03 — buildEscalationBatch: single item produces a valid selector
 *   E04 — buildEscalationBatch: empty escalations array returns empty batch
 *   E05 — buildEscalationBatch: throws on missing question string
 *   E06 — buildEscalationBatch: throws on non-array input
 *   E07 — un-answered escalation stays open — no fabricated answer (NFR-06)
 *
 * --- ESCALATE-02 (consolidated selector prompt) ---
 *   E08 — N escalations deduplicate to fewer batch items when same gray-area
 *   E09 — dedup: source_worktrees accumulates all contributing agent ids
 *   E10 — dedup: distinct questions produce distinct batch items (no false merge)
 *   E11 — assertBatchItemInvariant throws when options < 2
 *   E12 — assertBatchItemInvariant throws when options > 4
 *   E13 — assertBatchItemInvariant throws when freeText.id !== "other"
 *   E14 — assertBatchItemInvariant passes for a valid item
 *   E15 — runEscalation: answered items collected correctly
 *   E16 — runEscalation: throws when promptFn is not a function
 *   E17 — runEscalation: throws when batch is not an array
 *   E18 — options come from oracle candidates when provided
 *   E19 — options synthesised from domain patterns when no candidates
 *
 * --- ESCALATE-03 (oracle enrichment / feedback loop) ---
 *   E20 — enrichOracleFromAnswers: answered item appended as new decision entry
 *   E21 — enrichOracleFromAnswers: new entry source is "escalation"
 *   E22 — enrichOracleFromAnswers: un-answered item NOT written (no fabrication, NFR-06)
 *   E23 — enrichOracleFromAnswers: enriched record re-sealed (sealed_at updated)
 *   E24 — enrichOracleFromAnswers: decisions.json written atomically to intakeDir
 *   E25 — feedback loop: after enrichment, same question auto-answers via oracle
 *   E26 — enrichOracleFromAnswers: throws on invalid answers input
 *   E27 — enrichOracleFromAnswers: throws on invalid record input
 *
 * --- ESCALATE-04 (rarity telemetry) ---
 *   E28 — createEscalationCounter: starts at zero
 *   E29 — incrementCounter: auto_answered increments correctly
 *   E30 — incrementCounter: escalated increments correctly
 *   E31 — incrementCounter: throws on invalid type
 *   E32 — renderEscalationTelemetry: format matches "auto-answered N / escalated M"
 *   E33 — renderEscalationTelemetry: includes threshold when provided
 *   E34 — renderEscalationTelemetry: shows pending selector count when provided
 *   E35 — renderEscalationTelemetry: throws on invalid counter
 *   E36 — counter increments correctly through a mixed auto-answer/escalate sequence
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  buildEscalationBatch,
  runEscalation,
  enrichOracleFromAnswers,
  buildEscalationItem,
  assertBatchItemInvariant,
  createEscalationCounter,
  incrementCounter,
  renderEscalationTelemetry,
} from "./escalate.mjs";

// Oracle is needed for E25 (the closed-loop test)
import {
  buildOracle,
  answerQuestion,
  PROFILE_WEIGHT,
} from "./oracle.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-oracle.mjs style)
// ---------------------------------------------------------------------------

let passed  = 0;
let failed  = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
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

const INTAKE_ID = "intake-test-escalate-0001";

/**
 * A representative oracle escalation result (what answerQuestion returns when
 * confidence < threshold).
 */
function makeEscalation(question, agentId = "agent-001", confidence = 0.25) {
  return {
    action:      "escalate",
    question,
    reason:      `confidence ${confidence.toFixed(3)} < threshold 0.60`,
    confidence,
    agentId,
    escalationId: `escalation-${Math.random().toString(36).slice(2, 8)}`,
    candidates:  [],
  };
}

/**
 * Write the three oracle source files into a temp intake dir.
 */
function makeOracleSourceFiles(intakeDir, decisions = []) {
  mkdirSync(intakeDir, { recursive: true });

  const record = {
    intake_id:  INTAKE_ID,
    sealed_at:  "2026-06-29T12:00:00.000Z",
    decisions,
  };
  writeFileSync(join(intakeDir, "decisions.json"), JSON.stringify(record, null, 2));

  const index = {
    intake_id:    INTAKE_ID,
    generated_at: "2026-06-29T12:00:00.000Z",
    chunks: [
      { id: `${INTAKE_ID}/scope`, heading: "Scope", anchor: "#scope", startLine: 1, endLine: 10,
        summary: "Scope of the project." },
    ],
  };
  writeFileSync(join(intakeDir, "index.json"), JSON.stringify(index, null, 2));

  const profile = {
    intake_id: INTAKE_ID,
    built_at:  "2026-06-29T12:00:00.000Z",
    authority: "preference",
    signals:   [],
  };
  writeFileSync(join(intakeDir, "profile.json"), JSON.stringify(profile, null, 2));
}

// Setup temp dir
let tmpRoot = mkdtempSync(join(tmpdir(), "bgsd-escalate-test-"));

// ---------------------------------------------------------------------------
// ESCALATE-01: confidence-gated routing + batch construction
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ESCALATE-01: Confidence-gated routing + batch construction ---\n");

await test("E01 — buildEscalationBatch: escalations consolidate into ONE batch", () => {
  const escalations = [
    makeEscalation("How tightly should the scope be bounded for the deliverable?", "agent-001"),
    makeEscalation("What is the primary deployment target for this project?",       "agent-002"),
    makeEscalation("Who is the primary user persona for this system?",              "agent-003"),
  ];
  const batch = buildEscalationBatch(escalations);
  // 3 distinct questions → 3 batch items (or fewer if dedup collapses any)
  assert.ok(batch.length > 0, "batch must be non-empty for non-empty escalations");
  assert.ok(batch.length <= escalations.length,
    "batch size must not exceed escalation count");
});

await test("E02 — buildEscalationBatch: every item has ≥2 options + freeText id:'other' (NFR-10)", () => {
  const escalations = [
    makeEscalation("How tightly should the scope be bounded for the deliverable?", "agent-001"),
    makeEscalation("What is the deployment target for this project?",              "agent-002"),
  ];
  const batch = buildEscalationBatch(escalations);
  for (const item of batch) {
    // This assertion must hold for EVERY item (NFR-10 hard requirement)
    assertBatchItemInvariant(item);
    assert.ok(item.options.length >= 2,
      `item "${item.id}" must have at least 2 options; got ${item.options.length}`);
    assert.ok(item.options.length <= 4,
      `item "${item.id}" must have at most 4 options; got ${item.options.length}`);
    assert.equal(item.freeText.id, "other",
      `item "${item.id}" freeText.id must be "other"`);
  }
});

await test("E03 — buildEscalationBatch: single item produces a valid selector", () => {
  const escalations = [makeEscalation("How tightly should scope be bounded?", "agent-001")];
  const batch = buildEscalationBatch(escalations);
  assert.equal(batch.length, 1, "single escalation must produce exactly 1 batch item");
  const item = batch[0];
  assertBatchItemInvariant(item);
  assert.ok(typeof item.question === "string" && item.question.length > 0,
    "item must have a non-empty question");
});

await test("E04 — buildEscalationBatch: empty escalations array returns empty batch", () => {
  const batch = buildEscalationBatch([]);
  assert.deepEqual(batch, [], "empty escalations must produce an empty batch");
});

await test("E05 — buildEscalationBatch: throws on missing question string", () => {
  const badEscalation = { action: "escalate", confidence: 0.3, reason: "no match" };
  assert.throws(
    () => buildEscalationBatch([badEscalation]),
    /non-empty question string/,
    "must throw when question is missing"
  );
});

await test("E06 — buildEscalationBatch: throws on non-array input", () => {
  assert.throws(
    () => buildEscalationBatch(null),
    /must be an array/,
    "must throw when escalations is null"
  );
  assert.throws(
    () => buildEscalationBatch("not-an-array"),
    /must be an array/,
    "must throw when escalations is a string"
  );
});

await test("E07 — un-answered escalation stays open — no fabricated answer (NFR-06)", async () => {
  const escalations = [makeEscalation("What is the deployment target?", "agent-001")];
  const batch       = buildEscalationBatch(escalations);

  // promptFn returns null → unanswered
  const { answers, answered, open } = await runEscalation({
    batch,
    promptFn: async () => null,
  });

  assert.equal(answered, 0, "no items should be answered when promptFn returns null");
  assert.equal(open,     batch.length, "all items must remain open");
  for (const [, answer] of answers) {
    assert.equal(answer, null, "un-answered item must have answer === null (no fabrication)");
  }
});

// ---------------------------------------------------------------------------
// ESCALATE-02: consolidated selector prompt + deduplication
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ESCALATE-02: Consolidated selector prompt + deduplication ---\n");

await test("E08 — N escalations deduplicate to fewer batch items when same gray-area", () => {
  // Same question from 3 different worktrees
  const SAME_Q = "How tightly should the scope be bounded for the first deliverable?";
  const escalations = [
    makeEscalation(SAME_Q, "agent-001"),
    makeEscalation(SAME_Q, "agent-002"),
    makeEscalation(SAME_Q, "agent-003"),
  ];
  const batch = buildEscalationBatch(escalations);
  // All three have the same dedup key → should collapse to 1 item
  assert.equal(batch.length, 1,
    "3 identical questions must deduplicate to exactly 1 batch item");
});

await test("E09 — dedup: source_worktrees accumulates all contributing agent ids", () => {
  const SAME_Q = "How tightly should the scope be bounded for the first deliverable?";
  const escalations = [
    makeEscalation(SAME_Q, "agent-001"),
    makeEscalation(SAME_Q, "agent-002"),
  ];
  const batch = buildEscalationBatch(escalations);
  assert.equal(batch.length, 1, "must deduplicate to 1 item");
  const item = batch[0];
  assert.ok(
    item.source_worktrees.includes("agent-001") &&
    item.source_worktrees.includes("agent-002"),
    "source_worktrees must include both agent ids after dedup"
  );
});

await test("E10 — dedup: distinct questions produce distinct batch items (no false merge)", () => {
  const escalations = [
    makeEscalation("How tightly should the scope be bounded for the deliverable?",  "agent-001"),
    makeEscalation("What is the primary deployment target for the project?",         "agent-002"),
    makeEscalation("Who is the primary user persona for this system?",               "agent-003"),
  ];
  const batch = buildEscalationBatch(escalations);
  // All 3 are genuinely distinct questions — must not be false-merged
  assert.equal(batch.length, 3,
    "3 genuinely distinct questions must produce 3 batch items (no false merge)");
});

await test("E11 — assertBatchItemInvariant throws when options < 2", () => {
  const item = {
    id: "esc-001", topic: "scope",
    question: "Q?",
    options: [{ id: "a", label: "A", description: "desc" }], // only 1 option
    freeText: { id: "other", label: "Type your own", placeholder: "..." },
  };
  assert.throws(
    () => assertBatchItemInvariant(item),
    /at least 2 options/,
    "must throw when options.length < 2"
  );
});

await test("E12 — assertBatchItemInvariant throws when options > 4", () => {
  const item = {
    id: "esc-001", topic: "scope",
    question: "Q?",
    options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `O${i}`, description: "" })),
    freeText: { id: "other", label: "Type your own", placeholder: "..." },
  };
  assert.throws(
    () => assertBatchItemInvariant(item),
    /at most 4 options/,
    "must throw when options.length > 4"
  );
});

await test("E13 — assertBatchItemInvariant throws when freeText.id !== 'other'", () => {
  const item = {
    id: "esc-001", topic: "scope",
    question: "Q?",
    options: [
      { id: "a", label: "A", description: "" },
      { id: "b", label: "B", description: "" },
    ],
    freeText: { id: "custom", label: "Custom", placeholder: "..." }, // wrong id
  };
  assert.throws(
    () => assertBatchItemInvariant(item),
    /freeText.*id.*"other"/i,
    "must throw when freeText.id is not 'other'"
  );
});

await test("E14 — assertBatchItemInvariant passes for a valid item", () => {
  const item = {
    id: "esc-001", topic: "scope",
    question: "How tightly should scope be bounded?",
    options: [
      { id: "thin-mvp",   label: "Thin MVP",   description: "One core user flow." },
      { id: "full-scope", label: "Full scope",  description: "All surfaces." },
    ],
    freeText: { id: "other", label: "Type your own", placeholder: "..." },
  };
  assert.doesNotThrow(
    () => assertBatchItemInvariant(item),
    "valid item must not throw"
  );
});

await test("E15 — runEscalation: answered items collected correctly", async () => {
  const escalations = [
    makeEscalation("How tightly should scope be bounded?",  "agent-001"),
    makeEscalation("What is the deployment target?",         "agent-002"),
  ];
  const batch = buildEscalationBatch(escalations);
  assert.equal(batch.length, 2, "expect 2 batch items");

  // promptFn: answer first item, leave second unanswered
  let callCount = 0;
  const { answers, answered, open } = await runEscalation({
    batch,
    promptFn: async (item) => {
      callCount++;
      if (callCount === 1) return "thin-mvp"; // first item answered
      return null;                              // second item unanswered
    },
  });

  assert.equal(callCount, 2, "promptFn must be called once per batch item");
  assert.equal(answered, 1, "one item should be answered");
  assert.equal(open,     1, "one item should remain open");

  // Find the answered one
  const answerValues = [...answers.values()];
  assert.ok(answerValues.includes("thin-mvp"), "answered value must be in the map");
  assert.ok(answerValues.includes(null),        "open item must have null in the map");
});

await test("E16 — runEscalation: throws when promptFn is not a function", async () => {
  const batch = buildEscalationBatch([makeEscalation("Q?", "agent-001")]);
  await assert.rejects(
    () => runEscalation({ batch, promptFn: "not-a-function" }),
    /promptFn must be injected/
  );
});

await test("E17 — runEscalation: throws when batch is not an array", async () => {
  await assert.rejects(
    () => runEscalation({ batch: null, promptFn: async () => "answer" }),
    /batch must be an array/
  );
});

await test("E18 — options come from oracle candidates when provided", () => {
  const escalation = {
    action:      "escalate",
    question:    "What architecture pattern should be used?",
    reason:      "confidence 0.25 < threshold 0.60",
    confidence:  0.25,
    agentId:     "agent-001",
    escalationId: "esc-001",
    candidates: [
      { answer: "Monolith",     source: "spec",     matchText: "architecture monolith" },
      { answer: "Microservices", source: "decision", matchText: "microservices pattern" },
    ],
  };
  const item = buildEscalationItem(escalation, 0);
  assertBatchItemInvariant(item);
  // The item's options should incorporate the oracle candidates
  const optionLabels = item.options.map((o) => o.label);
  // At least some options present (may include domain fallback too)
  assert.ok(optionLabels.length >= 2, "must have at least 2 options");
  // Check that candidate answers surface in options
  const hasMonolith     = item.options.some((o) => o.label.includes("Monolith")      || o.description.includes("Monolith"));
  const hasMicroservices= item.options.some((o) => o.label.includes("Microservices") || o.description.includes("Microservices"));
  assert.ok(hasMonolith || hasMicroservices,
    "at least one oracle candidate should appear in item options");
});

await test("E19 — options synthesised from domain patterns when no candidates", () => {
  // Scope question with no oracle candidates
  const escalation = makeEscalation(
    "How tightly should the scope be bounded for the first deliverable?",
    "agent-001"
  );
  escalation.candidates = []; // no candidates
  const item = buildEscalationItem(escalation, 0);
  assertBatchItemInvariant(item);
  // Should have domain-specific options (thin-mvp, full-scope, spike-first)
  const optionIds = item.options.map((o) => o.id);
  const hasScopeOption = optionIds.some((id) =>
    id === "thin-mvp" || id === "full-scope" || id === "spike-first"
  );
  assert.ok(hasScopeOption,
    "domain pattern match (scope question) should produce scope-specific options");
});

// ---------------------------------------------------------------------------
// ESCALATE-03: Oracle enrichment / feedback loop
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ESCALATE-03: Oracle enrichment / feedback loop ---\n");

await test("E20 — enrichOracleFromAnswers: answered item appended as new decision entry", () => {
  const record = {
    intake_id:  INTAKE_ID,
    sealed_at:  "2026-06-29T12:00:00.000Z",
    decisions:  [],
  };
  const batch = buildEscalationBatch([
    makeEscalation("How tightly should scope be bounded?", "agent-001"),
  ]);
  const answers = new Map([[batch[0].id, "thin-mvp"]]);

  const { enrichedCount } = enrichOracleFromAnswers(answers, record, batch);

  assert.equal(enrichedCount, 1, "one entry must be enriched");
  assert.equal(record.decisions.length, 1,
    "record must now have exactly 1 decision entry");
});

await test("E21 — enrichOracleFromAnswers: new entry source is 'escalation'", () => {
  const record = { intake_id: INTAKE_ID, sealed_at: "2026-06-29T12:00:00.000Z", decisions: [] };
  const batch  = buildEscalationBatch([makeEscalation("What is the deployment target?", "agent-001")]);
  const answers = new Map([[batch[0].id, "static-host"]]);

  enrichOracleFromAnswers(answers, record, batch);

  const entry = record.decisions[0];
  assert.equal(entry.source, "escalation",
    "enriched entry source must be 'escalation' (ESCALATE-03)");
  assert.equal(entry.answer, "static-host", "enriched entry answer must match");
});

await test("E22 — enrichOracleFromAnswers: un-answered item NOT written (no fabrication, NFR-06)", () => {
  const record = { intake_id: INTAKE_ID, sealed_at: "2026-06-29T12:00:00.000Z", decisions: [] };
  const batch  = buildEscalationBatch([makeEscalation("What is the deployment target?", "agent-001")]);
  const answers = new Map([[batch[0].id, null]]); // unanswered

  const { enrichedCount } = enrichOracleFromAnswers(answers, record, batch);

  assert.equal(enrichedCount, 0, "unanswered item must NOT be enriched (no fabrication)");
  assert.equal(record.decisions.length, 0,
    "record must remain empty — no fabricated decisions (NFR-06)");
});

await test("E23 — enrichOracleFromAnswers: enriched record re-sealed (sealed_at updated)", () => {
  const ORIGINAL_SEAL = "2026-06-29T12:00:00.000Z";
  const record = { intake_id: INTAKE_ID, sealed_at: ORIGINAL_SEAL, decisions: [] };
  const batch  = buildEscalationBatch([makeEscalation("What is the scope boundary?", "agent-001")]);
  const answers = new Map([[batch[0].id, "thin-mvp"]]);

  const OVERRIDE_SEAL = "2026-06-30T09:00:00.000Z";
  enrichOracleFromAnswers(answers, record, batch, { sealedAt: OVERRIDE_SEAL });

  assert.equal(record.sealed_at, OVERRIDE_SEAL,
    "sealed_at must be updated to the re-seal timestamp after enrichment");
  assert.notEqual(record.sealed_at, ORIGINAL_SEAL,
    "sealed_at must change from the original value");
});

await test("E24 — enrichOracleFromAnswers: decisions.json written atomically to intakeDir", () => {
  const intakeDir = join(tmpRoot, "intake-enrich-write-test");
  mkdirSync(intakeDir, { recursive: true });

  const record = { intake_id: INTAKE_ID, sealed_at: "2026-06-29T12:00:00.000Z", decisions: [] };
  const batch  = buildEscalationBatch([makeEscalation("What is the deployment target?", "agent-001")]);
  const answers = new Map([[batch[0].id, "static-host"]]);

  const writtenFiles = [];
  const mockWriter = (filePath, content) => {
    writtenFiles.push({ filePath, content });
  };

  enrichOracleFromAnswers(answers, record, batch, { intakeDir, writeFn: mockWriter });

  assert.equal(writtenFiles.length, 1, "exactly one file must be written");
  const { filePath, content } = writtenFiles[0];
  assert.ok(filePath.endsWith("decisions.json"),
    "written file must be decisions.json");
  const parsed = JSON.parse(content);
  assert.equal(parsed.decisions[0].source, "escalation",
    "written record must contain the enriched entry");
});

await test("E25 — feedback loop: after enrichment, same question auto-answers via oracle", () => {
  // This test demonstrates the closed feedback loop (ESCALATE-03 SC#3):
  // 1. Build an oracle with an empty decision record.
  // 2. A question escalates (below threshold).
  // 3. enrichOracleFromAnswers writes the human's answer back into decisions.json.
  // 4. The oracle now sees the enriched entry → auto-answers.

  const intakeDir = join(tmpRoot, "intake-loop-close");
  const bgsdDir   = join(tmpRoot, "bgsd-loop-close");

  // Step 1: write empty decision record (no entries)
  makeOracleSourceFiles(intakeDir, []);
  const oracleResult = buildOracle({ intakeId: INTAKE_ID, intakeDir, bgsdDir });
  const manifest     = oracleResult.manifest;

  // Step 2: answerQuestion → escalates because no entries exist
  const question  = "How tightly should scope be bounded for the deliverable?";
  const before    = answerQuestion(manifest, question, { threshold: 0.60 });
  assert.equal(before.action, "escalate",
    "question must escalate before enrichment (oracle has no relevant entries)");

  // Step 3: enrich with human's answer
  const record = JSON.parse(readFileSync(join(intakeDir, "decisions.json"), "utf8"));
  const batch  = buildEscalationBatch([{
    action:      "escalate",
    question,
    reason:      "insufficient_spec",
    confidence:  0,
    agentId:     "agent-001",
  }]);
  const answers = new Map([[batch[0].id, "thin-mvp"]]);

  enrichOracleFromAnswers(answers, record, batch, { intakeDir });

  // Step 4: re-build the oracle so it reads the updated decisions.json
  const freshOracle = buildOracle({ intakeId: INTAKE_ID, intakeDir, bgsdDir });
  const after       = answerQuestion(freshOracle.manifest, question, { threshold: 0.30 });

  // The enriched entry (source:"escalation") must push confidence above the low threshold
  assert.equal(after.action, "auto_answer",
    "after enrichment, the same question must auto-answer (loop closed, ESCALATE-03)");
  assert.equal(after.answer, "thin-mvp",
    "auto-answer must return the human's escalation answer");
});

await test("E26 — enrichOracleFromAnswers: throws on invalid answers input", () => {
  const record = { intake_id: INTAKE_ID, sealed_at: "2026-06-29T12:00:00.000Z", decisions: [] };
  assert.throws(
    () => enrichOracleFromAnswers(null, record, []),
    /answers must be a Map/,
    "must throw when answers is null"
  );
  assert.throws(
    () => enrichOracleFromAnswers({}, record, []),
    /answers must be a Map/,
    "must throw when answers is a plain object"
  );
});

await test("E27 — enrichOracleFromAnswers: throws on invalid record input", () => {
  const answers = new Map();
  assert.throws(
    () => enrichOracleFromAnswers(answers, null, []),
    /record must be a decision record/,
    "must throw when record is null"
  );
  assert.throws(
    () => enrichOracleFromAnswers(answers, { intake_id: "x" }, []),
    /record must be a decision record/,
    "must throw when record has no .decisions array"
  );
});

// ---------------------------------------------------------------------------
// ESCALATE-04: Rarity telemetry
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ESCALATE-04: Rarity telemetry ---\n");

await test("E28 — createEscalationCounter: starts at zero", () => {
  const counter = createEscalationCounter();
  assert.equal(counter.autoAnswered, 0, "autoAnswered must start at 0");
  assert.equal(counter.escalated,    0, "escalated must start at 0");
});

await test("E29 — incrementCounter: auto_answered increments correctly", () => {
  const counter = createEscalationCounter();
  incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "auto_answered");
  assert.equal(counter.autoAnswered, 2, "autoAnswered must be 2 after two increments");
  assert.equal(counter.escalated,    0, "escalated must remain 0");
});

await test("E30 — incrementCounter: escalated increments correctly", () => {
  const counter = createEscalationCounter();
  incrementCounter(counter, "escalated");
  assert.equal(counter.escalated,    1, "escalated must be 1 after one increment");
  assert.equal(counter.autoAnswered, 0, "autoAnswered must remain 0");
});

await test("E31 — incrementCounter: throws on invalid type", () => {
  const counter = createEscalationCounter();
  assert.throws(
    () => incrementCounter(counter, "unknown"),
    /"auto_answered" or "escalated"/,
    "must throw on invalid type"
  );
  assert.throws(
    () => incrementCounter(counter, null),
    /"auto_answered" or "escalated"/,
    "must throw on null type"
  );
});

await test("E32 — renderEscalationTelemetry: format matches 'auto-answered N / escalated M'", () => {
  const counter = createEscalationCounter();
  incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "escalated");

  const line = renderEscalationTelemetry(counter);
  assert.ok(line.includes("auto-answered 2"),
    `line must include "auto-answered 2"; got: "${line}"`);
  assert.ok(line.includes("escalated 1"),
    `line must include "escalated 1"; got: "${line}"`);
});

await test("E33 — renderEscalationTelemetry: includes threshold when provided", () => {
  const counter = createEscalationCounter();
  incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "escalated");

  const line = renderEscalationTelemetry(counter, { threshold: 0.60 });
  assert.ok(line.includes("0.60"),
    `line must include "0.60" (threshold); got: "${line}"`);
  assert.ok(line.includes("threshold"),
    `line must include "threshold"; got: "${line}"`);
});

await test("E34 — renderEscalationTelemetry: shows pending selector count when provided", () => {
  const counter = createEscalationCounter();
  incrementCounter(counter, "escalated");

  const line = renderEscalationTelemetry(counter, {
    threshold: 0.60,
    pending: { batchSize: 3 },
  });
  assert.ok(line.includes("pending"),
    `line must mention "pending" selectors; got: "${line}"`);
  assert.ok(line.includes("3"),
    `line must include the pending count "3"; got: "${line}"`);
});

await test("E35 — renderEscalationTelemetry: throws on invalid counter", () => {
  assert.throws(
    () => renderEscalationTelemetry(null),
    /counter must be an object/,
    "must throw when counter is null"
  );
  assert.throws(
    () => renderEscalationTelemetry("string"),
    /counter must be an object/,
    "must throw when counter is a string"
  );
});

await test("E36 — counter increments correctly through a mixed auto-answer/escalate sequence", () => {
  const counter = createEscalationCounter();
  // Simulate: 5 auto-answers, 1 escalation, 3 more auto-answers
  for (let i = 0; i < 5; i++) incrementCounter(counter, "auto_answered");
  incrementCounter(counter, "escalated");
  for (let i = 0; i < 3; i++) incrementCounter(counter, "auto_answered");

  assert.equal(counter.autoAnswered, 8, "autoAnswered must be 8");
  assert.equal(counter.escalated,    1, "escalated must be 1");

  const line = renderEscalationTelemetry(counter, { threshold: 0.60 });
  assert.ok(line.includes("auto-answered 8"), `must show "auto-answered 8"; got: "${line}"`);
  assert.ok(line.includes("escalated 1"),     `must show "escalated 1"; got: "${line}"`);

  // The auto-answer rate should be mentioned
  const total = 9;
  const rate  = Math.round((8 / total) * 100); // 88%
  assert.ok(line.includes(`${rate}%`) || line.includes("88%"),
    `must show the auto-answer rate (~88%); got: "${line}"`);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

rmSync(tmpRoot, { recursive: true, force: true });

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
      process.stdout.write(
        `        ${f.err.stack.split("\n").slice(0, 4).join("\n        ")}\n`
      );
    }
  }
  process.exit(1);
}

process.stdout.write("All tests passed.\n");
process.exit(0);
