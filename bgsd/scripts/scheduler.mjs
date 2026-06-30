#!/usr/bin/env node
/**
 * scheduler.mjs — Phase 3: Wave Scheduler (SPAWN-02, SPAWN-03)
 *
 * Consumes graph waves (from graph.mjs topoWaves) + dispatches units
 * wave-by-wave:
 *
 *   1. Only dispatch a unit when all its graph dependencies are `done`/`merged`.
 *   2. Cap concurrency at a configurable `maxConcurrency`.
 *   3. Wait for a wave's workers to reach terminal state (via injected
 *      readStatus) before starting dependents.
 *   4. A worker in `failed`/`dead` state blocks its dependents and is
 *      surfaced as an error — never a silent green (NFR-06).
 *
 * DEPENDENCY INJECTION (SPAWN-02)
 * ================================
 * Both the "spawn" action and the "wait for completion" poll are injected
 * so the entire scheduler is deterministically testable with fake functions —
 * no real `git worktree add`, no real `claude -p` process, no real filesystem
 * reads during tests.
 *
 *   spawnFn(unitId, plan)  =>  Promise<void>
 *     In tests: records that the unit was dispatched, immediately sets it running.
 *     In live:  calls spawnWorktreeReal from worktree.mjs.
 *
 *   readStatusFn(unitId)   =>  Promise<"running"|"done"|"failed"|"dead">
 *     In tests: reads from a caller-controlled state map.
 *     In live:  reads the control file from disk.
 *
 * ALGORITHM (SPAWN-03)
 * =====================
 * For each wave (in topological order):
 *   a. Split the wave into batches of maxConcurrency.
 *   b. For each batch: spawn all units in the batch concurrently (Promise.all).
 *   c. Poll status of every in-flight unit until all reach a terminal state
 *      (done / failed / dead).
 *   d. Collect failures. If any unit failed/died, block ALL dependents
 *      (units in later waves that depend on the failed unit) and surface
 *      them in the returned failure list — never pretend they passed.
 *   e. Proceed to next batch / next wave only after the previous batch
 *      fully terminates.
 *
 * RETURN VALUE
 * ============
 * runScheduler() returns:
 * {
 *   dispatched: string[]   — unit ids that were dispatched
 *   done:       string[]   — unit ids that completed successfully
 *   failed:     string[]   — unit ids that failed or died
 *   blocked:    string[]   — unit ids that were not dispatched because a
 *                            dependency failed (NFR-06)
 *   waves:      number     — number of waves processed
 * }
 *
 * Usage (library):
 *   import { runScheduler } from './scheduler.mjs';
 *
 *   const result = await runScheduler({
 *     waves,          // string[][] from topoWaves()
 *     graph,          // { edges: Map<id, Set<id>>, reverseEdges: Map<id, Set<id>> }
 *     plans,          // Map<unitId, WorktreePlan> from planWorktrees()
 *     spawnFn,        // INJECTED — async (unitId, plan) => void
 *     readStatusFn,   // INJECTED — async (unitId) => "running"|"done"|"failed"|"dead"
 *     maxConcurrency, // number (default 4)
 *     pollIntervalMs, // number (default 2000) — poll interval for status checks
 *     pollTimeoutMs,  // number (default 300000) — max wait per batch (5 min)
 *   });
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_TIMEOUT_MS  = 300_000; // 5 minutes per batch

/** Terminal statuses — a unit in one of these states will not change further. */
export const TERMINAL_STATUSES = new Set(["done", "failed", "dead"]);

/** Success statuses — only these count as "dependency satisfied". */
export const SUCCESS_STATUSES = new Set(["done"]);

// ---------------------------------------------------------------------------
// runScheduler — main entry point
// ---------------------------------------------------------------------------

/**
 * Run the wave scheduler over the dependency graph.
 *
 * @param {object} opts
 * @param {string[][]} opts.waves           Topological wave grouping from topoWaves()
 * @param {{ edges: Map, reverseEdges: Map }} opts.graph  Graph adjacency
 * @param {Map}    opts.plans               Map<unitId, WorktreePlan>
 * @param {Function} opts.spawnFn           async (unitId, plan) => void  — INJECTED
 * @param {Function} opts.readStatusFn      async (unitId) => string       — INJECTED
 * @param {number}  [opts.maxConcurrency]   Max units in flight simultaneously
 * @param {number}  [opts.pollIntervalMs]   How often to poll for status (ms)
 * @param {number}  [opts.pollTimeoutMs]    Max time to wait per batch (ms)
 * @param {Function} [opts.onPollFn]        async (inFlightUnitIds[]) => void — INJECTED.
 *   Called once per poll cycle with the units still in flight. The Conductor
 *   injects its context-management tick here (context.mjs runContextTick) so
 *   per-subagent context pressure is evaluated + acted on every cycle. Pure
 *   scheduling stays unaffected if omitted. Errors are surfaced, never silent.
 * @returns {Promise<{
 *   dispatched: string[],
 *   done:       string[],
 *   failed:     string[],
 *   blocked:    string[],
 *   waves:      number,
 * }>}
 */
export async function runScheduler({
  waves,
  graph,
  plans,
  spawnFn,
  readStatusFn,
  maxConcurrency  = DEFAULT_MAX_CONCURRENCY,
  pollIntervalMs  = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs   = DEFAULT_POLL_TIMEOUT_MS,
  onPollFn,
}) {
  // Validate required injections — fail loud rather than silently doing nothing
  if (typeof spawnFn !== "function") {
    throw new Error("runScheduler: spawnFn must be a function (INJECTED — use a mock in tests)");
  }
  if (typeof readStatusFn !== "function") {
    throw new Error("runScheduler: readStatusFn must be a function (INJECTED — use a mock in tests)");
  }
  if (!Array.isArray(waves)) {
    throw new Error("runScheduler: waves must be an array");
  }
  if (!graph || !graph.edges || !graph.reverseEdges) {
    throw new Error("runScheduler: graph must have .edges and .reverseEdges Maps");
  }

  const dispatched = [];
  const done       = [];
  const failed     = [];
  const blocked    = [];

  // Track which units have failed so we can block their dependents
  const failedSet  = new Set();
  // Track which units are successfully done
  const doneSet    = new Set();

  // ---------------------------------------------------------------------------
  // Helper: collect all transitive dependents of a failed unit
  // ---------------------------------------------------------------------------
  function collectTransitiveDependents(unitId) {
    const result = new Set();
    const queue = [...(graph.reverseEdges.get(unitId) ?? [])];
    while (queue.length > 0) {
      const dep = queue.shift();
      if (!result.has(dep)) {
        result.add(dep);
        for (const next of (graph.reverseEdges.get(dep) ?? [])) {
          queue.push(next);
        }
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Helper: poll a set of units until all reach terminal state or timeout
  // ---------------------------------------------------------------------------
  async function waitForBatch(unitIds) {
    const inFlight = new Set(unitIds);
    const batchFailed = [];
    const batchDone   = [];

    const deadline = Date.now() + pollTimeoutMs;

    while (inFlight.size > 0) {
      if (Date.now() > deadline) {
        // Treat timed-out units as dead (NFR-06: no silent green)
        for (const uid of inFlight) {
          process.stderr.write(
            `[scheduler] TIMEOUT: unit "${uid}" did not reach terminal state within ${pollTimeoutMs}ms — treating as dead (NFR-06)\n`
          );
          batchFailed.push(uid);
          failedSet.add(uid);
          inFlight.delete(uid);
        }
        break;
      }

      // Poll all in-flight units
      const checks = [...inFlight].map(async (uid) => {
        const status = await readStatusFn(uid);
        return { uid, status };
      });

      const results = await Promise.all(checks);

      for (const { uid, status } of results) {
        if (TERMINAL_STATUSES.has(status)) {
          inFlight.delete(uid);
          if (SUCCESS_STATUSES.has(status)) {
            batchDone.push(uid);
            doneSet.add(uid);
          } else {
            // failed or dead — surface immediately (NFR-06: no silent green)
            process.stderr.write(
              `[scheduler] WORKER FAILURE: unit "${uid}" reached status "${status}" — blocking its dependents (NFR-06)\n`
            );
            batchFailed.push(uid);
            failedSet.add(uid);
          }
        }
        // "running" or other non-terminal status: keep polling
      }

      // Per-cycle Conductor hook (CTX-02): evaluate + act on context pressure
      // for every agent still in flight. Dependency-injected and optional; the
      // scheduler's own logic does not depend on it. Errors are surfaced loudly
      // (NFR-06: no silent green) but do not derail scheduling.
      if (typeof onPollFn === "function" && inFlight.size > 0) {
        try {
          await onPollFn([...inFlight]);
        } catch (err) {
          process.stderr.write(
            `[scheduler] onPollFn (context tick) error: ${err.message}\n`
          );
        }
      }

      if (inFlight.size > 0) {
        await sleep(pollIntervalMs);
      }
    }

    return { batchDone, batchFailed };
  }

  // ---------------------------------------------------------------------------
  // Helper: check whether all declared deps of a unit are done
  // ---------------------------------------------------------------------------
  function depsAllDone(unitId) {
    const deps = graph.edges.get(unitId) ?? new Set();
    for (const depId of deps) {
      if (!doneSet.has(depId)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Main wave loop
  // ---------------------------------------------------------------------------
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];

    // Partition wave units into: eligible (deps met + not blocked) vs blocked
    const eligible = [];
    for (const unitId of wave) {
      if (failedSet.has(unitId)) {
        // already marked failed (transitive from previous wave)
        failed.push(unitId);
        blocked.push(unitId);
        continue;
      }
      // Check if any dep is failed
      const deps = graph.edges.get(unitId) ?? new Set();
      let depFailed = false;
      for (const depId of deps) {
        if (failedSet.has(depId)) {
          depFailed = true;
          break;
        }
      }
      if (depFailed) {
        blocked.push(unitId);
        failedSet.add(unitId); // propagate block so transitive dependents also block
        process.stderr.write(
          `[scheduler] BLOCKED: unit "${unitId}" has a failed dependency — it will not be dispatched (NFR-06)\n`
        );
        continue;
      }
      // Verify deps are all done (should be true for correct wave ordering)
      if (!depsAllDone(unitId)) {
        // Shouldn't happen with correct topoWaves input; surface as an error
        process.stderr.write(
          `[scheduler] WARNING: unit "${unitId}" in wave ${waveIdx} has unresolved deps — skipping (graph ordering issue)\n`
        );
        blocked.push(unitId);
        continue;
      }
      eligible.push(unitId);
    }

    // Split eligible units into maxConcurrency batches
    for (let batchStart = 0; batchStart < eligible.length; batchStart += maxConcurrency) {
      const batch = eligible.slice(batchStart, batchStart + maxConcurrency);

      // Spawn all units in the batch concurrently
      await Promise.all(
        batch.map(async (unitId) => {
          const plan = plans?.get(unitId);
          dispatched.push(unitId);
          await spawnFn(unitId, plan);
        })
      );

      // Wait for all batch units to reach a terminal state before proceeding
      const { batchDone, batchFailed } = await waitForBatch(batch);

      for (const uid of batchDone) done.push(uid);

      // For every failed unit, collect + mark transitive dependents as blocked
      for (const uid of batchFailed) {
        failed.push(uid);
        // Collect all transitive dependents across subsequent waves
        const dependents = collectTransitiveDependents(uid);
        for (const dep of dependents) {
          if (!failedSet.has(dep)) {
            failedSet.add(dep);
          }
        }
      }
    }
  }

  return {
    dispatched,
    done,
    failed,
    blocked,
    waves: waves.length,
  };
}

// ---------------------------------------------------------------------------
// sleep helper — injectable for tests (exported for test overrides)
// ---------------------------------------------------------------------------

/**
 * Simple sleep. Exported so tests can verify it is not called when
 * pollIntervalMs=0.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
