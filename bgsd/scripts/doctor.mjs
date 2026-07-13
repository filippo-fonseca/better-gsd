#!/usr/bin/env node
/** Subscription-only preflight for BGSD v2. Never prints credential values. */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveModelContract, parseClaudeAuth, parseCodexAuth, harnessForLane } from "./model-contract.mjs";
import { isGsdInstalled, resolveRuntimeConfigDir } from "./gsdinstall-live.mjs";
import { resolveProxyConfig, probeProxy as probeConfiguredProxy, assertProxyModel } from "./proxy.mjs";

export function probeCommand(command, spawn = spawnSync) {
  const result = spawn("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return { ok: result?.status === 0, path: result?.status === 0 ? String(result.stdout).trim() : null };
}

export function probeSubscription(provider, spawn = spawnSync) {
  if (provider === "claude") {
    const result = spawn("claude", ["auth", "status"], { encoding: "utf8" });
    if (result?.status !== 0) return { ok: false, provider, mode: "missing" };
    try { return parseClaudeAuth(result.stdout); } catch (_) { return { ok: false, provider, mode: "invalid" }; }
  }
  const result = spawn("codex", ["login", "status"], { encoding: "utf8" });
  return result?.status === 0 ? parseCodexAuth(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) : { ok: false, provider, mode: "missing" };
}

export async function probeProxy({ env = process.env, fetchImpl = globalThis.fetch, models = [] } = {}) {
  try {
    const result = await probeConfiguredProxy({ config: resolveProxyConfig(env), fetchImpl });
    for (const model of models) assertProxyModel(result.models, model);
    return { ok: true, url: resolveProxyConfig(env).url, models: result.models, reason: null };
  } catch (error) {
    return { ok: false, url: env.BGSD_PROXY_URL ?? null, reason: error.message };
  }
}

export async function runDoctor({ contract, env = process.env, spawn = spawnSync, fetchImpl } = {}) {
  const c = contract ?? resolveModelContract({ profile: env.BGSD_PIPELINE_PROFILE || "claude", proxy: env.BGSD_PROXY === "1", env });
  const providers = [...new Set([c.build.provider, c.evaluate.provider])];
  const runtimes = [...new Set([harnessForLane(c.build), harnessForLane(c.evaluate)])];
  const cli = Object.fromEntries(runtimes.map((runtime) => [runtime, probeCommand(runtime, spawn)]));
  const auth = Object.fromEntries(providers.map((provider) => [provider, probeSubscription(provider, spawn)]));
  const gsd = Object.fromEntries(runtimes.map((runtime) => [runtime, {
    ok: isGsdInstalled({ runtime, env }),
    config_dir: resolveRuntimeConfigDir(runtime, { env }),
  }]));
  const proxy = c.build.transport === "proxy"
    ? await probeProxy({ env, fetchImpl, models: [c.build.model, c.evaluate.model] })
    : { ok: true, enabled: false };
  const ok = Object.values(cli).every((x) => x.ok) && Object.values(auth).every((x) => x.ok) && Object.values(gsd).every((x) => x.ok) && proxy.ok;
  return { ok, contract: c, cli, auth, gsd, proxy };
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.replace(/^--/, "");
    if (!key || key === args[i]) continue;
    if (args[i + 1] && !args[i + 1].startsWith("--")) out[key] = args[++i]; else out[key] = true;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = parseFlags(process.argv.slice(2));
  const contract = resolveModelContract({
    profile: flags.profile || "claude",
    buildModel: flags["build-model"],
    lightBuildModel: flags["light-build-model"],
    evaluateModel: flags["evaluate-model"],
    routing: flags.routing || "fixed",
    proxy: flags.proxy === true,
  });
  const result = await runDoctor({ contract });
  if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`\nBGSD doctor — ${result.ok ? "READY" : "SETUP REQUIRED"}\n`);
    process.stdout.write(`  conductor: ${contract.conductor.provider}/${contract.conductor.model}\n`);
    process.stdout.write(`  build:     ${contract.build.provider}/${contract.build.model} (${contract.build.transport})\n`);
    process.stdout.write(`  evaluate:  ${contract.evaluate.provider}/${contract.evaluate.model} (${contract.evaluate.transport})\n`);
    for (const [runtime, row] of Object.entries(result.cli)) process.stdout.write(`  ${runtime} CLI: ${row.ok ? "ready" : "missing"}\n`);
    for (const [provider, row] of Object.entries(result.auth)) process.stdout.write(`  ${provider} subscription: ${row.ok ? "ready" : "login required"}\n`);
    for (const [runtime, row] of Object.entries(result.gsd)) process.stdout.write(`  ${runtime} GSD: ${row.ok ? "ready" : "install required"}\n`);
    if (contract.build.transport === "proxy") process.stdout.write(`  proxy: ${result.proxy.ok ? "ready" : result.proxy.reason}\n`);
  }
  process.exitCode = result.ok ? 0 : 2;
}
