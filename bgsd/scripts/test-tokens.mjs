#!/usr/bin/env node
/**
 * test-tokens.mjs — Unit tests for tokens.mjs (token + cost accounting).
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-tokens.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green — NFR-06).
 *
 * Groups:
 *   PRICING — pricingKey alias resolution + estimateCost math
 *   LEDGER  — recordUsage append/atomic + loadUsage roundtrip + cost fill-in
 *   SUMMARY — summarize totals + by-model/role/agent breakdowns + unknown pricing
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRICING,
  pricingKey,
  estimateCost,
  recordUsage,
  loadUsage,
  summarize,
  renderReport,
} from "./tokens.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dir, "../../.bgsd-tmp/test-tokens");
try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }
mkdirSync(TMP, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

// --- PRICING ---------------------------------------------------------------

test("P01 — pricingKey resolves concrete ids", () => {
  assert.equal(pricingKey("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(pricingKey("gpt-5.4-mini"), "gpt-5.4-mini");
});

test("P02 — pricingKey resolves semantic tier aliases", () => {
  assert.equal(pricingKey("opus"), "claude-opus-4-8");
  assert.equal(pricingKey("sonnet"), "claude-sonnet-5");
  assert.equal(pricingKey("haiku"), "claude-haiku-4-5");
  assert.equal(pricingKey("fable"), "claude-fable-5");
});

test("P03 — pricingKey returns null for unknown model", () => {
  assert.equal(pricingKey("gpt-9-imaginary"), null);
  assert.equal(pricingKey(null), null);
});

test("P04 — estimateCost basic input+output (opus)", () => {
  // 1M input @ $5 + 1M output @ $25 = $30
  const usd = estimateCost({ model: "claude-opus-4-8", inputTokens: 1e6, outputTokens: 1e6 });
  assert.equal(usd, 30);
});

test("P05 — estimateCost nets cache-read out of full-price input", () => {
  // input 42k (15k of it cache-read), output 9k on opus
  // full input 27k*$5 + cache 15k*$0.5 + out 9k*$25 (per M)
  const usd = estimateCost({
    model: "claude-opus-4-8",
    inputTokens: 42000,
    outputTokens: 9000,
    cacheReadTokens: 15000,
  });
  assert.equal(usd, Number((0.135 + 0.0075 + 0.225).toFixed(6)));
});

test("P06 — estimateCost null when no pricing", () => {
  assert.equal(estimateCost({ model: "unknownium", inputTokens: 100 }), null);
});

test("P07 — every PRICING entry has input/output/cacheRead", () => {
  for (const [k, v] of Object.entries(PRICING)) {
    assert.ok(typeof v.input === "number", `${k} input`);
    assert.ok(typeof v.output === "number", `${k} output`);
    assert.ok(typeof v.cacheRead === "number", `${k} cacheRead`);
  }
});

// --- LEDGER ----------------------------------------------------------------

const BGSD = join(TMP, ".bgsd");

test("L01 — recordUsage creates ledger + fills computed cost", () => {
  const row = recordUsage(BGSD, "bgsd-t1", {
    agentId: "u-1", role: "executor", harness: "claude",
    model: "claude-opus-4-8", effort: "xhigh",
    inputTokens: 10000, outputTokens: 2000,
  });
  assert.equal(row.cost_usd, estimateCost({ model: "claude-opus-4-8", inputTokens: 10000, outputTokens: 2000 }));
  assert.equal(row.source, "measured");
  assert.ok(existsSync(join(BGSD, "runs", "bgsd-t1", "tokens.json")));
});

test("L02 — recordUsage appends (does not clobber)", () => {
  recordUsage(BGSD, "bgsd-t1", { agentId: "conductor", role: "conductor", model: "claude-opus-4-8", inputTokens: 5000, outputTokens: 500 });
  const ledger = loadUsage(BGSD, "bgsd-t1");
  assert.equal(ledger.entries.length, 2);
});

test("L03 — explicit --cost overrides computed", () => {
  const row = recordUsage(BGSD, "bgsd-t2", { agentId: "x", role: "planner", model: "claude-opus-4-8", inputTokens: 1000, costUsd: 9.99 });
  assert.equal(row.cost_usd, 9.99);
});

test("L04 — no token numbers => source none, cost null", () => {
  const row = recordUsage(BGSD, "bgsd-t3", { agentId: "x", role: "verifier", model: "made-up-model" });
  assert.equal(row.source, "none");
  assert.equal(row.cost_usd, null);
});

test("L05 — loadUsage on unknown run returns empty ledger", () => {
  const ledger = loadUsage(BGSD, "does-not-exist");
  assert.deepEqual(ledger.entries, []);
});

test("L06 — recordUsage throws without runId", () => {
  assert.throws(() => recordUsage(BGSD, "", { agentId: "x" }));
});

test("L07 — ledger persists valid JSON", () => {
  const raw = JSON.parse(readFileSync(join(BGSD, "runs", "bgsd-t1", "tokens.json"), "utf8"));
  assert.equal(raw.run_id, "bgsd-t1");
  assert.ok(Array.isArray(raw.entries));
});

// --- SUMMARY ---------------------------------------------------------------

test("S01 — summarize totals across rows", () => {
  const ledger = loadUsage(BGSD, "bgsd-t1"); // 2 rows: 10k+2k, 5k+0.5k
  const s = summarize(ledger);
  assert.equal(s.totals.calls, 2);
  assert.equal(s.totals.input, 15000);
  assert.equal(s.totals.output, 2500);
});

test("S02 — breakdowns by model/role/agent present", () => {
  const s = summarize(loadUsage(BGSD, "bgsd-t1"));
  assert.ok(s.byModel["claude-opus-4-8"]);
  assert.ok(s.byRole.executor && s.byRole.conductor);
  assert.ok(s.byAgent["u-1"] && s.byAgent.conductor);
});

test("S03 — unknown pricing marks costKnown false", () => {
  const s = summarize(loadUsage(BGSD, "bgsd-t3")); // the made-up-model row
  assert.equal(s.totals.costKnown, false);
});

test("S04 — renderReport returns a non-empty string with run id", () => {
  const out = renderReport(summarize(loadUsage(BGSD, "bgsd-t1")));
  assert.ok(out.includes("bgsd-t1"));
  assert.ok(out.includes("by model"));
});

// --- Cleanup + summary -----------------------------------------------------

try { rmSync(TMP, { recursive: true, force: true }); } catch (_) { /**/ }

const total = passed + failed;
process.stdout.write(`\n${total} test(s): ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures) process.stderr.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
} else {
  process.stdout.write("\nAll tests PASSED.\n");
  process.exit(0);
}
