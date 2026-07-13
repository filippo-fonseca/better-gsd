#!/usr/bin/env node
/** Optional, fail-closed CLIProxyAPI transport for Claude Code hosted models. */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function resolveProxyConfig(env = process.env) {
  const rawUrl = String(env.BGSD_PROXY_URL || "").trim().replace(/\/$/, "");
  const token = String(env.BGSD_PROXY_TOKEN || "").trim();
  if (!rawUrl) throw new Error("Proxy mode requires BGSD_PROXY_URL (for example http://127.0.0.1:8317)");
  if (!token) throw new Error("Proxy mode requires BGSD_PROXY_TOKEN; it is the proxy access token, not a provider API key");
  let url;
  try { url = new URL(rawUrl); } catch (_) { throw new Error("BGSD_PROXY_URL must be an absolute http(s) URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("BGSD_PROXY_URL must use http or https");
  if (!LOCAL_HOSTS.has(url.hostname) && env.BGSD_PROXY_ALLOW_REMOTE !== "1") {
    throw new Error("Refusing non-local proxy. Set BGSD_PROXY_ALLOW_REMOTE=1 only after securing the endpoint.");
  }
  return { url: url.toString().replace(/\/$/, ""), token, local: LOCAL_HOSTS.has(url.hostname) };
}

export function proxyEnvForClaude(env = process.env, model) {
  const proxy = resolveProxyConfig(env);
  return {
    ...env,
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_AUTH_TOKEN: proxy.token,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export async function probeProxy({ config = resolveProxyConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Proxy probe requires fetch support");
  const response = await fetchImpl(`${config.url}/v1/models`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) throw new Error(`Proxy model probe failed (${response.status})`);
  const body = await response.json();
  const models = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter(Boolean) : [];
  if (!models.length) throw new Error("Proxy returned no models from /v1/models");
  return { ok: true, models };
}

export function assertProxyModel(models, model) {
  if (!models.includes(model)) throw new Error(`Proxy does not advertise requested model "${model}"`);
  return true;
}
