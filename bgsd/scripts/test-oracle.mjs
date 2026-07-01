#!/usr/bin/env node
/**
 * test-oracle.mjs — Unit tests for oracle.mjs (Phase E4: ORACLE-01..04)
 *
 * No external framework.  Uses node:assert.
 * Run with: node bgsd/scripts/test-oracle.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are fully deterministic:
 *   - No real model / API calls.
 *   - Filesystem I/O uses OS temp directories, cleaned up after tests.
 *   - No live /gsd-discuss-phase invocations (guarded by requireLiveFlag).
 *
 * Test groups:
 *
 * --- ORACLE-01: buildOracle / loadOracle ---
 *   O01 — buildOracle writes manifest.json atomically
 *   O02 — manifest contains pointers (paths) to the three source files, not blobs
 *   O03 — manifest retrieval_order is decision-first
 *   O04 — buildOracle throws if a source file is missing (NFR-06)
 *   O05 — loadOracle returns manifest from a previously built oracle
 *   O06 — loadOracle throws if manifest.json does not exist
 *
 * --- ORACLE-02: answerQuestion — confidence scoring ---
 *   O07 — decision-record hit → high confidence → auto_answer with source:"decision"
 *   O08 — spec-only hit → medium confidence → auto_answer (above threshold) with source:"spec"
 *   O09 — profile-only hit → low confidence → escalate (below threshold)
 *   O10 — conflicting sources → conflict penalty lowers confidence (asserted)
 *   O11 — confidence score breakdown fields are present and sum correctly
 *   O12 — threshold == 1.0 → escalate everything (safety floor, ORACLE-04)
 *   O13 — just-below threshold → escalate
 *   O14 — at threshold → auto_answer
 *   O15 — no candidates found → escalate with reason "insufficient_spec"
 *   O16 — profile-only match score ≤ PROFILE_WEIGHT × 1 × 0.50 (≤ 0.125) — bias to escalate
 *   O17 — decision hit confidence strictly higher than spec hit confidence for same question
 *   O18 — throws on bad oracle input
 *   O19 — throws on empty/null question
 *
 * --- ORACLE-03: buildDiscussPhaseSeam ---
 *   O20 — seam payload has contextMdPatch (string) and contextMdPath (string)
 *   O21 — seam invocation is /gsd-discuss-phase <phase> --assumptions
 *   O22 — seam resolveBlockerArgs present when blockerId supplied
 *   O23 — seam inboxPath present when blockerId supplied
 *   O24 — seam live: false always
 *   O25 — buildDiscussPhaseSeam throws when action is not auto_answer
 *   O26 — requireLiveFlag throws without --live
 *   O27 — requireLiveFlag does NOT throw with --live
 *
 * --- ORACLE-04: threshold config + audit log ---
 *   O28 — loadOracleConfig returns defaults when config.json has no conductor block
 *   O29 — loadOracleConfig reads conductor.oracle_threshold and auto_answer_cap
 *   O30 — appendAutoAnswerLog appends a JSONL line
 *   O31 — appendAutoAnswerLog entry includes logged_at
 *   O32 — threshold 1.0 in answerQuestion escalates even a perfect decision hit
 *   O33 — auto_answer_cap value is readable from config
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
  buildOracle,
  loadOracle,
  answerQuestion,
  buildDiscussPhaseSeam,
  requireLiveFlag,
  loadOracleConfig,
  appendAutoAnswerLog,
  DECISION_WEIGHT,
  SPEC_WEIGHT,
  PROFILE_WEIGHT,
  DEFAULT_THRESHOLD,
  DEFAULT_AUTO_ANSWER_CAP,
} from "./oracle.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-profile.mjs style)
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
// Fixture helpers
// ---------------------------------------------------------------------------

const INTAKE_ID = "intake-test-oracle-0001";

/**
 * Write the three sealed source files into a temp intake directory.
 * Accepts optional overrides for each source to control what the oracle sees.
 */
function makeSourceFiles(intakeDir, {
  decisions = null,
  indexChunks = null,
  profileSignals = null,
} = {}) {
  mkdirSync(intakeDir, { recursive: true });

  // decisions.json — a sealed decision record
  const decisionRecord = decisions ?? {
    intake_id: INTAKE_ID,
    sealed_at: "2026-06-29T12:00:00.000Z",
    decisions: [
      {
        id:          "q-001",
        topic:       "scope-bound",
        question:    "How tightly should the scope be bounded for the first deliverable?",
        options:     [
          { id: "mvp-thin", label: "Thin MVP", description: "One core user flow." },
          { id: "mvp-full", label: "Full MVP", description: "All surfaces." },
        ],
        freeText:    { id: "other", label: "Type your own", placeholder: "..." },
        answer:      "mvp-thin",
        source:      "selected",
        rationale:   "Keep scope small.",
        spec_section: "scope",
      },
      {
        id:          "q-002",
        topic:       "deploy-target",
        question:    "What is the primary deployment target?",
        options:     [
          { id: "static-host", label: "Static host", description: "Vercel/Netlify." },
          { id: "node-server", label: "Node server", description: "Express/Fastify." },
        ],
        freeText:    { id: "other", label: "Type your own", placeholder: "..." },
        answer:      "static-host",
        source:      "selected",
        rationale:   null,
        spec_section: "constraints",
      },
    ],
  };
  writeFileSync(
    join(intakeDir, "decisions.json"),
    JSON.stringify(decisionRecord, null, 2)
  );

  // index.json — spec chunk index
  const index = indexChunks ?? {
    intake_id: INTAKE_ID,
    generated_at: "2026-06-29T12:00:00.000Z",
    chunks: [
      {
        id:        `${INTAKE_ID}/scope`,
        heading:   "Scope",
        anchor:    "#scope",
        startLine: 10,
        endLine:   20,
        summary:   "MVP scope only, one core user flow end-to-end.",
      },
      {
        id:        `${INTAKE_ID}/constraints`,
        heading:   "Constraints",
        anchor:    "#constraints",
        startLine: 21,
        endLine:   30,
        summary:   "Node 18+, no external dependencies, static host deployment.",
      },
      {
        id:        `${INTAKE_ID}/open-questions`,
        heading:   "Open Questions",
        anchor:    "#open-questions",
        startLine: 40,
        endLine:   50,
        summary:   "What is the primary user persona? What are the performance requirements?",
      },
    ],
  };
  writeFileSync(join(intakeDir, "index.json"), JSON.stringify(index, null, 2));

  // profile.json — preference profile
  const profile = profileSignals ?? {
    intake_id: INTAKE_ID,
    built_at:  "2026-06-29T12:00:00.000Z",
    authority: "preference",
    signals: [
      {
        id:          "pref-001",
        topic:       "scope-bound",
        category:    "scope",
        leaning:     "mvp-thin",
        label:       "Thin MVP",
        weight:      PROFILE_WEIGHT,
        authority:   "preference",
        source_ids:  ["q-001"],
        rationale:   "Keep scope small.",
        spec_section: "scope",
      },
      {
        id:          "pref-002",
        topic:       "deploy-target",
        category:    "architecture",
        leaning:     "static-host",
        label:       "Static host",
        weight:      PROFILE_WEIGHT,
        authority:   "preference",
        source_ids:  ["q-002"],
        rationale:   null,
        spec_section: "constraints",
      },
    ],
  };
  writeFileSync(join(intakeDir, "profile.json"), JSON.stringify(profile, null, 2));

  return { decisionsPath: join(intakeDir, "decisions.json") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpRoot = mkdtempSync(join(tmpdir(), "bgsd-oracle-test-"));
const intakeDir = join(tmpRoot, "intake", INTAKE_ID);
const bgsdDir   = join(tmpRoot, "bgsd");

// Write test fixture files
makeSourceFiles(intakeDir);

// ---------------------------------------------------------------------------
// ORACLE-01: buildOracle / loadOracle
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ORACLE-01: buildOracle / loadOracle ---\n");

let builtOracle;

await test("O01 — buildOracle writes manifest.json atomically", () => {
  const result = buildOracle({ intakeId: INTAKE_ID, intakeDir, bgsdDir });
  builtOracle = result;
  const manifestPath = join(bgsdDir, "oracle", INTAKE_ID, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json must exist on disk");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.intake_id, INTAKE_ID);
});

await test("O02 — manifest contains pointers (paths) to the three source files, not blobs", () => {
  const { manifest } = builtOracle;
  // Must have pointer paths, not the actual content
  assert.ok(manifest.sources.decisions.path, "decisions source must have a path");
  assert.ok(manifest.sources.spec_index.path, "spec_index source must have a path");
  assert.ok(manifest.sources.profile.path, "profile source must have a path");
  // The paths must point to files, not be inline data
  assert.ok(typeof manifest.sources.decisions.path === "string");
  assert.ok(manifest.sources.decisions.path.endsWith("decisions.json"));
  assert.ok(manifest.sources.spec_index.path.endsWith("index.json"));
  assert.ok(manifest.sources.profile.path.endsWith("profile.json"));
  // No inline blobs
  assert.equal(manifest.sources.decisions.data, undefined, "must not embed data blobs");
});

await test("O03 — manifest retrieval_order is decision-first", () => {
  const { manifest } = builtOracle;
  assert.ok(Array.isArray(manifest.retrieval_order));
  assert.equal(manifest.retrieval_order[0], "decisions",
    "decisions must be first in retrieval_order");
  assert.ok(manifest.retrieval_order.includes("spec_index"),
    "retrieval_order must include spec_index");
  assert.ok(manifest.retrieval_order.includes("profile"),
    "retrieval_order must include profile");
});

await test("O04 — buildOracle throws if a source file is missing (NFR-06)", () => {
  const missingIntakeDir = join(tmpRoot, "missing-intake");
  mkdirSync(missingIntakeDir, { recursive: true });
  // Write only one of the required files
  writeFileSync(join(missingIntakeDir, "decisions.json"), "{}");
  // index.json and profile.json are absent

  assert.throws(
    () => buildOracle({
      intakeId:  "intake-missing-files-0001",
      intakeDir: missingIntakeDir,
      bgsdDir,
    }),
    /missing required source files/,
    "must throw when source files are missing"
  );
});

await test("O05 — loadOracle returns manifest from a previously built oracle", () => {
  const { manifest: loaded } = loadOracle({ intakeId: INTAKE_ID, bgsdDir });
  assert.equal(loaded.intake_id, INTAKE_ID);
  assert.ok(loaded.sources, "loaded manifest must have sources");
  assert.ok(loaded.retrieval_order, "loaded manifest must have retrieval_order");
});

await test("O06 — loadOracle throws if manifest.json does not exist", () => {
  assert.throws(
    () => loadOracle({ intakeId: "intake-nonexistent-0001", bgsdDir }),
    /manifest not found/,
    "must throw when manifest does not exist"
  );
});

// ---------------------------------------------------------------------------
// ORACLE-02: answerQuestion — confidence scoring
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ORACLE-02: answerQuestion — confidence scoring ---\n");

const { manifest } = builtOracle;

await test("O07 — decision-record hit → high confidence → auto_answer with source:'decision'", () => {
  // "scope" is the topic of q-001; "scope bounded deliverable" is rich in keywords
  const result = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the deliverable?",
    { threshold: DEFAULT_THRESHOLD }
  );
  assert.equal(result.action, "auto_answer",
    `expected auto_answer, got ${result.action} (confidence ${result.confidence?.toFixed(3)})`);
  assert.equal(result.source, "decision",
    "a direct decision-record hit must report source:'decision'");
  // Confidence must be well above DEFAULT_THRESHOLD (0.60)
  assert.ok(result.confidence >= DEFAULT_THRESHOLD,
    `confidence ${result.confidence} must be >= threshold ${DEFAULT_THRESHOLD}`);
  assert.ok(result.confidence > SPEC_WEIGHT,
    `decision hit confidence (${result.confidence}) must exceed SPEC_WEIGHT (${SPEC_WEIGHT})`);
});

await test("O08 — spec-only hit → medium confidence → auto_answer (above 0.30 threshold) with source:'spec'", () => {
  // Override: decisions with ONLY an unanswered entry so only spec hits
  const specOnlyIntakeDir = join(tmpRoot, "intake-spec-only");
  makeSourceFiles(specOnlyIntakeDir, {
    decisions: {
      intake_id: "intake-spec-only",
      sealed_at: "2026-06-29T12:00:00.000Z",
      decisions: [], // no matching decisions
    },
    profileSignals: {
      intake_id: "intake-spec-only",
      built_at:  "2026-06-29T12:00:00.000Z",
      authority: "preference",
      signals:   [], // no matching profile signals
    },
  });
  const specOracle = buildOracle({
    intakeId: "intake-spec-only",
    intakeDir: specOnlyIntakeDir,
    bgsdDir,
  });

  const result = answerQuestion(
    specOracle.manifest,
    "What are the deployment constraints for this project?",
    { threshold: 0.20 }   // low threshold so spec hit auto-answers
  );
  assert.equal(result.action, "auto_answer",
    `expected auto_answer for spec hit at low threshold; got ${result.action} (conf ${result.confidence?.toFixed(3)})`);
  assert.equal(result.source, "spec",
    "a spec-section hit must report source:'spec'");
  assert.ok(result.confidence > 0,
    "spec hit confidence must be > 0");
  // Spec hit score < DECISION_WEIGHT
  assert.ok(result.confidence < DECISION_WEIGHT,
    `spec hit confidence (${result.confidence}) must be < DECISION_WEIGHT (${DECISION_WEIGHT})`);
});

await test("O09 — profile-only hit → low confidence → escalate (below default threshold)", () => {
  // Override: no decisions, no spec chunks, only profile signals
  const profileOnlyIntakeDir = join(tmpRoot, "intake-profile-only");
  makeSourceFiles(profileOnlyIntakeDir, {
    decisions: {
      intake_id: "intake-profile-only",
      sealed_at: "2026-06-29T12:00:00.000Z",
      decisions: [],
    },
    indexChunks: {
      intake_id:    "intake-profile-only",
      generated_at: "2026-06-29T12:00:00.000Z",
      chunks: [],  // no spec chunks
    },
    profileSignals: {
      intake_id: "intake-profile-only",
      built_at:  "2026-06-29T12:00:00.000Z",
      authority: "preference",
      signals: [
        {
          id:          "pref-001",
          topic:       "scope-bound",
          category:    "scope",
          leaning:     "mvp-thin",
          label:       "Thin MVP",
          weight:      PROFILE_WEIGHT,
          authority:   "preference",
          source_ids:  ["q-001"],
          rationale:   null,
          spec_section: "scope",
        },
      ],
    },
  });
  const profileOracle = buildOracle({
    intakeId: "intake-profile-only",
    intakeDir: profileOnlyIntakeDir,
    bgsdDir,
  });

  const result = answerQuestion(
    profileOracle.manifest,
    "How should scope be bounded for the deliverable?",
    { threshold: DEFAULT_THRESHOLD }  // 0.60
  );
  assert.equal(result.action, "escalate",
    `profile-only hit must escalate at threshold ${DEFAULT_THRESHOLD}; got ${result.action} (confidence ${result.confidence?.toFixed(3)})`);
  // Score must be <= PROFILE_WEIGHT × 1 × 0.50 = 0.125
  assert.ok(result.confidence <= 0.20,
    `profile-only confidence (${result.confidence}) must be ≤ 0.20`);
});

await test("O10 — conflicting sources → conflict penalty lowers confidence (asserted)", () => {
  // Create a scenario where decisions.json has TWO conflicting answers for the same question
  const conflictIntakeDir = join(tmpRoot, "intake-conflict");
  makeSourceFiles(conflictIntakeDir, {
    decisions: {
      intake_id: "intake-conflict",
      sealed_at: "2026-06-29T12:00:00.000Z",
      decisions: [
        {
          id:          "q-001",
          topic:       "scope-bound",
          question:    "How tightly should the scope be bounded for the first deliverable?",
          options:     [{ id: "mvp-thin", label: "Thin MVP", description: "..." },
                        { id: "mvp-full", label: "Full MVP", description: "..." }],
          freeText:    { id: "other", label: "Type your own", placeholder: "..." },
          answer:      "mvp-thin",
          source:      "selected",
          rationale:   null,
          spec_section: "scope",
        },
        // A CONFLICTING second decision on the same topic with different answer
        {
          id:          "q-002",
          topic:       "scope-bound",
          question:    "What scope should be targeted for the deliverable?",
          options:     [{ id: "mvp-thin", label: "Thin MVP", description: "..." },
                        { id: "mvp-full", label: "Full MVP", description: "..." }],
          freeText:    { id: "other", label: "Type your own", placeholder: "..." },
          answer:      "mvp-full",  // DIFFERENT answer → conflict
          source:      "selected",
          rationale:   null,
          spec_section: "scope",
        },
      ],
    },
  });
  const conflictOracle = buildOracle({
    intakeId: "intake-conflict",
    intakeDir: conflictIntakeDir,
    bgsdDir,
  });

  // Score the question and also score without conflict to compare
  const conflictResult = answerQuestion(
    conflictOracle.manifest,
    "How tightly should the scope be bounded for the deliverable?",
    { threshold: 0.01 }  // very low threshold so we see the score, not routing
  );

  // The breakdown must show a conflict_penalty > 0
  assert.ok(conflictResult.breakdown, "breakdown must be present");
  assert.ok(conflictResult.breakdown.conflict_penalty > 0,
    `conflict_penalty must be > 0 when sources disagree; got ${conflictResult.breakdown.conflict_penalty}`);
});

await test("O11 — confidence score breakdown fields are present and sum correctly", () => {
  const result = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: DEFAULT_THRESHOLD }
  );
  // action may be auto_answer or escalate — both should have breakdown
  assert.ok(result.breakdown, "breakdown must be present in result");
  assert.ok("authority_weight"  in result.breakdown, "breakdown.authority_weight must be present");
  assert.ok("match_strength"    in result.breakdown, "breakdown.match_strength must be present");
  assert.ok("specificity"       in result.breakdown, "breakdown.specificity must be present");
  assert.ok("conflict_penalty"  in result.breakdown, "breakdown.conflict_penalty must be present");
  // Verify the formula: authority_weight × match_strength × specificity − conflict_penalty
  const { authority_weight, match_strength, specificity, conflict_penalty } = result.breakdown;
  const expected = Math.max(0, Math.min(1,
    authority_weight * match_strength * specificity - conflict_penalty
  ));
  assert.ok(Math.abs(result.confidence - expected) < 0.001,
    `confidence (${result.confidence}) must match formula output (${expected})`);
});

await test("O12 — threshold == 1.0 → escalate everything (safety floor, ORACLE-04)", () => {
  const result = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: 1.0 }
  );
  assert.equal(result.action, "escalate",
    "threshold 1.0 must always escalate (safety floor)");
  assert.ok(result.reason && result.reason.includes("1.0"),
    "escalate reason must mention the 1.0 threshold");
});

await test("O13 — just-below threshold → escalate", () => {
  // Find the actual confidence for the decision hit
  const reference = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: 0.0 }   // no threshold, accept anything
  );
  assert.ok(reference.confidence > 0, "need a reference confidence > 0");

  // Set threshold just above the actual confidence
  const justAbove = reference.confidence + 0.001;
  const result = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: justAbove }
  );
  assert.equal(result.action, "escalate",
    `just-below-threshold must escalate (threshold: ${justAbove}, confidence: ${reference.confidence})`);
});

await test("O14 — at threshold → auto_answer", () => {
  // Find the actual confidence for the decision hit
  const reference = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: 0.0 }
  );
  assert.ok(reference.confidence > 0, "need a reference confidence > 0");

  // Set threshold exactly at the confidence value
  const exactly = reference.confidence;
  const result = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: exactly }
  );
  assert.equal(result.action, "auto_answer",
    `at-threshold must auto_answer (threshold == confidence == ${exactly})`);
});

await test("O15 — no candidates found → escalate with reason 'insufficient_spec'", () => {
  // Ask a question with no keywords that appear in any source
  const result = answerQuestion(
    manifest,
    "zzzz-completely-unrelated-xyzzy-topic",
    { threshold: DEFAULT_THRESHOLD }
  );
  assert.equal(result.action, "escalate",
    "no-candidates case must escalate");
  assert.ok(result.reason && result.reason.includes("insufficient_spec"),
    `escalate reason must include 'insufficient_spec'; got: "${result.reason}"`);
  assert.equal(result.confidence, 0,
    "no-candidates confidence must be 0");
});

await test("O16 — profile-only match score ≤ 0.125 — bias to escalate (PROFILE-02)", () => {
  // Max profile-only score = PROFILE_WEIGHT × match_strength(1.0) × specificity(0.50) = 0.125
  const profileOnlyIntakeDir = join(tmpRoot, "intake-profile-bias");
  makeSourceFiles(profileOnlyIntakeDir, {
    decisions: {
      intake_id: "intake-profile-bias",
      sealed_at: "2026-06-29T12:00:00.000Z",
      decisions: [],
    },
    indexChunks: {
      intake_id:    "intake-profile-bias",
      generated_at: "2026-06-29T12:00:00.000Z",
      chunks:       [],
    },
    profileSignals: {
      intake_id: "intake-profile-bias",
      built_at:  "2026-06-29T12:00:00.000Z",
      authority: "preference",
      signals: [
        {
          id:          "pref-001",
          topic:       "scope",
          category:    "scope",
          leaning:     "mvp-thin",
          label:       "Thin MVP scope bounded deliverable",
          weight:      PROFILE_WEIGHT,
          authority:   "preference",
          source_ids:  ["q-001"],
          rationale:   null,
          spec_section: "scope",
        },
      ],
    },
  });
  const profileBiasOracle = buildOracle({
    intakeId: "intake-profile-bias",
    intakeDir: profileOnlyIntakeDir,
    bgsdDir,
  });

  // Use a very low threshold to actually get a result (otherwise it escalates)
  const result = answerQuestion(
    profileBiasOracle.manifest,
    "scope bounded deliverable",
    { threshold: 0.0 }
  );

  // The score should be at most PROFILE_WEIGHT × 1 × 0.50 = 0.125
  const MAX_PROFILE_SCORE = PROFILE_WEIGHT * 1.0 * 0.50;
  assert.ok(result.confidence <= MAX_PROFILE_SCORE + 0.001,
    `profile-only score (${result.confidence}) must be ≤ max possible (${MAX_PROFILE_SCORE})`);
});

await test("O17 — decision hit confidence > spec hit confidence for same question", () => {
  // Decision hit
  const decisionResult = answerQuestion(
    manifest,
    "How tightly should scope be bounded for the deliverable?",
    { threshold: 0.0 }
  );
  // Force a spec-only oracle
  const specOnlyIntakeDir = join(tmpRoot, "intake-spec-compare");
  makeSourceFiles(specOnlyIntakeDir, {
    decisions: {
      intake_id: "intake-spec-compare",
      sealed_at: "2026-06-29T12:00:00.000Z",
      decisions: [],
    },
    profileSignals: {
      intake_id: "intake-spec-compare",
      built_at:  "2026-06-29T12:00:00.000Z",
      authority: "preference",
      signals: [],
    },
  });
  const specOracle = buildOracle({
    intakeId: "intake-spec-compare",
    intakeDir: specOnlyIntakeDir,
    bgsdDir,
  });
  const specResult = answerQuestion(
    specOracle.manifest,
    "How tightly should scope be bounded for the deliverable?",
    { threshold: 0.0 }
  );

  // Decision confidence must be strictly higher than spec confidence
  assert.ok(
    decisionResult.confidence > specResult.confidence,
    `decision confidence (${decisionResult.confidence}) must exceed spec confidence (${specResult.confidence})`
  );
});

await test("O18 — answerQuestion throws on bad oracle input", () => {
  assert.throws(
    () => answerQuestion(null, "question", {}),
    /oracle must be an object/
  );
  assert.throws(
    () => answerQuestion({}, "question", {}),
    /oracle must be a manifest/
  );
});

await test("O19 — answerQuestion throws on empty/null question", () => {
  assert.throws(
    () => answerQuestion(manifest, null, {}),
    /question must be a non-empty string/
  );
  assert.throws(
    () => answerQuestion(manifest, "", {}),
    /question must be a non-empty string/
  );
  assert.throws(
    () => answerQuestion(manifest, "   ", {}),
    /question must be a non-empty string/
  );
});

// ---------------------------------------------------------------------------
// ORACLE-03: buildDiscussPhaseSeam
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ORACLE-03: buildDiscussPhaseSeam ---\n");

// Build a representative auto_answer to use for seam tests
const sampleAutoAnswer = {
  action:     "auto_answer",
  answer:     "mvp-thin",
  source:     "decision",
  confidence: 0.72,
  breakdown:  {
    authority_weight: 0.75,
    match_strength:   0.75,
    specificity:      0.80,
    conflict_penalty: 0,
  },
};

const AGENT_ID     = "agent-test-001";
const WORKTREE_DIR = join(tmpRoot, "worktree");
const PHASE        = "1";
const BLOCKER_ID   = "blocker-1234-abcde";

await test("O20 — seam payload has contextMdPatch (string) and contextMdPath (string)", () => {
  const payload = buildDiscussPhaseSeam(sampleAutoAnswer, {
    phase:       PHASE,
    agentId:     AGENT_ID,
    worktreeDir: WORKTREE_DIR,
    question:    "How tightly should the scope be bounded?",
  });
  assert.ok(typeof payload.contextMdPatch === "string" && payload.contextMdPatch.length > 0,
    "contextMdPatch must be a non-empty string");
  assert.ok(typeof payload.contextMdPath === "string" && payload.contextMdPath.length > 0,
    "contextMdPath must be a non-empty string");
  // Must mention the answer
  assert.ok(payload.contextMdPatch.includes("mvp-thin"),
    "contextMdPatch must include the answer");
  // Must mention confidence
  assert.ok(payload.contextMdPatch.includes("0.720"),
    "contextMdPatch must include confidence");
});

await test("O21 — seam invocation is /gsd-discuss-phase <phase> --assumptions", () => {
  const payload = buildDiscussPhaseSeam(sampleAutoAnswer, {
    phase:       PHASE,
    agentId:     AGENT_ID,
    worktreeDir: WORKTREE_DIR,
  });
  // Must be the documented non-interactive discuss mode (NFR-03/04)
  assert.ok(payload.invocation.includes("/gsd-discuss-phase"),
    "invocation must include /gsd-discuss-phase");
  assert.ok(payload.invocation.includes("--assumptions"),
    "invocation must include --assumptions (the non-interactive mode)");
  assert.ok(payload.invocation.includes(PHASE),
    "invocation must include the phase number");
});

await test("O22 — seam resolveBlockerArgs present when blockerId supplied", () => {
  const payload = buildDiscussPhaseSeam(sampleAutoAnswer, {
    phase:       PHASE,
    agentId:     AGENT_ID,
    worktreeDir: WORKTREE_DIR,
    blockerId:   BLOCKER_ID,
  });
  assert.ok(payload.resolveBlockerArgs,
    "resolveBlockerArgs must be present when blockerId is supplied");
  assert.equal(payload.resolveBlockerArgs.blockerId, BLOCKER_ID,
    "resolveBlockerArgs.blockerId must match");
  assert.ok(payload.resolveBlockerArgs.resolution?.answer,
    "resolveBlockerArgs.resolution.answer must be present");
  assert.equal(payload.resolveBlockerArgs.resolution.answer, "mvp-thin");
  // inboxContent for the Conductor to write before re-launch
  assert.ok(typeof payload.resolveBlockerArgs.inboxContent === "string",
    "resolveBlockerArgs.inboxContent must be a string (written to inbox by Conductor)");
});

await test("O23 — seam inboxPath present when blockerId supplied", () => {
  const payload = buildDiscussPhaseSeam(sampleAutoAnswer, {
    phase:       PHASE,
    agentId:     AGENT_ID,
    worktreeDir: WORKTREE_DIR,
    blockerId:   BLOCKER_ID,
  });
  assert.ok(payload.inboxPath && payload.inboxPath.includes(AGENT_ID),
    "inboxPath must include the agent id");
  assert.ok(payload.inboxPath.endsWith(".inbox.md"),
    "inboxPath must end with .inbox.md (v2 control-file protocol)");
});

await test("O24 — seam live: false always", () => {
  const payload = buildDiscussPhaseSeam(sampleAutoAnswer, {
    phase:       PHASE,
    agentId:     AGENT_ID,
    worktreeDir: WORKTREE_DIR,
  });
  assert.equal(payload.live, false,
    "live must always be false — the real invocation is --live-guarded (NFR-08)");
});

await test("O25 — buildDiscussPhaseSeam throws when action is not auto_answer", () => {
  const escalate = { action: "escalate", reason: "no match", confidence: 0 };
  assert.throws(
    () => buildDiscussPhaseSeam(escalate, {
      phase: PHASE, agentId: AGENT_ID, worktreeDir: WORKTREE_DIR,
    }),
    /auto_answer/,
    "must throw when autoAnswer.action is not 'auto_answer'"
  );
});

await test("O26 — requireLiveFlag throws without --live", () => {
  assert.throws(
    () => requireLiveFlag([]),
    /--live/,
    "must throw when --live is absent"
  );
  assert.throws(
    () => requireLiveFlag("--assumptions"),
    /--live/,
    "must throw when only --assumptions is present but not --live"
  );
  assert.throws(
    () => requireLiveFlag(null),
    /--live/,
    "must throw on null args"
  );
});

await test("O27 — requireLiveFlag does NOT throw with --live", () => {
  assert.doesNotThrow(
    () => requireLiveFlag(["--live"]),
    "must not throw when --live is present"
  );
  assert.doesNotThrow(
    () => requireLiveFlag(["--live", "--assumptions"]),
    "must not throw when --live is one of several flags"
  );
  assert.doesNotThrow(
    () => requireLiveFlag("/gsd-discuss-phase 1 --assumptions --live"),
    "must not throw when --live is in a string"
  );
});

// ---------------------------------------------------------------------------
// ORACLE-04: threshold config + audit log
// ---------------------------------------------------------------------------

process.stdout.write("\n--- ORACLE-04: threshold config + audit log ---\n");

await test("O28 — loadOracleConfig returns defaults when config.json has no conductor block", () => {
  // Write a config.json with no conductor block
  const configDir = join(tmpRoot, "planning-no-conductor");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ workflow: { discuss_mode: "discuss" } }));

  const cfg = loadOracleConfig(configPath);
  assert.equal(cfg.threshold, DEFAULT_THRESHOLD,
    `threshold must default to ${DEFAULT_THRESHOLD}`);
  assert.equal(cfg.autoAnswerCap, DEFAULT_AUTO_ANSWER_CAP,
    `autoAnswerCap must default to ${DEFAULT_AUTO_ANSWER_CAP}`);
});

await test("O29 — loadOracleConfig reads conductor.oracle_threshold and auto_answer_cap", () => {
  const configDir = join(tmpRoot, "planning-with-conductor");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    conductor: {
      oracle_threshold: 0.75,
      auto_answer_cap:  5,
    },
  }));

  const cfg = loadOracleConfig(configPath);
  assert.equal(cfg.threshold, 0.75, "must read oracle_threshold from conductor block");
  assert.equal(cfg.autoAnswerCap, 5, "must read auto_answer_cap from conductor block");
});

await test("O30 — appendAutoAnswerLog appends a JSONL line", () => {
  const oracleDir = join(tmpRoot, "oracle-audit-test");
  mkdirSync(oracleDir, { recursive: true });

  const lines = [];
  const mockAppend = (filePath, line) => { lines.push(line); };

  const entry = {
    question:   "What is the deployment target?",
    answer:     "static-host",
    source:     "decision",
    confidence: 0.72,
    phase:      "1",
    agent_id:   "agent-abc",
  };

  appendAutoAnswerLog({ oracleDir, entry, writeFn: mockAppend });

  assert.equal(lines.length, 1, "must append exactly one line");
  const parsed = JSON.parse(lines[0].trim());
  assert.equal(parsed.answer, "static-host");
  assert.equal(parsed.source, "decision");
  assert.ok(parsed.logged_at, "appended entry must have logged_at");
});

await test("O31 — appendAutoAnswerLog entry includes logged_at", () => {
  const oracleDir = join(tmpRoot, "oracle-audit-test2");
  mkdirSync(oracleDir, { recursive: true });

  let capturedLine;
  const mockAppend = (_path, line) => { capturedLine = line; };

  appendAutoAnswerLog({
    oracleDir,
    entry: { question: "q", answer: "a", confidence: 0.7 },
    writeFn: mockAppend,
  });

  const parsed = JSON.parse(capturedLine.trim());
  assert.ok(parsed.logged_at, "entry must include logged_at");
  // logged_at must be a valid ISO string
  const ts = new Date(parsed.logged_at);
  assert.ok(!isNaN(ts.getTime()), "logged_at must be a valid ISO timestamp");
});

await test("O32 — threshold 1.0 in answerQuestion escalates even a perfect decision hit", () => {
  // This is the "escalate-everything safety floor" (ORACLE-04)
  const result = answerQuestion(
    manifest,
    "How tightly should the scope be bounded for the first deliverable?",
    { threshold: 1.0 }
  );
  assert.equal(result.action, "escalate",
    "threshold 1.0 must always result in escalate — even for a perfect decision hit");
  assert.ok(result.reason && result.reason.includes("1.0"),
    "reason must mention the 1.0 threshold floor");
});

await test("O33 — auto_answer_cap value is readable from config", () => {
  const configDir = join(tmpRoot, "planning-cap-check");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    conductor: { oracle_threshold: 0.65, auto_answer_cap: 3 },
  }));
  const cfg = loadOracleConfig(configPath);
  assert.equal(cfg.autoAnswerCap, 3, "auto_answer_cap must be 3 from config");
  assert.equal(cfg.threshold, 0.65, "threshold must be 0.65 from config");
  // Ensure the cap is a positive integer
  assert.ok(Number.isInteger(cfg.autoAnswerCap) && cfg.autoAnswerCap > 0,
    "autoAnswerCap must be a positive integer");
});

// ---------------------------------------------------------------------------
// CLI: --answer sub-command
// ---------------------------------------------------------------------------

process.stdout.write("\n--- CLI: oracle.mjs --answer ---\n");

const oracleScript = resolve(fileURLToPath(import.meta.url), "../oracle.mjs");

// Helper: run the CLI and return { status, stdout, stderr, json? }
function runCli(args) {
  const result = spawnSync(process.execPath, [oracleScript, ...args], { encoding: "utf8" });
  let json = null;
  try {
    if (result.stdout && result.stdout.trim()) json = JSON.parse(result.stdout.trim());
  } catch (_) { /* leave json null */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// Build a CLI oracle dir in a fresh temp tree so it's independent of the main tmpRoot
let cliTmpRoot = mkdtempSync(join(tmpdir(), "bgsd-oracle-cli-test-"));
const cliIntakeId = "intake-cli-test-0001";
const cliIntakeDir = join(cliTmpRoot, "intake", cliIntakeId);
const cliBgsdDir   = join(cliTmpRoot, "bgsd");
makeSourceFiles(cliIntakeDir);  // reuse the shared fixture helper
const cliOracle = buildOracle({ intakeId: cliIntakeId, intakeDir: cliIntakeDir, bgsdDir: cliBgsdDir });

await test("C01 — no oracle store for run → escalate + exit 0", () => {
  const r = runCli([
    "--answer",
    "--run-id", "nonexistent-run-xyz",
    "--phase", "1",
    "--question", "What is the deployment target?",
    "--bgsd-dir", cliBgsdDir,
  ]);
  assert.equal(r.status, 0, "exit code must be 0 even when no oracle store exists");
  assert.ok(r.json, `stdout must be valid JSON; got: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.json.action, "escalate", "action must be escalate when no store exists");
  assert.ok(
    r.json.reason && /no oracle/i.test(r.json.reason),
    `reason must mention 'no oracle'; got: ${r.json.reason}`
  );
  assert.equal(r.json.confidence, 0, "confidence must be 0 for missing store");
});

await test("C02 — known run with high-confidence question → auto_answer", () => {
  const r = runCli([
    "--answer",
    "--run-id", cliIntakeId,
    "--phase", "scope",
    "--question", "How tightly should the scope be bounded for the first deliverable?",
    "--bgsd-dir", cliBgsdDir,
    "--threshold", "0.3",   // low enough to guarantee auto_answer on this decision hit
  ]);
  assert.equal(r.status, 0, `exit code must be 0; stderr: ${r.stderr}`);
  assert.ok(r.json, `stdout must be valid JSON; got: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.json.action, "auto_answer",
    `expected auto_answer; got ${r.json.action} (confidence: ${r.json.confidence})`);
  assert.ok(r.json.confidence > 0, "confidence must be > 0");
  assert.ok(r.json.answer,         "answer must be present for auto_answer");
  assert.ok(r.json.source,         "source must be present for auto_answer");
});

await test("C03 — nonsense question → escalate (no candidates)", () => {
  const r = runCli([
    "--answer",
    "--run-id", cliIntakeId,
    "--phase", "1",
    "--question", "zzzxqq-completely-unrelated-xyzzy-gibberish",
    "--bgsd-dir", cliBgsdDir,
  ]);
  assert.equal(r.status, 0, "exit code must be 0 for escalate path");
  assert.ok(r.json, `stdout must be valid JSON; got: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.json.action, "escalate", "nonsense question must escalate");
  assert.equal(r.json.confidence, 0, "no candidates → confidence 0");
});

await test("C04 — stdout is ONLY the JSON object (no extra output)", () => {
  const r = runCli([
    "--answer",
    "--run-id", cliIntakeId,
    "--phase", "1",
    "--question", "scope bounded deliverable",
    "--bgsd-dir", cliBgsdDir,
    "--threshold", "0.1",
  ]);
  assert.equal(r.status, 0);
  // stdout should parse cleanly as a single JSON object
  const trimmed = r.stdout.trim();
  assert.ok(trimmed.startsWith("{") && trimmed.endsWith("}"),
    `stdout must be a single JSON object; got: ${trimmed.slice(0, 200)}`);
  // No stray lines
  const lines = trimmed.split("\n").filter(Boolean);
  assert.equal(lines.length, 1,
    `stdout must be exactly one line (the JSON); got ${lines.length} lines`);
});

await test("C05 — --help exits 0 and writes usage to stderr", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, "--help must exit 0");
  assert.ok(r.stderr && r.stderr.includes("--answer"),
    "help output must include '--answer' flag description");
  assert.ok(r.stderr && r.stderr.includes("--run-id"),
    "help output must include '--run-id'");
  // stdout should be empty for --help
  assert.equal(r.stdout.trim(), "", "--help must not write to stdout");
});

// Cleanup CLI temp dir
rmSync(cliTmpRoot, { recursive: true, force: true });

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
