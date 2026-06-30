#!/usr/bin/env node
/**
 * test-profile.mjs — Unit tests for profile.mjs (Phase E3: PROFILE-01..02)
 *
 * No external framework.  Uses node:assert.
 * Run with: node bgsd/scripts/test-profile.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully deterministic:
 *   - No real model / API calls.
 *   - Filesystem I/O uses OS temp directories, cleaned up after each test.
 *   - Zero real network I/O.
 *
 * Test groups:
 *
 * --- PROFILE-01: buildPreferenceProfile ---
 *   P01 — sealed record yields one signal per answered decision
 *   P02 — every signal carries authority: "preference"
 *   P03 — every signal is tagged with its source decision id
 *   P04 — every signal has a non-empty topic and category
 *   P05 — typed answer produces a signal with a truncated label
 *   P06 — selected answer carries the option label
 *   P07 — unsealed record yields an empty profile (no fabricated signals — NFR-06)
 *   P08 — partially-answered record only produces signals for answered decisions
 *   P09 — profile.json is written atomically when intakeDir is provided
 *   P10 — profile.json round-trips (parse → same shape)
 *   P11 — invalid input throws
 *
 * --- PROFILE-02: weight ordering invariant ---
 *   P12 — PROFILE_WEIGHT < DECISION_WEIGHT (strict — asserted by module)
 *   P13 — PROFILE_WEIGHT < SPEC_WEIGHT (strict)
 *   P14 — SPEC_WEIGHT < DECISION_WEIGHT (strict)
 *   P15 — every signal's weight equals PROFILE_WEIGHT
 *   P16 — every signal's weight is strictly less than DECISION_WEIGHT
 *   P17 — profile-only match weight < DECISION_WEIGHT (the escalation-bias guarantee)
 *
 * --- PROFILE-01: queryProfile ---
 *   P18 — queryProfile: exact topic match returns correct signal
 *   P19 — queryProfile: substring topic match returns a signal
 *   P20 — queryProfile: returns null when topic not found
 *   P21 — queryProfile: returns null on empty profile
 *   P22 — queryProfile: returns null on null/undefined inputs
 *   P23 — queryProfile: returned signal includes weight (PROFILE_WEIGHT)
 *   P24 — queryProfile: label substring match works as fallback
 *
 * --- Edge cases ---
 *   P25 — empty decisions array yields empty profile
 *   P26 — all-unanswered decisions yield empty profile (NFR-06)
 *   P27 — profile has intake_id matching the record
 *   P28 — profile.authority is always "preference"
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  buildPreferenceProfile,
  queryProfile,
  PROFILE_WEIGHT,
  DECISION_WEIGHT,
  SPEC_WEIGHT,
} from "./profile.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-brainstorm.mjs style)
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

const INTAKE_ID = "intake-test-profile-0001";

/**
 * Build a minimal sealed decision record with the given decision entries.
 * Mimics the shape produced by brainstorm.mjs sealDecisionRecord.
 */
function makeSealedRecord(decisions) {
  return {
    intake_id: INTAKE_ID,
    sealed_at: "2026-06-29T12:00:00.000Z",
    decisions,
  };
}

/**
 * Build a decision entry with source "selected".
 */
function selectedDecision(overrides = {}) {
  return {
    id:           "q-001",
    topic:        "scope-bound",
    question:     "How tightly should the scope be bounded for the first deliverable?",
    options: [
      { id: "mvp-thin", label: "Thin MVP", description: "One core user flow." },
      { id: "mvp-full", label: "Full MVP", description: "All surfaces." },
    ],
    freeText:     { id: "other", label: "Type your own", placeholder: "..." },
    answer:       "mvp-thin",
    source:       "selected",
    rationale:    "Keep scope small to move fast.",
    spec_section: "scope",
    ...overrides,
  };
}

/**
 * Build a decision entry with source "typed".
 */
function typedDecision(overrides = {}) {
  return {
    id:           "q-002",
    topic:        "ux-model",
    question:     "What UX model should the primary surface follow?",
    options: [
      { id: "zero-config", label: "Zero-config", description: "Sensible defaults." },
      { id: "power-user",  label: "Power-user",  description: "Expert controls." },
    ],
    freeText:     { id: "other", label: "Type your own", placeholder: "..." },
    answer:       "I want a hybrid approach with progressive disclosure",
    source:       "typed",
    rationale:    null,
    spec_section: "surfaces",
    ...overrides,
  };
}

/**
 * Build an unanswered decision entry.
 */
function unansweredDecision(overrides = {}) {
  return {
    id:           "q-003",
    topic:        "data-persist",
    question:     "Where should application data be persisted?",
    options: [
      { id: "local-only", label: "Local only", description: "Browser/local fs." },
      { id: "cloud-sync", label: "Cloud sync", description: "Hosted backend." },
    ],
    freeText:     { id: "other", label: "Type your own", placeholder: "..." },
    answer:       "unanswered",
    source:       "unanswered",
    rationale:    null,
    spec_section: "constraints",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PROFILE-01: buildPreferenceProfile
// ---------------------------------------------------------------------------

process.stdout.write("\n--- PROFILE-01: buildPreferenceProfile ---\n");

await test("P01 — sealed record yields one signal per answered decision", () => {
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.signals.length, 2,
    "two answered decisions → two signals");
});

await test("P02 — every signal carries authority: 'preference'", () => {
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  for (const sig of profile.signals) {
    assert.equal(sig.authority, "preference",
      `signal "${sig.id}" must have authority "preference"`);
  }
});

await test("P03 — every signal is tagged with its source decision id", () => {
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  assert.deepEqual(profile.signals[0].source_ids, ["q-001"]);
  assert.deepEqual(profile.signals[1].source_ids, ["q-002"]);
});

await test("P04 — every signal has a non-empty topic and category", () => {
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  for (const sig of profile.signals) {
    assert.ok(sig.topic,    `signal "${sig.id}" must have a topic`);
    assert.ok(sig.category, `signal "${sig.id}" must have a category`);
  }
});

await test("P05 — typed answer produces a signal with a label derived from the typed text", () => {
  const record = makeSealedRecord([typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  const sig = profile.signals[0];
  assert.ok(sig.label, "typed signal must have a non-empty label");
  // Label must be at most 80 chars (or the full text if shorter)
  assert.ok(sig.label.length <= 80,
    `typed signal label must be ≤ 80 chars, got ${sig.label.length}`);
  // The leaning should be the full typed answer
  assert.equal(sig.leaning, "I want a hybrid approach with progressive disclosure");
});

await test("P06 — selected answer carries the option label from the decision's options", () => {
  const record = makeSealedRecord([selectedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  const sig = profile.signals[0];
  assert.equal(sig.label, "Thin MVP", "label must match the chosen option label");
  assert.equal(sig.leaning, "mvp-thin", "leaning must be the option id");
});

await test("P07 — unsealed record yields an empty profile (no fabricated signals — NFR-06)", () => {
  const record = {
    intake_id: INTAKE_ID,
    sealed_at: null,   // NOT sealed
    decisions: [selectedDecision()],
  };
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.signals.length, 0,
    "unsealed record must produce zero signals — no fabrication (NFR-06)");
});

await test("P08 — partially-answered record only produces signals for answered decisions", () => {
  const record = makeSealedRecord([
    selectedDecision(),
    unansweredDecision(),    // should be skipped
    typedDecision({ id: "q-004", topic: "deploy-target" }),
  ]);
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.signals.length, 2,
    "only 2 answered decisions → 2 signals (unanswered skipped)");
  // No signal for the unanswered decision
  const dataPersistSignal = profile.signals.find((s) => s.topic === "data-persist");
  assert.equal(dataPersistSignal, undefined,
    "unanswered decision must NOT appear in the profile");
});

let tmpDir;

await test("P09 — profile.json is written atomically when intakeDir is provided", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bgsd-test-profile-"));
  const intakeDir = join(tmpDir, "intake-profile-01");
  const record = makeSealedRecord([selectedDecision()]);
  const { profileJsonPath } = buildPreferenceProfile(record, { intakeDir });
  assert.ok(profileJsonPath, "profileJsonPath must be returned");
  assert.ok(existsSync(profileJsonPath), "profile.json must exist on disk");
});

await test("P10 — profile.json round-trips (parse → same shape)", () => {
  const intakeDir = join(tmpDir, "intake-profile-02");
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile, profileJsonPath } = buildPreferenceProfile(record, { intakeDir });
  assert.ok(profileJsonPath);
  const parsed = JSON.parse(readFileSync(profileJsonPath, "utf8"));
  assert.equal(parsed.intake_id, profile.intake_id, "intake_id must round-trip");
  assert.equal(parsed.authority, "preference", "authority must round-trip");
  assert.equal(parsed.signals.length, profile.signals.length,
    "signal count must round-trip");
  for (const sig of parsed.signals) {
    assert.equal(sig.authority, "preference", "each signal authority must round-trip");
    assert.equal(sig.weight, PROFILE_WEIGHT,   "each signal weight must round-trip");
  }
});

await test("P11 — invalid input throws", () => {
  assert.throws(
    () => buildPreferenceProfile(null),
    /decisionRecord must be an object/
  );
  assert.throws(
    () => buildPreferenceProfile("string"),
    /decisionRecord must be an object/
  );
});

// ---------------------------------------------------------------------------
// PROFILE-02: weight ordering invariant
// ---------------------------------------------------------------------------

process.stdout.write("\n--- PROFILE-02: weight ordering invariant ---\n");

await test("P12 — PROFILE_WEIGHT < DECISION_WEIGHT (strict)", () => {
  assert.ok(PROFILE_WEIGHT < DECISION_WEIGHT,
    `PROFILE_WEIGHT(${PROFILE_WEIGHT}) must be strictly less than DECISION_WEIGHT(${DECISION_WEIGHT})`);
});

await test("P13 — PROFILE_WEIGHT < SPEC_WEIGHT (strict)", () => {
  assert.ok(PROFILE_WEIGHT < SPEC_WEIGHT,
    `PROFILE_WEIGHT(${PROFILE_WEIGHT}) must be strictly less than SPEC_WEIGHT(${SPEC_WEIGHT})`);
});

await test("P14 — SPEC_WEIGHT < DECISION_WEIGHT (strict)", () => {
  assert.ok(SPEC_WEIGHT < DECISION_WEIGHT,
    `SPEC_WEIGHT(${SPEC_WEIGHT}) must be strictly less than DECISION_WEIGHT(${DECISION_WEIGHT})`);
});

await test("P15 — every signal's weight equals PROFILE_WEIGHT", () => {
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  for (const sig of profile.signals) {
    assert.equal(sig.weight, PROFILE_WEIGHT,
      `signal "${sig.id}" weight must equal PROFILE_WEIGHT`);
  }
});

await test("P16 — every signal's weight is strictly less than DECISION_WEIGHT", () => {
  const record = makeSealedRecord([selectedDecision(), typedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  for (const sig of profile.signals) {
    assert.ok(sig.weight < DECISION_WEIGHT,
      `signal "${sig.id}" weight(${sig.weight}) must be < DECISION_WEIGHT(${DECISION_WEIGHT})`);
  }
});

await test("P17 — profile-only match weight < DECISION_WEIGHT (the escalation-bias guarantee)", () => {
  // This is the core PROFILE-02 guarantee: a profile-only confidence reading
  // will fall below the oracle's expected auto-answer threshold, biasing
  // the oracle toward escalation rather than auto-answering.
  const record = makeSealedRecord([selectedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  const sig = profile.signals[0];
  // A profile-only match returns weight = PROFILE_WEIGHT.
  // The oracle's practical threshold for auto-answering is at least 0.5
  // (SPEC_WEIGHT), so PROFILE_WEIGHT < threshold → escalate.
  assert.ok(sig.weight < SPEC_WEIGHT,
    `profile signal weight(${sig.weight}) must be < SPEC_WEIGHT(${SPEC_WEIGHT}) ` +
    `so it falls below the oracle's auto-answer confidence floor`);
  assert.ok(sig.weight < DECISION_WEIGHT,
    `profile signal weight(${sig.weight}) must be < DECISION_WEIGHT(${DECISION_WEIGHT})`);
});

// ---------------------------------------------------------------------------
// PROFILE-01: queryProfile
// ---------------------------------------------------------------------------

process.stdout.write("\n--- PROFILE-01: queryProfile ---\n");

function makeProfile() {
  const record = makeSealedRecord([
    selectedDecision(),
    typedDecision(),
    {
      id:           "q-005",
      topic:        "deploy-target",
      question:     "What is the primary deployment target?",
      options: [{ id: "static-host", label: "Static host", description: "..." },
                { id: "node-server", label: "Node server",  description: "..." }],
      freeText:     { id: "other", label: "Type your own", placeholder: "..." },
      answer:       "static-host",
      source:       "selected",
      rationale:    null,
      spec_section: "constraints",
    },
  ]);
  const { profile } = buildPreferenceProfile(record, { builtAt: "2026-06-29T12:00:00.000Z" });
  return profile;
}

await test("P18 — queryProfile: exact topic match returns correct signal", () => {
  const profile = makeProfile();
  const sig = queryProfile(profile, "scope-bound");
  assert.ok(sig, "must find a signal for 'scope-bound'");
  assert.equal(sig.topic, "scope-bound");
});

await test("P19 — queryProfile: substring topic match returns a signal", () => {
  const profile = makeProfile();
  // "scope" is a substring of "scope-bound"
  const sig = queryProfile(profile, "scope");
  assert.ok(sig, "must find a signal for 'scope' (substring of 'scope-bound')");
  assert.ok(sig.topic.includes("scope"));
});

await test("P20 — queryProfile: returns null when topic not found", () => {
  const profile = makeProfile();
  const sig = queryProfile(profile, "zzz-nonexistent-topic-xyz");
  assert.equal(sig, null, "must return null for an unknown topic");
});

await test("P21 — queryProfile: returns null on empty profile", () => {
  const emptyProfile = {
    intake_id: INTAKE_ID,
    built_at:  "2026-06-29T12:00:00.000Z",
    authority: "preference",
    signals:   [],
  };
  const sig = queryProfile(emptyProfile, "scope-bound");
  assert.equal(sig, null, "empty profile must return null");
});

await test("P22 — queryProfile: returns null on null/undefined inputs", () => {
  const profile = makeProfile();
  assert.equal(queryProfile(null, "scope"), null);
  assert.equal(queryProfile(undefined, "scope"), null);
  assert.equal(queryProfile(profile, null), null);
  assert.equal(queryProfile(profile, undefined), null);
  assert.equal(queryProfile(profile, ""), null);
});

await test("P23 — queryProfile: returned signal includes weight (PROFILE_WEIGHT)", () => {
  const profile = makeProfile();
  const sig = queryProfile(profile, "scope-bound");
  assert.ok(sig, "must find a signal");
  assert.equal(sig.weight, PROFILE_WEIGHT,
    "returned signal must include weight = PROFILE_WEIGHT");
});

await test("P24 — queryProfile: label substring match works as fallback", () => {
  const profile = makeProfile();
  // "Thin MVP" is the label of the scope-bound signal
  const sig = queryProfile(profile, "thin mvp");
  assert.ok(sig, "must find a signal by label substring");
  assert.equal(sig.topic, "scope-bound");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

process.stdout.write("\n--- Edge cases ---\n");

await test("P25 — empty decisions array yields empty profile", () => {
  const record = makeSealedRecord([]);
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.signals.length, 0,
    "empty decisions array must yield empty profile");
});

await test("P26 — all-unanswered decisions yield empty profile (NFR-06)", () => {
  const record = makeSealedRecord([
    unansweredDecision({ id: "q-001", topic: "scope-bound" }),
    unansweredDecision({ id: "q-002", topic: "ux-model" }),
  ]);
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.signals.length, 0,
    "all-unanswered decisions must yield zero signals — no fabrication (NFR-06)");
});

await test("P27 — profile has intake_id matching the record", () => {
  const record = makeSealedRecord([selectedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.intake_id, INTAKE_ID,
    "profile.intake_id must match the decision record's intake_id");
});

await test("P28 — profile.authority is always 'preference'", () => {
  const record = makeSealedRecord([selectedDecision()]);
  const { profile } = buildPreferenceProfile(record);
  assert.equal(profile.authority, "preference",
    "profile.authority must always be 'preference'");
});

// Cleanup
if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });

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
        `        ${f.err.stack.split("\n").slice(0, 3).join("\n        ")}\n`
      );
    }
  }
  process.exit(1);
}

process.stdout.write("All tests passed.\n");
process.exit(0);
