#!/usr/bin/env node
/**
 * test-recall.mjs — Unit tests for recall.mjs (session recall) and the queue
 * listQueued() batch selector helper.
 * Run with: node bgsd/scripts/test-recall.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point the queue at an isolated dir BEFORE importing queue.mjs (it reads the
// env at import time). This lets us exercise the real listQueued() on disk.
const QDIR = mkdtempSync(join(tmpdir(), "bgsd-recall-queue-"));
process.env.BGSD_QUEUE_DIR = QDIR;

const {
  parseLedger,
  mostRecentSession,
  referencesLastSession,
  recall,
  recallLive,
  formatRecall,
} = await import("./recall.mjs");
const { addItem, listQueued, resolveItem } = await import("./queue.mjs");

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

const LEDGER =
  "# bgsd Run Ledger\n\n" +
  "| Title | Run ID | State | Merged | Held | Created At | Prompt |\n" +
  "|-------|--------|-------|--------|------|------------|--------|\n" +
  "| Auth middleware rewrite | sesh-aaa-1 | done | 3 | 0 | 2026-07-01T10:00:00.000Z | rewrite auth |\n" +
  "| Env propagation fix | sesh-bbb-2 | done | 2 | 0 | 2026-07-02T10:00:00.000Z | fix env files in worktrees |\n";

test("R01 — parseLedger extracts rows, skipping header + separator", () => {
  const rows = parseLedger(LEDGER);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Auth middleware rewrite");
  assert.equal(rows[0].runId, "sesh-aaa-1");
  assert.equal(rows[1].merged, 2);
});

test("R02 — mostRecentSession returns the LAST row (append-only log)", () => {
  const rows = parseLedger(LEDGER);
  assert.equal(mostRecentSession(rows).runId, "sesh-bbb-2");
  assert.equal(mostRecentSession([]), null);
});

test("R03 — referencesLastSession catches explicit back-references", () => {
  assert.ok(referencesLastSession("based on the last sesh, fix the nav"));
  assert.ok(referencesLastSession("continue the previous session's work"));
  assert.ok(referencesLastSession("pick up where we left off"));
  assert.ok(!referencesLastSession("add a brand new settings page"));
});

test("R04 — recall folds per-doc hits into per-session relevance + ledger meta", () => {
  const rows = parseLedger(LEDGER);
  const searchHits = [
    { runId: "sesh-bbb-2", score: 5, snippet: "…env files in worktrees…", path: "a" },
    { runId: "sesh-bbb-2", score: 3, snippet: "second", path: "b" },
    { runId: "sesh-aaa-1", score: 1, snippet: "auth", path: "c" },
  ];
  const r = recall({ prompt: "env files", ledgerRows: rows, searchHits, limit: 3 });
  assert.equal(r.mostRecent.runId, "sesh-bbb-2");
  assert.equal(r.relevant[0].runId, "sesh-bbb-2"); // 5+3 = 8, top
  assert.equal(r.relevant[0].score, 8);
  assert.equal(r.relevant[0].title, "Env propagation fix"); // meta joined
  assert.equal(r.relevant[1].runId, "sesh-aaa-1");
});

test("R05 — recall honors the relevant-session limit", () => {
  const rows = parseLedger(LEDGER);
  const searchHits = [
    { runId: "sesh-bbb-2", score: 5 },
    { runId: "sesh-aaa-1", score: 4 },
  ];
  const r = recall({ prompt: "x", ledgerRows: rows, searchHits, limit: 1 });
  assert.equal(r.relevant.length, 1);
});

test("R06 — recallLive degrades to empty recall when .bgsd is absent", () => {
  const r = recallLive("/no/such/bgsd", "anything");
  assert.equal(r.mostRecent, null);
  assert.deepEqual(r.relevant, []);
});

test("R07 — recallLive reads a real ledger + injected searchFn", () => {
  const bgsdDir = mkdtempSync(join(tmpdir(), "bgsd-recall-"));
  try {
    writeFileSync(join(bgsdDir, "ledger.md"), LEDGER);
    const r = recallLive(bgsdDir, "env files", {
      searchFn: () => [{ runId: "sesh-bbb-2", score: 9, snippet: "env" }],
    });
    assert.equal(r.mostRecent.runId, "sesh-bbb-2");
    assert.equal(r.relevant[0].runId, "sesh-bbb-2");
  } finally {
    rmSync(bgsdDir, { recursive: true, force: true });
  }
});

test("R08 — formatRecall renders a non-empty recall, empty string for nothing", () => {
  const rows = parseLedger(LEDGER);
  const r = recall({ prompt: "based on the last sesh", ledgerRows: rows, searchHits: [] });
  const text = formatRecall(r);
  assert.ok(text.includes("last sesh"));
  assert.ok(text.includes("references the last sesh"));
  assert.equal(formatRecall({ mostRecent: null, relevant: [], referencesLast: false }), "");
});

test("QL01 — listQueued returns only queued items (the next-sesh batch)", () => {
  const id1 = addItem({ title: "Idea one", body: "first" });
  const id2 = addItem({ title: "Idea two", body: "second" });
  let q = listQueued();
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((i) => i.title).sort(), ["Idea one", "Idea two"]);
  // Resolving one drops it from the batch.
  resolveItem(id1, { state: "done" });
  q = listQueued();
  assert.equal(q.length, 1);
  assert.equal(q[0].id, id2);
});

rmSync(QDIR, { recursive: true, force: true });

process.stdout.write(`\nrecall.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
