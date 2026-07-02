#!/usr/bin/env node
/**
 * test-init.mjs — Unit tests for init.mjs (Phase 1 v0-init: /bgsd-init core)
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-init.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * The pure functions are tested directly; executeInit is tested against an
 * in-memory file map + branch set with mocked git (zero real I/O, zero git).
 *
 * Test groups:
 *   I01 — defaultBgsdConfig: shape + key defaults
 *   I02 — defaultBgsdConfig: returns a fresh deep copy (no shared refs)
 *   I03 — deepMerge: merges nested objects, replaces scalars, no mutation
 *   I04 — renderBgsdMd/parseBgsdMd: round-trips the config
 *   I05 — parseBgsdMd: no settings block -> defaults
 *   I06 — parseBgsdMd: malformed JSON block -> defaults
 *   I07 — parseBgsdMd: partial override layers over defaults
 *   I08 — mergeGitignore: empty input gains the block (changed)
 *   I09 — mergeGitignore: idempotent (second pass unchanged)
 *   I10 — mergeGitignore: preserves existing content
 *   I11 — planInit: fresh repo plans all create actions
 *   I12 — planInit: initialized repo only ensures dir + syncs
 *   I13 — planInit: sync disabled omits the sync action
 *   I14 — executeInit: fresh repo performs full bootstrap
 *   I15 — executeInit: second run is idempotent (no rewrites)
 *   I16 — executeInit: honors explicit base_branch from config
 *   I17 — executeInit: surfaces a non-sync reason as a note
 */

import assert from "node:assert/strict";

import {
  defaultBgsdConfig,
  deepMerge,
  renderBgsdMd,
  parseBgsdMd,
  mergeGitignore,
  mergeClaudeMd,
  planInit,
  executeInit,
} from "./init.mjs";
import { conductorOverride } from "./init-live.mjs";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n`);
    process.stdout.write(`        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// In-memory deps for executeInit (no real fs, no real git)
// ---------------------------------------------------------------------------

function mockDeps(overrides = {}) {
  const root = "/repo";
  const files = new Map(Object.entries(overrides.files ?? {}));
  const branches = new Set(overrides.branches ?? []);
  const calls = { createBranch: [], syncBranch: [], ensureGsdConfig: [] };

  const deps = {
    repoRoot: root,
    config: overrides.config,
    exists: (p) => files.has(p),
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
    writeFile: (p, s) => files.set(p, s),
    mkdirp: () => {},
    detectBaseBranch: overrides.detectBaseBranch ?? (() => "main"),
    branchExists: (b) => branches.has(b),
    createBranch: (b, base) => {
      calls.createBranch.push([b, base]);
      branches.add(b);
    },
    syncBranch:
      overrides.syncBranch ??
      ((b, base) => {
        calls.syncBranch.push([b, base]);
        return { updated: false, reason: "up to date" };
      }),
    ensureGsdConfig:
      overrides.ensureGsdConfig ??
      ((r, ib) => {
        calls.ensureGsdConfig.push([r, ib]);
        const p = `${r}/.planning/config.json`;
        if (files.has(p)) return false;
        files.set(p, JSON.stringify({ git: { base_branch: ib, branching_strategy: "none" } }));
        return true;
      }),
    log: () => {},
  };

  return { deps, files, branches, calls, root };
}

// ---------------------------------------------------------------------------
// Pure config
// ---------------------------------------------------------------------------

test("I01 — defaultBgsdConfig: shape + key defaults", () => {
  const c = defaultBgsdConfig();
  assert.equal(c.integration_branch, "next");
  assert.equal(c.base_branch, null);
  assert.equal(c.git.sync_integration_from_base, true);
  assert.equal(c.git.integration_to_main, "manual");
  assert.equal(c.env.propagate, true);
  assert.ok(Array.isArray(c.env.files) && c.env.files.includes(".env"));
  assert.equal(c.model_posture.tiers.high.model, "opus");
  assert.equal(c.model_posture.tiers.high.effort, "xhigh");
  assert.equal(c.model_posture.tiers.base.model, "sonnet");
  assert.equal(c.model_posture.tiers.base.effort, "xhigh");
  assert.equal(c.model_posture.verifier.model, "haiku");
  assert.equal(c.model_posture.verifier.effort, "low");
  assert.equal(c.conductor.suggest_gate_commands, true);
  // Conductor identity + self-management defaults.
  assert.equal(c.conductor.name, "Kiwi");
  assert.equal(c.conductor.emoji, "🥝");
  assert.equal(c.conductor.self_compact_at, 0.9);
  // Dashboard + walk-away notification defaults.
  assert.equal(c.gui.auto, true);
  assert.equal(c.notifications.os, true);
});

test("I02 — defaultBgsdConfig: fresh deep copy", () => {
  const a = defaultBgsdConfig();
  a.model_posture.tiers.high.model = "MUTATED";
  const b = defaultBgsdConfig();
  assert.equal(b.model_posture.tiers.high.model, "opus");
});

test("I03 — deepMerge: nested merge, scalar replace, no mutation", () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] };
  const over = { a: 2, nested: { y: 9 }, arr: [3] };
  const out = deepMerge(base, over);
  assert.deepEqual(out, { a: 2, nested: { x: 1, y: 9 }, arr: [3] });
  // base untouched
  assert.deepEqual(base, { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] });
});

test("I04 — render/parse round-trip", () => {
  const cfg = defaultBgsdConfig();
  const parsed = parseBgsdMd(renderBgsdMd(cfg));
  assert.deepEqual(parsed, cfg);
});

test("I05 — parseBgsdMd: no block -> defaults", () => {
  assert.deepEqual(parseBgsdMd("# just prose, no settings"), defaultBgsdConfig());
});

test("I06 — parseBgsdMd: malformed JSON -> defaults", () => {
  const bad = "```json bgsd-settings\n{ not valid json,, }\n```";
  assert.deepEqual(parseBgsdMd(bad), defaultBgsdConfig());
});

test("I07 — parseBgsdMd: partial override layers over defaults", () => {
  const text = '```json bgsd-settings\n{ "integration_branch": "develop" }\n```';
  const c = parseBgsdMd(text);
  assert.equal(c.integration_branch, "develop");
  // untouched keys still present from defaults
  assert.equal(c.model_posture.verifier.model, "haiku");
  assert.equal(c.env.propagate, true);
});

test("I07b — defaultBgsdConfig: context window-management section + defaults", () => {
  const c = defaultBgsdConfig();
  assert.equal(c.context.max_window_tokens, 1_000_000);
  assert.equal(c.context.compact_at, 0.70);
  assert.equal(c.context.relaunch_at, 0.90);
});

test("I07c — BGSD.md documents + round-trips the context block", () => {
  const md = renderBgsdMd(defaultBgsdConfig());
  assert.ok(md.includes("**context**"), "prose should document the context knob");
  assert.ok(md.includes("max_window_tokens"));
  // partial override of the context block layers over defaults
  const text = '```json bgsd-settings\n{ "context": { "compact_at": 0.5 } }\n```';
  const c = parseBgsdMd(text);
  assert.equal(c.context.compact_at, 0.5);
  assert.equal(c.context.relaunch_at, 0.90, "untouched context keys keep defaults");
  assert.equal(c.context.max_window_tokens, 1_000_000);
});

test("I07d — defaultBgsdConfig: verification.usage_testing defaults true", () => {
  const c = defaultBgsdConfig();
  assert.equal(c.verification.usage_testing, true);
});

test("I07d2 — defaultBgsdConfig: verification.headless + modes defaults", () => {
  const c = defaultBgsdConfig();
  assert.equal(c.verification.headless, false);
  assert.equal(c.modes.pipeline, "adaptive");
  assert.equal(c.modes.verifier, "adaptive");
});

test("I07e — BGSD.md documents + round-trips the verification knob", () => {
  const md = renderBgsdMd(defaultBgsdConfig());
  assert.ok(
    md.includes("verification.usage_testing"),
    "prose should document the verification knob"
  );
  const text = '```json bgsd-settings\n{ "verification": { "usage_testing": false } }\n```';
  const c = parseBgsdMd(text);
  assert.equal(c.verification.usage_testing, false, "override must disable usage testing");
});

// ---------------------------------------------------------------------------
// .gitignore merge
// ---------------------------------------------------------------------------

test("I08 — mergeGitignore: empty gains block", () => {
  const { content, changed } = mergeGitignore("");
  assert.equal(changed, true);
  assert.ok(content.includes(".bgsd/*"));
  assert.ok(content.includes("!.bgsd/seshs/"));
  assert.ok(content.includes("# bgsd — runtime artifacts (local only)"));
});

test("I09 — mergeGitignore: idempotent", () => {
  const first = mergeGitignore("node_modules\n").content;
  const second = mergeGitignore(first);
  assert.equal(second.changed, false);
  assert.equal(second.content, first);
});

test("I10 — mergeGitignore: preserves existing content", () => {
  const { content } = mergeGitignore("node_modules\ndist\n");
  assert.ok(content.startsWith("node_modules\ndist\n"));
  assert.ok(content.includes(".bgsd-tmp/"));
});

test("I10b — mergeClaudeMd: empty gains block + idempotent", () => {
  const first = mergeClaudeMd("");
  assert.equal(first.changed, true);
  assert.ok(first.content.includes("this is a bgsd repo"));
  assert.ok(first.content.includes(".bgsd/seshs/"));
  assert.ok(first.content.includes("/bgsd-sesh"));
  const second = mergeClaudeMd(first.content);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

// ---------------------------------------------------------------------------
// planInit
// ---------------------------------------------------------------------------

function freshState(overrides = {}) {
  return {
    bgsdConfigExists: false,
    bgsdMdExists: false,
    ledgerExists: false,
    seshsDirExists: false,
    integrationBranchExists: false,
    planningConfigExists: false,
    gitignoreHasBlock: false,
    integrationBranch: "next",
    baseBranch: "main",
    config: defaultBgsdConfig(),
    ...overrides,
  };
}

test("I11 — planInit: fresh repo plans all create actions", () => {
  const { alreadyInitialized, actions } = planInit(freshState());
  const types = actions.map((a) => a.type);
  assert.equal(alreadyInitialized, false);
  for (const t of [
    "ensure_bgsd_dir",
    "ensure_seshs_dir",
    "init_ledger",
    "write_config",
    "write_bgsd_md",
    "update_gitignore",
    "ensure_gsd_config",
    "create_integration_branch",
    "sync_integration_branch",
  ]) {
    assert.ok(types.includes(t), `expected action ${t}`);
  }
});

test("I12 — planInit: initialized repo only ensures dir + syncs", () => {
  const state = freshState({
    bgsdConfigExists: true,
    bgsdMdExists: true,
    ledgerExists: true,
    seshsDirExists: true,
    integrationBranchExists: true,
    planningConfigExists: true,
    gitignoreHasBlock: true,
    claudeMdHasBlock: true,
  });
  const { alreadyInitialized, actions } = planInit(state);
  const types = actions.map((a) => a.type);
  assert.equal(alreadyInitialized, true);
  assert.deepEqual(types, ["ensure_bgsd_dir", "sync_integration_branch"]);
});

test("I13 — planInit: sync disabled omits sync action", () => {
  const cfg = defaultBgsdConfig();
  cfg.git.sync_integration_from_base = false;
  const { actions } = planInit(freshState({ config: cfg }));
  assert.ok(!actions.some((a) => a.type === "sync_integration_branch"));
});

// ---------------------------------------------------------------------------
// executeInit
// ---------------------------------------------------------------------------

test("I14 — executeInit: fresh repo performs full bootstrap", () => {
  const { deps, files, branches, calls } = mockDeps();
  const res = executeInit(deps);

  assert.equal(res.alreadyInitialized, false);
  assert.equal(res.integrationBranch, "next");
  assert.equal(res.baseBranch, "main");
  for (const p of [
    "write_config",
    "write_bgsd_md",
    "init_ledger",
    "update_gitignore",
    "ensure_seshs_dir",
    "ensure_gsd_config",
    "create_integration_branch:next",
  ]) {
    assert.ok(res.performed.includes(p), `expected performed ${p}`);
  }
  assert.ok(files.has("/repo/.bgsd/config.json"));
  assert.ok(files.has("/repo/BGSD.md"));
  assert.ok(files.has("/repo/.bgsd/ledger.md"));
  assert.ok(files.get("/repo/.gitignore").includes(".bgsd/*"));
  assert.ok(branches.has("next"));
  assert.deepEqual(calls.createBranch[0], ["next", "main"]);
});

test("I15 — executeInit: second run is idempotent", () => {
  const ctx = mockDeps();
  executeInit(ctx.deps); // first
  const res = executeInit(ctx.deps); // second
  assert.equal(res.alreadyInitialized, true);
  assert.ok(!res.performed.includes("write_config"));
  assert.ok(!res.performed.includes("write_bgsd_md"));
  assert.ok(!res.performed.includes("create_integration_branch:next"));
  assert.ok(!res.performed.includes("ensure_gsd_config"));
});

test("I16 — executeInit: honors explicit base_branch", () => {
  const cfg = defaultBgsdConfig();
  cfg.base_branch = "trunk";
  const { deps, calls } = mockDeps({
    config: cfg,
    detectBaseBranch: () => {
      throw new Error("detectBaseBranch should not be called when base is pinned");
    },
  });
  const res = executeInit(deps);
  assert.equal(res.baseBranch, "trunk");
  assert.deepEqual(calls.createBranch[0], ["next", "trunk"]);
});

test("I17 — executeInit: surfaces a non-sync reason as a note", () => {
  const { deps } = mockDeps({
    branches: ["next"],
    syncBranch: () => ({ updated: false, reason: "diverged from base" }),
  });
  const res = executeInit(deps);
  assert.ok(res.notes.some((n) => n.includes("diverged from base")));
});

test("I18 — conductorOverride: sets name + emoji from flags", () => {
  const argv = ["node", "init-live.mjs", "--conductor-name", "Jarvis", "--conductor-emoji", "🤖"];
  const cfg = conductorOverride(argv, defaultBgsdConfig());
  assert.equal(cfg.conductor.name, "Jarvis");
  assert.equal(cfg.conductor.emoji, "🤖");
  // Untouched knobs keep their defaults.
  assert.equal(cfg.conductor.self_compact_at, 0.9);
});

test("I19 — conductorOverride: null when no identity flags", () => {
  assert.equal(conductorOverride(["node", "init-live.mjs"], defaultBgsdConfig()), null);
  assert.equal(conductorOverride(["node", "init-live.mjs", "--live"], defaultBgsdConfig()), null);
});

test("I20 — conductorOverride: one flag alone, no mutation of base", () => {
  const base = defaultBgsdConfig();
  const cfg = conductorOverride(["node", "x", "--conductor-name", "Friday"], base);
  assert.equal(cfg.conductor.name, "Friday");
  assert.equal(cfg.conductor.emoji, "🥝"); // default retained
  assert.equal(base.conductor.name, "Kiwi"); // base untouched
});

test("I21 — executeInit: writes conductor identity into BGSD.md + config", () => {
  const cfg = conductorOverride(
    ["node", "x", "--conductor-name", "Jarvis", "--conductor-emoji", "🤖"],
    defaultBgsdConfig()
  );
  const { deps, files } = mockDeps({ config: cfg });
  executeInit(deps);
  const parsed = parseBgsdMd(files.get("/repo/BGSD.md"));
  assert.equal(parsed.conductor.name, "Jarvis");
  assert.equal(parsed.conductor.emoji, "🤖");
  const json = JSON.parse(files.get("/repo/.bgsd/config.json"));
  assert.equal(json.conductor.name, "Jarvis");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\ninit.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
