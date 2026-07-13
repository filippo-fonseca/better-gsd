#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeCommand, probeSubscription, probeProxy, runDoctor } from "./doctor.mjs";
import { resolveModelContract } from "./model-contract.mjs";

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

await test("runDoctor is READY on CLI+login and stamps verified_at (GSD optional in-session)", async () => {
  const spawn = (cmd, args) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/claude\n" };
    if (cmd === "claude" && args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
    return { status: 1, stdout: "", stderr: "" };
  };
  const contract = resolveModelContract({ profile: "claude" });
  const r = await runDoctor({ contract, spawn, requireGsd: false, now: () => "2026-07-13T00:00:00Z" });
  assert.equal(r.ok, true);
  assert.equal(r.contract.auth.verified_at, "2026-07-13T00:00:00Z");
});
await test("runDoctor FAILS the gate when subscription login is API-key based", async () => {
  const spawn = (cmd) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/claude\n" };
    if (cmd === "claude") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }) };
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ profile: "claude" }), spawn, requireGsd: false });
  assert.equal(r.ok, false);
  assert.equal(r.auth.claude.ok, false);
});
await test("runDoctor FAILS the gate when the build CLI is absent", async () => {
  const spawn = (cmd) => {
    if (cmd === "sh") return { status: 1, stdout: "" }; // command -v → not found
    if (cmd === "claude") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ profile: "claude" }), spawn, requireGsd: false });
  assert.equal(r.ok, false);
});

process.stdout.write(`\ndoctor.mjs: ${passed} passed\n`);
