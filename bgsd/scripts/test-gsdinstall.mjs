#!/usr/bin/env node
/**
 * test-gsdinstall.mjs — Unit tests for gsdinstall.mjs + the live --live guard
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-gsdinstall.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * The pure planner is tested directly; ensureGsd is tested against fully mocked
 * deps (no `claude` CLI, no child_process). The --live guard is tested by
 * toggling process.argv around requireLiveFlag/installGsd/updateGsd.
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
 *   G10 — requireLiveFlag: throws without --live, passes with it
 *   G11 — installGsd/updateGsd: throw the guard without --live (real side-effect funcs)
 */

import assert from "node:assert/strict";

import { gsdEnsurePlan, ensureGsd } from "./gsdinstall.mjs";
import {
  requireLiveFlag,
  isLiveFlagSet,
  installGsd,
  updateGsd,
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
// Mocked deps for ensureGsd (no `claude` CLI, no child_process)
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

/** Run `fn` with process.argv temporarily set to include/exclude --live. */
function withLiveFlag(present, fn) {
  const saved = process.argv;
  process.argv = present
    ? ["node", "gsdinstall-live.mjs", "--live"]
    : ["node", "gsdinstall-live.mjs"];
  try {
    return fn();
  } finally {
    process.argv = saved;
  }
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
// --live guard (real side-effect functions)
// ---------------------------------------------------------------------------

test("G10 — requireLiveFlag: throws without --live, passes with it", () => {
  withLiveFlag(false, () => {
    assert.equal(isLiveFlagSet(), false);
    assert.throws(() => requireLiveFlag(), /without --live/);
  });
  withLiveFlag(true, () => {
    assert.equal(isLiveFlagSet(), true);
    assert.doesNotThrow(() => requireLiveFlag());
  });
});

test("G11 — installGsd/updateGsd: throw the guard without --live", () => {
  // The real side-effect functions must refuse to run the `claude` CLI when
  // --live is absent. They hit requireLiveFlag() FIRST, so they throw before
  // ever spawning a process — no `claude` invocation occurs in this test.
  withLiveFlag(false, () => {
    assert.throws(() => installGsd({ log: () => {} }), /without --live/);
    assert.throws(() => updateGsd({ log: () => {} }), /without --live/);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\ngsdinstall.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
