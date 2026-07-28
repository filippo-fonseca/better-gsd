#!/usr/bin/env node
import assert from "node:assert/strict";
import { assertProxyModel, probeProxy, proxyEnvForClaude, resolveProxyConfig } from "./proxy.mjs";

let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; process.stdout.write(`  PASS  ${name}\n`); }); }

await test("proxy requires explicit local URL and token", () => {
  assert.throws(() => resolveProxyConfig({}), /BGSD_PROXY_URL/);
  assert.deepEqual(resolveProxyConfig({ BGSD_PROXY_URL: "http://127.0.0.1:8317", BGSD_PROXY_TOKEN: "proxy-token" }), {
    url: "http://127.0.0.1:8317", token: "proxy-token", local: true,
  });
});
await test("remote proxy requires explicit acknowledgement", () => {
  assert.throws(() => resolveProxyConfig({ BGSD_PROXY_URL: "https://proxy.example.com", BGSD_PROXY_TOKEN: "x" }), /BGSD_PROXY_ALLOW_REMOTE/);
});
await test("Claude proxy environment maps the selected model", () => {
  const env = proxyEnvForClaude({ BGSD_PROXY_URL: "http://localhost:8317", BGSD_PROXY_TOKEN: "x" }, "gpt-5.5");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://localhost:8317");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-5.5");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "x");
});
await test("model probe and model assertion fail closed", async () => {
  const result = await probeProxy({
    config: resolveProxyConfig({ BGSD_PROXY_URL: "http://localhost:8317", BGSD_PROXY_TOKEN: "x" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "gpt-5.5" }] }) }),
  });
  assert.deepEqual(result.models, ["gpt-5.5"]);
  assert.throws(() => assertProxyModel(result.models, "claude-opus-5"), /does not advertise/);
});

process.stdout.write(`\nproxy.mjs: ${passed} passed\n`);
