#!/usr/bin/env node
/**
 * worktree.mjs — Phase 3: Worktree Fan-Out helpers (SPAWN-01, SPAWN-02)
 *
 * Pure deterministic helpers that, for each unit, compute:
 *   - Worktree path:  .bgsd/runs/<run-id>/worktrees/<unit-id>
 *   - Branch name:    <run-id>/<slug>
 *   - Isolated port:  hash of the worktree path, range 3100–3999
 *   - Ephemeral DB:   .bgsd/runs/<run-id>/dbs/<unit-id>.sqlite
 *
 * Port derivation mirrors runtime-isolate.sh's path_hash + 3100 base so that
 * real server boots (Phase 4 --live) use identical isolation math.
 *
 * PORT COLLISION SAFETY
 * =====================
 * Each worktree path is unique (different unit-id), so each unit gets a
 * deterministically different base port. No two concurrent worktrees share the
 * same hash because the path contains the unit-id. If two units happen to hash
 * to the same base (extremely rare at small N), the scheduler must detect this;
 * worktreePlan() computes all ports up front and raises an error if any two
 * units collide — checked in planWorktrees().
 *
 * SPAWN BOUNDARY (SPAWN-02)
 * ==========================
 * spawnWorktree() is the dependency-injected boundary. In tests, callers inject
 * a mock. In live runs, loop1-live.mjs provides the real implementation.
 * The real stub is clearly marked below and is NOT called in test paths.
 *
 * Usage (library):
 *   import {
 *     worktreePath, branchName, isolatedPort, dbPath,
 *     planWorktrees, spawnWorktreeReal
 *   } from './worktree.mjs';
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Port range — matches runtime-isolate.sh (ISO-01). */
export const PORT_BASE  = 3100;
export const PORT_RANGE = 900;  // 3100–3999

// ---------------------------------------------------------------------------
// Deterministic path helpers (SPAWN-01)
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the worktree directory for a unit.
 *
 * @param {string} repoRoot   Absolute repo root (e.g. /home/user/project)
 * @param {string} runId      Run identifier, e.g. "bgsd-0001-my-feature"
 * @param {string} unitId     Unit identifier, e.g. "unit-abc123"
 * @returns {string}  Absolute path to the worktree checkout
 */
export function worktreePath(repoRoot, runId, unitId) {
  if (!repoRoot || !runId || !unitId) {
    throw new Error("worktreePath: repoRoot, runId, and unitId are all required");
  }
  return join(repoRoot, ".bgsd", "runs", runId, "worktrees", unitId);
}

/**
 * Return the git branch name for a unit's worktree.
 *
 * Convention: <run-id>/<slug> where slug is derived from the unit id.
 *
 * @param {string} runId   Run identifier
 * @param {string} unitId  Unit identifier
 * @returns {string}  Branch name
 */
export function branchName(runId, unitId) {
  if (!runId || !unitId) {
    throw new Error("branchName: runId and unitId are required");
  }
  // Sanitize unitId to be a valid git branch component
  const slug = unitId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${runId}/${slug}`;
}

/**
 * Compute the deterministic port for a worktree, given its absolute path.
 * Mirrors runtime-isolate.sh path_hash logic:
 *   last 4 hex chars of sha256 → decimal → base + (decimal % range)
 *
 * Using the worktree path (which includes unit-id) guarantees distinct ports
 * for distinct units within the same run.
 *
 * @param {string} wtPath  Absolute path to the worktree directory
 * @returns {number}  Port number in [PORT_BASE, PORT_BASE + PORT_RANGE)
 */
export function isolatedPort(wtPath) {
  if (!wtPath) {
    throw new Error("isolatedPort: wtPath is required");
  }
  // sha256 of the path, first 4 hex chars → decimal (mirrors sha256sum | cut -c1-4)
  const hex4 = createHash("sha256").update(wtPath).digest("hex").slice(0, 4);
  const decimal = parseInt(hex4, 16);
  return PORT_BASE + (decimal % PORT_RANGE);
}

/**
 * Return the path to the ephemeral SQLite DB file for a unit's worktree.
 *
 * Each unit gets its own DB file under the run's db directory so that
 * concurrent verification runs never share database state (SPAWN-01, ISO-02).
 *
 * @param {string} repoRoot  Absolute repo root
 * @param {string} runId     Run identifier
 * @param {string} unitId    Unit identifier
 * @returns {string}  Absolute path to the .sqlite file
 */
export function dbPath(repoRoot, runId, unitId) {
  if (!repoRoot || !runId || !unitId) {
    throw new Error("dbPath: repoRoot, runId, and unitId are required");
  }
  return join(repoRoot, ".bgsd", "runs", runId, "dbs", `${unitId}.sqlite`);
}

// ---------------------------------------------------------------------------
// planWorktrees — compute all isolation parameters for a set of units
// ---------------------------------------------------------------------------

/**
 * Compute the full worktree plan (path, branch, port, db) for every unit.
 * Checks for port collisions and raises if any two units would share a port
 * (collision detection runs before any spawn — SPAWN-01).
 *
 * @param {string}   repoRoot  Absolute repo root
 * @param {string}   runId     Run identifier
 * @param {object[]} units     Array of unit objects with at least { id }
 * @returns {Map<string, WorktreePlan>}  unit-id -> plan
 *
 * @typedef {{ unitId: string, path: string, branch: string, port: number, db: string }} WorktreePlan
 */
export function planWorktrees(repoRoot, runId, units) {
  if (!repoRoot || !runId) {
    throw new Error("planWorktrees: repoRoot and runId are required");
  }
  if (!Array.isArray(units) || units.length === 0) {
    throw new Error("planWorktrees: units must be a non-empty array");
  }

  const plans = new Map();
  const portsSeen = new Map(); // port -> unitId

  for (const unit of units) {
    if (!unit.id) {
      throw new Error("planWorktrees: every unit must have an id");
    }
    const path   = worktreePath(repoRoot, runId, unit.id);
    const branch = branchName(runId, unit.id);
    const port   = isolatedPort(path);
    const db     = dbPath(repoRoot, runId, unit.id);

    if (portsSeen.has(port)) {
      throw new Error(
        `planWorktrees: port collision — units "${portsSeen.get(port)}" and "${unit.id}" both hash to port ${port}. ` +
        `Rename one unit to change its worktree path.`
      );
    }
    portsSeen.set(port, unit.id);

    plans.set(unit.id, { unitId: unit.id, path, branch, port, db });
  }

  return plans;
}

// ---------------------------------------------------------------------------
// Spawn boundary — DEPENDENCY-INJECTED (SPAWN-02)
// ---------------------------------------------------------------------------

/**
 * REAL SPAWN STUB — NOT CALLED IN TESTS.
 *
 * This is the real implementation that Phase 4 (--live) will invoke.
 * It is clearly separated here so tests can inject a mock in its place.
 *
 * In a live run this would:
 *   1. `git worktree add <path> -b <branch> <base-ref>`
 *   2. Write the unit's `.planning/config.json` via the config seam.
 *   3. Launch `claude -p` headless on the worktree.
 *
 * The scheduler never calls this directly — it receives a spawnFn parameter
 * so tests inject a mock (mirrors loop1/loop1-live DI split).
 *
 * @param {WorktreePlan} plan   The plan returned by planWorktrees
 * @param {string}       baseRef  Git ref to branch off (rehearsal head or base)
 * @returns {Promise<{ pid: number, worktree: string }>}
 */
export async function spawnWorktreeReal(plan, baseRef) {
  // REAL IMPLEMENTATION — only executed under Phase 4 --live gate.
  // Never reached in unit tests (callers inject a mock spawnFn instead).
  throw new Error(
    "[worktree.mjs] spawnWorktreeReal is the live stub — " +
    "inject a mock spawnFn in tests. Use --live to run for real (Phase 4)."
  );
}

// ---------------------------------------------------------------------------
// dryRunPlan — print spawn plan without launching anything (SPAWN-03, SPAWN-04)
// ---------------------------------------------------------------------------

/**
 * Print the spawn plan (worktrees + branches + ports) to stdout without
 * creating any worktree or process. Used by --dry-run.
 *
 * @param {string}   runId    Run identifier
 * @param {string[][]} waves  Output of topoWaves()
 * @param {Map}      plans    Output of planWorktrees()
 */
export function dryRunPlan(runId, waves, plans) {
  process.stdout.write(`\n[bgsd --dry-run] Spawn plan for run: ${runId}\n`);
  process.stdout.write(`${"=".repeat(60)}\n\n`);

  for (let w = 0; w < waves.length; w++) {
    process.stdout.write(`Wave ${w}:\n`);
    for (const unitId of waves[w]) {
      const plan = plans.get(unitId);
      if (!plan) {
        process.stdout.write(`  ${unitId}  (no plan — unit not in worktree map)\n`);
        continue;
      }
      process.stdout.write(`  Unit:    ${plan.unitId}\n`);
      process.stdout.write(`  Branch:  ${plan.branch}\n`);
      process.stdout.write(`  Path:    ${plan.path}\n`);
      process.stdout.write(`  Port:    ${plan.port}\n`);
      process.stdout.write(`  DB:      ${plan.db}\n`);
      process.stdout.write("\n");
    }
  }

  process.stdout.write(`[bgsd --dry-run] No worktrees or processes were created.\n\n`);
}
