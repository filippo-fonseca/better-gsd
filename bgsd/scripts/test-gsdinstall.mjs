#!/usr/bin/env node
/**
 * test-gsdinstall.mjs — Unit tests for gsdinstall.mjs + the live npx seam
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-gsdinstall.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * The pure planner is tested directly; ensureGsd is tested against fully mocked
 * deps. The live seam is tested with dependency injection: detection runs against
 * a temp dir (real fs, no global install touched) and install/update run against
 * a stub spawn (no real `npx @opengsd/gsd-core` ever executes).
 *
 * Test groups:
 *   G01 — gsdEnsurePlan: missing -> ["install"] (policy irrelevant)
 *   G02 — gsdEnsurePlan: present + "always" -> ["update"]
 *   G03 — gsdEnsurePlan: present + non-policy -> []
 *   G04 — gsdEnsurePlan: present, default policy -> ["update"]
 *   G05 — ensureGsd: missing -> installs, does NOT update
 *   G06 — ensureGsd: present + "always" -> updates, does NOT install
 *   G07 — ensureGsd: present + "never" -> no-op (alreadyCurrent)
 *   G08 — ensureGsd: present, default policy -> updates
 *   G09 — ensureGsd: log narrates the chosen path
 *   G10 — resolveClaudeConfigDir: $CLAUDE_CONFIG_DIR wins, else ~/.claude
 *   G11 — isGsdInstalled: filesystem detection against a temp config dir
 *   G12 — installGsd/updateGsd: run the verified npx command (stubbed spawn)
 *   G13 — installGsd/updateGsd: throw on non-zero exit and on spawn error
 *   G14 — ensureGsdLive: install-when-missing / update-when-present end-to-end
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gsdEnsurePlan, ensureGsd } from "./gsdinstall.mjs";
import {
  GSD_NPM_PACKAGE,
  GSD_NPM_SPEC,
  GSD_INSTALL_ARGS,
  resolveClaudeConfigDir,
  isGsdInstalled,
  installGsd,
  updateGsd,
  ensureGsdLive,
} from "./gsdinstall-live.mjs";

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
// Mocked deps for ensureGsd (no fs, no child_process)
// ---------------------------------------------------------------------------

function mockDeps(overrides = {}) {
  const calls = { isInstalled: 0, install: 0, update: 0, log: [] };
  const deps = {
    isInstalled: () => {
      calls.isInstalled++;
      return !!overrides.installed;
    },
    install: () => {
      calls.install++;
    },
    update: () => {
      calls.update++;
    },
    log: (m) => calls.log.push(m),
    updatePolicy: overrides.updatePolicy,
  };
  return { deps, calls };
}

/** A temp dir seeded (or not) with a gsd command marker, for fs detection tests. */
function tmpConfigDir({ installed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-gsdcfg-"));
  if (installed) {
    mkdirSync(join(dir, "skills", "gsd-help"), { recursive: true });
    writeFileSync(join(dir, "skills", "gsd-help", "SKILL.md"), "# gsd-help\n");
  }
  return dir;
}

/** A stub spawnSync that records calls and returns a configurable result. */
function stubSpawn(result = { status: 0 }) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { spawn, calls };
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

test('G01 — gsdEnsurePlan: missing -> ["install"] (policy irrelevant)', () => {
  assert.deepEqual(gsdEnsurePlan({ installed: false }), ["install"]);
  assert.deepEqual(gsdEnsurePlan({ installed: false, updatePolicy: "always" }), ["install"]);
  assert.deepEqual(gsdEnsurePlan({ installed: false, updatePolicy: "never" }), ["install"]);
});

test('G02 — gsdEnsurePlan: present + "always" -> ["update"]', () => {
  assert.deepEqual(gsdEnsurePlan({ installed: true, updatePolicy: "always" }), ["update"]);
});

test("G03 — gsdEnsurePlan: present + non-policy -> []", () => {
  assert.deepEqual(gsdEnsurePlan({ installed: true, updatePolicy: "never" }), []);
  assert.deepEqual(gsdEnsurePlan({ installed: true, updatePolicy: "manual" }), []);
});

test('G04 — gsdEnsurePlan: present, default policy -> ["update"]', () => {
  // omitting updatePolicy falls back to DEFAULT_UPDATE_POLICY ("always")
  assert.deepEqual(gsdEnsurePlan({ installed: true }), ["update"]);
});

// ---------------------------------------------------------------------------
// DI executor
// ---------------------------------------------------------------------------

test("G05 — ensureGsd: missing -> installs, does NOT update", () => {
  const { deps, calls } = mockDeps({ installed: false, updatePolicy: "always" });
  const res = ensureGsd(deps);
  assert.equal(calls.install, 1);
  assert.equal(calls.update, 0);
  assert.deepEqual(res.performed, ["install"]);
  assert.equal(res.installed, true);
  assert.equal(res.alreadyCurrent, false);
});

test('G06 — ensureGsd: present + "always" -> updates, does NOT install', () => {
  const { deps, calls } = mockDeps({ installed: true, updatePolicy: "always" });
  const res = ensureGsd(deps);
  assert.equal(calls.install, 0);
  assert.equal(calls.update, 1);
  assert.deepEqual(res.performed, ["update"]);
  assert.equal(res.installed, true);
  assert.equal(res.alreadyCurrent, false);
});

test('G07 — ensureGsd: present + "never" -> no-op (alreadyCurrent)', () => {
  const { deps, calls } = mockDeps({ installed: true, updatePolicy: "never" });
  const res = ensureGsd(deps);
  assert.equal(calls.install, 0);
  assert.equal(calls.update, 0);
  assert.deepEqual(res.performed, []);
  assert.equal(res.installed, true);
  assert.equal(res.alreadyCurrent, true);
});

test("G08 — ensureGsd: present, default policy -> updates", () => {
  const { deps, calls } = mockDeps({ installed: true }); // no updatePolicy -> "always"
  const res = ensureGsd(deps);
  assert.equal(calls.update, 1);
  assert.deepEqual(res.performed, ["update"]);
});

test("G09 — ensureGsd: log narrates the chosen path", () => {
  const missing = mockDeps({ installed: false, updatePolicy: "always" });
  ensureGsd(missing.deps);
  assert.ok(missing.calls.log.some((m) => /installing/i.test(m)));

  const stale = mockDeps({ installed: true, updatePolicy: "always" });
  ensureGsd(stale.deps);
  assert.ok(stale.calls.log.some((m) => /updating/i.test(m)));

  const current = mockDeps({ installed: true, updatePolicy: "never" });
  ensureGsd(current.deps);
  assert.ok(current.calls.log.some((m) => /nothing to do/i.test(m)));
});

// ---------------------------------------------------------------------------
// Config-dir resolution
// ---------------------------------------------------------------------------

test("G10 — resolveClaudeConfigDir: $CLAUDE_CONFIG_DIR wins, else ~/.claude", () => {
  const home = () => "/home/tester";
  assert.equal(
    resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "/custom/cfg" }, home }),
    "/custom/cfg"
  );
  // empty / whitespace env falls back to ~/.claude
  assert.equal(resolveClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "" }, home }), "/home/tester/.claude");
  assert.equal(resolveClaudeConfigDir({ env: {}, home }), "/home/tester/.claude");
});

// ---------------------------------------------------------------------------
// Filesystem detection (real fs against a temp dir — no global install touched)
// ---------------------------------------------------------------------------

test("G11 — isGsdInstalled: filesystem detection against a temp config dir", () => {
  // gsd-core is NOT a Claude Code plugin, so detection is purely fs-based:
  // a known gsd command file under the config dir means "installed".
  const empty = tmpConfigDir({ installed: false });
  assert.equal(isGsdInstalled({ configDir: empty }), false);

  const present = tmpConfigDir({ installed: true });
  assert.equal(isGsdInstalled({ configDir: present }), true);

  // injectable exists predicate (no real fs at all) also works
  assert.equal(
    isGsdInstalled({ configDir: "/x", exists: (p) => p.endsWith("gsd-help/SKILL.md") }),
    true
  );
  assert.equal(isGsdInstalled({ configDir: "/x", exists: () => false }), false);
});

// ---------------------------------------------------------------------------
// Install / update side effects (stubbed spawn — no real npx)
// ---------------------------------------------------------------------------

test("G12 — installGsd/updateGsd: run the verified npx command (stubbed spawn)", () => {
  // the one correct, non-interactive command: npx -y @opengsd/gsd-core@latest --claude --global
  assert.deepEqual(GSD_INSTALL_ARGS, ["-y", GSD_NPM_SPEC, "--claude", "--global"]);
  assert.equal(GSD_NPM_PACKAGE, "@opengsd/gsd-core");
  assert.equal(GSD_NPM_SPEC, "@opengsd/gsd-core@latest");

  const inst = stubSpawn({ status: 0 });
  assert.doesNotThrow(() => installGsd({ spawn: inst.spawn, log: () => {} }));
  assert.equal(inst.calls.length, 1);
  assert.equal(inst.calls[0].cmd, "npx");
  assert.deepEqual(inst.calls[0].args, ["-y", GSD_NPM_SPEC, "--claude", "--global"]);
  assert.equal(inst.calls[0].opts.stdio, "inherit");

  const upd = stubSpawn({ status: 0 });
  assert.doesNotThrow(() => updateGsd({ spawn: upd.spawn, log: () => {} }));
  assert.deepEqual(upd.calls[0].args, ["-y", GSD_NPM_SPEC, "--claude", "--global"]);
});

test("G13 — installGsd/updateGsd: throw on non-zero exit and on spawn error", () => {
  const nonzero = stubSpawn({ status: 7 });
  assert.throws(() => installGsd({ spawn: nonzero.spawn }), /exit 7/);

  const spawnErr = stubSpawn({ status: null, error: new Error("ENOENT npx") });
  assert.throws(() => updateGsd({ spawn: spawnErr.spawn }), /failed to spawn/);
});

// ---------------------------------------------------------------------------
// End-to-end live seam: detect (temp dir) + act (stub spawn)
// ---------------------------------------------------------------------------

test("G14 — ensureGsdLive: install-when-missing / update-when-present end-to-end", () => {
  // Missing: empty config dir -> install runs the npx command exactly once.
  {
    const dir = tmpConfigDir({ installed: false });
    const spy = stubSpawn({ status: 0 });
    // Inject the stub spawn via installGsd/updateGsd by overriding ensureGsdLive's
    // deps path: ensureGsdLive uses the real installGsd, so we instead drive
    // ensureGsd directly with deps that detect against the temp dir and use the
    // stub spawn for mutations. This mirrors what ensureGsdLive wires together.
    const res = ensureGsd({
      isInstalled: () => isGsdInstalled({ configDir: dir }),
      install: () => installGsd({ spawn: spy.spawn }),
      update: () => updateGsd({ spawn: spy.spawn }),
      updatePolicy: "always",
    });
    assert.deepEqual(res.performed, ["install"]);
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0].args, ["-y", GSD_NPM_SPEC, "--claude", "--global"]);
  }

  // Present: seeded config dir + "always" -> update runs the npx command once.
  {
    const dir = tmpConfigDir({ installed: true });
    const spy = stubSpawn({ status: 0 });
    const res = ensureGsd({
      isInstalled: () => isGsdInstalled({ configDir: dir }),
      install: () => installGsd({ spawn: spy.spawn }),
      update: () => updateGsd({ spawn: spy.spawn }),
      updatePolicy: "always",
    });
    assert.deepEqual(res.performed, ["update"]);
    assert.equal(spy.calls.length, 1);
  }

  // Present + "never" -> no spawn at all (alreadyCurrent).
  {
    const dir = tmpConfigDir({ installed: true });
    const spy = stubSpawn({ status: 0 });
    const res = ensureGsd({
      isInstalled: () => isGsdInstalled({ configDir: dir }),
      install: () => installGsd({ spawn: spy.spawn }),
      update: () => updateGsd({ spawn: spy.spawn }),
      updatePolicy: "never",
    });
    assert.equal(res.alreadyCurrent, true);
    assert.equal(spy.calls.length, 0);
  }

  // ensureGsdLive itself is exported and callable with an injected configDir;
  // we only assert it does not throw on a present dir with policy "never" (no
  // spawn happens, so no real npx runs).
  {
    const dir = tmpConfigDir({ installed: true });
    assert.doesNotThrow(() =>
      ensureGsdLive({ updatePolicy: "never", configDir: dir, log: () => {} })
    );
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\ngsdinstall.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
