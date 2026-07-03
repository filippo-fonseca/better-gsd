#!/usr/bin/env node
/**
 * test-graph.mjs — Unit tests for decompose.mjs + graph.mjs (Phase 1: GRAPH-01..04)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-graph.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * All tests are deterministic: no model calls, no I/O beyond temp dirs.
 *
 * Test groups:
 *
 * --- decompose.mjs (GRAPH-01, GRAPH-04) ---
 *   D01 — buildUnits: valid descriptors produce correct unit shape
 *   D02 — buildUnits: ids are unique across units
 *   D03 — buildUnits: touched and deps default to []
 *   D04 — buildUnits: title-based dep resolution maps to generated ids
 *   D05 — buildUnits: throws on empty descriptor array
 *   D06 — buildUnits: throws on missing title
 *   D07 — parseDecompositionResponse: parses valid JSON string
 *   D08 — parseDecompositionResponse: parses already-parsed object
 *   D09 — parseDecompositionResponse: strips markdown code fences
 *   D10 — parseDecompositionResponse: throws on missing units array
 *   D11 — parseDecompositionResponse: throws on unit missing title
 *   D12 — difficultyScore: returns value in [0, 1]
 *   D13 — difficultyScore: more touched entries -> higher score
 *   D14  — deriveModelPosture: >=0.5 -> opus executor, NO fablePlan by default (--fable turns it on)
 *   D15  — deriveModelPosture: 0.2..0.5 -> opus/xhigh executor, no fablePlan
 *   D16  — deriveModelPosture: <0.2 -> opus by default, sonnet only with --sonnet
 *   D16b — deriveModelPosture: fablePlan OFF by default at all difficulties, --fable turns it on
 *   D17  — deriveModelPosture: verifier is always opus/medium
 *   D18 — serializeUnits: produces non-empty markdown with unit ids
 *   D19 — writeUnitConfig: writes bgsd_unit_posture to config.json (config seam)
 *
 * --- graph.mjs (GRAPH-02, GRAPH-03) ---
 *   G01 — buildGraph: builds nodes + edges from units
 *   G02 — buildGraph: throws on duplicate unit ids
 *   G03 — buildGraph: records unknownDeps for missing dep ids
 *   G04 — topoWaves: single wave for independent units
 *   G05 — topoWaves: correct wave order for a chain A->B->C
 *   G06 — topoWaves: diamond pattern A->B, A->C, B->D, C->D -> 4 waves
 *   G07 — topoWaves: throws on cyclic graph (with clear error message)
 *   G08 — detectCycles: returns [] for acyclic graph
 *   G09 — detectCycles: finds cycle in a simple A->B->A graph
 *   G10 — detectCycles: finds cycle in a longer chain
 *   G11 — verifyGraph: ok=true for clean acyclic graph
 *   G12 — verifyGraph: ok=false when cycles present
 *   G13 — verifyGraph: ok=false when unknownDeps present
 *   G14 — verifyGraph: falseIndependent does NOT set ok=false (warning only)
 *   G15 — detectFalseIndependence: flags two units with identical touched entry
 *   G16 — detectFalseIndependence: flags path-prefix overlap (src/api vs src/api/routes)
 *   G17 — detectFalseIndependence: does NOT flag when dep already declared
 *   G18 — detectFalseIndependence: does NOT flag when no overlap
 *   G19 — findTouchedOverlap: exact match returns overlapping entry
 *   G20 — findTouchedOverlap: prefix match detected
 *   G21 — findTouchedOverlap: no overlap returns []
 *   G22 — pathsOverlap: exact strings match
 *   G23 — pathsOverlap: glob /** stripped correctly
 *   G24 — pathsOverlap: src/api does NOT overlap src/api-v2
 *   G25 — serializeGraph: produces markdown with wave headings
 *   G26 — full integration: decompose fixture -> build units -> build graph -> verify -> waves
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import {
  generateUnitId,
  difficultyScore,
  deriveModelPosture,
  parseDecompositionResponse,
  buildUnits,
  serializeUnits,
  writeUnitConfig,
} from "./decompose.mjs";

import {
  buildGraph,
  topoWaves,
  detectCycles,
  detectFalseIndependence,
  verifyGraph,
  findTouchedOverlap,
  pathsOverlap,
  serializeGraph,
} from "./graph.mjs";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n`);
    process.stderr.write(`        ${err.message}\n`);
    if (err.stack) {
      const lines = err.stack.split("\n").slice(1, 4);
      for (const l of lines) process.stderr.write(`        ${l.trim()}\n`);
    }
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid raw descriptor set for 3 units */
const THREE_DESCRIPTORS = [
  { title: "Setup database schema",   scope: "Create tables", touched: ["db/schema.sql", "db/migrations/**"], deps: [] },
  { title: "Build API layer",         scope: "REST endpoints", touched: ["src/api/**", "src/models/**"], deps: ["Setup database schema"] },
  { title: "Build frontend UI",       scope: "React components", touched: ["src/ui/**", "src/pages/**"], deps: ["Build API layer"] },
];

/** Helper: build units from THREE_DESCRIPTORS */
function threeUnits() {
  return buildUnits(THREE_DESCRIPTORS);
}

/** Helper: build a simple linear graph A -> B -> C */
function linearGraph() {
  const units = buildUnits([
    { title: "A", touched: ["src/a.ts"], deps: [] },
    { title: "B", touched: ["src/b.ts"], deps: ["A"] },
    { title: "C", touched: ["src/c.ts"], deps: ["B"] },
  ]);
  return { units, graph: buildGraph(units) };
}

/** Helper: build a diamond graph:
 *   A (no deps)
 *   B depends on A
 *   C depends on A
 *   D depends on B and C
 */
function diamondGraph() {
  const rawA = { title: "A", touched: ["src/a.ts"], deps: [] };
  const rawB = { title: "B", touched: ["src/b.ts"], deps: ["A"] };
  const rawC = { title: "C", touched: ["src/c.ts"], deps: ["A"] };
  const rawD = { title: "D", touched: ["src/d.ts"], deps: ["B", "C"] };
  const units = buildUnits([rawA, rawB, rawC, rawD]);
  return { units, graph: buildGraph(units) };
}

/** Helper: build a cyclic graph by manually constructing units with explicit ids */
function cyclicGraph() {
  const idA = "unit-a-0001";
  const idB = "unit-b-0002";
  const units = [
    { id: idA, title: "A", scope: "", touched: ["src/a.ts"], deps: [idB], difficulty: 0.1, model_posture: {} },
    { id: idB, title: "B", scope: "", touched: ["src/b.ts"], deps: [idA], difficulty: 0.1, model_posture: {} },
  ];
  return buildGraph(units);
}

// ---------------------------------------------------------------------------
// decompose.mjs tests (GRAPH-01, GRAPH-04)
// ---------------------------------------------------------------------------

process.stdout.write("\nbgsd graph unit tests (Phase 1: GRAPH-01..04)\n\n");
process.stdout.write("--- decompose.mjs ---\n");

await test("D01: buildUnits produces correct unit shape (id, title, scope, touched, deps, difficulty, model_posture)", () => {
  const units = threeUnits();
  assert.equal(units.length, 3, "must produce 3 units");
  for (const u of units) {
    assert.ok(typeof u.id === "string" && u.id.startsWith("unit-"), `id must be a string starting with 'unit-', got ${u.id}`);
    assert.ok(typeof u.title === "string" && u.title.length > 0, "title must be a non-empty string");
    assert.ok(typeof u.scope === "string", "scope must be a string");
    assert.ok(Array.isArray(u.touched), "touched must be an array");
    assert.ok(Array.isArray(u.deps), "deps must be an array");
    assert.ok(typeof u.difficulty === "number" && u.difficulty >= 0 && u.difficulty <= 1,
      `difficulty must be in [0,1], got ${u.difficulty}`);
    assert.ok(u.model_posture && typeof u.model_posture === "object", "model_posture must be an object");
    assert.ok(u.model_posture.executor, "model_posture.executor must exist");
    assert.ok(u.model_posture.researcher, "model_posture.researcher must exist");
    assert.ok(u.model_posture.verifier, "model_posture.verifier must exist");
  }
});

await test("D02: buildUnits assigns unique ids to all units", () => {
  const units = threeUnits();
  const ids = units.map((u) => u.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "all unit ids must be unique");
});

await test("D03: buildUnits defaults touched=[] and deps=[] when absent", () => {
  const units = buildUnits([{ title: "Bare unit" }]);
  assert.deepEqual(units[0].touched, [], "touched must default to []");
  assert.deepEqual(units[0].deps, [], "deps must default to []");
});

await test("D04: buildUnits resolves title-based deps to generated ids", () => {
  const units = threeUnits();
  const dbUnit  = units.find((u) => u.title === "Setup database schema");
  const apiUnit = units.find((u) => u.title === "Build API layer");
  const uiUnit  = units.find((u) => u.title === "Build frontend UI");

  // API depends on DB; dep should resolve to the DB unit's id
  assert.ok(apiUnit.deps.includes(dbUnit.id),
    `API unit deps must include DB unit id "${dbUnit.id}", got ${JSON.stringify(apiUnit.deps)}`);
  // UI depends on API
  assert.ok(uiUnit.deps.includes(apiUnit.id),
    `UI unit deps must include API unit id "${apiUnit.id}", got ${JSON.stringify(uiUnit.deps)}`);
});

await test("D05: buildUnits throws on empty descriptor array", () => {
  assert.throws(() => buildUnits([]), /non-empty array/);
});

await test("D06: buildUnits throws when a descriptor has no title", () => {
  assert.throws(() => buildUnits([{ scope: "no title here" }]), /title/i);
});

await test("D07: parseDecompositionResponse parses a valid JSON string", () => {
  const raw = JSON.stringify({ units: [{ title: "Unit A", touched: ["src/a.ts"] }] });
  const result = parseDecompositionResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Unit A");
  assert.deepEqual(result[0].touched, ["src/a.ts"]);
});

await test("D08: parseDecompositionResponse accepts an already-parsed object", () => {
  const obj = { units: [{ title: "Unit B" }] };
  const result = parseDecompositionResponse(obj);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Unit B");
});

await test("D09: parseDecompositionResponse strips markdown code fences", () => {
  const withFences = "```json\n" + JSON.stringify({ units: [{ title: "Fenced" }] }) + "\n```";
  const result = parseDecompositionResponse(withFences);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Fenced");
});

await test("D10: parseDecompositionResponse throws when units array is missing", () => {
  assert.throws(
    () => parseDecompositionResponse(JSON.stringify({ notUnits: [] })),
    /units.*array/i
  );
});

await test("D11: parseDecompositionResponse throws on unit missing required title", () => {
  assert.throws(
    () => parseDecompositionResponse(JSON.stringify({ units: [{ scope: "no title" }] })),
    /title/i
  );
});

await test("D12: difficultyScore returns a value in [0, 1]", () => {
  const cases = [
    { touched: [], deps: [], title: "Short", scope: "" },
    { touched: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], deps: ["x", "y", "z", "w"], title: "Very long title with many words here now", scope: "A".repeat(400) },
  ];
  for (const c of cases) {
    const score = difficultyScore(c);
    assert.ok(score >= 0 && score <= 1, `score must be in [0,1], got ${score}`);
  }
});

await test("D13: difficultyScore increases with more touched entries", () => {
  const low  = difficultyScore({ touched: [],               deps: [], title: "Task", scope: "" });
  const high = difficultyScore({ touched: ["a","b","c","d","e","f","g","h"], deps: [], title: "Task", scope: "" });
  assert.ok(high > low, `higher touched count must yield higher score (${high} > ${low})`);
});

await test("D14: deriveModelPosture(>=0.5) -> executor=opus/xhigh, NO fablePlan by default", () => {
  const posture = deriveModelPosture(0.8);
  assert.equal(posture.executor.model, "opus"); // NEVER fable
  assert.equal(posture.executor.effort, "xhigh");
  assert.equal(posture.spawnModel, "opus");     // subprocess is Opus
  assert.equal(posture.fablePlan, false);        // default is plain Opus GSD, no pre-plan
  // --fable turns the pre-plan on for the session:
  assert.equal(deriveModelPosture(0.8, { fable: true }).fablePlan, true);
});

await test("D15: deriveModelPosture(0.2..0.5) -> executor=opus/xhigh, no fablePlan", () => {
  const posture = deriveModelPosture(0.35);
  assert.equal(posture.executor.model, "opus");
  assert.equal(posture.executor.effort, "xhigh");
  assert.equal(posture.spawnModel, "opus");
  assert.equal(posture.fablePlan, false);
});

await test("D16: deriveModelPosture(<0.2) -> executor still opus (sonnet only with --sonnet)", () => {
  const posture = deriveModelPosture(0.15);
  assert.equal(posture.executor.model, "opus");  // default: Opus even on trivial
  assert.equal(posture.spawnModel, "opus");
  const sonnetOptIn = deriveModelPosture(0.15, { sonnet: true });
  assert.equal(sonnetOptIn.executor.model, "sonnet"); // opt-in -> Sonnet on trivial
  assert.equal(sonnetOptIn.spawnModel, "sonnet");
});

await test("D16b: fablePlan is OFF by default at every difficulty; --fable turns it on", () => {
  assert.equal(deriveModelPosture(0.8).fablePlan, false);  // high difficulty, still off
  assert.equal(deriveModelPosture(0.5).fablePlan, false);
  assert.equal(deriveModelPosture(0.1).fablePlan, false);
  assert.equal(deriveModelPosture(0.1, { fable: true }).fablePlan, true); // flag turns it on
  assert.equal(deriveModelPosture(0.8, { fable: true }).fablePlan, true);
  assert.equal(deriveModelPosture(0.8).executor.model, "opus"); // executor never Fable
});

await test("D16c: planner is always opus/high (Fable seeds it externally, never inline)", () => {
  assert.equal(deriveModelPosture(0.8).planner.model, "opus");
  assert.equal(deriveModelPosture(0.5).planner.model, "opus");
  assert.equal(deriveModelPosture(0.1).planner.model, "opus");
  assert.equal(deriveModelPosture(0.8).planner.effort, "high");
});

await test("D16d: scout/researcher floors at Opus — explore quality gates plan quality", () => {
  assert.equal(deriveModelPosture(0.8).researcher.model, "opus");
  assert.equal(deriveModelPosture(0.8).researcher.effort, "high");
  assert.equal(deriveModelPosture(0.3).researcher.model, "opus");
  assert.equal(deriveModelPosture(0.1).researcher.model, "opus"); // trivial still Opus
  assert.equal(deriveModelPosture(0.1).researcher.effort, "medium"); // eased effort
});

await test("D17: deriveModelPosture always yields verifier=opus/medium regardless of score", () => {
  for (const score of [0.0, 0.4, 0.7, 1.0]) {
    const posture = deriveModelPosture(score);
    assert.equal(posture.verifier.model, "opus",
      `verifier.model must always be opus at score=${score}`);
    assert.equal(posture.verifier.effort, "medium",
      `verifier.effort must always be medium at score=${score}`);
  }
});

await test("D18: serializeUnits produces non-empty markdown containing unit ids", () => {
  const units = threeUnits();
  const md = serializeUnits(units, "test prompt");
  assert.ok(md.length > 0, "markdown must be non-empty");
  for (const u of units) {
    assert.ok(md.includes(u.id), `markdown must contain unit id "${u.id}"`);
  }
  assert.ok(md.includes("## Decomposition"), "markdown must include ## Decomposition heading");
});

await test("D19: writeUnitConfig writes bgsd_unit_posture to config.json (config seam, NFR-04)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "bgsd-test-"));
  const planningDir = join(tmpDir, ".planning");
  try {
    const posture = deriveModelPosture(0.8, { fable: true }); // exercise fablePlan serialization
    const configPath = writeUnitConfig(planningDir, posture, "unit-test-xx");

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.ok(config.bgsd_unit_posture, "config must have bgsd_unit_posture");
    assert.equal(config.bgsd_unit_posture.unit_id, "unit-test-xx");
    assert.equal(config.bgsd_unit_posture.executor.model, "opus"); // executor never Fable
    assert.equal(config.bgsd_unit_posture.fablePlan, true);        // --fable -> Fable pre-plan
    assert.equal(config.bgsd_unit_posture.verifier.model, "opus");

    // Confirm it ONLY writes under bgsd_unit_posture — does not touch GSD keys
    const keys = Object.keys(config);
    assert.ok(keys.includes("bgsd_unit_posture"), "must have bgsd_unit_posture key");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// graph.mjs tests (GRAPH-02, GRAPH-03)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- graph.mjs ---\n");

await test("G01: buildGraph produces nodes, edges, and reverseEdges maps from units", () => {
  const { units, graph } = linearGraph();
  assert.equal(graph.nodes.size, 3, "must have 3 nodes");
  assert.equal(graph.edges.size, 3, "must have 3 edge entries (one per node)");
  assert.equal(graph.reverseEdges.size, 3, "must have 3 reverseEdge entries");
  // B depends on A, so A's reverse edge set must include B
  const aId = units.find((u) => u.title === "A").id;
  const bId = units.find((u) => u.title === "B").id;
  assert.ok(graph.reverseEdges.get(aId).has(bId),
    "A's reverse edges must include B (B depends on A)");
});

await test("G02: buildGraph throws on duplicate unit ids", () => {
  const dupId = "unit-dup-0000";
  const units = [
    { id: dupId, title: "Dup1", touched: [], deps: [] },
    { id: dupId, title: "Dup2", touched: [], deps: [] },
  ];
  assert.throws(() => buildGraph(units), /duplicate unit id/i);
});

await test("G03: buildGraph records unknownDeps for missing dep ids", () => {
  const units = [
    { id: "unit-a-0001", title: "A", touched: [], deps: ["unit-nonexistent-xxxx"] },
  ];
  const graph = buildGraph(units);
  assert.equal(graph.unknownDeps.length, 1);
  assert.equal(graph.unknownDeps[0].missingDep, "unit-nonexistent-xxxx");
});

await test("G04: topoWaves — independent units all land in wave 0", () => {
  const units = buildUnits([
    { title: "X", touched: ["x.ts"] },
    { title: "Y", touched: ["y.ts"] },
    { title: "Z", touched: ["z.ts"] },
  ]);
  const graph = buildGraph(units);
  const waves = topoWaves(graph);
  assert.equal(waves.length, 1, "all independent units must be in 1 wave");
  assert.equal(waves[0].length, 3, "wave 0 must contain all 3 ids");
});

await test("G05: topoWaves — chain A->B->C produces 3 waves", () => {
  const { units, graph } = linearGraph();
  const waves = topoWaves(graph);
  assert.equal(waves.length, 3, "linear chain must produce 3 waves");

  const aId = units.find((u) => u.title === "A").id;
  const bId = units.find((u) => u.title === "B").id;
  const cId = units.find((u) => u.title === "C").id;

  assert.ok(waves[0].includes(aId), "A must be in wave 0");
  assert.ok(waves[1].includes(bId), "B must be in wave 1");
  assert.ok(waves[2].includes(cId), "C must be in wave 2");
});

await test("G06: topoWaves — diamond A->B,A->C,B->D,C->D produces correct wave structure", () => {
  const { units, graph } = diamondGraph();
  const waves = topoWaves(graph);

  // A is in wave 0; B and C are in wave 1; D is in wave 2
  const aId = units.find((u) => u.title === "A").id;
  const bId = units.find((u) => u.title === "B").id;
  const cId = units.find((u) => u.title === "C").id;
  const dId = units.find((u) => u.title === "D").id;

  assert.ok(waves[0].includes(aId), "A must be in wave 0");
  // B and C may be in the same wave (wave 1) since both depend only on A
  const wave1 = waves[1];
  assert.ok(wave1.includes(bId), "B must be in wave 1");
  assert.ok(wave1.includes(cId), "C must be in wave 1");
  // D depends on B and C, so it must be in a later wave
  const dWaveIdx = waves.findIndex((w) => w.includes(dId));
  const bWaveIdx = waves.findIndex((w) => w.includes(bId));
  const cWaveIdx = waves.findIndex((w) => w.includes(cId));
  assert.ok(dWaveIdx > bWaveIdx, "D must be in a later wave than B");
  assert.ok(dWaveIdx > cWaveIdx, "D must be in a later wave than C");
});

await test("G07: topoWaves throws on a cyclic graph with clear error message", () => {
  const graph = cyclicGraph();
  assert.throws(
    () => topoWaves(graph),
    /cycle detected/i,
    "topoWaves must throw 'cycle detected' on a cyclic graph"
  );
});

await test("G08: detectCycles returns [] for an acyclic graph", () => {
  const { graph } = linearGraph();
  const cycles = detectCycles(graph);
  assert.deepEqual(cycles, [], "acyclic graph must have no cycles");
});

await test("G09: detectCycles finds cycle in simple A->B->A (both directions)", () => {
  const graph = cyclicGraph();
  const cycles = detectCycles(graph);
  assert.ok(cycles.length > 0, "cyclic graph must have at least one cycle detected");
});

await test("G10: detectCycles finds cycle in a longer chain A->B->C->A", () => {
  const idA = "unit-la-0001";
  const idB = "unit-lb-0002";
  const idC = "unit-lc-0003";
  const units = [
    { id: idA, title: "LA", scope: "", touched: [], deps: [idC], difficulty: 0.1, model_posture: {} },
    { id: idB, title: "LB", scope: "", touched: [], deps: [idA], difficulty: 0.1, model_posture: {} },
    { id: idC, title: "LC", scope: "", touched: [], deps: [idB], difficulty: 0.1, model_posture: {} },
  ];
  const graph = buildGraph(units);
  const cycles = detectCycles(graph);
  assert.ok(cycles.length > 0, "3-node cycle must be detected");
});

await test("G11: verifyGraph returns ok=true for a clean acyclic graph with no unknown deps", () => {
  const { graph } = linearGraph();
  const result = verifyGraph(graph);
  assert.equal(result.ok, true, "clean graph must be ok=true");
  assert.deepEqual(result.cycles, [], "must have no cycles");
  assert.deepEqual(result.unknownDeps, [], "must have no unknownDeps");
});

await test("G12: verifyGraph returns ok=false when cycles are present", () => {
  const graph = cyclicGraph();
  const result = verifyGraph(graph);
  assert.equal(result.ok, false, "cyclic graph must be ok=false");
  assert.ok(result.cycles.length > 0, "must report cycles");
});

await test("G13: verifyGraph returns ok=false when unknown deps are present", () => {
  const units = [
    { id: "unit-a-0001", title: "A", touched: [], deps: ["unit-ghost-0000"] },
  ];
  const graph = buildGraph(units);
  const result = verifyGraph(graph);
  assert.equal(result.ok, false, "graph with unknown deps must be ok=false");
  assert.ok(result.unknownDeps.length > 0, "must report unknownDeps");
});

await test("G14: verifyGraph falseIndependent warnings do NOT set ok=false (warnings only)", () => {
  // Two units with overlapping touched but no declared dep between them
  const units = buildUnits([
    { title: "Shared writer A", touched: ["src/shared/utils.ts"], deps: [] },
    { title: "Shared writer B", touched: ["src/shared/utils.ts"], deps: [] },
  ]);
  const graph = buildGraph(units);
  const result = verifyGraph(graph);
  // The graph is structurally valid (no cycles, no unknown deps) -> ok=true
  assert.equal(result.ok, true, "false-independence warnings must not set ok=false");
  assert.ok(result.falseIndependent.length > 0, "must surface the false-independence warning");
});

await test("G15: detectFalseIndependence flags two units with identical touched entry", () => {
  const units = buildUnits([
    { title: "Unit Alpha", touched: ["src/shared/config.ts"], deps: [] },
    { title: "Unit Beta",  touched: ["src/shared/config.ts"], deps: [] },
  ]);
  const graph = buildGraph(units);
  const flagged = detectFalseIndependence(graph);
  assert.ok(flagged.length >= 1, "must flag units with identical touched entry");
  assert.ok(flagged[0].overlap.includes("src/shared/config.ts"),
    "overlap must contain the shared file");
});

await test("G16: detectFalseIndependence flags path-prefix overlap (src/api vs src/api/routes.ts)", () => {
  const units = buildUnits([
    { title: "API module",  touched: ["src/api"],             deps: [] },
    { title: "API routes",  touched: ["src/api/routes.ts"],   deps: [] },
  ]);
  const graph = buildGraph(units);
  const flagged = detectFalseIndependence(graph);
  assert.ok(flagged.length >= 1,
    `must flag path-prefix overlap (src/api vs src/api/routes.ts); got ${JSON.stringify(flagged)}`);
});

await test("G17: detectFalseIndependence does NOT flag when dep is already declared", () => {
  // If B declares A as a dep, the pair is skipped (not false-independent)
  const units = buildUnits([
    { title: "Writer A", touched: ["src/shared/db.ts"], deps: [] },
    { title: "Writer B", touched: ["src/shared/db.ts"], deps: ["Writer A"] },
  ]);
  const graph = buildGraph(units);
  const flagged = detectFalseIndependence(graph);
  assert.equal(flagged.length, 0,
    "must not flag a pair where a dep is already declared between them");
});

await test("G18: detectFalseIndependence does NOT flag units with no overlap", () => {
  const units = buildUnits([
    { title: "Frontend",  touched: ["src/ui/**"],    deps: [] },
    { title: "Database",  touched: ["db/schema.sql"], deps: [] },
  ]);
  const graph = buildGraph(units);
  const flagged = detectFalseIndependence(graph);
  assert.equal(flagged.length, 0, "must not flag units with completely disjoint touched sets");
});

await test("G19: findTouchedOverlap — exact match returns overlapping entry", () => {
  const overlap = findTouchedOverlap(["src/api.ts", "src/models.ts"], ["src/models.ts"]);
  assert.ok(overlap.includes("src/models.ts"), "exact match must be in overlap");
});

await test("G20: findTouchedOverlap — prefix match detected (src/api overlaps src/api/foo.ts)", () => {
  const overlap = findTouchedOverlap(["src/api"], ["src/api/foo.ts"]);
  assert.ok(overlap.includes("src/api"), `prefix match must be detected; got ${JSON.stringify(overlap)}`);
});

await test("G21: findTouchedOverlap — disjoint sets return []", () => {
  const overlap = findTouchedOverlap(["src/ui/**"], ["db/schema.sql"]);
  assert.deepEqual(overlap, [], "disjoint sets must return empty overlap");
});

await test("G22: pathsOverlap — identical strings overlap", () => {
  assert.equal(pathsOverlap("src/api.ts", "src/api.ts"), true);
});

await test("G23: pathsOverlap — /** suffix stripped for comparison (src/api/** vs src/api/foo.ts)", () => {
  assert.equal(pathsOverlap("src/api/**", "src/api/foo.ts"), true,
    "src/api/** must overlap src/api/foo.ts after stripping /**");
});

await test("G24: pathsOverlap — src/api does NOT overlap src/api-v2 (no false prefix match)", () => {
  assert.equal(pathsOverlap("src/api", "src/api-v2"), false,
    "src/api must NOT be treated as a prefix of src/api-v2");
});

await test("G25: serializeGraph produces markdown with wave headings", () => {
  const { units, graph } = linearGraph();
  const waves = topoWaves(graph);
  const result = verifyGraph(graph);
  const md = serializeGraph(graph, waves, result);
  assert.ok(md.includes("## Dependency Graph"), "must include ## Dependency Graph heading");
  assert.ok(md.includes("Wave 0"), "must include Wave 0");
  assert.ok(md.includes("Wave 1"), "must include Wave 1");
  assert.ok(md.includes("PASS"), "must include verification PASS status");
});

await test("G26: full integration — decompose fixture -> buildUnits -> buildGraph -> verifyGraph -> topoWaves all pass", () => {
  // Full pipeline integration test (GRAPH-01..04)
  const fixture = {
    units: [
      { title: "Init project",       scope: "Scaffold repo", touched: ["package.json", ".gitignore"], deps: [] },
      { title: "Design data model",  scope: "ERD + migrations", touched: ["db/**"],              deps: ["Init project"] },
      { title: "Build API",          scope: "Express routes",  touched: ["src/api/**"],          deps: ["Design data model"] },
      { title: "Build frontend",     scope: "React SPA",       touched: ["src/ui/**"],           deps: ["Build API"] },
      { title: "Write docs",         scope: "User docs",       touched: ["docs/**"],             deps: ["Build API"] },
    ],
  };

  // Step 1: parse (model seam)
  const descriptors = parseDecompositionResponse(fixture);
  assert.equal(descriptors.length, 5, "must parse 5 descriptors");

  // Step 2: build units (GRAPH-01)
  const units = buildUnits(descriptors);
  assert.equal(units.length, 5, "must build 5 units");
  for (const u of units) {
    assert.ok(u.id && u.difficulty >= 0 && u.model_posture.executor, "each unit must have id, difficulty, and posture");
  }

  // Step 3: build graph (GRAPH-02)
  const graph = buildGraph(units);
  assert.equal(graph.nodes.size, 5);
  assert.equal(graph.unknownDeps.length, 0, "no unknown deps in a clean fixture");

  // Step 4: verify graph (GRAPH-03)
  const vr = verifyGraph(graph);
  assert.equal(vr.ok, true, "clean fixture must pass verification");
  assert.deepEqual(vr.cycles, [], "clean fixture must have no cycles");

  // Step 5: compute waves (GRAPH-02)
  const waves = topoWaves(graph);
  // "Init project" is in wave 0 (no deps), "Design data model" in wave 1, etc.
  const initId = units.find((u) => u.title === "Init project").id;
  assert.ok(waves[0].includes(initId), "Init project must be in wave 0");
  // Total waves: Init -> DataModel -> API -> [Frontend + Docs] = 4 waves
  assert.ok(waves.length >= 3, `must have at least 3 waves, got ${waves.length}`);

  // Step 6: serialize (GRAPH-02 "serialized to RUN.md")
  const md = serializeGraph(graph, waves, vr);
  assert.ok(md.length > 0, "serialized graph must be non-empty");
  assert.ok(md.includes("PASS"), "serialized graph must show verification PASS");
});

// ---------------------------------------------------------------------------
// Summary (no silent green — NFR-06)
// ---------------------------------------------------------------------------

const totalDefined = 26 + 19; // G01-G26 + D01-D19
process.stdout.write(`\n${totalDefined} test(s) defined: ${passed} passed, ${failed} failed\n`);

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
