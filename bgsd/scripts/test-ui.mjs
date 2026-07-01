#!/usr/bin/env node
/**
 * test-ui.mjs — Unit tests for ui.mjs (kiwiPill, renderLogo, lifecycle banners, CLI).
 * Run with: node bgsd/scripts/test-ui.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { kiwiPill, renderLogo, finishBanner } from "./ui.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiScript = join(__dirname, "ui.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Colour fixture constants
// ---------------------------------------------------------------------------

// Color forced ON: empty env (no NO_COLOR / CI) + isTTY true.
const COLOR_ON = { env: {}, isTTY: true };
// Color forced OFF via NO_COLOR even on a TTY.
const NO_COLOR = { env: { NO_COLOR: "1" }, isTTY: true };
// Color forced OFF via non-TTY even with a clean env.
const NON_TTY = { env: {}, isTTY: false };

// ---------------------------------------------------------------------------
// kiwiPill tests (UI01–UI09, unchanged from original harness)
// ---------------------------------------------------------------------------

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
  assert.ok(out.includes("\x1b["), "expected an ANSI escape sequence");
  assert.ok(out.includes("1;97;48;5;35"), "expected bold-white-on-green SGR");
  assert.ok(out.includes("\x1b[0m"), "expected an SGR reset");
});

test("UI04 — pill renders rounded end-caps when color is enabled", () => {
  const out = kiwiPill("kiwi · conductor", COLOR_ON);
  assert.ok(out.includes(""), "expected left half-circle cap (U+E0B6)");
  assert.ok(out.includes(""), "expected right half-circle cap (U+E0B4)");
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

// ---------------------------------------------------------------------------
// renderLogo — fallback tests (UI10–UI13)
// ---------------------------------------------------------------------------

// A spawnImpl that throws synchronously (simulates npx not found).
function throwingSpawn() {
  throw new Error("npx not found");
}

// A spawnImpl that returns a non-zero exit (npx found but oh-my-logo failed).
function nonZeroSpawn() {
  return { error: null, status: 1, stdout: "" };
}

// A spawnImpl that returns empty stdout (edge case).
function emptyStdoutSpawn() {
  return { error: null, status: 0, stdout: "" };
}

// A spawnImpl that returns a result with error set (child_process error field).
function errorFieldSpawn() {
  return { error: new Error("ENOENT"), status: null, stdout: null };
}

// A spawnImpl that returns fake oh-my-logo stdout with trailing escape codes.
function fakeLogoSpawn() {
  return {
    error: null,
    status: 0,
    stdout: "\x1b[32mBGSD\x1b[0m\n\x1b[?25h\x1b[K\x1b[0m   ",
  };
}

test("UI10 — renderLogo falls back to BGSD_ART when spawnImpl throws", () => {
  const out = renderLogo("BGSD", { spawnImpl: throwingSpawn });
  assert.ok(out.includes("██"), "expected BGSD_ART block characters in fallback");
  assert.ok(!out.includes("undefined"), "fallback must not contain 'undefined'");
});

test("UI11 — renderLogo falls back when spawnImpl returns non-zero exit", () => {
  const out = renderLogo("BGSD", { spawnImpl: nonZeroSpawn });
  assert.ok(out.includes("██"), "expected BGSD_ART block characters in fallback");
});

test("UI12 — renderLogo falls back when spawnImpl returns error field", () => {
  const out = renderLogo("BGSD", { spawnImpl: errorFieldSpawn });
  assert.ok(out.includes("██"), "expected BGSD_ART block characters in fallback");
});

test("UI13 — renderLogo falls back when spawnImpl returns empty stdout", () => {
  const out = renderLogo("BGSD", { spawnImpl: emptyStdoutSpawn });
  assert.ok(out.includes("██"), "expected BGSD_ART block characters in fallback");
});

test("UI14 — renderLogo strips cursor-hide/reset escapes from oh-my-logo output", () => {
  const out = renderLogo("BGSD", { spawnImpl: fakeLogoSpawn });
  // The meaningful content must survive.
  assert.ok(out.includes("BGSD"), "expected BGSD text to survive");
  // Cursor-hide escape \x1b[?25h must be stripped.
  assert.ok(!out.includes("\x1b[?25h"), "cursor-hide escape must be stripped");
  // Erase-to-EOL \x1b[K must be stripped.
  assert.ok(!out.includes("\x1b[K"), "erase-to-EOL escape must be stripped");
});

test("UI15 — renderLogo never throws on any input", () => {
  // Inject a truly pathological spawnImpl.
  const wild = () => { throw new TypeError("catastrophic"); };
  let threw = false;
  try {
    renderLogo("BGSD", { spawnImpl: wild });
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, "renderLogo must never throw");
});

// ---------------------------------------------------------------------------
// finishBanner — smoke test (UI16)
// ---------------------------------------------------------------------------

test("UI16 — finishBanner does not throw with fallback spawnImpl", () => {
  let threw = false;
  // Redirect stdout capture isn't possible without extra effort, but we can
  // at least confirm it does not throw even with a failing spawnImpl.
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    finishBanner({ summary: "all done", spawnImpl: throwingSpawn });
  } catch (err) {
    threw = true;
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(threw, false, "finishBanner must not throw");
  const out = chunks.join("");
  assert.ok(out.length > 0, "finishBanner must write something to stdout");
});

// ---------------------------------------------------------------------------
// CLI verb tests — drive node ui.mjs via spawnSync (UI17–UI22)
// ---------------------------------------------------------------------------

function runCli(...args) {
  return spawnSync(process.execPath, [uiScript, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }, // deterministic, no ANSI
    timeout: 15000,
  });
}

test("UI17 — CLI verb 'splash' exits 0 and prints non-empty output", () => {
  const r = runCli("splash");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok((r.stdout ?? "").trim().length > 0, "splash must print something");
});

test("UI18 — CLI verb 'init' exits 0 and prints non-empty output", () => {
  const r = runCli("init");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok((r.stdout ?? "").trim().length > 0, "init must print something");
});

test("UI19 — CLI verb 'banner' exits 0 and prints non-empty output", () => {
  const r = runCli("banner");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok((r.stdout ?? "").trim().length > 0, "banner must print something");
});

test("UI20 — CLI verb 'stage' with name + note exits 0 and includes name", () => {
  const r = runCli("stage", "Loop 1", "3 agents running");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok((r.stdout ?? "").includes("Loop 1"), "stage output must include the stage name");
  assert.ok((r.stdout ?? "").includes("3 agents running"), "stage output must include the note");
});

test("UI21 — CLI verb 'finish' exits 0 and prints non-empty output", () => {
  const r = runCli("finish", "auth + search shipped");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok((r.stdout ?? "").trim().length > 0, "finish must print something");
});

test("UI22 — CLI with unknown verb exits non-zero", () => {
  const r = runCli("nope");
  assert.notEqual(r.status, 0, "unknown verb must exit non-zero");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\nui.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
