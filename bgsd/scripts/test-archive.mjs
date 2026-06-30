#!/usr/bin/env node
/**
 * test-archive.mjs — Unit tests for archive.mjs (Phase 4 sesh archive).
 * Run with: node bgsd/scripts/test-archive.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  planSeshArchive,
  executeSeshArchive,
  liveListPlanning,
  archiveSeshLive,
} from "./archive.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

test("AR01 — planSeshArchive maps worktree planning files to seshs/<run>/<unit>", () => {
  const plan = planSeshArchive({
    runId: "bgsd-0001-x",
    bgsdDir: "/repo/.bgsd",
    worktrees: [
      { unitId: "u-auth", worktree: "/wt/u-auth" },
      { unitId: "u-bill", worktree: "/wt/u-bill" },
    ],
    listPlanningFn: (wt) => (wt.endsWith("u-auth") ? ["RUN.md", "phases/01/PLAN.md"] : ["RUN.md"]),
  });
  assert.equal(plan.seshDir, "/repo/.bgsd/seshs/bgsd-0001-x");
  assert.equal(plan.copies.length, 3);
  assert.deepEqual(plan.copies[0], {
    src: "/wt/u-auth/.planning/RUN.md",
    dest: "/repo/.bgsd/seshs/bgsd-0001-x/u-auth/planning/RUN.md",
  });
  assert.equal(
    plan.copies[1].dest,
    "/repo/.bgsd/seshs/bgsd-0001-x/u-auth/planning/phases/01/PLAN.md"
  );
});

test("AR02 — executeSeshArchive runs the copyFn for each file", () => {
  const copied = [];
  const res = executeSeshArchive({
    plan: { seshDir: "/s", copies: [{ src: "a", dest: "b" }, { src: "c", dest: "d" }] },
    copyFn: (s, d) => copied.push([s, d]),
  });
  assert.equal(res.copied, 2);
  assert.deepEqual(copied, [["a", "b"], ["c", "d"]]);
});

test("AR03 — archiveSeshLive copies real .planning into the master folder", () => {
  const wtRoot = mkdtempSync(join(tmpdir(), "bgsd-wt-"));
  const bgsdDir = mkdtempSync(join(tmpdir(), "bgsd-master-"));
  try {
    const planning = join(wtRoot, ".planning");
    mkdirSync(join(planning, "phases", "01"), { recursive: true });
    writeFileSync(join(planning, "RUN.md"), "# run\n");
    writeFileSync(join(planning, "phases", "01", "PLAN.md"), "# plan\n");

    const rels = liveListPlanning(wtRoot).sort();
    assert.deepEqual(rels, ["RUN.md", join("phases", "01", "PLAN.md")].sort());

    const res = archiveSeshLive({
      runId: "bgsd-0007-y",
      bgsdDir,
      worktrees: [{ unitId: "u-1", worktree: wtRoot }],
    });
    assert.equal(res.copied, 2);
    const dest = join(bgsdDir, "seshs", "bgsd-0007-y", "u-1", "planning");
    assert.ok(existsSync(join(dest, "RUN.md")));
    assert.ok(existsSync(join(dest, "phases", "01", "PLAN.md")));
    assert.equal(readFileSync(join(dest, "RUN.md"), "utf8"), "# run\n");
  } finally {
    rmSync(wtRoot, { recursive: true, force: true });
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

process.stdout.write(`\narchive.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
