#!/usr/bin/env node
/**
 * envprop.mjs — env-file propagation into worktrees.
 *
 * Git worktrees do NOT carry gitignored files. So before a Pipeline Agent boots
 * an app in its worktree (and before the integration branch is booted for Loop
 * 2 / the review gate), the Conductor copies the configured env files from the
 * repo root into the target checkout. Without this, servers won't start and the
 * Tester/Integration agents fail spuriously. The patterns come from BGSD.md
 * (`env.files`); the default is in init.mjs defaultBgsdConfig().
 *
 * Pure matching + DI copy so it is unit-testable; the live fs deps are exported
 * for the spawn path.
 */

import { readdirSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Convert a simple env-file glob (only `*` wildcards) to an anchored RegExp. */
export function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Return the filenames that match any of the patterns. */
export function matchEnvFiles(filenames, patterns) {
  const regexes = (patterns ?? []).map(globToRegex);
  return (filenames ?? []).filter((f) => regexes.some((r) => r.test(f)));
}

/**
 * Propagate env files from repo root into a destination checkout.
 *
 * @param {object} opts
 * @param {string[]} opts.patterns       globs (e.g. [".env", ".env.*.local"])
 * @param {string}   opts.destDir        the worktree/checkout to copy into
 * @param {object}   opts.deps
 * @param {()=>string[]}                 opts.deps.listRoot   filenames at repo root
 * @param {(name:string,destDir:string)=>void} opts.deps.copy
 * @param {(msg:string)=>void}           [opts.deps.log]
 * @returns {{ copied: string[] }}
 */
export function propagateEnv({ patterns, destDir, deps }) {
  const log = deps.log ?? (() => {});
  const rootFiles = deps.listRoot();
  const toCopy = matchEnvFiles(rootFiles, patterns);
  for (const name of toCopy) deps.copy(name, destDir);
  if (toCopy.length) log(`propagated ${toCopy.length} env file(s): ${toCopy.join(", ")}`);
  return { copied: toCopy };
}

/** Live fs deps: list root files, copy by name into destDir. */
export function liveEnvDeps(repoRoot, log) {
  return {
    listRoot: () =>
      readdirSync(repoRoot, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name),
    copy: (name, destDir) => {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(join(repoRoot, name), join(destDir, name));
    },
    log: log ?? (() => {}),
  };
}

/** Convenience: propagate using real fs + given patterns. */
export function propagateEnvLive({ repoRoot, destDir, patterns, log }) {
  if (!existsSync(repoRoot)) throw new Error(`propagateEnvLive: repoRoot not found: ${repoRoot}`);
  return propagateEnv({ patterns, destDir, deps: liveEnvDeps(repoRoot, log) });
}
