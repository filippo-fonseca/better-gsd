#!/usr/bin/env node
/**
 * test-kb.mjs — Unit tests for kb.mjs (Phase 6 knowledge base).
 * Run with: node bgsd/scripts/test-kb.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { tokenize, buildIndex, search, loadSeshs, queryLive } from "./kb.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

const SESHS = [
  {
    runId: "bgsd-0001-auth",
    docs: [
      { path: "seshs/bgsd-0001-auth/u-auth/planning/RUN.md", unitId: "u-auth", text: "Implemented the auth middleware. The verifier flagged a session token issue." },
      { path: "seshs/bgsd-0001-auth/AGENTS.md", text: "u-auth agent: added login. u-bill agent: stripe billing." },
    ],
  },
  {
    runId: "bgsd-0002-ui",
    docs: [
      { path: "seshs/bgsd-0002-ui/u-nav/planning/RUN.md", unitId: "u-nav", text: "Built the navbar component. No blockers." },
    ],
  },
];

test("KB01 — tokenize splits on words and path chars", () => {
  assert.deepEqual(tokenize("Auth middleware src/auth/x.ts"), ["auth", "middleware", "src/auth/x.ts"]);
});

test("KB02 — search ranks by term frequency + returns a snippet", () => {
  const idx = buildIndex(SESHS);
  const hits = search(idx, "auth verifier");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].runId, "bgsd-0001-auth");
  assert.equal(hits[0].unitId, "u-auth");
  assert.ok(hits[0].snippet.length > 0);
});

test("KB03 — search returns [] for no match / empty query", () => {
  const idx = buildIndex(SESHS);
  assert.deepEqual(search(idx, "kubernetes"), []);
  assert.deepEqual(search(idx, ""), []);
});

test("KB04 — search finds which agent touched a module", () => {
  const idx = buildIndex(SESHS);
  const hits = search(idx, "stripe billing");
  assert.ok(hits.some((h) => h.path.endsWith("AGENTS.md")));
});

test("KB05 — loadSeshs + queryLive over a real corpus", () => {
  const bgsdDir = mkdtempSync(join(tmpdir(), "bgsd-kb-"));
  try {
    const p = join(bgsdDir, "seshs", "bgsd-0009-pay", "u-pay", "planning");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "RUN.md"), "Added the payments webhook handler. Integration Tester passed.\n");
    writeFileSync(join(bgsdDir, "seshs", "bgsd-0009-pay", "RUN.md"), "Run summary for payments.\n");

    const seshs = loadSeshs(bgsdDir);
    assert.equal(seshs.length, 1);
    assert.equal(seshs[0].runId, "bgsd-0009-pay");

    const hits = queryLive(bgsdDir, "payments webhook");
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].path.includes("bgsd-0009-pay"));
    // the unit-scoped doc carries its unitId
    assert.ok(hits.some((h) => h.unitId === "u-pay"));
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

process.stdout.write(`\nkb.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
