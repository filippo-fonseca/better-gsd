#!/usr/bin/env node
import assert from "node:assert/strict";
import { probeCommand, probeSubscription, probeProxy, runDoctor, parseCursorModelList, validateCursorSelector } from "./doctor.mjs";
import { resolveModelContract } from "./model-contract.mjs";

let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; process.stdout.write(`  PASS  ${name}\n`); }); }

const MODEL_LIST = `
Available models
auto - Auto (default)
composer-2.5 - Composer 2.5 (current)
composer-2.5-fast - Composer 2.5 Fast
cursor-grok-4.5-high - Cursor Grok 4.5
cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast
`;

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

await test("parseCursorModelList extracts selectors", () => {
  const m = parseCursorModelList(MODEL_LIST);
  assert.equal(m.get("composer-2.5"), "Composer 2.5 (current)");
  assert.ok(m.has("cursor-grok-4.5-high"));
});

await test("validateCursorSelector rejects Fast", () => {
  const m = parseCursorModelList(MODEL_LIST);
  assert.equal(validateCursorSelector("composer-2.5-fast", m).ok, false);
  assert.equal(validateCursorSelector("composer-2.5", m).ok, true);
  assert.equal(validateCursorSelector("missing-model", m).ok, false);
});

function cursorReadySpawn(cmd, args) {
  if (cmd === "sh") return { status: 0, stdout: "/bin/cursor-agent\n" };
  if (cmd === "cursor-agent" && args?.[0] === "status") {
    return { status: 0, stdout: JSON.stringify({ status: "authenticated", isAuthenticated: true, apiKeySource: "login" }) };
  }
  if (cmd === "cursor-agent" && (args?.[0] === "--list-models" || args?.includes("--list-models"))) {
    return { status: 0, stdout: MODEL_LIST };
  }
  return { status: 1, stdout: "", stderr: "" };
}

await test("17 — Cursor missing fails the gate", async () => {
  const spawn = (cmd) => {
    if (cmd === "sh") return { status: 1, stdout: "" };
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ env: { PATH: "/bin" } }), spawn, requireGsd: false, env: { PATH: "/bin" } });
  assert.equal(r.ok, false);
  assert.equal(r.cli.cursor?.ok, false);
});

await test("18 — Cursor logged out fails the gate", async () => {
  const spawn = (cmd, args) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/cursor-agent\n" };
    if (cmd === "cursor-agent" && args?.[0] === "status") {
      return { status: 0, stdout: JSON.stringify({ isAuthenticated: false }) };
    }
    if (cmd === "cursor-agent" && args?.[0] === "--list-models") return { status: 0, stdout: MODEL_LIST };
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ env: { PATH: "/bin" } }), spawn, requireGsd: false, env: { PATH: "/bin" } });
  assert.equal(r.ok, false);
  assert.equal(r.auth.cursor.ok, false);
});

await test("19 — Composer selector missing fails the gate", async () => {
  const spawn = (cmd, args) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/cursor-agent\n" };
    if (cmd === "cursor-agent" && args?.[0] === "status") {
      return { status: 0, stdout: JSON.stringify({ isAuthenticated: true, apiKeySource: "login" }) };
    }
    if (cmd === "cursor-agent" && args?.[0] === "--list-models") {
      return { status: 0, stdout: "cursor-grok-4.5-high - Cursor Grok 4.5\n" };
    }
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ env: { PATH: "/bin" } }), spawn, requireGsd: false, env: { PATH: "/bin" } });
  assert.equal(r.ok, false);
  assert.equal(r.cursorModels.ok, false);
});

await test("20 — Grok selector missing fails the gate", async () => {
  const spawn = (cmd, args) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/cursor-agent\n" };
    if (cmd === "cursor-agent" && args?.[0] === "status") {
      return { status: 0, stdout: JSON.stringify({ isAuthenticated: true, apiKeySource: "login" }) };
    }
    if (cmd === "cursor-agent" && args?.[0] === "--list-models") {
      return { status: 0, stdout: "composer-2.5 - Composer 2.5 (current)\n" };
    }
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ env: { PATH: "/bin" } }), spawn, requireGsd: false, env: { PATH: "/bin" } });
  assert.equal(r.ok, false);
  assert.match(r.cursorModels.reason, /hard/);
});

await test("21 — Cursor plus both models plus valid login passes", async () => {
  const r = await runDoctor({
    contract: resolveModelContract({ env: { PATH: "/bin" } }),
    spawn: cursorReadySpawn,
    requireGsd: false,
    env: { PATH: "/bin" },
    now: () => "2026-07-18T00:00:00Z",
  });
  assert.equal(r.ok, true);
  assert.equal(r.cursorEnabled, true);
  assert.equal(r.contract.auth.verified_at, "2026-07-18T00:00:00Z");
});

await test("22 — --no-cursor performs no Cursor probes", async () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...(args || [])]);
    if (cmd === "sh") return { status: 0, stdout: "/bin/claude\n" };
    if (cmd === "claude" && args?.[0] === "auth") {
      return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const r = await runDoctor({
    contract: resolveModelContract({ cursor: false, profile: "claude" }),
    spawn,
    requireGsd: false,
    env: { PATH: "/bin" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cursorEnabled, false);
  assert.equal(r.cursorModels.probed, false);
  const flat = calls.map((c) => c.join(" ")).join("\n");
  assert.ok(!flat.includes("cursor-agent"), `unexpected cursor probe:\n${flat}`);
});

await test("Cursor API key env fails closed", async () => {
  const r = await runDoctor({
    contract: resolveModelContract({ env: { PATH: "/bin" } }),
    spawn: cursorReadySpawn,
    requireGsd: false,
    env: { PATH: "/bin", CURSOR_API_KEY: "secret" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.auth.cursor.ok, false);
});

await test("runDoctor is READY on CLI+login for --no-cursor (GSD optional)", async () => {
  const spawn = (cmd, args) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/claude\n" };
    if (cmd === "claude" && args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
    return { status: 1, stdout: "", stderr: "" };
  };
  const contract = resolveModelContract({ profile: "claude", cursor: false });
  const r = await runDoctor({ contract, spawn, requireGsd: false, now: () => "2026-07-13T00:00:00Z" });
  assert.equal(r.ok, true);
  assert.equal(r.contract.auth.verified_at, "2026-07-13T00:00:00Z");
});

await test("runDoctor FAILS when subscription login is API-key based (--no-cursor)", async () => {
  const spawn = (cmd) => {
    if (cmd === "sh") return { status: 0, stdout: "/bin/claude\n" };
    if (cmd === "claude") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }) };
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ profile: "claude", cursor: false }), spawn, requireGsd: false });
  assert.equal(r.ok, false);
  assert.equal(r.auth.claude.ok, false);
});

await test("runDoctor FAILS when the build CLI is absent (--no-cursor)", async () => {
  const spawn = (cmd) => {
    if (cmd === "sh") return { status: 1, stdout: "" };
    if (cmd === "claude") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    return { status: 1 };
  };
  const r = await runDoctor({ contract: resolveModelContract({ profile: "claude", cursor: false }), spawn, requireGsd: false });
  assert.equal(r.ok, false);
});

process.stdout.write(`\ndoctor.mjs: ${passed} passed\n`);
