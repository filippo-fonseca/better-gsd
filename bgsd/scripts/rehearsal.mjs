#!/usr/bin/env node
/**
 * rehearsal.mjs — Phase 6: Rehearsal Assembly + Doc Aggregation + Cleanup
 *                 (REHEARSE-01..04)
 *
 * Three capabilities, all deterministic scripts (NFR-05):
 *
 *   1. REHEARSAL ASSEMBLY (REHEARSE-01)
 *      Orchestrate assembling rehearsal/<run-id> from verified worktree branches
 *      in dependency order (reuses conflict.mjs's computeMergeOrder + executeMerges).
 *      The real git checkout -b rehearsal/... + merges are behind a --live guard.
 *      Deterministic assembly PLAN is fully unit-testable with mocked mergeFn.
 *
 *   2. DOC AGGREGATION (REHEARSE-02)
 *      Pure functions that read each worktree's .planning/ artifacts
 *      (RUN.md / ledger / per-unit docs) and aggregate into:
 *        - A run-level RUN.md (prompt, decomposition, graph, timeline)
 *        - An AGENTS.md (per-subagent: asked/did/decided/committed)
 *        - An updated .bgsd/ledger.md index
 *      No model calls. Unit-testable against fixture inputs.
 *
 *   3. REVERSIBLE BRANCH CLEANUP (REHEARSE-03)
 *      Compute which merged branches are safe to delete.
 *      Default: --dry-run (reports what WOULD be deleted).
 *      Live deletion is --live guarded AND records each deleted branch's tip
 *      SHA to a recovery file first (so it is recoverable — NFR-08).
 *      NEVER deletes an unmerged branch.
 *      NEVER deletes rehearsal/* branches.
 *
 * EXPORTS (library)
 * =================
 *
 *   planRehearsalAssembly({ waves, unitStatuses, edges })
 *     Pure function. Returns { assemblyOrder: string[], skipped: string[] }.
 *     Reuses computeMergeOrder from conflict.mjs for dependency ordering.
 *
 *   executeRehearsalAssembly({ assemblyOrder, runId, mergeFn })
 *     Drives the assembly by calling INJECTED mergeFn for each unit in order.
 *     Returns { assembled: string[], failed: string[] }.
 *     The real git checkout + merges live in liveAssembleFn (--live guarded).
 *
 *   aggregateDocs({ runId, worktrees, runPath, bgsdDir, readFileFn? })
 *     Pure aggregation function. Returns { runMd: string, agentsMd: string }.
 *     Writes RUN.md + AGENTS.md under .bgsd/runs/<run-id>/ and updates ledger.md.
 *     readFileFn is injectable for unit tests.
 *
 *   updateLedger({ bgsdDir, runId, state, prompt, mergedCount, heldCount,
 *                  writeFn?, readFn?, existsFn? })
 *     Update the global .bgsd/ledger.md with the run's final state.
 *     I/O functions are injectable for unit tests.
 *
 *   planBranchCleanup({ mergedUnits, runId, unitBranchFn? })
 *     Pure function. Returns { toDelete: BranchInfo[], toRetain: BranchInfo[] }.
 *     toDelete = merged worktree branches (safe to remove, work is in rehearsal/<run-id>).
 *     toRetain = rehearsal/* branches + any unmerged branches (NEVER deleted).
 *
 *   executeBranchCleanup({ plan, runId, bgsdDir, dry?, deleteFn?, gitRevParseFn?,
 *                          writeFn? })
 *     Execute branch cleanup.
 *     dry=true (default): prints report, writes nothing.
 *     dry=false + --live: records SHA recovery file first, then calls deleteFn.
 *     Returns { deleted: BranchInfo[], retained: BranchInfo[], dry: boolean,
 *               recoveryPath: string|null }.
 *
 *   liveAssembleFn(unitId, runId, opts?)
 *     HUMAN-GATED real git checkout + merge implementation.
 *     Requires --live in process.argv.
 *
 *   liveDeleteBranchFn(branch, opts?)
 *     HUMAN-GATED real git branch -d implementation.
 *     Requires --live in process.argv.
 *
 *   isLiveFlagSet()
 *     Returns true if --live is in process.argv.
 *
 * BranchInfo: { unitId: string, branch: string, sha?: string }
 *
 * CHANGELOG (REHEARSE-04)
 *   generateChangelog({ worktrees, readFileFn? })
 *   Pure function. Produces a per-agent CHANGELOG string from each worktree's
 *   commit + summary artifacts. Cheap summarizer call is out of scope for v2
 *   (NFR-05: no model calls in scripts); the output is a structured stub that
 *   a v3 Haiku/low call can enrich. Returns { changelog: string }.
 *
 * Usage (library):
 *   import {
 *     planRehearsalAssembly, executeRehearsalAssembly,
 *     aggregateDocs, updateLedger,
 *     planBranchCleanup, executeBranchCleanup,
 *     generateChangelog,
 *     liveAssembleFn, liveDeleteBranchFn, isLiveFlagSet,
 *   } from './rehearsal.mjs';
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Re-use computeMergeOrder from conflict.mjs for dependency ordering (REHEARSE-01).
import { computeMergeOrder } from "./conflict.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// HUMAN-GATED guard (mirrors loop1-live.mjs + conflict.mjs pattern)
// ---------------------------------------------------------------------------

/**
 * Returns true when --live is explicitly in process.argv.
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to run any git-mutating operation unless --live is explicitly set.
 * Mirrors the pattern in loop1-live.mjs and conflict.mjs.
 *
 * @throws {Error} if --live is not in process.argv
 */
function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: rehearsal.mjs live seam refused.\n" +
      "\n" +
      "The real git branch creation / merge / deletion paths require an\n" +
      "explicit --live flag to prevent accidental automation.\n" +
      "\n" +
      "Safe (always allowed, no flag needed):\n" +
      "  planRehearsalAssembly()    — pure, no git\n" +
      "  planBranchCleanup()        — pure, no git\n" +
      "  aggregateDocs()            — reads files, writes docs (no git)\n" +
      "  executeBranchCleanup(..., dry=true)  — dry-run, no deletion\n" +
      "\n" +
      "To use the live seam (human-supervised only):\n" +
      "  pass liveAssembleFn as mergeFn with --live set in process.argv\n" +
      "  pass liveDeleteBranchFn as deleteFn with --live set in process.argv\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts (NFR-08).\n" +
      "  - Merge into the 'next' branch (NFR-01).\n" +
      "  - Delete a rehearsal/* branch (REHEARSE-03).\n" +
      "  - Delete an unmerged branch (REHEARSE-03, NFR-06).\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// REHEARSE-01: Rehearsal Assembly Plan + Executor
// ---------------------------------------------------------------------------

/**
 * Plan which units should be merged into rehearsal/<run-id> and in what order.
 *
 * Pure function — wraps computeMergeOrder from conflict.mjs to produce the
 * dependency-ordered assembly sequence for the rehearsal branch (REHEARSE-01).
 *
 * @param {object} opts
 * @param {string[][]} opts.waves
 *   Topological wave grouping from topoWaves() — waves[0] = no-dep units.
 * @param {Map<string,string>|object} opts.unitStatuses
 *   Map or plain object: unitId -> "passed" | "failed" | "blocked" | ...
 * @param {Map<string,Set<string>>|object} opts.edges
 *   Adjacency map: unitId -> Set of dep ids.
 * @param {Set<string>} [opts.alreadyMerged]
 *   Set of unit ids already in rehearsal/<run-id> (default: empty).
 * @returns {{ assemblyOrder: string[], skipped: string[] }}
 *   assemblyOrder — ordered unit ids eligible to merge (deps first).
 *   skipped       — unit ids that are NOT eligible (failed/blocked/dep not merged).
 */
export function planRehearsalAssembly({
  waves,
  unitStatuses,
  edges,
  alreadyMerged = new Set(),
}) {
  if (!Array.isArray(waves)) {
    throw new Error("planRehearsalAssembly: waves must be an array");
  }

  // Delegate to conflict.mjs's computeMergeOrder for the dependency-ordered
  // list of units eligible to merge (REHEARSE-01 reuses conflict.mjs ordering).
  // computeMergeOrder seeds its internal mergedSoFar with alreadyMerged so
  // downstream dependents can be unlocked, but may still include already-merged
  // units in its output (they pass the "passed" status check). Filter them out
  // here so that assemblyOrder only contains units that still need assembling.
  const rawOrder = computeMergeOrder({
    waves,
    unitStatuses,
    edges,
    alreadyMerged,
  });
  const assemblyOrder = rawOrder.filter((id) => !alreadyMerged.has(id));

  // Determine which units were skipped (not in assemblyOrder and not already done)
  const allIds = waves.flat();
  const assemblySet = new Set(assemblyOrder);
  const skipped = allIds.filter((id) => !assemblySet.has(id) && !alreadyMerged.has(id));

  return { assemblyOrder, skipped };
}

/**
 * Execute the rehearsal assembly by calling INJECTED mergeFn for each unit
 * in the dependency-ordered assemblyOrder.
 *
 * The mergeFn is fully injected — in tests it is a mock, in live runs it is
 * liveAssembleFn (which requires --live). This keeps the executor unit-testable
 * with zero real git state changed (REHEARSE-01, NFR-08).
 *
 * @param {object} opts
 * @param {string[]} opts.assemblyOrder   Ordered unit ids (from planRehearsalAssembly).
 * @param {string}   opts.runId           The run id (used for rehearsal/<run-id>).
 * @param {Function} opts.mergeFn
 *   async (unitId: string, runId: string) => void | { error?: string }
 *   INJECTED. In tests: mock. In live: liveAssembleFn (requires --live).
 * @returns {Promise<{ assembled: string[], failed: string[] }>}
 */
export async function executeRehearsalAssembly({ assemblyOrder, runId, mergeFn }) {
  if (!Array.isArray(assemblyOrder)) {
    throw new Error("executeRehearsalAssembly: assemblyOrder must be an array");
  }
  if (typeof mergeFn !== "function") {
    throw new Error("executeRehearsalAssembly: mergeFn must be a function (inject a mock in tests)");
  }
  if (!runId || typeof runId !== "string") {
    throw new Error("executeRehearsalAssembly: runId is required");
  }

  const assembled = [];
  const failed    = [];

  for (const unitId of assemblyOrder) {
    try {
      const result = await mergeFn(unitId, runId);
      // If the injected function returns an explicit error, treat as failure
      if (result && result.error) {
        failed.push(unitId);
      } else {
        assembled.push(unitId);
      }
    } catch (err) {
      failed.push(unitId);
    }
  }

  return { assembled, failed };
}

/**
 * HUMAN-GATED real git assembly function.
 *
 * On the rehearsal/<run-id> branch, performs:
 *   git merge --no-ff <branchRef>
 *
 * This is the live seam for REHEARSE-01. Pass as mergeFn to
 * executeRehearsalAssembly() only when --live is set.
 *
 * @param {string} unitId    The unit id being assembled
 * @param {string} runId     The run id (used to derive branch names)
 * @param {object} [opts]
 * @param {string} [opts.cwd]       Working directory (default: process.cwd())
 * @param {string} [opts.branchRef] Override the branch ref (default: <runId>/<unitId>)
 * @throws {Error} if --live is not set, or if git merge exits non-zero
 */
export function liveAssembleFn(unitId, runId, { cwd = process.cwd(), branchRef } = {}) {
  requireLiveFlag();

  const branch = branchRef ?? `${runId}/${unitId}`;
  const result = spawnSync(
    "git",
    [
      "merge",
      "--no-ff",
      branch,
      "-m",
      `chore(bgsd): assemble ${branch} into rehearsal/${runId} [auto]`,
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );

  if (result.error) {
    throw new Error(`liveAssembleFn: git spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `liveAssembleFn: git merge ${branch} failed (exit ${result.status}):\n` +
      (result.stderr ?? "")
    );
  }
}

// ---------------------------------------------------------------------------
// REHEARSE-02: Doc Aggregation
// ---------------------------------------------------------------------------

/**
 * Read a file safely, returning a fallback string if the file does not exist
 * or cannot be read.
 *
 * @param {Function} readFileFn  Injectable (path) => string
 * @param {string}   path
 * @param {string}   [fallback=""]
 * @returns {string}
 */
function safeRead(readFileFn, path, fallback = "") {
  try {
    return readFileFn(path);
  } catch (_) {
    return fallback;
  }
}

/**
 * Aggregate each worktree's .planning/ artifacts into run-level documents.
 *
 * Deterministic script — no model calls (NFR-05).
 *
 * Writes (or returns for testing):
 *   .bgsd/runs/<run-id>/RUN.md     — prompt + decomposition + graph + timeline
 *   .bgsd/runs/<run-id>/AGENTS.md  — per-subagent: asked / did / decided / committed
 *
 * Also updates .bgsd/ledger.md via updateLedger().
 *
 * @param {object} opts
 * @param {string}   opts.runId        The run id.
 * @param {string}   opts.prompt       The original run prompt.
 * @param {string[]} opts.units        Array of unit ids in dependency order.
 * @param {Array<{
 *   unitId:      string,
 *   agentId:     string,
 *   worktree:    string,
 *   branch:      string,
 *   commits:     string[],
 *   phase:       string,
 *   status:      string,
 *   assumptions: object[],
 *   blockers:    object[],
 * }>} opts.worktrees  Per-worktree descriptor objects.
 * @param {string}   opts.bgsdDir      Absolute path to .bgsd directory.
 * @param {string}   [opts.runState]   The run's final state (default: "done").
 * @param {Function} [opts.readFileFn] Injectable file reader: (path) => string.
 *                   Default: readFileSync from node:fs (utf8).
 * @param {Function} [opts.writeFn]    Injectable file writer: (path, content) => void.
 *                   Default: writeFileSync from node:fs (utf8), with atomic rename.
 * @param {Function} [opts.existsFn]   Injectable: (path) => boolean.
 * @returns {{ runMd: string, agentsMd: string }}
 */
export function aggregateDocs({
  runId,
  prompt,
  units,
  worktrees,
  bgsdDir,
  runState = "done",
  readFileFn,
  writeFn,
  existsFn,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("aggregateDocs: runId is required");
  }
  if (!Array.isArray(worktrees)) {
    throw new Error("aggregateDocs: worktrees must be an array");
  }

  const now = new Date().toISOString();

  // Default I/O implementations
  const _read  = readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const _write = writeFn    ?? ((p, c) => {
    const tmp = p + ".tmp";
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, c, "utf8");
    renameSync(tmp, p);
  });
  const _exists = existsFn  ?? existsSync;

  // -------------------------------------------------------------------------
  // Build RUN.md — prompt dump + decomposition + graph + timeline
  // -------------------------------------------------------------------------
  const unitsSection = (units ?? [])
    .map((id, i) => `  ${i + 1}. \`${id}\``)
    .join("\n") || "  (none)";

  const timelineSection = worktrees
    .map((wt) => {
      const commits = (wt.commits ?? []).join(", ") || "(none)";
      return `| ${wt.unitId} | ${wt.agentId} | ${wt.branch} | ${wt.status} | ${commits} |`;
    })
    .join("\n") || "| — | — | — | — | — |";

  const runMd = [
    `# Run: ${runId}`,
    "",
    `**Generated:** ${now}`,
    `**State:** ${runState}`,
    `**Branch:** rehearsal/${runId}`,
    "",
    "## Prompt",
    "",
    (prompt ?? "(no prompt)").trim(),
    "",
    "## Decomposition",
    "",
    `Units in dependency order (${(units ?? []).length} total):`,
    "",
    unitsSection,
    "",
    "## Timeline",
    "",
    "| Unit | Agent | Branch | Status | Commits |",
    "|------|-------|--------|--------|---------|",
    timelineSection,
    "",
    "## Worktree Summaries",
    "",
    ...worktrees.map((wt) => {
      // Attempt to read the worktree's own .planning/RUN.md or PLAN.md
      const planPath = join(wt.worktree, ".planning", "RUN.md");
      const planContent = _exists(planPath)
        ? safeRead(_read, planPath, "")
        : "";

      return [
        `### ${wt.unitId} — ${wt.agentId}`,
        "",
        `- **Branch:** \`${wt.branch}\``,
        `- **Status:** ${wt.status}`,
        `- **Phase:** ${wt.phase ?? "(unknown)"}`,
        `- **Commits:** ${(wt.commits ?? []).join(", ") || "(none)"}`,
        "",
        planContent
          ? `<details><summary>.planning/RUN.md</summary>\n\n${planContent}\n</details>`
          : "(no .planning/RUN.md found in this worktree)",
        "",
      ].join("\n");
    }),
  ].join("\n");

  // -------------------------------------------------------------------------
  // Build AGENTS.md — per-subagent section
  // -------------------------------------------------------------------------
  const agentSections = worktrees.map((wt) => {
    const assumptions = (wt.assumptions ?? [])
      .map((a) => `  - ${a.description ?? JSON.stringify(a)}`)
      .join("\n") || "  (none)";

    const blockers = (wt.blockers ?? [])
      .map((b) => `  - [${b.severity ?? "?"}] ${b.question ?? JSON.stringify(b)}`)
      .join("\n") || "  (none)";

    const commits = (wt.commits ?? []).join(", ") || "(none)";

    return [
      `## Agent: ${wt.agentId} (unit: ${wt.unitId})`,
      "",
      `**Asked to do:** Work on unit \`${wt.unitId}\` on branch \`${wt.branch}\``,
      "",
      `**Did:** Reached phase \`${wt.phase ?? "(unknown)"}\` with status \`${wt.status}\``,
      `**Commits made:** ${commits}`,
      "",
      "**Assumptions made:**",
      assumptions,
      "",
      "**Blockers raised:**",
      blockers,
      "",
      `**Final worktree path:** \`${wt.worktree}\``,
      "",
    ].join("\n");
  });

  const agentsMd = [
    `# Agents: ${runId}`,
    "",
    `**Generated:** ${now}`,
    `**Run:** ${runId}`,
    `**Total agents:** ${worktrees.length}`,
    "",
    ...agentSections,
  ].join("\n");

  // -------------------------------------------------------------------------
  // Write output files (if bgsdDir is provided and writeFn allows it)
  // -------------------------------------------------------------------------
  if (bgsdDir) {
    const runDir = join(bgsdDir, "runs", runId);
    _write(join(runDir, "RUN.md"),    runMd);
    _write(join(runDir, "AGENTS.md"), agentsMd);

    // Update the global ledger
    updateLedger({
      bgsdDir,
      runId,
      state:        runState,
      prompt:       prompt ?? "",
      mergedCount:  worktrees.filter((w) => w.status === "done" || w.status === "merged").length,
      heldCount:    worktrees.filter((w) => w.status !== "done" && w.status !== "merged").length,
      writeFn:      _write,
      readFn:       _read,
      existsFn:     _exists,
    });
  }

  return { runMd, agentsMd };
}

/**
 * Update the global .bgsd/ledger.md with a run's final state.
 *
 * Creates the ledger with a header if it does not exist.
 * Appends a new row — does NOT update existing rows (an append-only log).
 *
 * @param {object} opts
 * @param {string}   opts.bgsdDir      Absolute path to .bgsd directory.
 * @param {string}   opts.runId        The run id.
 * @param {string}   opts.state        Final run state.
 * @param {string}   [opts.prompt]     The original prompt (truncated to 60 chars).
 * @param {number}   [opts.mergedCount] Count of merged units.
 * @param {number}   [opts.heldCount]  Count of held-back units.
 * @param {Function} [opts.writeFn]    Injectable: (path, content) => void.
 * @param {Function} [opts.readFn]     Injectable: (path) => string.
 * @param {Function} [opts.existsFn]   Injectable: (path) => boolean.
 */
export function updateLedger({
  bgsdDir,
  runId,
  state,
  prompt = "",
  mergedCount = 0,
  heldCount   = 0,
  writeFn,
  readFn,
  existsFn,
}) {
  const _write  = writeFn  ?? ((p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c, "utf8");
  });
  const _read   = readFn   ?? ((p) => readFileSync(p, "utf8"));
  const _exists = existsFn ?? existsSync;

  const ledgerPath = join(bgsdDir, "ledger.md");

  const HEADER =
    "# bgsd Run Ledger\n\n" +
    "| Run ID | State | Merged | Held | Created At | Prompt |\n" +
    "|--------|-------|--------|------|------------|--------|\n";

  let existing = "";
  if (_exists(ledgerPath)) {
    existing = safeRead(_read, ledgerPath, HEADER);
  } else {
    existing = HEADER;
  }

  const promptExcerpt = (prompt).slice(0, 60).replace(/\n/g, " ");
  const now = new Date().toISOString();
  const line = `| ${runId} | ${state} | ${mergedCount} | ${heldCount} | ${now} | ${promptExcerpt} |\n`;

  _write(ledgerPath, existing + line);
}

// ---------------------------------------------------------------------------
// REHEARSE-04: CHANGELOG generation
// ---------------------------------------------------------------------------

/**
 * Generate a per-agent human-readable CHANGELOG for the run record.
 *
 * Deterministic script — no model calls (NFR-05). Produces a structured
 * Markdown CHANGELOG with one section per subagent. In v2 this is a script-
 * generated stub; v3 will enrich it via a Haiku/low summarizer call.
 *
 * The generated CHANGELOG is the "seed" described in REHEARSE-04: it records
 * what each subagent added/fixed/changed (commits + status) in a traceable,
 * per-agent structure. Not wired into a PR at this milestone (v3 scope).
 *
 * @param {object} opts
 * @param {string}   opts.runId         The run id.
 * @param {Array<{
 *   unitId:   string,
 *   agentId:  string,
 *   branch:   string,
 *   commits:  string[],
 *   status:   string,
 *   phase:    string,
 *   summary?: string,    — optional human/model-written summary
 * }>} opts.worktrees    Per-worktree descriptor objects.
 * @param {Function} [opts.readFileFn]  Injectable: (path) => string (unused in
 *                                       stub, reserved for v3 enrichment).
 * @returns {{ changelog: string }}
 */
export function generateChangelog({ runId, worktrees, readFileFn }) {
  if (!runId || typeof runId !== "string") {
    throw new Error("generateChangelog: runId is required");
  }
  if (!Array.isArray(worktrees)) {
    throw new Error("generateChangelog: worktrees must be an array");
  }

  const now = new Date().toISOString();

  const agentEntries = worktrees.map((wt) => {
    const commits = (wt.commits ?? []);
    const commitsSection = commits.length > 0
      ? commits.map((sha) => `  - \`${sha}\``).join("\n")
      : "  - (no commits)";

    const summary = wt.summary
      ? `\n**Summary:** ${wt.summary}\n`
      : "\n*(v3: Haiku/low summarizer will enrich this section with a human-readable description)*\n";

    return [
      `### ${wt.unitId} (agent: ${wt.agentId})`,
      "",
      `- **Branch:** \`${wt.branch}\``,
      `- **Final status:** ${wt.status}`,
      `- **Final phase:** ${wt.phase ?? "(unknown)"}`,
      "",
      "**Commits:**",
      commitsSection,
      summary,
    ].join("\n");
  });

  const changelog = [
    `# CHANGELOG: ${runId}`,
    "",
    `> Generated ${now} — Phase 6 script stub.`,
    `> This CHANGELOG is the seed for the v3 PR body (REHEARSE-04).`,
    `> Not wired into a PR at this milestone.`,
    "",
    ...agentEntries,
  ].join("\n");

  return { changelog };
}

// ---------------------------------------------------------------------------
// REHEARSE-03: Reversible Branch Cleanup
// ---------------------------------------------------------------------------

/**
 * Default function that derives the branch name for a unit.
 * Convention: <runId>/<unitId>
 *
 * @param {string} runId
 * @param {string} unitId
 * @returns {string}
 */
function defaultUnitBranchFn(runId, unitId) {
  return `${runId}/${unitId}`;
}

/**
 * Compute which merged branches are safe to delete.
 *
 * NEVER includes:
 *   - rehearsal/* branches (always retained)
 *   - branches for units that did NOT merge cleanly (REHEARSE-03, NFR-06)
 *
 * @param {object} opts
 * @param {string[]} opts.mergedUnits    Unit ids that were successfully assembled
 *                                       into rehearsal/<run-id>.
 * @param {string[]} [opts.heldUnits]   Unit ids that were held back (not merged).
 * @param {string}   opts.runId         The run id (used to compute branch names).
 * @param {Function} [opts.unitBranchFn] (runId, unitId) => branchName.
 *                   Default: `${runId}/${unitId}`.
 * @returns {{
 *   toDelete: Array<{ unitId: string, branch: string }>,
 *   toRetain: Array<{ unitId: string, branch: string }>,
 * }}
 */
export function planBranchCleanup({ mergedUnits, heldUnits = [], runId, unitBranchFn }) {
  if (!Array.isArray(mergedUnits)) {
    throw new Error("planBranchCleanup: mergedUnits must be an array");
  }
  if (!runId || typeof runId !== "string") {
    throw new Error("planBranchCleanup: runId is required");
  }

  const branchFn = unitBranchFn ?? defaultUnitBranchFn;

  // Merged units: their worktree branches can be safely deleted — work is in rehearsal/<run-id>
  const toDelete = mergedUnits.map((unitId) => ({
    unitId,
    branch: branchFn(runId, unitId),
  }));

  // Held/unmerged units: NEVER deleted (REHEARSE-03)
  const toRetain = heldUnits.map((unitId) => ({
    unitId,
    branch: branchFn(runId, unitId),
  }));

  // Also retain the rehearsal branch itself (always — REHEARSE-03)
  toRetain.push({
    unitId: "__rehearsal__",
    branch: `rehearsal/${runId}`,
  });

  return { toDelete, toRetain };
}

/**
 * Execute branch cleanup.
 *
 * MODES:
 *   dry=true  (DEFAULT): Print what would be deleted, write nothing. Safe.
 *   dry=false + --live:  Record each branch's tip SHA to a recovery file first,
 *                        then call deleteFn. REVERSIBLE (REHEARSE-03, NFR-08).
 *
 * The recovery file is written to:
 *   .bgsd/runs/<run-id>/branch-recovery.json
 * before any deletion so branches are recoverable with:
 *   git branch <branch> <sha>
 *
 * @param {object} opts
 * @param {{ toDelete: Array<{unitId,branch}>, toRetain: Array<{unitId,branch}> }} opts.plan
 *   From planBranchCleanup().
 * @param {string}   opts.runId     The run id.
 * @param {string}   [opts.bgsdDir] Absolute path to .bgsd (for recovery file).
 * @param {boolean}  [opts.dry=true] Dry-run mode (default: true — safe).
 * @param {Function} [opts.deleteFn]
 *   async ({ branch, sha, unitId }) => void  — INJECTED.
 *   In tests: mock. In live: liveDeleteBranchFn (requires --live).
 * @param {Function} [opts.gitRevParseFn]
 *   (branch) => string  — returns the tip SHA of a branch. INJECTED.
 *   Default (live): runs git rev-parse <branch>.
 * @param {Function} [opts.writeFn]
 *   (path, content) => void — INJECTED. Default: writeFileSync.
 * @returns {Promise<{
 *   deleted: Array<{unitId,branch,sha}>,
 *   retained: Array<{unitId,branch}>,
 *   dry: boolean,
 *   recoveryPath: string|null,
 * }>}
 */
export async function executeBranchCleanup({
  plan,
  runId,
  bgsdDir,
  dry = true,
  deleteFn,
  gitRevParseFn,
  writeFn,
}) {
  if (!plan || !Array.isArray(plan.toDelete)) {
    throw new Error("executeBranchCleanup: plan.toDelete must be an array");
  }
  if (!runId || typeof runId !== "string") {
    throw new Error("executeBranchCleanup: runId is required");
  }

  const _write = writeFn ?? ((p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, c, "utf8");
    renameSync(tmp, p);
  });

  const _revParse = gitRevParseFn ?? ((branch) => {
    const r = spawnSync("git", ["rev-parse", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) return "(unknown)";
    return (r.stdout ?? "").trim();
  });

  // --- Dry-run mode (default, always safe) ---
  if (dry) {
    const report = plan.toDelete.map((b) => ({
      unitId:  b.unitId,
      branch:  b.branch,
      action:  "would-delete",
    }));
    const retained = plan.toRetain.map((b) => ({
      unitId: b.unitId,
      branch: b.branch,
    }));

    // Print report to stdout (informational, no side effects)
    process.stdout.write(
      `\n[bgsd cleanup --dry-run] run: ${runId}\n` +
      `  Would delete (${report.length}):\n` +
      report.map((b) => `    - ${b.branch} (unit: ${b.unitId})`).join("\n") +
      `\n  Would retain (${retained.length}):\n` +
      retained.map((b) => `    + ${b.branch}`).join("\n") +
      `\n  Recovery file: would be written to .bgsd/runs/${runId}/branch-recovery.json\n` +
      `  [dry-run] No branches deleted. Pass --live to delete for real.\n\n`
    );

    return {
      deleted:      [],
      retained,
      dry:          true,
      recoveryPath: null,
    };
  }

  // --- Live deletion path (requires --live) ---
  requireLiveFlag();

  if (typeof deleteFn !== "function") {
    throw new Error(
      "executeBranchCleanup: deleteFn must be injected for live deletion " +
      "(pass liveDeleteBranchFn or a mock)"
    );
  }

  // Step 1: Resolve tip SHAs for all branches to delete (REVERSIBLE — REHEARSE-03)
  const withShas = plan.toDelete.map((b) => ({
    ...b,
    sha: _revParse(b.branch),
  }));

  // Step 2: Write recovery file BEFORE any deletion
  let recoveryPath = null;
  if (bgsdDir) {
    recoveryPath = join(bgsdDir, "runs", runId, "branch-recovery.json");
    const recoveryData = {
      run_id:      runId,
      recorded_at: new Date().toISOString(),
      recoverable: withShas.map((b) => ({
        unitId: b.unitId,
        branch: b.branch,
        sha:    b.sha,
        recover_cmd: `git branch ${b.branch} ${b.sha}`,
      })),
    };
    _write(recoveryPath, JSON.stringify(recoveryData, null, 2));
  }

  // Step 3: Delete branches (now reversible — recovery file exists)
  const deleted  = [];
  const retained = [...plan.toRetain];

  for (const b of withShas) {
    try {
      await deleteFn({ branch: b.branch, sha: b.sha, unitId: b.unitId });
      deleted.push({ unitId: b.unitId, branch: b.branch, sha: b.sha });
    } catch (err) {
      // If deletion fails, keep the branch and continue (NFR-06: no silent green)
      retained.push({ unitId: b.unitId, branch: b.branch, error: err.message });
    }
  }

  return { deleted, retained, dry: false, recoveryPath };
}

/**
 * HUMAN-GATED real git branch deletion.
 *
 * Requires --live in process.argv. Records the tip SHA before deletion.
 * The recovery file is written by executeBranchCleanup() before this is called.
 *
 * Only deletes MERGED branches. NEVER deletes rehearsal/* (enforced by
 * planBranchCleanup not including them in toDelete).
 *
 * @param {{ branch: string, sha: string, unitId: string }} info
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @throws {Error} if --live is not set, or if git exits non-zero
 */
export function liveDeleteBranchFn({ branch, sha, unitId }, { cwd = process.cwd() } = {}) {
  requireLiveFlag();

  // Safety check: never delete a rehearsal branch
  if (branch.startsWith("rehearsal/")) {
    throw new Error(
      `liveDeleteBranchFn: REFUSED to delete rehearsal branch "${branch}" — ` +
      `rehearsal/* branches are always retained (REHEARSE-03).`
    );
  }

  const result = spawnSync("git", ["branch", "-d", branch], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`liveDeleteBranchFn: git spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `liveDeleteBranchFn: git branch -d ${branch} failed (exit ${result.status}):\n` +
      (result.stderr ?? "") +
      `\n  Recovery: git branch ${branch} ${sha}`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint (smoke test — library module, not a CLI tool)
// ---------------------------------------------------------------------------
if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  process.stdout.write(
    "rehearsal.mjs — Phase 6: Rehearsal Assembly + Doc Aggregation + Cleanup\n" +
    "(library module — import and use its exported functions)\n\n" +
    "Exports:\n" +
    "  planRehearsalAssembly({ waves, unitStatuses, edges })  — pure, no git\n" +
    "  executeRehearsalAssembly({ assemblyOrder, runId, mergeFn })  — injected mergeFn\n" +
    "  liveAssembleFn(unitId, runId, opts?)  — HUMAN-GATED (requires --live)\n" +
    "  aggregateDocs({ runId, prompt, units, worktrees, bgsdDir, ... })  — no model\n" +
    "  updateLedger({ bgsdDir, runId, state, ... })  — append-only ledger entry\n" +
    "  generateChangelog({ runId, worktrees })  — CHANGELOG stub (v3 enrichment)\n" +
    "  planBranchCleanup({ mergedUnits, heldUnits, runId })  — pure, no git\n" +
    "  executeBranchCleanup({ plan, runId, bgsdDir, dry?, ... })  — dry-run default\n" +
    "  liveDeleteBranchFn({ branch, sha, unitId }, opts?)  — HUMAN-GATED (requires --live)\n" +
    "  isLiveFlagSet()  — check --live flag\n"
  );
  process.exit(0);
}
