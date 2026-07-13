#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeCommand, probeSubscription, probeProxy } from "./doctor.mjs";

let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; process.stdout.write(`  PASS  ${name}\n`); }); }

await test("command probe reports presence", () => {
  const spawn = () => ({ status: 0, stdout: "/bin/codex\n" });
  assert.deepEqual(probeCommand("codex", spawn), { ok: true, path: "/bin/codex" });
});
await test("Claude subscription rejects API auth", () => {
  const spawn = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }) });
  assert.equal(probeSubscription("claude", spawn).ok, false);
});
await test("Codex subscription accepts ChatGPT", () => {
  const spawn = () => ({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" });
  assert.equal(probeSubscription("openai", spawn).ok, true);
});
await test("proxy probe fails closed", async () => {
  const result = await probeProxy({ fetchImpl: async () => ({ ok: false, status: 503 }), env: { BGSD_PROXY_URL: "http://localhost:8317", BGSD_PROXY_TOKEN: "x" } });
  assert.match(result.reason, /503/);
});

process.stdout.write(`\ndoctor.mjs: ${passed} passed\n`);
