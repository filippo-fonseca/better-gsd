#!/usr/bin/env node
/**
 * issues-live.mjs — real `gh` + git-remote seam for issues.mjs (HUMAN-GATED).
 *
 * Creates the epic + per-unit GitHub issues via `gh issue create`, behind a
 * --live guard. Detects whether the repo has a GitHub remote; when it does not,
 * issues.mjs skips creation and the run proceeds with plain branch + merge.
 *
 * Persists the result to .bgsd/runs/<run-id>/issues.json so PRs can later
 * reference `Closes #N` (see issues.mjs collectCloses).
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";

import { createIssues } from "./issues.mjs";

export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\nissues-live: refusing to create GitHub issues without --live.\n" +
        "Re-run with --live to file the epic + per-unit issues.\n"
    );
  }
}

/** True when origin is a GitHub remote. */
export function hasGitHubRemote(repoRoot) {
  const r = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0) return false;
  return /github\.com[:/]/i.test((r.stdout ?? "").trim());
}

/** Create one issue via `gh` and return its number. Requires --live. */
export function ghCreateIssue(repoRoot, { title, body, labels }) {
  requireLiveFlag();
  const args = ["issue", "create", "--title", title, "--body", body];
  for (const l of labels ?? []) args.push("--label", l);
  const r = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`gh issue create failed: ${(r.stderr ?? "").trim()}`);
  }
  const out = (r.stdout ?? "").trim();
  const m = out.match(/\/issues\/(\d+)/);
  if (!m) {
    throw new Error(`gh issue create: could not parse issue number from: ${out}`);
  }
  return Number(m[1]);
}

function writeAtomic(p, s) {
  const t = p + ".tmp";
  writeFileSync(t, s, "utf8");
  renameSync(t, p);
}

export function liveDeps(repoRoot, runDir, log) {
  return {
    hasRemote: () => hasGitHubRemote(repoRoot),
    createIssue: (payload) => ghCreateIssue(repoRoot, payload),
    persist: (result) => {
      mkdirSync(runDir, { recursive: true });
      writeAtomic(`${runDir}/issues.json`, JSON.stringify(result, null, 2) + "\n");
    },
    log: log ?? (() => {}),
  };
}

/** Convenience: create the epic + unit issues for a run against real gh/git. */
export async function createIssuesLive({ repoRoot, runDir, runId, prompt, units, log }) {
  return createIssues({ runId, prompt, units, deps: liveDeps(repoRoot, runDir, log) });
}
