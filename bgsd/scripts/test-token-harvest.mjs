#!/usr/bin/env node
/**
 * test-token-harvest.mjs — Claude / Codex / Cursor usage harvesting.
 */
import assert from "node:assert/strict";
import { harvestUsage, parseCursorStreamUsage } from "./token-harvest.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  PASS  ${name}\n`); }

test("39 — Cursor stream events are parsed when usage exists", () => {
  const text = [
    JSON.stringify({ type: "system", subtype: "init", model: "composer-2.5", apiKeySource: "login" }),
    JSON.stringify({ type: "result", usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 } }),
  ].join("\n");
  const u = parseCursorStreamUsage(text);
  assert.equal(u.source, "measured");
  assert.equal(u.inputTokens, 110);
  assert.equal(u.outputTokens, 40);
  assert.equal(u.apiKeySource, "login");
  assert.equal(u.model, "composer-2.5");
});

test("40 — Missing usage records source: none rather than fabricated numbers", () => {
  const text = JSON.stringify({ type: "system", subtype: "init", model: "composer-2.5", apiKeySource: "login" });
  const u = parseCursorStreamUsage(text);
  assert.equal(u.source, "none");
  assert.equal(u.inputTokens, null);
  assert.equal(u.outputTokens, null);
});

test("41 — Cursor is never sent through the Claude transcript parser", () => {
  // Unknown harness returns null; cursor with no files returns null — never invents Claude numbers.
  assert.equal(harvestUsage("unknown-harness", "/tmp", Date.now()), null);
  assert.equal(harvestUsage("cursor", "/nonexistent-cwd-xyz", Date.now()), null);
  const measured = harvestUsage("cursor", "/tmp", Date.now(), {
    streamText: JSON.stringify({ usage: { input_tokens: 5, output_tokens: 2 } }),
  });
  assert.equal(measured.source, "measured");
  assert.equal(measured.inputTokens, 5);
});

test("Claude harness still dispatches (returns null without transcripts)", () => {
  assert.equal(harvestUsage("claude", "/nonexistent", Date.now()), null);
});

process.stdout.write(`\ntoken-harvest.mjs: ${passed} passed\n`);
