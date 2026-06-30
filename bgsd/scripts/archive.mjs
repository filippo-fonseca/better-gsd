#!/usr/bin/env node
/**
 * archive.mjs — persist each sesh's markdown into the committed master folder.
 *
 * Worktrees are ephemeral: each one's `.planning/` (the GSD sub-workflow output)
 * is deleted with the worktree at cleanup. To keep a durable, queryable record
 * of every sesh (the knowledge base), the Conductor copies each worktree's
 * `.planning/` into `.bgsd/seshs/<run-id>/<unit-id>/planning/` BEFORE branch
 * cleanup. `.bgsd/seshs/` is committed (see the init gitignore allowlist).
 *
 * Pure planning + DI copy so it is unit-testable; live fs deps are exported.
 */

import { readdirSync, statSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";

/**
 * Plan the archive copies for a sesh.
 *
 * @param {object} opts
 * @param {string}   opts.runId
 * @param {string}   opts.bgsdDir       absolute path to .bgsd
 * @param {Array<{unitId:string, worktree:string}>} opts.worktrees
 * @param {(worktree:string)=>string[]} opts.listPlanningFn
 *   returns the planning files for a worktree, RELATIVE to its .planning/ dir
 * @returns {{ seshDir:string, copies: Array<{src:string,dest:string}> }}
 */
export function planSeshArchive({ runId, bgsdDir, worktrees, listPlanningFn }) {
  if (!runId) throw new Error("planSeshArchive: runId is required");
  const seshDir = join(bgsdDir, "seshs", runId);
  const copies = [];
  for (const wt of worktrees ?? []) {
    const rels = listPlanningFn(wt.worktree) ?? [];
    for (const rel of rels) {
      copies.push({
        src: join(wt.worktree, ".planning", rel),
        dest: join(seshDir, wt.unitId, "planning", rel),
      });
    }
  }
  return { seshDir, copies };
}

/**
 * Execute the archive plan via an injected copy function.
 *
 * @param {object} opts
 * @param {{ seshDir:string, copies:Array<{src,dest}> }} opts.plan
 * @param {(src:string,dest:string)=>void} opts.copyFn
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{ copied:number, seshDir:string }}
 */
export function executeSeshArchive({ plan, copyFn, log }) {
  for (const c of plan.copies) copyFn(c.src, c.dest);
  (log ?? (() => {}))(`archived ${plan.copies.length} planning file(s) to ${plan.seshDir}`);
  return { copied: plan.copies.length, seshDir: plan.seshDir };
}

/** Recursively list files under <worktree>/.planning, relative to that dir. */
export function liveListPlanning(worktree) {
  const base = join(worktree, ".planning");
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(base, full));
    }
  };
  walk(base);
  return out;
}

/** Live copy: ensure the destination directory exists, then copy. */
export function liveCopyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/** Convenience: archive a sesh against real fs. */
export function archiveSeshLive({ runId, bgsdDir, worktrees, log }) {
  const plan = planSeshArchive({ runId, bgsdDir, worktrees, listPlanningFn: liveListPlanning });
  return executeSeshArchive({ plan, copyFn: liveCopyFile, log });
}
