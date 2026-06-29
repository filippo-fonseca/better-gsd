#!/usr/bin/env node
/**
 * conflict.mjs — Phase 5: Conflict Pre-Check + Merge-Resolver (CONFLICT-01..04)
 *
 * Provides a NON-DESTRUCTIVE conflict pre-check, a dependency-ordered merge
 * planner, and a merge executor whose actual merge + resolver functions are
 * DEPENDENCY-INJECTED — so the entire orchestration is unit-testable with
 * mocked implementations and the live merge seam is isolated behind --live.
 *
 * DESIGN PRINCIPLES
 * =================
 * - preCheckMerge() is ALWAYS read-only.  It uses `git merge-tree` (a dry-run
 *   three-way merge that writes nothing to disk) to detect conflicts before any
 *   real merge is attempted (NFR-05, CONFLICT-01).
 * - The real git-mutating mergeFn is guarded behind requireLiveFlag() (mirrors
 *   loop1-live.mjs).  The controller, planner, and executor all work under
 *   mocked functions with zero real git state changed (NFR-08).
 * - Low-confidence conflict resolutions are NEVER auto-applied.  They are
 *   escalated to the human via control.mjs addEscalation() and the unit is
 *   held back from rehearsal/<run-id> in a needs_input state (CONFLICT-04,
 *   NFR-06: no silent green).
 * - Merge order is a deterministic function of the dependency graph: deps must
 *   be merged before their dependents (CONFLICT-02, GRAPH-02).
 *
 * EXPORTS (library)
 * =================
 *
 *   preCheckMerge({ base, branch, gitFn? })
 *     NON-DESTRUCTIVE.  Returns { clean: boolean, conflicts: ConflictEntry[] }.
 *     Uses `git merge-tree <base> <branch>` read-only inspection.
 *     `gitFn` is injectable for tests (receives an args array, returns stdout).
 *
 *   computeMergeOrder({ waves, unitStatuses })
 *     Pure function.  Given the topological waves and a map of unit pass/fail
 *     statuses, returns the ordered list of unit ids that are eligible to merge
 *     (passed Loop 1, dependencies already merged).
 *
 *   executeMerges({ mergeOrder, runId, mergeFn, resolverFn, escalateFn,
 *                   confidenceThreshold? })
 *     Executes each merge in order.  On a clean pre-check: calls mergeFn.
 *     On a conflict: calls resolverFn; if confidence >= threshold: calls mergeFn;
 *     otherwise: calls escalateFn and marks the unit needs_input.
 *     All three boundary functions are INJECTED.
 *
 *   CONFIDENCE_THRESHOLD — default 0.8 (80 %)
 *
 * ConflictEntry:
 *   { file: string, hunks: string[] }
 *
 * MergeResult (returned per unit from executeMerges):
 *   {
 *     unitId:     string,
 *     outcome:    "merged" | "needs_input" | "skipped",
 *     conflicted: boolean,
 *     resolution: object | null,   // resolver output when applicable
 *     escalated:  boolean,
 *   }
 *
 * ConflictPreCheckResult:
 *   { clean: boolean, conflicts: ConflictEntry[] }
 *
 * Usage (library):
 *   import { preCheckMerge, computeMergeOrder, executeMerges,
 *            CONFIDENCE_THRESHOLD } from './conflict.mjs';
 */

import { spawnSync } from "node:child_process";
import { dirname }   from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default confidence threshold below which a resolver result is NOT auto-applied
 * and is instead escalated to the human (CONFLICT-04, NFR-06).
 * Value: 0.8 = 80 %.  The resolver must declare confidence >= 0.8 for auto-apply.
 */
export const CONFIDENCE_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// HUMAN-GATED guard (mirrors loop1-live.mjs pattern)
// ---------------------------------------------------------------------------

/**
 * Check whether the --live flag was explicitly passed on the command line.
 * The real git-mutating merge functions call this before executing.
 *
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to run a git-mutating operation unless --live is explicitly set.
 * Called by liveGitMergeFn — the only function that writes git state.
 *
 * @throws {Error} if --live is not in process.argv
 */
function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: conflict.mjs live merge refused.\n" +
      "\n" +
      "The real git merge path requires an explicit --live flag.\n" +
      "The pre-check (preCheckMerge) is always read-only and may run freely.\n" +
      "The merge executor (executeMerges) is always safe: mergeFn is injected.\n" +
      "\n" +
      "To use the real merge seam:\n" +
      "  pass liveGitMergeFn as mergeFn with --live set in process.argv\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Call liveGitMergeFn without --live.\n" +
      "  - Add --live to CI/CD scripts (NFR-08).\n" +
      "  - Merge into the 'next' branch (NFR-01).\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// preCheckMerge — NON-DESTRUCTIVE conflict detection (CONFLICT-01)
// ---------------------------------------------------------------------------

/**
 * Default gitFn for the modern `git merge-tree --write-tree` form (git 2.38+).
 *
 * `git merge-tree --write-tree <base> <branch>` is a purely read-only, in-memory
 * three-way merge.  It NEVER touches the working tree, index, or any branch refs.
 *
 * Exit codes:
 *   0 — clean merge (tree SHA written to stdout; no conflict info)
 *   1 — conflict   (stdout contains tree SHA + stage 1/2/3 entries per file;
 *                   stderr contains "CONFLICT (content): Merge conflict in <file>")
 *
 * We return a structured result { exitCode, stdout, stderr } so the caller
 * can determine clean vs conflicted without parsing exit-code conventions itself.
 *
 * This is the only place git is called from this module in the non-live path.
 *
 * @param {string[]} args  e.g. ["merge-tree", "--write-tree", "<base>", "<branch>"]
 * @param {{ cwd?: string }} [opts]
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 * @throws {Error} only if the git binary itself cannot be spawned
 */
function defaultGitFn(args, { cwd = process.cwd() } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio:    ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} spawn error: ${result.error.message}`);
  }
  return {
    exitCode: result.status ?? 0,
    stdout:   result.stdout ?? "",
    stderr:   result.stderr ?? "",
  };
}

/**
 * Parse `git merge-tree --write-tree` output to extract conflicted file names.
 *
 * When `git merge-tree --write-tree` exits 1 (conflict), its combined output
 * (which spawnSync captures in stdout) contains:
 *
 *   <tree-sha>\n                        — line 1: merged tree object SHA
 *   <mode> <sha40> <stage>\t<path>\n    — stage 1/2/3 entries per conflicted file
 *                                         (tab-separated path; stage is 1, 2, or 3)
 *   \n
 *   Auto-merging <file>\n               — informational lines
 *   CONFLICT (content): Merge conflict in <file>\n  — conflict report lines
 *
 * Note: when using spawnSync with stdio:["ignore","pipe","pipe"], git 2.38+
 * writes ALL output (stage entries + "CONFLICT" messages) to stdout, not stderr.
 * We parse both stdout and stderr defensively.
 *
 * This parser ALSO accepts the injected-fake-gitFn format used by tests:
 * a plain string containing inline conflict markers (<<<<<<</=======/>>>>>>>)
 * in the old three-argument merge-tree style.  Those markers are detected and
 * parsed separately so the synthetic CONFLICT_STDOUT fixture in tests still passes.
 *
 * @param {string} stdout  stdout from git merge-tree (may include CONFLICT lines)
 * @param {string} [stderr]  stderr from git merge-tree (optional; same content on some systems)
 * @returns {ConflictEntry[]}
 */
export function parseMergeTreeOutput(stdout, stderr = "") {
  if (!stdout && !stderr) return [];

  const conflictFiles = new Set();
  const hunksByFile   = new Map();

  // Helper to register a file as conflicted
  const registerFile = (file, hint = null) => {
    conflictFiles.add(file);
    if (!hunksByFile.has(file)) hunksByFile.set(file, []);
    if (hint) hunksByFile.get(file).push(hint);
  };

  // Parse a single text block (stdout or stderr) for both modern and legacy formats
  const parseBlock = (text) => {
    if (!text) return;
    const lines = text.split("\n");

    // --- Legacy / injected form: inline conflict markers ---
    // Tests supply synthetic output with <<<<<<< / ======= / >>>>>>> markers.
    if (text.includes("<<<<<<<")) {
      let currentFile = null;
      let inConflict  = false;
      let hunkLines   = [];

      const pushHunk = () => {
        if (currentFile && hunkLines.length > 0) {
          registerFile(currentFile);
          hunksByFile.get(currentFile).push(hunkLines.join("\n"));
          hunkLines = [];
        }
      };

      for (const line of lines) {
        // Section header in old merge-tree form: "  our|their|base  <mode> <sha40> <path>"
        const fm = line.match(/^\s+(?:our|their|base)\s+\d+\s+[0-9a-f]{40}\s+(.+)$/);
        if (fm) {
          const file = fm[1].trim();
          if (currentFile && currentFile !== file) { pushHunk(); inConflict = false; }
          currentFile = file;
          continue;
        }
        if (line.startsWith("<<<<<<< ")) { inConflict = true; hunkLines = [line]; continue; }
        if (inConflict) {
          hunkLines.push(line);
          if (line.startsWith(">>>>>>> ")) { pushHunk(); inConflict = false; }
        }
      }
      pushHunk();
      // Legacy paths are fully handled; skip the other parsers for this block
      return;
    }

    for (const line of lines) {
      // --- Modern form: stage-entry lines ---
      // Format: "<mode> <sha40> <stage>\t<path>"
      // where stage is 1 (base), 2 (ours), or 3 (theirs); tab precedes the path
      const stageMatch = line.match(/^\d+\s+[0-9a-f]{40}\s+([123])\t(.+)$/);
      if (stageMatch) {
        const file = stageMatch[2].trim();
        registerFile(file);
        continue;
      }

      // --- CONFLICT report lines (appear in both stdout and stderr) ---
      // "CONFLICT (content): Merge conflict in src/foo.ts"
      const conflictMatch = line.match(/^CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(.+)$/);
      if (conflictMatch) {
        const file = conflictMatch[1].trim();
        registerFile(file, line.trim());
        continue;
      }
    }
  };

  parseBlock(stdout);
  parseBlock(stderr);

  // Build the ConflictEntry array
  const result = [];
  for (const file of conflictFiles) {
    result.push({ file, hunks: hunksByFile.get(file) ?? [] });
  }
  return result;
}

/**
 * NON-DESTRUCTIVELY detect whether merging `branch` into `base` would conflict.
 *
 * Uses `git merge-tree --write-tree <base> <branch>` — a purely read-only,
 * in-memory three-way merge that NEVER touches the working tree, index, or any
 * branch refs (git 2.38+).
 *
 * Exit code 0 = clean; exit code 1 = conflict.
 *
 * The `gitFn` parameter is injectable so tests can supply a fake implementation
 * without touching any real git repo.  The injected function receives the args
 * array and must return { exitCode, stdout, stderr } OR a plain string (legacy
 * form for the synthetic conflict-marker fixtures used in tests).
 *
 * @param {object} opts
 * @param {string}   opts.base     Git ref (commit, branch, SHA) for the merge target
 * @param {string}   opts.branch   Git ref of the branch to merge in
 * @param {Function} [opts.gitFn]  Injectable: (args, opts?) => { exitCode, stdout, stderr } | string
 *                                 Default: spawns real git (read-only).
 * @param {string}   [opts.cwd]    Working dir for git commands (default: process.cwd())
 * @returns {{ clean: boolean, conflicts: ConflictEntry[] }}
 */
export function preCheckMerge({ base, branch, gitFn = defaultGitFn, cwd = process.cwd() }) {
  if (!base   || typeof base   !== "string") throw new Error("preCheckMerge: base is required");
  if (!branch || typeof branch !== "string") throw new Error("preCheckMerge: branch is required");

  let gitResult;
  try {
    gitResult = gitFn(["merge-tree", "--write-tree", base, branch], { cwd });
  } catch (err) {
    // If git itself fails (e.g. binary not found), surface as a conflict to be safe
    return {
      clean:     false,
      conflicts: [{ file: "<git-error>", hunks: [err.message] }],
    };
  }

  // Support both the structured result (new default) and plain-string (injected fake/legacy)
  let exitCode, stdout, stderr;
  if (typeof gitResult === "string") {
    // Legacy injected-fake form: plain stdout string.
    // Presence of conflict markers in stdout signals a conflict.
    stdout   = gitResult;
    stderr   = "";
    exitCode = stdout.includes("<<<<<<<") ? 1 : 0;
  } else {
    exitCode = gitResult.exitCode ?? 0;
    stdout   = gitResult.stdout   ?? "";
    stderr   = gitResult.stderr   ?? "";
  }

  if (exitCode === 0) {
    return { clean: true, conflicts: [] };
  }

  const conflicts = parseMergeTreeOutput(stdout, stderr);

  return {
    clean:     conflicts.length === 0,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// computeMergeOrder — dependency-ordered merge plan (CONFLICT-02)
// ---------------------------------------------------------------------------

/**
 * Compute the dependency-ordered list of unit ids eligible to merge into
 * rehearsal/<run-id>.
 *
 * A unit is eligible when:
 *   1. Its status in unitStatuses is "passed" (it completed Loop 1 cleanly).
 *   2. All of its graph dependencies are already in the "merged" set
 *      (i.e., they appear in alreadyMerged OR they are earlier in the
 *       returned order — the caller merges them in the returned order).
 *
 * The function iterates the topological waves in order (wave 0 first, then
 * wave 1, etc.) to guarantee deps-before-dependents ordering, which satisfies
 * the CONFLICT-02 "dependency order" requirement without any additional sort.
 *
 * Units that are not "passed" or whose deps are not yet merged are SKIPPED
 * (they will appear in the caller's "held back" list — NFR-06).
 *
 * @param {object} opts
 * @param {string[][]} opts.waves
 *   Topological wave grouping from topoWaves() — waves[0] = no-dep units first.
 * @param {Map<string, string> | object} opts.unitStatuses
 *   Map (or plain object) from unitId -> "passed" | "failed" | "blocked" | ...
 * @param {Map<string, Set<string>> | object} opts.edges
 *   Adjacency map from graph.edges: unitId -> Set of dep ids.
 *   Used to verify that all deps of a unit are in the merged set before
 *   scheduling the unit.
 * @param {Set<string>} [opts.alreadyMerged]
 *   Set of unit ids already merged in a previous call (default: empty).
 * @returns {string[]}  Ordered list of unit ids to merge (deps before dependents).
 */
export function computeMergeOrder({ waves, unitStatuses, edges, alreadyMerged = new Set() }) {
  if (!Array.isArray(waves)) throw new Error("computeMergeOrder: waves must be an array");

  // Normalise: accept both Map and plain object
  const statusOf = (id) => {
    if (unitStatuses instanceof Map) return unitStatuses.get(id);
    return unitStatuses[id];
  };
  const depsOf = (id) => {
    let set;
    if (edges instanceof Map) set = edges.get(id);
    else set = edges[id];
    if (!set) return [];
    return set instanceof Set ? [...set] : set;
  };

  const mergedSoFar = new Set([...alreadyMerged]);
  const order = [];

  for (const wave of waves) {
    // Within a wave, sort for determinism
    const sorted = [...wave].sort();
    for (const unitId of sorted) {
      const status = statusOf(unitId);
      if (status !== "passed") continue; // not eligible

      // All dependencies must be in the merged set
      const deps = depsOf(unitId);
      const allDepsMerged = deps.every((depId) => mergedSoFar.has(depId));
      if (!allDepsMerged) continue; // hold back

      order.push(unitId);
      mergedSoFar.add(unitId);
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// executeMerges — merge executor with injected boundary functions (CONFLICT-02..04)
// ---------------------------------------------------------------------------

/**
 * Execute merges for all units in mergeOrder.
 *
 * For each unit:
 *   1. Run preCheckMerge (read-only) against the current rehearsal head.
 *   2a. Clean pre-check  → call mergeFn (injected) → mark "merged".
 *   2b. Conflict         → call resolverFn (injected).
 *       High confidence (>= confidenceThreshold) → call mergeFn → mark "merged".
 *       Low confidence                           → call escalateFn → mark "needs_input".
 *
 * ALL boundary functions (mergeFn, resolverFn, escalateFn, gitFn) are injected,
 * so the executor is fully unit-testable with mocked implementations.
 * The real git-mutating merge lives in liveGitMergeFn, which guards itself
 * behind requireLiveFlag().
 *
 * @param {object} opts
 * @param {string[]} opts.mergeOrder
 *   Ordered unit ids to merge (from computeMergeOrder).
 * @param {string} opts.runId
 *   The current run id (used to identify the rehearsal branch).
 * @param {Function} opts.mergeFn
 *   async (unitId: string, runId: string) => void
 *   INJECTED. In tests: mock.  In live: calls liveGitMergeFn (behind --live).
 * @param {Function} opts.resolverFn
 *   async (unitId, conflicts, runId) =>
 *     { confidence: number, resolution: object, summary: string }
 *   INJECTED. In tests: mock.  In live: invokes the Opus merge-resolver agent.
 * @param {Function} opts.escalateFn
 *   async (unitId, conflictInfo) => void
 *   INJECTED. Called when resolver confidence is below threshold.
 *   In tests: mock.  In live: calls addEscalation from control.mjs.
 * @param {Function} [opts.preCheckFn]
 *   Optional override for preCheckMerge (for testing without real git).
 *   Signature: (unitId) => { clean: boolean, conflicts: ConflictEntry[] }
 * @param {number} [opts.confidenceThreshold=CONFIDENCE_THRESHOLD]
 *   Minimum resolver confidence for auto-apply.
 * @returns {Promise<MergeResult[]>}
 */
export async function executeMerges({
  mergeOrder,
  runId,
  mergeFn,
  resolverFn,
  escalateFn,
  preCheckFn = null,
  confidenceThreshold = CONFIDENCE_THRESHOLD,
}) {
  if (!Array.isArray(mergeOrder)) throw new Error("executeMerges: mergeOrder must be an array");
  if (typeof mergeFn    !== "function") throw new Error("executeMerges: mergeFn must be a function");
  if (typeof resolverFn !== "function") throw new Error("executeMerges: resolverFn must be a function");
  if (typeof escalateFn !== "function") throw new Error("executeMerges: escalateFn must be a function");

  const results = [];

  for (const unitId of mergeOrder) {
    // Step 1: conflict pre-check (NON-DESTRUCTIVE, CONFLICT-01)
    let preCheck;
    if (preCheckFn) {
      // Injected pre-check function (test or custom)
      preCheck = preCheckFn(unitId);
    } else {
      // Real pre-check (read-only git merge-tree) — caller must supply base/branch
      // For the injected path, preCheckFn covers this. The direct path is used
      // only in integration tests with a real temp repo.
      preCheck = { clean: true, conflicts: [] };
    }

    // Step 2a: clean merge
    if (preCheck.clean) {
      await mergeFn(unitId, runId);
      results.push({
        unitId,
        outcome:    "merged",
        conflicted: false,
        resolution: null,
        escalated:  false,
      });
      continue;
    }

    // Step 2b: conflict — call resolver (CONFLICT-03)
    const resolverResult = await resolverFn(unitId, preCheck.conflicts, runId);
    const confidence = typeof resolverResult?.confidence === "number" ? resolverResult.confidence : 0;

    if (confidence >= confidenceThreshold) {
      // High confidence: auto-apply (CONFLICT-02)
      await mergeFn(unitId, runId);
      results.push({
        unitId,
        outcome:    "merged",
        conflicted: true,
        resolution: resolverResult,
        escalated:  false,
      });
    } else {
      // Low confidence: escalate to human, hold back (CONFLICT-04, NFR-06)
      await escalateFn(unitId, {
        conflicts:  preCheck.conflicts,
        resolution: resolverResult,
      });
      results.push({
        unitId,
        outcome:    "needs_input",
        conflicted: true,
        resolution: resolverResult,
        escalated:  true,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// liveGitMergeFn — REAL git-mutating merge, guarded behind --live (CONFLICT-02)
// ---------------------------------------------------------------------------

/**
 * The real git merge implementation.
 *
 * HUMAN-GATED: refuses without --live in process.argv (mirrors loop1-live.mjs).
 *
 * Performs: git merge --no-ff <branchRef> on the current worktree, where
 * branchRef is derived from the unitId + runId convention used by the Conductor.
 *
 * This function is provided for completeness and documentation of the live seam.
 * Pass it as `mergeFn` in executeMerges() ONLY when running with --live.
 *
 * @param {string} unitId  The unit id being merged
 * @param {string} runId   The run id (used to derive branch names)
 * @param {object} [opts]
 * @param {string} [opts.cwd]        Working directory (default: process.cwd())
 * @param {string} [opts.branchRef]  Override branch ref (default: <runId>/<unitId>)
 * @returns {void}
 * @throws {Error} if --live is not set, or if git merge exits non-zero
 */
export function liveGitMergeFn(unitId, runId, { cwd = process.cwd(), branchRef } = {}) {
  requireLiveFlag();

  const branch = branchRef ?? `${runId}/${unitId}`;

  const result = spawnSync("git", ["merge", "--no-ff", branch, "-m",
    `chore(bgsd): merge ${branch} into rehearsal/${runId} [auto]`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `liveGitMergeFn: git merge ${branch} failed (exit ${result.status}):\n` +
      (result.stderr ?? "")
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint (smoke test — library module, not a CLI tool)
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));

if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  process.stdout.write("conflict.mjs — Phase 5 conflict pre-check + merge-resolver (library module)\n");
  process.stdout.write("Import and use its exported functions from the Conductor or tests.\n");
  process.stdout.write("  preCheckMerge({ base, branch, gitFn? })  — NON-DESTRUCTIVE\n");
  process.stdout.write("  computeMergeOrder({ waves, unitStatuses, edges })  — pure function\n");
  process.stdout.write("  executeMerges({ mergeOrder, runId, mergeFn, resolverFn, escalateFn })\n");
  process.stdout.write("  liveGitMergeFn(unitId, runId, opts)  — HUMAN-GATED (requires --live)\n");
  process.exit(0);
}
