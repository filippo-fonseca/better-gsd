#!/usr/bin/env node
/**
 * test-ui.mjs — Unit tests for ui.mjs (Kiwi pill + ANSI degradation).
 * Run with: node bgsd/scripts/test-ui.mjs
 */

import assert from "node:assert/strict";

import { kiwiPill } from "./ui.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

// Color forced ON: empty env (no NO_COLOR / CI) + isTTY true.
const COLOR_ON = { env: {}, isTTY: true };
// Color forced OFF via NO_COLOR even on a TTY.
const NO_COLOR = { env: { NO_COLOR: "1" }, isTTY: true };
// Color forced OFF via non-TTY even with a clean env.
const NON_TTY = { env: {}, isTTY: false };

test("UI01 — pill contains the default label text", () => {
  const out = kiwiPill("kiwi · conductor", COLOR_ON);
  assert.ok(out.includes("kiwi · conductor"), out);
});

test("UI02 — pill contains a custom label text", () => {
  const out = kiwiPill("kiwi · scout", COLOR_ON);
  assert.ok(out.includes("kiwi · scout"), out);
});

test("UI03 — pill includes ANSI escape sequences when color is enabled", () => {
  const out = kiwiPill("kiwi · conductor", COLOR_ON);
  // Contains at least one ESC (\x1b) SGR sequence.
  assert.ok(out.includes("\x1b["), "expected an ANSI escape sequence");
  // Bold white text on the kiwi-green 256-color background.
  assert.ok(out.includes("1;97;48;5;35"), "expected bold-white-on-green SGR");
  // A trailing reset so the pill does not bleed into following text.
  assert.ok(out.includes("\x1b[0m"), "expected an SGR reset");
});

test("UI04 — pill renders rounded end-caps when color is enabled", () => {
  const out = kiwiPill("kiwi · conductor", COLOR_ON);
  assert.ok(out.includes(""), "expected left half-circle cap (U+E0B6)");
  assert.ok(out.includes(""), "expected right half-circle cap (U+E0B4)");
});

test("UI05 — NO_COLOR returns the plain bracket form with no ANSI", () => {
  const out = kiwiPill("kiwi · conductor", NO_COLOR);
  assert.equal(out, "[kiwi · conductor]");
  assert.ok(!out.includes("\x1b["), "plain form must contain no ANSI");
});

test("UI06 — non-TTY returns the plain bracket form with no ANSI", () => {
  const out = kiwiPill("kiwi · conductor", NON_TTY);
  assert.equal(out, "[kiwi · conductor]");
  assert.ok(!out.includes("\x1b["), "plain form must contain no ANSI");
});

test("UI07 — CI=true degrades to the plain bracket form", () => {
  const out = kiwiPill("kiwi · conductor", { env: { CI: "true" }, isTTY: true });
  assert.equal(out, "[kiwi · conductor]");
});

test("UI08 — default label is `kiwi · conductor`", () => {
  const out = kiwiPill(undefined, NO_COLOR);
  assert.equal(out, "[kiwi · conductor]");
});

test("UI09 — pill is pure: same inputs yield the same string", () => {
  const a = kiwiPill("kiwi · conductor", COLOR_ON);
  const b = kiwiPill("kiwi · conductor", COLOR_ON);
  assert.equal(a, b);
});

process.stdout.write(`\nui.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
