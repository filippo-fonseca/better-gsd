#!/usr/bin/env node
/**
 * test-conductor.mjs — Unit tests for conductor.mjs (harness-neutral entrypoint)
 * and the AGENTS.md managed block. Run: node bgsd/scripts/test-conductor.mjs
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  PLUGIN_ROOT,
  resolvePluginRoot,
  buildConductorPrompt,
  buildConductorSpawn,
} from "./conductor.mjs";
import { bgsdAgentsMdBlock, mergeAgentsMd } from "./init.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); process.stdout.write(`  PASS  ${name}\n`); passed++; }
  catch (err) { process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`); failures.push({ name, error: err.message }); failed++; }
}

test("C01 — PLUGIN_ROOT points at the bgsd plugin dir (has commands/bgsd-sesh.md)", () => {
  assert.ok(existsSync(join(PLUGIN_ROOT, "commands", "bgsd-sesh.md")), "bgsd-sesh.md resolvable from PLUGIN_ROOT");
});

test("C02 — resolvePluginRoot prefers env override, else derives from script", () => {
  assert.equal(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: "/x" }), "/x");
  assert.equal(resolvePluginRoot({ BGSD_PLUGIN_ROOT: "/y" }), "/y");
  assert.equal(resolvePluginRoot({}), PLUGIN_ROOT);
});

test("C03 — buildConductorPrompt embeds request, flags, plugin root, and instructions", () => {
  const prompt = buildConductorPrompt({
    instructions: "SESH-BODY-MARKER",
    request: "build a forum",
    flags: ["--project"],
    pluginRoot: "/plug",
  });
  assert.ok(prompt.includes("build a forum"));
  assert.ok(prompt.includes("--project"));
  assert.ok(prompt.includes("/plug"));
  assert.ok(prompt.includes("SESH-BODY-MARKER"));
  assert.ok(prompt.includes("You are Kiwi, the bgsd Conductor"));
});

test("C04 — buildConductorSpawn (codex, interactive) exports plugin root into env", () => {
  const s = buildConductorSpawn({ harness: "codex", prompt: "P", pluginRoot: "/plug", env: {} });
  assert.equal(s.cmd, "codex");
  assert.deepEqual(s.args, ["P"]);
  assert.equal(s.env.CLAUDE_PLUGIN_ROOT, "/plug");
  assert.equal(s.env.BGSD_PLUGIN_ROOT, "/plug");
  assert.equal(s.env.AGENT, "codex");
});

test("C05 — buildConductorSpawn (codex, --exec) → codex exec … --sandbox", () => {
  const s = buildConductorSpawn({ harness: "codex", prompt: "P", pluginRoot: "/plug", exec: true, env: {} });
  assert.deepEqual(s.args, ["exec", "P", "--sandbox", "workspace-write"]);
});

test("C06 — buildConductorSpawn returns null for claude (use the slash command)", () => {
  assert.equal(buildConductorSpawn({ harness: "claude", prompt: "P", pluginRoot: "/plug" }), null);
});

test("C07 — bgsdAgentsMdBlock teaches Codex the launcher + backlog rule", () => {
  const block = bgsdAgentsMdBlock();
  assert.ok(block.includes("conductor.mjs"), "names the launcher");
  assert.ok(block.includes("queue.mjs add"), "routes backlog to the queue");
  assert.ok(block.includes(".planning/"), "warns off .planning");
  assert.ok(block.includes("<!-- bgsd:managed -->"), "sentinel present");
});

test("C08 — mergeAgentsMd is idempotent (sentinel-guarded)", () => {
  const first = mergeAgentsMd("");
  assert.equal(first.changed, true);
  assert.ok(first.content.includes("bgsd (this is a bgsd repo)"));
  const second = mergeAgentsMd(first.content);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
  // Appends to existing content without clobbering it.
  const withExisting = mergeAgentsMd("# My repo agents\n\nExisting notes.\n");
  assert.ok(withExisting.changed);
  assert.ok(withExisting.content.startsWith("# My repo agents"));
  assert.ok(withExisting.content.includes("<!-- bgsd:managed -->"));
});

process.stdout.write(`\nconductor.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`); process.exit(1); }
