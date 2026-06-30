#!/usr/bin/env node
/**
 * test-brainstorm.mjs — Unit tests for brainstorm.mjs (Phase E2: BRAINSTORM-01..04)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-brainstorm.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully deterministic:
 *   - No real model / API calls.
 *   - promptFn is always an injected mock.
 *   - Filesystem I/O uses OS temp directories, cleaned up after each test.
 *   - Zero real network I/O.
 *
 * Test groups:
 *
 * --- BRAINSTORM-02: buildBrainstormQuestions (selector shape, NFR-10) ---
 *   B01 — buildBrainstormQuestions: returns at least 1 question
 *   B02 — buildBrainstormQuestions: every question has an id, topic, prompt
 *   B03 — buildBrainstormQuestions: every question has ≥2 concrete options (NFR-10)
 *   B04 — buildBrainstormQuestions: every question has a freeText affordance with id "other" (NFR-10)
 *   B05 — buildBrainstormQuestions: no question has >4 options (NFR-10)
 *   B06 — buildBrainstormQuestions: open-q-prio question populated from spec openQuestions
 *   B07 — buildBrainstormQuestions: assertSelectorInvariant passes on all generated questions
 *   B08 — buildBrainstormQuestions: throws on non-object intentSpec
 *
 * --- BRAINSTORM-03: createDecisionRecord ---
 *   B09 — createDecisionRecord: produces a record with one entry per question
 *   B10 — createDecisionRecord: all entries start as "unanswered"
 *   B11 — createDecisionRecord: sealed_at is null initially
 *
 * --- BRAINSTORM-03: recordDecision ---
 *   B12 — recordDecision: selected option id → source "selected"
 *   B13 — recordDecision: free-text (non-option id) → source "typed"
 *   B14 — recordDecision: null answer → source "unanswered"
 *   B15 — recordDecision: "other" option id not in options → source "typed"
 *   B16 — recordDecision: rationale is captured when provided
 *   B17 — recordDecision: throws on unknown decisionId
 *
 * --- BRAINSTORM-04: sealDecisionRecord ---
 *   B18 — sealDecisionRecord: seals a fully-answered record, sets sealed_at
 *   B19 — sealDecisionRecord: throws if any decision is unanswered (NFR-06 / BRAINSTORM-04)
 *   B20 — sealDecisionRecord: writes decisions.json and DECISIONS.md atomically
 *   B21 — sealDecisionRecord: decisions.json round-trips (parse → same record shape)
 *   B22 — sealDecisionRecord: DECISIONS.md contains all topic slugs
 *   B23 — sealDecisionRecord: sealed record has a non-null sealed_at
 *
 * --- BRAINSTORM-03: queryDecision (E4 oracle seam) ---
 *   B24 — queryDecision: returns null on unsealed record
 *   B25 — queryDecision: exact topic match returns correct entry
 *   B26 — queryDecision: substring topic match returns an entry
 *   B27 — queryDecision: returns null when topic not found
 *   B28 — queryDecision: typed answer is retrievable by topic
 *
 * --- BRAINSTORM-01..04: runBrainstorm (interactive-by-design, mocked promptFn) ---
 *   B29 — runBrainstorm: answers all questions, seals when gate confirms
 *   B30 — runBrainstorm: typed own answer is tagged source "typed"
 *   B31 — runBrainstorm: unanswered gate leaves record unsealed (NFR-06 / BRAINSTORM-04)
 *   B32 — runBrainstorm: partial answers leave record unsealed when gate not confirmed
 *   B33 — runBrainstorm: scope-creep typed answers collected in deferredIdeas
 *   B34 — runBrainstorm: decisions.json written when intakeDir provided and session sealed
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  buildBrainstormQuestions,
  assertSelectorInvariant,
  createDecisionRecord,
  recordDecision,
  sealDecisionRecord,
  queryDecision,
  buildReadyGateQuestion,
  runBrainstorm,
} from "./brainstorm.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-intake.mjs style)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
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

const FIXTURE_SPEC = {
  intake_id:     "intake-test-brainstorm-0001",
  openQuestions: [
    "What is the primary user persona (developer vs. general knowledge worker)?",
    "Should the timer be configurable per session or fixed at 25 min?",
    "Offline-first or online-first persistence model?",
  ],
  chunks: [
    { id: "intake-test-brainstorm-0001/goals",          heading: "Goals",          summary: "Build a Pomodoro timer." },
    { id: "intake-test-brainstorm-0001/scope",          heading: "Scope",          summary: "MVP scope only." },
    { id: "intake-test-brainstorm-0001/surfaces",       heading: "Surfaces",       summary: "Web and CLI." },
    { id: "intake-test-brainstorm-0001/constraints",    heading: "Constraints",    summary: "Node 18+ only." },
    { id: "intake-test-brainstorm-0001/open-questions", heading: "Open Questions", summary: "What is the primary user persona?" },
  ],
};

/** Build a fresh (unsealed) record with all-unanswered entries. */
function makeRecord(questions) {
  return createDecisionRecord(FIXTURE_SPEC.intake_id, questions);
}

/** Return the first question from the generated set. */
function firstQuestion() {
  return buildBrainstormQuestions(FIXTURE_SPEC)[0];
}

/** Answer all decisions in a record with the first option's id. */
function answerAll(record, questions) {
  for (const q of questions) {
    const optionId = q.options[0].id;
    recordDecision(record, q.id, optionId);
  }
}

// ---------------------------------------------------------------------------
// Tests: buildBrainstormQuestions (BRAINSTORM-02, NFR-10)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- BRAINSTORM-02: buildBrainstormQuestions (selector shape, NFR-10) ---\n");

await test("B01 — buildBrainstormQuestions: returns at least 1 question", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  assert.ok(qs.length >= 1, "must return at least one question");
});

await test("B02 — buildBrainstormQuestions: every question has an id, topic, prompt", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  for (const q of qs) {
    assert.ok(q.id,    `question must have id, got: ${JSON.stringify(q)}`);
    assert.ok(q.topic, `question must have topic`);
    assert.ok(q.prompt, `question must have prompt`);
  }
});

await test("B03 — buildBrainstormQuestions: every question has ≥2 concrete options (NFR-10)", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  for (const q of qs) {
    assert.ok(
      Array.isArray(q.options) && q.options.length >= 2,
      `question "${q.id}" must have ≥2 options, got ${q.options?.length ?? 0}`
    );
  }
});

await test("B04 — buildBrainstormQuestions: every question has a freeText affordance with id 'other' (NFR-10)", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  for (const q of qs) {
    assert.ok(q.freeText, `question "${q.id}" must have a freeText affordance`);
    assert.equal(q.freeText.id, "other", `freeText.id must be "other" (NFR-10)`);
    assert.ok(q.freeText.label, `freeText must have a label`);
    assert.ok(q.freeText.placeholder, `freeText must have a placeholder`);
  }
});

await test("B05 — buildBrainstormQuestions: no question has >4 options (NFR-10)", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  for (const q of qs) {
    assert.ok(
      q.options.length <= 4,
      `question "${q.id}" must have ≤4 options, got ${q.options.length}`
    );
  }
});

await test("B06 — buildBrainstormQuestions: open-q-prio question populated from spec openQuestions", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const oqPrio = qs.find((q) => q.topic === "open-q-prio");
  assert.ok(oqPrio, "should include an open-q-prio question");
  // Options should be derived from the fixture's openQuestions (up to 3)
  assert.ok(oqPrio.options.length >= 2, "open-q-prio must have ≥2 options");
});

await test("B07 — buildBrainstormQuestions: assertSelectorInvariant passes on all generated questions", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  for (const q of qs) {
    // Should not throw
    assert.doesNotThrow(() => assertSelectorInvariant(q), `invariant must hold for question "${q.id}"`);
  }
});

await test("B08 — buildBrainstormQuestions: throws on non-object intentSpec", () => {
  assert.throws(
    () => buildBrainstormQuestions(null),
    /intentSpec must be an object/
  );
  assert.throws(
    () => buildBrainstormQuestions("string"),
    /intentSpec must be an object/
  );
});

// ---------------------------------------------------------------------------
// Tests: createDecisionRecord (BRAINSTORM-03)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- BRAINSTORM-03: createDecisionRecord ---\n");

await test("B09 — createDecisionRecord: produces a record with one entry per question", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  assert.equal(record.decisions.length, qs.length, "one decision entry per question");
});

await test("B10 — createDecisionRecord: all entries start as 'unanswered'", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  for (const d of record.decisions) {
    assert.equal(d.source, "unanswered", `decision "${d.id}" must start as unanswered`);
    assert.equal(d.answer, "unanswered", `decision "${d.id}" answer must start as "unanswered"`);
  }
});

await test("B11 — createDecisionRecord: sealed_at is null initially", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  assert.equal(record.sealed_at, null, "sealed_at must be null before sealing");
});

// ---------------------------------------------------------------------------
// Tests: recordDecision (BRAINSTORM-03)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- BRAINSTORM-03: recordDecision ---\n");

await test("B12 — recordDecision: selected option id → source 'selected'", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  const q = qs[0];
  const optionId = q.options[0].id;
  const entry = recordDecision(record, q.id, optionId);
  assert.equal(entry.source, "selected", "source must be 'selected' for a known option id");
  assert.equal(entry.answer, optionId, "answer must match the option id");
});

await test("B13 — recordDecision: free-text (non-option id) → source 'typed'", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  const q = qs[0];
  const entry = recordDecision(record, q.id, "I want something completely different");
  assert.equal(entry.source, "typed", "source must be 'typed' for free-text answer");
  assert.equal(entry.answer, "I want something completely different");
});

await test("B14 — recordDecision: null answer → source 'unanswered'", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  const q = qs[0];
  const entry = recordDecision(record, q.id, null);
  assert.equal(entry.source, "unanswered", "null answer must leave source as 'unanswered'");
});

await test("B15 — recordDecision: 'other' as raw answer (not an option id) → source 'typed'", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  const q = qs[0];
  // "other" is the freeText id — it is NOT in q.options, so it's free-text
  const entry = recordDecision(record, q.id, "other");
  assert.equal(entry.source, "typed",
    "'other' is the freeText affordance id, not a concrete option → source typed");
});

await test("B16 — recordDecision: rationale is captured when provided", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  const q = qs[0];
  const optionId = q.options[0].id;
  const entry = recordDecision(record, q.id, optionId, { rationale: "Because of X" });
  assert.equal(entry.rationale, "Because of X", "rationale must be captured");
});

await test("B17 — recordDecision: throws on unknown decisionId", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  assert.throws(
    () => recordDecision(record, "q-999", "some-answer"),
    /no decision entry with id/
  );
});

// ---------------------------------------------------------------------------
// Tests: sealDecisionRecord (BRAINSTORM-04)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- BRAINSTORM-04: sealDecisionRecord ---\n");

await test("B18 — sealDecisionRecord: seals a fully-answered record, sets sealed_at", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  answerAll(record, qs);
  const { record: sealed } = sealDecisionRecord(record, { sealedAt: "2026-06-29T12:00:00.000Z" });
  assert.ok(sealed.sealed_at, "sealed_at must be set");
  assert.equal(sealed.sealed_at, "2026-06-29T12:00:00.000Z");
});

await test("B19 — sealDecisionRecord: throws if any decision is unanswered (NFR-06 / BRAINSTORM-04)", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  // Answer only the first question — leave the rest unanswered
  recordDecision(record, qs[0].id, qs[0].options[0].id);
  assert.throws(
    () => sealDecisionRecord(record),
    /cannot seal.*unanswered/i
  );
});

let tmpSealDir;

await test("B20 — sealDecisionRecord: writes decisions.json and DECISIONS.md atomically", async () => {
  tmpSealDir = mkdtempSync(join(tmpdir(), "bgsd-test-brainstorm-seal-"));
  const intakeDir = join(tmpSealDir, "intake-seal-test");
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  answerAll(record, qs);
  const { decisionsJsonPath, decisionsMdPath } = sealDecisionRecord(record, { intakeDir });
  assert.ok(existsSync(decisionsJsonPath), "decisions.json must exist");
  assert.ok(existsSync(decisionsMdPath), "DECISIONS.md must exist");
});

await test("B21 — sealDecisionRecord: decisions.json round-trips (parse → same record shape)", () => {
  const intakeDir = join(tmpSealDir, "intake-seal-test-rt");
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  answerAll(record, qs);
  const { decisionsJsonPath } = sealDecisionRecord(record, { intakeDir });
  const parsed = JSON.parse(readFileSync(decisionsJsonPath, "utf8"));
  assert.equal(parsed.intake_id, record.intake_id, "intake_id must round-trip");
  assert.ok(parsed.sealed_at, "sealed_at must be present after round-trip");
  assert.equal(parsed.decisions.length, qs.length, "decision count must round-trip");
  for (const d of parsed.decisions) {
    assert.ok(d.id, "each decision must have id");
    assert.ok(d.topic, "each decision must have topic");
    assert.ok(d.source !== "unanswered", "no decision should be unanswered in sealed record");
  }
});

await test("B22 — sealDecisionRecord: DECISIONS.md contains all topic slugs", () => {
  const intakeDir = join(tmpSealDir, "intake-seal-test-md");
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  answerAll(record, qs);
  const { decisionsMdPath } = sealDecisionRecord(record, { intakeDir });
  const md = readFileSync(decisionsMdPath, "utf8");
  for (const q of qs) {
    assert.ok(
      md.includes(q.topic),
      `DECISIONS.md must contain topic "${q.topic}"`
    );
  }
});

await test("B23 — sealDecisionRecord: sealed record has a non-null sealed_at", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  answerAll(record, qs);
  const { record: sealed } = sealDecisionRecord(record);
  assert.ok(sealed.sealed_at !== null, "sealed_at must be non-null after sealing");
  assert.ok(typeof sealed.sealed_at === "string", "sealed_at must be a string");
});

// Cleanup seal temp dir
if (tmpSealDir) rmSync(tmpSealDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Tests: queryDecision (E4 oracle seam — BRAINSTORM-03)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- BRAINSTORM-03: queryDecision (E4 oracle seam) ---\n");

function makeSealedRecord() {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  answerAll(record, qs);
  sealDecisionRecord(record, { sealedAt: "2026-06-29T10:00:00.000Z" });
  return { record, qs };
}

await test("B24 — queryDecision: returns null on unsealed record", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  // Do NOT seal
  const result = queryDecision(record, "scope-bound");
  assert.equal(result, null, "queryDecision must return null on unsealed record");
});

await test("B25 — queryDecision: exact topic match returns correct entry", () => {
  const { record, qs } = makeSealedRecord();
  const firstTopic = qs[0].topic;
  const result = queryDecision(record, firstTopic);
  assert.ok(result, "should find a match by exact topic");
  assert.equal(result.topic, firstTopic, "matched topic must equal query");
});

await test("B26 — queryDecision: substring topic match returns an entry", () => {
  const { record } = makeSealedRecord();
  // "scope" is a substring of "scope-bound"
  const result = queryDecision(record, "scope");
  assert.ok(result, "should find a match by substring");
  assert.ok(result.topic.includes("scope"), "matched topic must contain substring");
});

await test("B27 — queryDecision: returns null when topic not found", () => {
  const { record } = makeSealedRecord();
  const result = queryDecision(record, "zzz-nonexistent-topic-xyz");
  assert.equal(result, null, "should return null for unknown topic");
});

await test("B28 — queryDecision: typed answer is retrievable by topic", () => {
  const qs = buildBrainstormQuestions(FIXTURE_SPEC);
  const record = makeRecord(qs);
  // Answer the first question with typed text
  recordDecision(record, qs[0].id, "My custom typed answer");
  // Answer the rest with option ids
  for (const q of qs.slice(1)) {
    recordDecision(record, q.id, q.options[0].id);
  }
  sealDecisionRecord(record, { sealedAt: "2026-06-29T11:00:00.000Z" });
  const firstTopic = qs[0].topic;
  const result = queryDecision(record, firstTopic);
  assert.ok(result, "should find the typed-answer entry");
  assert.equal(result.source, "typed", "source must be 'typed'");
  assert.equal(result.answer, "My custom typed answer", "answer must match typed text");
});

// ---------------------------------------------------------------------------
// Tests: runBrainstorm (BRAINSTORM-01..04, interactive-by-design, mocked promptFn)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- BRAINSTORM-01..04: runBrainstorm (mocked promptFn) ---\n");

/**
 * Build a mock promptFn that:
 *   - For regular questions: returns the first option's id.
 *   - For the ready gate (id "gate-ready"): returns "seal-now".
 */
function makeAutoAnswerPromptFn() {
  return async (question) => {
    if (question.id === "gate-ready") return "seal-now";
    return question.options[0].id;
  };
}

let tmpRunDir;

await test("B29 — runBrainstorm: answers all questions, seals when gate confirms", async () => {
  tmpRunDir = mkdtempSync(join(tmpdir(), "bgsd-test-brainstorm-run-"));
  const intakeDir = join(tmpRunDir, "intake-run-01");
  const result = await runBrainstorm({
    intentSpec: FIXTURE_SPEC,
    intakeId:   FIXTURE_SPEC.intake_id,
    intakeDir,
    promptFn:   makeAutoAnswerPromptFn(),
  });
  assert.equal(result.sealed, true, "record must be sealed when gate confirms 'seal-now'");
  assert.ok(result.record.sealed_at, "sealed_at must be set");
  // All decisions must be answered
  for (const d of result.record.decisions) {
    assert.notEqual(d.source, "unanswered", `decision "${d.id}" must be answered`);
  }
});

await test("B30 — runBrainstorm: typed own answer is tagged source 'typed'", async () => {
  const intakeDir = join(tmpRunDir, "intake-run-02");
  let callCount = 0;
  const typingPromptFn = async (question) => {
    if (question.id === "gate-ready") return "seal-now";
    callCount++;
    // For the very first question, return free text; all others pick option 0
    if (callCount === 1) return "I want my own custom approach entirely";
    return question.options[0].id;
  };
  const result = await runBrainstorm({
    intentSpec: FIXTURE_SPEC,
    intakeId:   FIXTURE_SPEC.intake_id,
    intakeDir,
    promptFn:   typingPromptFn,
  });
  assert.equal(result.sealed, true, "record must be sealed");
  const typedDecision = result.record.decisions.find((d) => d.source === "typed");
  assert.ok(typedDecision, "at least one decision must have source 'typed'");
  assert.equal(
    typedDecision.answer,
    "I want my own custom approach entirely",
    "typed answer must match the free-text input"
  );
});

await test("B31 — runBrainstorm: unanswered gate leaves record unsealed (NFR-06 / BRAINSTORM-04)", async () => {
  const intakeDir = join(tmpRunDir, "intake-run-03");
  // Gate always returns null — simulates unanswered / user closes session
  const nullGatePromptFn = async (question) => {
    if (question.id === "gate-ready") return null;
    return question.options[0].id;
  };
  const result = await runBrainstorm({
    intentSpec: FIXTURE_SPEC,
    intakeId:   FIXTURE_SPEC.intake_id,
    intakeDir,
    promptFn:   nullGatePromptFn,
  });
  // Gate was null → record must NOT be sealed
  assert.equal(result.sealed, false, "record must NOT be sealed when gate returns null (NFR-06)");
  assert.equal(result.record.sealed_at, null, "sealed_at must remain null");
});

await test("B32 — runBrainstorm: partial answers leave record unsealed when gate not confirmed", async () => {
  const intakeDir = join(tmpRunDir, "intake-run-04");
  let callCount = 0;
  const partialPromptFn = async (question) => {
    if (question.id === "gate-ready") return null; // never confirm gate
    callCount++;
    // Answer only the first 2 questions; return null for the rest
    if (callCount <= 2) return question.options[0].id;
    return null;
  };
  const result = await runBrainstorm({
    intentSpec: FIXTURE_SPEC,
    intakeId:   FIXTURE_SPEC.intake_id,
    intakeDir,
    promptFn:   partialPromptFn,
  });
  assert.equal(result.sealed, false, "partially-answered record must NOT be sealed");
  assert.equal(result.record.sealed_at, null, "sealed_at must remain null");
});

await test("B33 — runBrainstorm: scope-creep typed answers collected in deferredIdeas", async () => {
  const intakeDir = join(tmpRunDir, "intake-run-05");
  let callCount = 0;
  const scopeCreepFn = async (question) => {
    if (question.id === "gate-ready") return "seal-now";
    callCount++;
    if (callCount === 2) return "also add a mobile app to the scope";
    return question.options[0].id;
  };
  const result = await runBrainstorm({
    intentSpec: FIXTURE_SPEC,
    intakeId:   FIXTURE_SPEC.intake_id,
    intakeDir,
    promptFn:   scopeCreepFn,
  });
  assert.ok(
    result.deferredIdeas.some((idea) => idea.startsWith("also")),
    "scope-creep answer must be captured in deferredIdeas"
  );
});

await test("B34 — runBrainstorm: decisions.json written when intakeDir provided and session sealed", async () => {
  const intakeDir = join(tmpRunDir, "intake-run-06");
  const result = await runBrainstorm({
    intentSpec: FIXTURE_SPEC,
    intakeId:   FIXTURE_SPEC.intake_id,
    intakeDir,
    promptFn:   makeAutoAnswerPromptFn(),
  });
  assert.equal(result.sealed, true, "must be sealed to write files");
  const decisionsJsonPath = join(intakeDir, "decisions.json");
  assert.ok(existsSync(decisionsJsonPath), "decisions.json must be written when sealed and intakeDir provided");
  const parsed = JSON.parse(readFileSync(decisionsJsonPath, "utf8"));
  assert.equal(parsed.intake_id, FIXTURE_SPEC.intake_id, "decisions.json intake_id must match");
  assert.ok(parsed.sealed_at, "decisions.json sealed_at must be set");
});

// Cleanup
if (tmpRunDir) rmSync(tmpRunDir, { recursive: true, force: true });

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
