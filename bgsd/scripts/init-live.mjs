#!/usr/bin/env node
/**
 * init-live.mjs — Phase 1 (v0-init): /bgsd-init live seam (real git + fs)
 *
 * Wires real git/fs into the pure executeInit (init.mjs) and guards every
 * mutation behind --live (mirrors run-live.mjs / loop1-live.mjs). Without
 * --live it prints a read-only PLAN (what it WOULD do); with --live it performs
 * the bootstrap.
 *
 * TARGET REPO RESOLUTION
 * ======================
 * The repo is resolved from cwd via `git rev-parse --show-toplevel`, NOT from
 * the plugin location. bgsd runs in the USER's repo, while its engine code
 * lives at ${CLAUDE_PLUGIN_ROOT}.
 *
 * Usage (CLI):
 *   node init-live.mjs            # preview the plan (no changes)
 *   node init-live.mjs --live     # perform the bootstrap
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

import {
  detectInitState,
  planInit,
  executeInit,
} from "./init.mjs";

// ---------------------------------------------------------------------------
// Live-flag guard (mirrors run-live.mjs / loop1-live.mjs)
// ---------------------------------------------------------------------------

export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
        "======================================================================\n" +
        "  bgsd-init: refusing to mutate without --live.\n" +
        "  This creates the integration branch, the .bgsd/ master folder,\n" +
        "  BGSD.md, and bgsd-compatible GSD config in THIS repo.\n" +
        "  Re-run with --live to apply, or omit it to preview the plan.\n" +
        "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// git + fs helpers
// ---------------------------------------------------------------------------

function git(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function writeAtomic(p, s) {
  const tmp = p + ".tmp";
  writeFileSync(tmp, s, "utf8");
  renameSync(tmp, p);
}

export function resolveRepoRoot() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return process.cwd();
}

function refExists(repoRoot, ref) {
  return git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]).code === 0;
}

function revParse(repoRoot, ref) {
  const r = git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  return r.code === 0 ? r.stdout : null;
}

function currentBranch(repoRoot) {
  const r = git(repoRoot, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  return r.code === 0 ? r.stdout : null;
}

/** Auto-detect the base branch: origin/HEAD, then main, then master, then HEAD. */
export function detectBaseBranch(repoRoot) {
  const r = git(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (r.code === 0 && r.stdout) {
    const m = r.stdout.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  if (refExists(repoRoot, "refs/heads/main")) return "main";
  if (refExists(repoRoot, "refs/heads/master")) return "master";
  return currentBranch(repoRoot) || "main";
}

/** Prefer origin/<base> when it exists (so a fresh local branch tracks remote tip). */
function resolveBaseRef(repoRoot, base) {
  if (refExists(repoRoot, `refs/remotes/origin/${base}`)) return `origin/${base}`;
  return base;
}

/**
 * Ensure .planning/config.json exists and is bgsd-compatible, WITHOUT clobbering
 * existing keys: branching_strategy="none" (bgsd owns branching via worktrees)
 * and base_branch=<integration branch> (worktree branches merge into it).
 *
 * @returns {boolean} true if the file was created or changed
 */
export function ensureGsdConfig(repoRoot, integrationBranch) {
  const path = `${repoRoot}/.planning/config.json`;
  const existed = existsSync(path);
  let config = {};
  if (existed) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch (_) {
      config = {};
    }
  }
  config.git = config.git ?? {};
  const before = JSON.stringify(config.git);
  config.git.branching_strategy = "none";
  config.git.base_branch = integrationBranch;
  const changed = !existed || JSON.stringify(config.git) !== before;
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, JSON.stringify(config, null, 2) + "\n");
  }
  return changed;
}

/**
 * Fast-forward the integration branch to base. Read-only when apply=false
 * (preview). Never force-overwrites a diverged branch — if the integration
 * branch has commits not in base, it reports a note and leaves it for the sesh
 * to merge.
 */
export function computeSync(repoRoot, branch, base, apply) {
  const baseRef = resolveBaseRef(repoRoot, base);
  const baseSha = revParse(repoRoot, baseRef);
  if (!baseSha) return { updated: false, reason: `base ref '${baseRef}' not found` };
  const branchSha = revParse(repoRoot, branch);
  if (!branchSha) return { updated: false, reason: `branch '${branch}' not found` };
  if (branchSha === baseSha) return { updated: false, reason: "already up to date" };

  const isAncestor =
    git(repoRoot, ["merge-base", "--is-ancestor", branch, baseRef]).code === 0;
  if (!isAncestor) {
    return {
      updated: false,
      reason: `'${branch}' has diverged from '${baseRef}' (will merge during sesh)`,
    };
  }
  if (!apply) return { updated: true, reason: `would fast-forward '${branch}' to '${baseRef}'` };

  const cur = currentBranch(repoRoot);
  const r =
    cur === branch
      ? git(repoRoot, ["merge", "--ff-only", baseRef])
      : git(repoRoot, ["branch", "-f", branch, baseRef]);
  if (r.code !== 0) return { updated: false, reason: `fast-forward failed: ${r.stderr}` };
  return { updated: true };
}

// ---------------------------------------------------------------------------
// Deps builders
// ---------------------------------------------------------------------------

function readDeps(repoRoot) {
  return {
    repoRoot,
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    detectBaseBranch: () => detectBaseBranch(repoRoot),
    branchExists: (b) => refExists(repoRoot, `refs/heads/${b}`),
  };
}

export function liveDeps(repoRoot, log) {
  return {
    ...readDeps(repoRoot),
    writeFile: (p, s) => {
      mkdirSync(dirname(p), { recursive: true });
      writeAtomic(p, s);
    },
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    createBranch: (branch, base) => {
      const baseRef = resolveBaseRef(repoRoot, base);
      const r = git(repoRoot, ["branch", branch, baseRef]);
      if (r.code !== 0) {
        throw new Error(`git branch ${branch} ${baseRef} failed: ${r.stderr}`);
      }
    },
    syncBranch: (branch, base) => computeSync(repoRoot, branch, base, true),
    ensureGsdConfig: (root, ib) => ensureGsdConfig(root, ib),
    log: log ?? (() => {}),
  };
}

/**
 * Sesh preflight: make the repo bgsd-ready and bring the integration branch
 * current with base. Idempotent — full setup on first run, just ensure + ff
 * sync thereafter. Returns the executeInit summary. Used at the start of every
 * /bgsd-sesh so `next` never falls behind `main` before work fans out.
 */
export function seshPreflight(repoRoot, { log } = {}) {
  return executeInit(liveDeps(repoRoot, log));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function previewPlan(repoRoot) {
  const { state, integrationBranch, baseBranch } = detectInitState(readDeps(repoRoot));
  const { alreadyInitialized, actions } = planInit(state);
  return { alreadyInitialized, actions, integrationBranch, baseBranch };
}

export function main() {
  const repoRoot = resolveRepoRoot();
  const out = (s) => process.stdout.write(s);

  if (!isLiveFlagSet()) {
    const { alreadyInitialized, actions, integrationBranch, baseBranch } = previewPlan(repoRoot);
    out(`\nbgsd-init preview — repo: ${repoRoot}\n`);
    out(`  base branch:         ${baseBranch}\n`);
    out(`  integration branch:  ${integrationBranch}\n`);
    out(`  already initialized: ${alreadyInitialized ? "yes" : "no"}\n`);
    out(`  planned actions:\n`);
    for (const a of actions) {
      out(`    - ${a.type}${a.branch ? ` (${a.branch} <- ${a.base})` : ""}\n`);
    }
    out(`\n  Re-run with --live to apply.\n`);
    return;
  }

  requireLiveFlag();
  const res = executeInit(liveDeps(repoRoot, (m) => out(`  ${m}\n`)));
  out(`\nbgsd-init ${res.alreadyInitialized ? "refreshed" : "complete"} — repo: ${repoRoot}\n`);
  out(`  base branch:         ${res.baseBranch}\n`);
  out(`  integration branch:  ${res.integrationBranch}\n`);
  if (res.performed.length) out(`  performed: ${res.performed.join(", ")}\n`);
  for (const n of res.notes) out(`  note: ${n}\n`);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]init-live\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
