#!/usr/bin/env node
/**
 * clean.mjs — prune stale bgsd worktrees and merged branches.
 *
 * Pure planner (planClean) + live seam (main CLI).
 *
 * Branch naming conventions from worktree.mjs / integration.mjs:
 *   worktree branches:  <run-id>/<slug>   (e.g. "bgsd-0003-auth/unit-api")
 *   run-id format:      bgsd-NNNN-<slug>  (starts with "bgsd-")
 *
 * Only branches/worktrees whose branch name starts with "bgsd-" are ever
 * touched. Generic user branches are never considered.
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

export const PROTECTED = Object.freeze(["next", "main", "master"]);

/**
 * Decide which worktrees and branches to remove.
 *
 * @param {object} opts
 * @param {string[]}  opts.branches        All branch names in the repo
 * @param {string[]}  opts.worktrees       All non-bare worktree paths that exist (excludes main checkout)
 * @param {string[]}  opts.worktreeBranches Branch checked out in each worktree (parallel array to worktrees)
 * @param {string[]}  opts.mergedBranches  Branches already merged into the integration branch
 * @param {string}    opts.currentBranch   The branch currently checked out in the main worktree
 * @param {string[]}  [opts.protected]     Extra protected branch names (defaults to PROTECTED)
 * @param {boolean}   [opts.force]         Include unmerged bgsd branches (still never touches protected/current)
 * @returns {{ removeWorktrees: string[], deleteBranches: string[], skipped: Array<{name:string,reason:string}> }}
 */
export function planClean({
  branches,
  worktrees,
  worktreeBranches,
  mergedBranches,
  currentBranch,
  protected: extraProtected = [],
  force = false,
}) {
  const protectedSet = new Set([...PROTECTED, ...extraProtected]);
  const mergedSet = new Set(mergedBranches);

  const removeWorktrees = [];
  const deleteBranches = [];
  const skipped = [];

  // Determine which branches are locked in an active worktree
  const worktreeBranchSet = new Set(worktreeBranches ?? []);

  // Evaluate worktrees: remove if their branch is merged (or force + bgsd branch)
  for (let i = 0; i < (worktrees ?? []).length; i++) {
    const wtPath = worktrees[i];
    const wtBranch = worktreeBranches[i];
    if (!isBgsdBranch(wtBranch)) {
      skipped.push({ name: wtPath, reason: "not a bgsd worktree" });
      continue;
    }
    if (protectedSet.has(wtBranch)) {
      skipped.push({ name: wtPath, reason: `branch '${wtBranch}' is protected` });
      continue;
    }
    if (wtBranch === currentBranch) {
      skipped.push({ name: wtPath, reason: `branch '${wtBranch}' is current` });
      continue;
    }
    if (mergedSet.has(wtBranch)) {
      removeWorktrees.push(wtPath);
    } else if (force) {
      removeWorktrees.push(wtPath);
    } else {
      skipped.push({ name: wtPath, reason: `branch '${wtBranch}' is unmerged` });
    }
  }

  // Evaluate branches
  for (const branch of (branches ?? [])) {
    if (!isBgsdBranch(branch)) continue;
    if (protectedSet.has(branch)) {
      skipped.push({ name: branch, reason: "protected branch" });
      continue;
    }
    if (branch === currentBranch) {
      skipped.push({ name: branch, reason: "current branch" });
      continue;
    }
    if (worktreeBranchSet.has(branch) && !removeWorktrees.some((wt, i) => worktreeBranches[i] === branch)) {
      // Still checked out in a worktree we're NOT removing
      const wouldRemove = removeWorktrees.some((_, i) => worktreeBranches[i] === branch);
      if (!wouldRemove) {
        skipped.push({ name: branch, reason: "checked out in active worktree" });
        continue;
      }
    }
    if (mergedSet.has(branch)) {
      deleteBranches.push(branch);
    } else if (force) {
      deleteBranches.push(branch);
    } else {
      skipped.push({ name: branch, reason: "unmerged" });
    }
  }

  return { removeWorktrees, deleteBranches, skipped };
}

/** True when a branch name follows bgsd naming: starts with "bgsd-" */
function isBgsdBranch(name) {
  return typeof name === "string" && name.startsWith("bgsd-");
}

// ---------------------------------------------------------------------------
// Live helpers (real git I/O)
// ---------------------------------------------------------------------------

/** Run git and return trimmed stdout. */
function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

/** Gather live git state for planClean. */
export function gatherState({ integrationBranch = "next" } = {}) {
  // All local branches
  const branches = git("branch --format=%(refname:short)")
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean);

  // Merged into integration branch (may fail if branch doesn't exist yet — treat as empty)
  let mergedBranches = [];
  try {
    mergedBranches = git(`branch --merged ${integrationBranch} --format=%(refname:short)`)
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
  } catch (_) { /* integration branch may not exist */ }

  // Current branch
  let currentBranch = "";
  try {
    currentBranch = git("rev-parse --abbrev-ref HEAD").trim();
  } catch (_) { /* detached HEAD */ }

  // Worktrees (porcelain)
  const wtLines = git("worktree list --porcelain").split("\n");
  const worktrees = [];
  const worktreeBranches = [];

  let wtPath = null;
  let wtBranch = null;
  let isBare = false;
  for (const line of wtLines) {
    if (line.startsWith("worktree ")) {
      wtPath = line.slice("worktree ".length).trim();
      wtBranch = null;
      isBare = false;
    } else if (line.startsWith("branch ")) {
      wtBranch = line.slice("branch ".length).replace("refs/heads/", "").trim();
    } else if (line === "bare") {
      isBare = true;
    } else if (line === "") {
      // end of stanza — the first stanza (bare or main checkout) is the main worktree; skip it
      if (wtPath && !isBare && worktrees.length > 0 || (worktrees.length === 0 && !isBare && wtPath)) {
        // Always push — we'll filter bare ones. The very first stanza is main checkout; include all
        // non-bare linked worktrees (those are in addition to the main checkout)
      }
      if (wtPath && !isBare && worktrees.length === 0) {
        // This is the main checkout — skip adding it to the list
      } else if (wtPath && !isBare && wtBranch) {
        worktrees.push(wtPath);
        worktreeBranches.push(wtBranch);
      }
      wtPath = null;
      wtBranch = null;
      isBare = false;
    }
  }
  // handle last stanza without trailing blank line
  if (wtPath && !isBare && wtBranch && worktrees.length > 0) {
    worktrees.push(wtPath);
    worktreeBranches.push(wtBranch);
  }

  return { branches, mergedBranches, currentBranch, worktrees, worktreeBranches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force  = args.includes("--force");
  const json   = args.includes("--json");
  const yes    = args.includes("--yes");

  const integrationBranch = (() => {
    const idx = args.indexOf("--integration-branch");
    return idx !== -1 ? args[idx + 1] : "next";
  })();

  const state = gatherState({ integrationBranch });
  const plan  = planClean({ ...state, force });

  if (json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    if (dryRun) process.exit(0);
  } else {
    printPlan(plan, { dryRun, force, integrationBranch });
    if (dryRun) process.exit(0);
  }

  if (!yes && !json) {
    // When run from the command line interactively, the slash command handles confirmation.
    // When --yes is passed, skip the prompt and execute directly.
    process.stdout.write(
      "\nPass --yes to execute, or use /bgsd-clean (which asks for confirmation).\n"
    );
    process.exit(0);
  }

  const results = executePlan(plan, { force });
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } else {
    printResults(results);
  }
}

function printPlan(plan, { dryRun, force, integrationBranch }) {
  const tag = dryRun ? "[dry-run] " : "";
  process.stdout.write(`\n${tag}bgsd-clean plan  (integration: ${integrationBranch}${force ? ", --force" : ""})\n`);
  process.stdout.write("─".repeat(56) + "\n");

  if (plan.removeWorktrees.length === 0 && plan.deleteBranches.length === 0) {
    process.stdout.write("  Nothing to clean.\n");
  } else {
    if (plan.removeWorktrees.length > 0) {
      process.stdout.write(`  Worktrees to remove (${plan.removeWorktrees.length}):\n`);
      for (const wt of plan.removeWorktrees) process.stdout.write(`    ${wt}\n`);
    }
    if (plan.deleteBranches.length > 0) {
      process.stdout.write(`  Branches to delete (${plan.deleteBranches.length}):\n`);
      for (const b of plan.deleteBranches) process.stdout.write(`    ${b}\n`);
    }
  }
  if (plan.skipped.length > 0) {
    process.stdout.write(`  Skipped (${plan.skipped.length}):\n`);
    for (const s of plan.skipped) process.stdout.write(`    ${s.name}  — ${s.reason}\n`);
  }
  process.stdout.write("\n");
}

function executePlan(plan, { force }) {
  const removed = [];
  const deleted = [];
  const errors  = [];

  for (const wt of plan.removeWorktrees) {
    try {
      execSync(`git worktree remove ${JSON.stringify(wt)}${force ? " --force" : ""}`, { encoding: "utf8" });
      removed.push(wt);
    } catch (err) {
      errors.push({ item: wt, error: err.message });
    }
  }

  // Prune stale worktree metadata
  try { execSync("git worktree prune", { encoding: "utf8" }); } catch (_) {}

  for (const branch of plan.deleteBranches) {
    try {
      execSync(`git branch ${force ? "-D" : "-d"} ${JSON.stringify(branch)}`, { encoding: "utf8" });
      deleted.push(branch);
    } catch (err) {
      errors.push({ item: branch, error: err.message });
    }
  }

  return { removed, deleted, errors };
}

function printResults({ removed, deleted, errors }) {
  process.stdout.write("bgsd-clean results\n");
  process.stdout.write("─".repeat(40) + "\n");
  if (removed.length > 0) {
    process.stdout.write(`  Removed ${removed.length} worktree(s).\n`);
  }
  if (deleted.length > 0) {
    process.stdout.write(`  Deleted ${deleted.length} branch(es).\n`);
  }
  if (errors.length > 0) {
    process.stdout.write(`  Errors (${errors.length}):\n`);
    for (const e of errors) process.stdout.write(`    ${e.item}: ${e.error}\n`);
  }
  if (removed.length === 0 && deleted.length === 0 && errors.length === 0) {
    process.stdout.write("  Nothing was removed.\n");
  }
  process.stdout.write("\n");
}

const _argv1 = process.argv[1] ?? "";
const _isMain =
  import.meta.url === `file://${_argv1}` ||
  _argv1.endsWith("/clean.mjs");
if (_isMain) {
  main().catch((err) => {
    process.stderr.write(`bgsd-clean error: ${err.message}\n`);
    process.exit(1);
  });
}
