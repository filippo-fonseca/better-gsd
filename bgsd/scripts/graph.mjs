#!/usr/bin/env node
/**
 * graph.mjs — Phase 1: GRAPH-02, GRAPH-03 (Dependency Graph)
 *
 * Builds a directed acyclic dependency graph (DAG) from a units array,
 * groups units into topological waves, and runs a verification pass.
 *
 * DESIGN PRINCIPLES
 * =================
 * - All pure functions: no I/O, no model calls, no process spawning (NFR-05).
 * - The graph is a plain, serializable object — written to RUN.md by the Conductor.
 * - Fail-loud: a cyclic graph is rejected with a clear error rather than silently
 *   continuing (NFR-06). A graph that fails verification is never marked ready.
 * - False-independence detection: units whose touched-surface estimates overlap
 *   but declare no dependency between them are flagged as likely hidden conflicts
 *   (GRAPH-03, Plan Part 9 §6). The heuristic biases toward declaring a dependency.
 *
 * DATA STRUCTURES
 * ===============
 *
 * Graph:
 * {
 *   nodes:   Map<id, Unit>        — the unit objects indexed by id
 *   edges:   Map<id, Set<id>>     — outgoing edges: id -> Set of dep ids
 *   reverseEdges: Map<id, Set<id>> — incoming edges: dep_id -> Set of dependent ids
 * }
 *
 * Wave grouping (GRAPH-02):
 *   An ordered array of arrays of unit ids.
 *   waves[0] = ids with no deps (independent, launch first)
 *   waves[1] = ids whose only deps are in waves[0]
 *   etc.
 *
 * Verification result (GRAPH-03):
 * {
 *   ok:               boolean
 *   cycles:           string[][]   — each cycle as an ordered path of ids
 *   falseIndependent: Array<{ unitA, unitB, overlap: string[] }>
 *                     — pairs flagged as likely hidden dependencies
 * }
 *
 * Usage (library):
 *   import { buildGraph, topoWaves, verifyGraph, serializeGraph } from './graph.mjs';
 *
 *   const graph = buildGraph(units);
 *   const { ok, cycles, falseIndependent } = verifyGraph(graph);
 *   if (!ok) throw new Error('Graph failed verification');
 *   const waves = topoWaves(graph);  // [ [id1, id2], [id3], ... ]
 */

// ---------------------------------------------------------------------------
// buildGraph — construct the adjacency structure (GRAPH-02)
// ---------------------------------------------------------------------------

/**
 * Build a graph from a units array.
 *
 * Validates that every dep id referenced in a unit's deps[] actually exists
 * as a node in the graph. Unknown dep ids are collected as errors in the
 * returned graph's `unknownDeps` field (the Conductor treats this as a
 * decomposition error and re-decomposes).
 *
 * @param {Array<{ id: string, deps: string[], touched: string[], ... }>} units
 * @returns {{
 *   nodes:        Map<string, object>,
 *   edges:        Map<string, Set<string>>,
 *   reverseEdges: Map<string, Set<string>>,
 *   unknownDeps:  Array<{ unitId: string, missingDep: string }>
 * }}
 */
export function buildGraph(units) {
  if (!Array.isArray(units)) {
    throw new Error("buildGraph: units must be an array");
  }

  const nodes = new Map();
  const edges = new Map();
  const reverseEdges = new Map();

  // Register all nodes first so dep resolution can check existence
  for (const unit of units) {
    if (!unit.id || typeof unit.id !== "string") {
      throw new Error(`buildGraph: every unit must have a string id; got ${JSON.stringify(unit.id)}`);
    }
    if (nodes.has(unit.id)) {
      throw new Error(`buildGraph: duplicate unit id "${unit.id}"`);
    }
    nodes.set(unit.id, unit);
    edges.set(unit.id, new Set());
    reverseEdges.set(unit.id, new Set());
  }

  // Register all edges
  const unknownDeps = [];
  for (const unit of units) {
    const deps = Array.isArray(unit.deps) ? unit.deps : [];
    for (const depId of deps) {
      if (!nodes.has(depId)) {
        unknownDeps.push({ unitId: unit.id, missingDep: depId });
        continue;
      }
      edges.get(unit.id).add(depId);
      reverseEdges.get(depId).add(unit.id);
    }
  }

  return { nodes, edges, reverseEdges, unknownDeps };
}

// ---------------------------------------------------------------------------
// topoWaves — topological wave grouping (GRAPH-02)
// ---------------------------------------------------------------------------

/**
 * Compute topological wave groups from a verified graph.
 *
 * A wave is the set of units whose all dependencies have been "resolved" by
 * earlier waves. Wave 0 = units with no deps. Wave 1 = units whose only deps
 * are in Wave 0. Etc.
 *
 * Precondition: the graph must be acyclic. If there are cycles, topoWaves()
 * throws rather than silently returning a partial result (NFR-06).
 *
 * @param {{ nodes: Map, edges: Map, reverseEdges: Map }} graph
 * @returns {string[][]}  ordered array of waves, each wave is an array of unit ids.
 *                        The ids within a wave are sorted for deterministic output.
 */
export function topoWaves(graph) {
  const { nodes, edges } = graph;

  // Compute in-degree (number of unresolved deps) for each node
  const inDegree = new Map();
  for (const id of nodes.keys()) {
    inDegree.set(id, edges.get(id)?.size ?? 0);
  }

  const waves = [];
  const resolved = new Set();

  // BFS-style wave extraction
  while (resolved.size < nodes.size) {
    // Collect all nodes with in-degree 0 that are not yet resolved
    const wave = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0 && !resolved.has(id)) {
        wave.push(id);
      }
    }

    if (wave.length === 0) {
      // No nodes with in-degree 0 but unresolved nodes remain = cycle
      const remaining = [...nodes.keys()].filter((id) => !resolved.has(id));
      throw new Error(
        `topoWaves: cycle detected — cannot compute waves. Remaining nodes: [${remaining.join(", ")}]. ` +
        `Run verifyGraph() first to get the cycle detail.`
      );
    }

    // Sort for determinism
    wave.sort();
    waves.push(wave);

    // Mark resolved and reduce in-degrees of dependents
    for (const id of wave) {
      resolved.add(id);
      // `reverseEdges[id]` = nodes that depend ON id (i.e. id is a dep of those nodes)
      for (const dependent of (graph.reverseEdges.get(id) ?? [])) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      }
    }
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Cycle detection — DFS-based (GRAPH-03)
// ---------------------------------------------------------------------------

/**
 * Detect all cycles in the graph using iterative DFS.
 * Returns an array of cycles, where each cycle is a path of ids that forms a
 * cycle (the last id is a dep of the first, completing the loop).
 *
 * Returns [] if the graph is acyclic.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {string[][]}  array of cycles, each an ordered id path
 */
export function detectCycles(graph) {
  const { nodes, edges } = graph;

  const WHITE = 0; // unvisited
  const GRAY  = 1; // in current DFS path
  const BLACK = 2; // fully processed

  const color  = new Map();
  const parent = new Map();
  const cycles = [];

  for (const id of nodes.keys()) {
    color.set(id, WHITE);
  }

  /**
   * DFS visit from `startId`. Uses an explicit stack to avoid call-stack overflow
   * on large graphs.
   */
  function dfsVisit(startId) {
    // Stack entries: [nodeId, iteratorOverDeps]
    const stack = [[startId, edges.get(startId)[Symbol.iterator]()]];
    color.set(startId, GRAY);

    while (stack.length > 0) {
      const [nodeId, iter] = stack[stack.length - 1];
      const next = iter.next();

      if (next.done) {
        // All neighbours processed: mark black and pop
        color.set(nodeId, BLACK);
        stack.pop();
      } else {
        const depId = next.value;
        if (color.get(depId) === GRAY) {
          // Back edge: found a cycle. Reconstruct the path.
          const cyclePath = [depId];
          // Walk back up the stack collecting the cycle
          for (let i = stack.length - 1; i >= 0; i--) {
            cyclePath.unshift(stack[i][0]);
            if (stack[i][0] === depId) break;
          }
          cycles.push(cyclePath);
        } else if (color.get(depId) === WHITE) {
          color.set(depId, GRAY);
          parent.set(depId, nodeId);
          stack.push([depId, edges.get(depId)[Symbol.iterator]()]);
        }
      }
    }
  }

  for (const id of nodes.keys()) {
    if (color.get(id) === WHITE) {
      dfsVisit(id);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// False-independence detection — overlap heuristic (GRAPH-03)
// ---------------------------------------------------------------------------

/**
 * Flag pairs of units that are declared independent (no dep between them)
 * but whose touched-surface estimates overlap.
 *
 * Overlap is detected by glob/area string comparison:
 *   - Exact match: both units list the same touched string.
 *   - Prefix match: one touched string is a path prefix of the other
 *     (e.g. "src/api" overlaps with "src/api/routes.ts").
 *
 * This is intentionally conservative (biases toward flagging) because a false
 * flag is cheaper than a missed hidden conflict that poisons parallelism
 * (Plan Part 9 §6, GRAPH-03).
 *
 * Only units with at least one touched entry participate (units with empty
 * touched arrays are assumed to be globally-scoped and are never pair-flagged
 * here — the Conductor treats them as "touch everything" and forces them to
 * wave 0 dependency if any other unit has them as a dep).
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @returns {Array<{ unitA: string, unitB: string, overlap: string[] }>}
 */
export function detectFalseIndependence(graph) {
  const { nodes, edges } = graph;
  const unitList = [...nodes.values()].filter((u) =>
    Array.isArray(u.touched) && u.touched.length > 0
  );

  const flagged = [];

  for (let i = 0; i < unitList.length; i++) {
    for (let j = i + 1; j < unitList.length; j++) {
      const a = unitList[i];
      const b = unitList[j];

      // Skip if there is already a declared dep between them (in either direction)
      if (edges.get(a.id)?.has(b.id) || edges.get(b.id)?.has(a.id)) {
        continue;
      }

      // Find overlapping touched entries
      const overlap = findTouchedOverlap(a.touched, b.touched);
      if (overlap.length > 0) {
        flagged.push({ unitA: a.id, unitB: b.id, overlap });
      }
    }
  }

  return flagged;
}

/**
 * Find overlapping paths/globs between two touched arrays.
 * Returns the set of overlapping strings (from unitA's perspective).
 *
 * Overlap rules:
 *   1. Exact string match.
 *   2. One is a path prefix of the other (a "/" is appended to test prefix
 *      so "src/api" does NOT match "src/api-v2" as a prefix).
 *   3. Both end with "/**" and share a common base path.
 *
 * @param {string[]} touchedA
 * @param {string[]} touchedB
 * @returns {string[]}  entries from touchedA that overlap with at least one entry in touchedB
 */
export function findTouchedOverlap(touchedA, touchedB) {
  const overlapping = [];
  for (const a of touchedA) {
    for (const b of touchedB) {
      if (pathsOverlap(a, b)) {
        overlapping.push(a);
        break;
      }
    }
  }
  return overlapping;
}

/**
 * Determine whether two path/glob strings overlap.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function pathsOverlap(a, b) {
  if (a === b) return true;

  // Strip trailing /** for prefix comparison
  const normalize = (s) => s.replace(/\/\*\*$/, "");
  const na = normalize(a);
  const nb = normalize(b);

  // Prefix check: na is a directory prefix of nb (or vice versa)
  // Append "/" to avoid "src/api" matching "src/api-v2"
  if (nb.startsWith(na + "/") || na.startsWith(nb + "/")) return true;

  // Direct equality after normalization
  if (na === nb) return true;

  return false;
}

// ---------------------------------------------------------------------------
// verifyGraph — full verification pass (GRAPH-03)
// ---------------------------------------------------------------------------

/**
 * Run the full graph verification pass.
 *
 * Checks:
 *   1. Cycle detection (a cyclic graph is NEVER ready — NFR-06).
 *   2. Unknown dep ids (referenced dep ids not present as nodes).
 *   3. False-independence / overlap heuristic (GRAPH-03).
 *
 * Returns a verification result. A graph is `ok` only when:
 *   - No cycles.
 *   - No unknown deps.
 *   (False-independence warnings do NOT block readiness by themselves but
 *   are always surfaced so the Conductor can decide whether to escalate.)
 *
 * @param {{ nodes: Map, edges: Map, reverseEdges: Map, unknownDeps: Array }} graph
 * @returns {{
 *   ok:               boolean,
 *   cycles:           string[][],
 *   unknownDeps:      Array<{ unitId, missingDep }>,
 *   falseIndependent: Array<{ unitA, unitB, overlap }>
 * }}
 */
export function verifyGraph(graph) {
  const cycles = detectCycles(graph);
  const falseIndependent = detectFalseIndependence(graph);
  const unknownDeps = graph.unknownDeps ?? [];

  const ok = cycles.length === 0 && unknownDeps.length === 0;

  return { ok, cycles, unknownDeps, falseIndependent };
}

// ---------------------------------------------------------------------------
// serializeGraph — produce a human-readable summary for RUN.md (GRAPH-02)
// ---------------------------------------------------------------------------

/**
 * Serialize a graph + wave grouping to a Markdown block for RUN.md.
 *
 * @param {{ nodes: Map, edges: Map }} graph
 * @param {string[][]}  waves             output of topoWaves()
 * @param {object}      [verifyResult]    output of verifyGraph() (optional)
 * @returns {string}  Markdown text
 */
export function serializeGraph(graph, waves, verifyResult) {
  const { nodes } = graph;
  const lines = [];

  lines.push("## Dependency Graph");
  lines.push("");
  lines.push(`**Nodes:** ${nodes.size}  **Waves:** ${waves.length}`);
  lines.push("");

  for (let w = 0; w < waves.length; w++) {
    lines.push(`### Wave ${w}`);
    for (const id of waves[w]) {
      const unit = nodes.get(id);
      const deps = [...(graph.edges.get(id) ?? [])];
      const depsStr = deps.length > 0 ? `deps: [${deps.join(", ")}]` : "no deps";
      lines.push(`- **${id}** — ${unit?.title ?? "(unknown)"}  (${depsStr})`);
    }
    lines.push("");
  }

  if (verifyResult) {
    lines.push("### Verification");
    lines.push(`**Status:** ${verifyResult.ok ? "PASS" : "FAIL"}`);
    if (verifyResult.cycles.length > 0) {
      lines.push(`**Cycles detected (${verifyResult.cycles.length}):**`);
      for (const cycle of verifyResult.cycles) {
        lines.push(`  - ${cycle.join(" -> ")}`);
      }
    }
    if (verifyResult.unknownDeps.length > 0) {
      lines.push(`**Unknown dep ids (${verifyResult.unknownDeps.length}):**`);
      for (const { unitId, missingDep } of verifyResult.unknownDeps) {
        lines.push(`  - ${unitId} references unknown dep "${missingDep}"`);
      }
    }
    if (verifyResult.falseIndependent.length > 0) {
      lines.push(`**False-independence warnings (${verifyResult.falseIndependent.length}):**`);
      for (const { unitA, unitB, overlap } of verifyResult.falseIndependent) {
        lines.push(`  - ${unitA} ↔ ${unitB}  shared surface: [${overlap.join(", ")}]`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
