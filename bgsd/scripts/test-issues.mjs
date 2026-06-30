#!/usr/bin/env node
/**
 * test-issues.mjs — Unit tests for issues.mjs (Phase 3 atomic GH issues).
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-issues.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green).
 */

import assert from "node:assert/strict";

import {
  truncate,
  formatEpic,
  formatUnit,
  createIssues,
  collectCloses,
} from "./issues.mjs";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

const UNITS = [
  { id: "u-auth", title: "Add auth", scope: "login + signup", touched: ["src/auth/**"], deps: [] },
  { id: "u-bill", title: "Add billing", scope: "stripe", touched: ["src/billing/**"], deps: ["u-auth"] },
];

await test("ISS01 — truncate keeps short strings, ellipsizes long", () => {
  assert.equal(truncate("short", 60), "short");
  const long = truncate("a".repeat(100), 20);
  assert.ok(long.endsWith("…"));
  assert.ok(long.length <= 21);
});

await test("ISS02 — formatEpic lists units as a checklist", () => {
  const e = formatEpic({ runId: "bgsd-0001-x", prompt: "Build the thing", units: UNITS });
  assert.ok(e.title.includes("bgsd-0001-x"));
  assert.ok(e.body.includes("- [ ] Add auth"));
  assert.ok(e.body.includes("- [ ] Add billing"));
});

await test("ISS03 — formatUnit links to epic + includes scope/touches/deps", () => {
  const u = formatUnit({ unit: UNITS[1], runId: "bgsd-0001-x", epicNumber: 7 });
  assert.equal(u.title, "Add billing");
  assert.ok(u.body.includes("Part of #7"));
  assert.ok(u.body.includes("stripe"));
  assert.ok(u.body.includes("src/billing/**"));
  assert.ok(u.body.includes("u-auth")); // dep
});

await test("ISS04 — createIssues: happy path creates epic then units", async () => {
  let n = 100;
  const created = [];
  const persisted = [];
  const res = await createIssues({
    runId: "bgsd-0001-x",
    prompt: "Build the thing",
    units: UNITS,
    deps: {
      hasRemote: () => true,
      createIssue: (p) => { created.push(p); return ++n; },
      persist: (r) => persisted.push(r),
    },
  });
  assert.equal(res.skipped, false);
  assert.equal(res.epic, 101, "epic created first");
  assert.equal(res.units["u-auth"], 102);
  assert.equal(res.units["u-bill"], 103);
  assert.equal(created.length, 3, "1 epic + 2 units");
  assert.equal(persisted.length, 1, "result persisted once");
  // unit bodies reference the epic number
  assert.ok(created[1].body.includes("Part of #101"));
});

await test("ISS05 — createIssues: no remote skips entirely", async () => {
  let calls = 0;
  const res = await createIssues({
    runId: "bgsd-0001-x",
    prompt: "Build",
    units: UNITS,
    deps: { hasRemote: () => false, createIssue: () => { calls++; return 1; } },
  });
  assert.equal(res.skipped, true);
  assert.equal(res.epic, null);
  assert.deepEqual(res.units, {});
  assert.equal(calls, 0, "no gh calls when there's no remote");
});

await test("ISS06 — collectCloses builds Closes lines for units (+ optional epic)", () => {
  const res = { skipped: false, epic: 101, units: { "u-auth": 102, "u-bill": 103 } };
  assert.equal(collectCloses(res, ["u-auth"]), "Closes #102");
  assert.equal(collectCloses(res, ["u-auth", "u-bill"]), "Closes #102\nCloses #103");
  assert.equal(
    collectCloses(res, ["u-auth"], { includeEpic: true }),
    "Closes #102\nCloses #101"
  );
  assert.equal(collectCloses({ skipped: true }, ["u-auth"]), "");
});

process.stdout.write(`\nissues.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
