#!/usr/bin/env node
/**
 * integration.mjs — the standing integration branch + the production guard.
 *
 * TOPOLOGY (FINAL)
 * ================
 * Worktree branches assemble into ONE standing integration branch (default
 * `next`, configurable in BGSD.md). That branch IS the rehearsal/integration
 * mirror of production: Loop 2 verifies the integrated app on it, the User
 * Review Gate boots it, and `next -> main` is a manual, human-only merge.
 * Agents NEVER write to the production branch.
 *
 * This replaces the earlier per-run `rehearsal/<run-id>` branch and the old
 * "never touch next" invariant. The new invariant: never touch `main` (the
 * production/default branch); `next` is the integration target.
 *
 * Usage (library):
 *   import { resolveIntegrationBranch, requireNotProductionBranch,
 *            integrationBranchForRun, PRODUCTION_BRANCHES } from './integration.mjs';
 */

import { existsSync, readFileSync } from "node:fs";
import { parseBgsdMd } from "./init.mjs";

export const INTEGRATION_BRANCH_DEFAULT = "next";

/** Branch names agents must never write to. The repo's actual default branch is added at the callsite. */
export const PRODUCTION_BRANCHES = Object.freeze(["main", "master"]);

/**
 * Resolve the integration branch name. Precedence:
 *   explicit opts.integrationBranch > opts.config.integration_branch >
 *   BGSD.md in opts.repoRoot > default "next".
 *
 * @param {object} [opts]
 * @param {string} [opts.integrationBranch]
 * @param {object} [opts.config]
 * @param {string} [opts.repoRoot]
 * @returns {string}
 */
export function resolveIntegrationBranch(opts = {}) {
  if (opts.integrationBranch) return opts.integrationBranch;
  if (opts.config && opts.config.integration_branch) return opts.config.integration_branch;
  if (opts.repoRoot) {
    const p = `${opts.repoRoot}/BGSD.md`;
    if (existsSync(p)) {
      try {
        const cfg = parseBgsdMd(readFileSync(p, "utf8"));
        if (cfg.integration_branch) return cfg.integration_branch;
      } catch (_) {
        /* fall through to default */
      }
    }
  }
  return INTEGRATION_BRANCH_DEFAULT;
}

/**
 * The integration branch for a run. The run id is no longer part of the branch
 * name (there is one standing branch), but the signature is kept so existing
 * `rehearsalBranch ?? f(runId)` callsites can swap in cleanly.
 *
 * @param {string} _runId  ignored (kept for callsite compatibility)
 * @param {object} [opts]  forwarded to resolveIntegrationBranch
 * @returns {string}
 */
export function integrationBranchForRun(_runId, opts = {}) {
  return resolveIntegrationBranch(opts);
}

/** True when `branch` is a protected production branch. */
export function isProductionBranch(branch, extra = []) {
  return PRODUCTION_BRANCHES.includes(branch) || extra.includes(branch);
}

/**
 * Throw if `branch` is the production/default branch. Agents assemble into the
 * integration branch (`next`); promoting to `main` is human-only.
 *
 * @param {string} branch
 * @param {object} [opts]
 * @param {string} [opts.defaultBranch]  the repo's actual default branch (also protected)
 */
export function requireNotProductionBranch(branch, { defaultBranch } = {}) {
  if (!branch || typeof branch !== "string") {
    throw new Error("requireNotProductionBranch: branch is required and must be a string");
  }
  const extra = defaultBranch ? [defaultBranch] : [];
  if (isProductionBranch(branch, extra)) {
    throw new Error(
      `bgsd never writes to the production branch '${branch}'. ` +
        `Integration happens on the standing integration branch (e.g. 'next'); ` +
        `promoting to '${branch}' is a manual, human-only merge.`
    );
  }
}
