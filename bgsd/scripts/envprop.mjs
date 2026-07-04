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

import { readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { defaultBgsdConfig, parseBgsdMd } from "./init.mjs";

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

/**
 * Resolve the env-propagation settings for a repo from its BGSD.md
 * (`env.propagate` + `env.files`), falling back to defaultBgsdConfig() when
 * BGSD.md is absent or unparseable. Single source of truth for every call site,
 * so patterns are never hardcoded.
 *
 * @param {string} repoRoot
 * @param {(p:string)=>string}  [readFileFn]  injectable reader (tests)
 * @param {(p:string)=>boolean} [existsFn]    injectable existence check (tests)
 * @returns {{ propagate: boolean, files: string[] }}
 */
export function resolveEnvConfig(repoRoot, readFileFn, existsFn) {
  const _exists = existsFn ?? existsSync;
  const _read = readFileFn ?? ((p) => readFileSync(p, "utf8"));
  const defaults = defaultBgsdConfig().env;
  const bgsdMdPath = join(repoRoot, "BGSD.md");
  let env = defaults;
  if (_exists(bgsdMdPath)) {
    try {
      env = parseBgsdMd(_read(bgsdMdPath)).env ?? defaults;
    } catch (_) {
      env = defaults;
    }
  }
  const files = Array.isArray(env.files) && env.files.length ? env.files : defaults.files;
  return { propagate: env.propagate !== false, files };
}

/** An env-looking filename at the repo root: `.env`, `.env.local`, `.env.production`, … */
export const ENV_LIKE_RE = /^\.env(\..+)?$/;

/**
 * Inspect the repo root for env files and split them by whether the configured
 * `env.files` globs already cover them. This is what lets the Conductor CONFIRM
 * WHEN UNSURE: if there are env-looking files at the root that the globs miss
 * (e.g. `.env.production` when the config only lists `.env`/`.env.local`), it can
 * ask the user whether to propagate them too, instead of silently skipping env
 * the app may need.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {(p:string)=>string}  [opts.readFileFn]  injectable reader (tests)
 * @param {(p:string)=>boolean} [opts.existsFn]    injectable existence check (tests)
 * @param {()=>string[]}        [opts.listRootFn]  injectable root lister (tests)
 * @returns {{ propagate: boolean, patterns: string[], covered: string[], uncovered: string[] }}
 *   covered   — env files at root matched by the configured globs (will propagate)
 *   uncovered — env-looking files at root NOT matched (the ambiguity to confirm)
 */
export function detectEnvFiles(repoRoot, { readFileFn, existsFn, listRootFn } = {}) {
  const { propagate, files } = resolveEnvConfig(repoRoot, readFileFn, existsFn);
  const listRoot =
    listRootFn ??
    (() =>
      readdirSync(repoRoot, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name));
  let rootFiles = [];
  try {
    rootFiles = listRoot();
  } catch (_) {
    rootFiles = [];
  }
  const covered = matchEnvFiles(rootFiles, files);
  const coveredSet = new Set(covered);
  const uncovered = rootFiles.filter((f) => ENV_LIKE_RE.test(f) && !coveredSet.has(f));
  return { propagate, patterns: files, covered, uncovered };
}

/**
 * Config-driven propagation: read env.propagate/env.files from the repo's
 * BGSD.md and copy the matching root env files into destDir. This is the seam
 * every worktree / integration-boot site should call so the whole session
 * inherits the root's env exactly as configured.
 *
 * No-ops (returns copied: []) when propagation is disabled, or when destDir
 * resolves to the repo root (source === dest — the root already has its env).
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.destDir
 * @param {(msg:string)=>void} [opts.log]
 * @param {(p:string)=>string}  [opts.readFileFn]  injectable reader (tests)
 * @param {(p:string)=>boolean} [opts.existsFn]    injectable existence check (tests)
 * @returns {{ copied: string[], skipped?: "disabled"|"same-dir" }}
 */
export function propagateEnvForConfig({ repoRoot, destDir, log, readFileFn, existsFn }) {
  const _log = log ?? (() => {});
  const { propagate, files } = resolveEnvConfig(repoRoot, readFileFn, existsFn);
  if (!propagate) {
    _log("env propagation disabled (env.propagate=false) — skipping");
    return { copied: [], skipped: "disabled" };
  }
  if (resolve(destDir) === resolve(repoRoot)) {
    _log("env propagation target is the repo root — env already present, skipping");
    return { copied: [], skipped: "same-dir" };
  }
  return propagateEnvLive({ repoRoot, destDir, patterns: files, log: _log });
}

// ---------------------------------------------------------------------------
// CLI — env preflight check for the Conductor (confirm-when-unsure)
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]envprop\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const json = argv.includes("--json");
  const repoRoot = process.cwd();

  if (sub === "detect" || sub === "check") {
    const { propagate, patterns, covered, uncovered } = detectEnvFiles(repoRoot);
    if (json) {
      process.stdout.write(JSON.stringify({ propagate, patterns, covered, uncovered }) + "\n");
    } else {
      process.stdout.write(`\nenv preflight — repo: ${repoRoot}\n`);
      process.stdout.write(`  propagate:  ${propagate ? "on" : "off (env.propagate=false)"}\n`);
      process.stdout.write(`  patterns:   ${patterns.join(", ")}\n`);
      process.stdout.write(`  covered:    ${covered.join(", ") || "(none)"}\n`);
      process.stdout.write(`  uncovered:  ${uncovered.join(", ") || "(none)"}\n`);
      if (uncovered.length) {
        process.stdout.write(
          `\n  ⚠ ${uncovered.length} env-looking file(s) are NOT covered by env.files.\n` +
          `    Confirm with the user whether to propagate them, or add them to env.files in BGSD.md.\n`
        );
      }
      process.stdout.write("\n");
    }
    process.exit(uncovered.length ? 2 : 0);
  }

  process.stderr.write('Usage: node envprop.mjs detect [--json]\n');
  process.exit(1);
}
