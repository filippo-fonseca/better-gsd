#!/usr/bin/env node
/** Subscription-only preflight for BGSD. Never prints credential values. */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveModelContract,
  parseClaudeAuth,
  parseCodexAuth,
  parseCursorAuth,
  isForbiddenCursorSelector,
  validateModelId,
  contractRuntimes,
  contractProviders,
  isCursorContract,
  DEFAULT_CURSOR_MODELS,
} from "./model-contract.mjs";
import { isGsdInstalled, resolveRuntimeConfigDir } from "./gsdinstall-live.mjs";
import { resolveProxyConfig, probeProxy as probeConfiguredProxy, assertProxyModel } from "./proxy.mjs";

export function probeCommand(command, spawn = spawnSync) {
  const result = spawn("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return { ok: result?.status === 0, path: result?.status === 0 ? String(result.stdout).trim() : null };
}

export function probeSubscription(provider, spawn = spawnSync, env = process.env) {
  if (provider === "claude") {
    const result = spawn("claude", ["auth", "status"], { encoding: "utf8" });
    if (result?.status !== 0) return { ok: false, provider, mode: "missing" };
    try { return parseClaudeAuth(result.stdout); } catch (_) { return { ok: false, provider, mode: "invalid" }; }
  }
  if (provider === "cursor") {
    // Never probe Cursor when CURSOR_API_KEY is set — reject immediately.
    if (env.CURSOR_API_KEY) {
      return parseCursorAuth({}, { env });
    }
    const result = spawn("cursor-agent", ["status", "--format", "json"], { encoding: "utf8" });
    if (result?.status !== 0) return { ok: false, provider: "cursor", mode: "missing" };
    return parseCursorAuth(result.stdout, { env });
  }
  const result = spawn("codex", ["login", "status"], { encoding: "utf8" });
  return result?.status === 0 ? parseCodexAuth(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) : { ok: false, provider, mode: "missing" };
}

/**
 * Parse `cursor-agent --list-models` / `models` text output into id → label map.
 */
export function parseCursorModelList(text) {
  const models = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)\s+-\s+(.+)$/);
    if (m) models.set(m[1], m[2].trim());
  }
  return models;
}

/**
 * Validate that a configured Cursor selector exists and is not a Fast/Auto variant.
 */
export function validateCursorSelector(selector, availableModels) {
  const id = String(selector ?? "").trim();
  const forbidden = isForbiddenCursorSelector(id);
  if (forbidden.forbidden) {
    return { ok: false, reason: forbidden.reason, selector: id };
  }
  const valid = validateModelId("cursor", id);
  if (!valid.ok) return { ok: false, reason: valid.reason, selector: id };
  if (availableModels && availableModels.size > 0 && !availableModels.has(id)) {
    return { ok: false, reason: "model_not_available", selector: id };
  }
  // Fail closed when a Fast twin exists and the configured id cannot be
  // distinguished from it (e.g. bare name that only resolves to Fast).
  if (availableModels && availableModels.size > 0) {
    const label = (availableModels.get(id) || "").toLowerCase();
    if (/\bfast\b/.test(label) && !/-fast$/i.test(id)) {
      return { ok: false, reason: "fast_variant_ambiguous", selector: id };
    }
  }
  return { ok: true, reason: null, selector: id };
}

export function probeCursorModels(spawn = spawnSync, required = {}) {
  const result = spawn("cursor-agent", ["--list-models"], { encoding: "utf8" });
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (result?.status !== 0 && !/available models/i.test(text)) {
    return { ok: false, models: new Map(), routine: null, hard: null, reason: "list_models_failed" };
  }
  const models = parseCursorModelList(text);
  const routineSel = required.routine || DEFAULT_CURSOR_MODELS.routine;
  const hardSel = required.hard || DEFAULT_CURSOR_MODELS.hard;
  const routine = validateCursorSelector(routineSel, models);
  const hard = validateCursorSelector(hardSel, models);
  return {
    ok: routine.ok && hard.ok,
    models,
    routine,
    hard,
    reason: !routine.ok ? `routine: ${routine.reason}` : (!hard.ok ? `hard: ${hard.reason}` : null),
  };
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

/**
 * Run BGSD Doctor.
 *
 * When Cursor is enabled: probes cursor-agent, login auth, and model selectors.
 * When `--no-cursor` / cursor.enabled=false: performs ZERO Cursor probes and
 * uses Claude Code / Codex profile behavior — an equal alternative backend.
 */
export async function runDoctor({
  contract,
  env = process.env,
  spawn = spawnSync,
  fetchImpl,
  requireGsd = true,
  now = () => new Date().toISOString(),
} = {}) {
  const c = contract ?? resolveModelContract({
    profile: env.BGSD_PIPELINE_PROFILE || "claude",
    proxy: env.BGSD_PROXY === "1",
    cursor: env.BGSD_NO_CURSOR === "1" ? false : undefined,
    env,
  });

  const cursorEnabled = isCursorContract(c);
  const providers = contractProviders(c);
  const runtimes = contractRuntimes(c);

  // CLI binary names: cursor harness → cursor-agent; others match harness id.
  const cliName = (runtime) => (runtime === "cursor" ? "cursor-agent" : runtime);
  const cli = Object.fromEntries(runtimes.map((runtime) => [runtime, probeCommand(cliName(runtime), spawn)]));
  const auth = Object.fromEntries(providers.map((provider) => [provider, probeSubscription(provider, spawn, env)]));

  let cursorModels = { ok: true, probed: false, routine: null, hard: null, reason: null };
  if (cursorEnabled) {
    cursorModels = {
      ...probeCursorModels(spawn, {
        routine: c.cursor?.routine?.model,
        hard: c.cursor?.hard?.model,
      }),
      probed: true,
    };
  }

  const gsd = Object.fromEntries(runtimes.map((runtime) => [runtime, {
    ok: isGsdInstalled({ runtime, env }),
    config_dir: resolveRuntimeConfigDir(runtime, { env }),
  }]));

  const proxyNeeded =
    !cursorEnabled &&
    (c.build?.transport === "proxy" || c.claude_codex?.build?.transport === "proxy" || c.legacy?.build?.transport === "proxy");
  const proxy = proxyNeeded
    ? await probeProxy({
      env,
      fetchImpl,
      models: [c.build?.model, c.evaluate?.model].filter(Boolean),
    })
    : { ok: true, enabled: false };

  const cliOk = Object.values(cli).every((x) => x.ok);
  const authOk = Object.values(auth).every((x) => x.ok);
  const modelsOk = cursorModels.ok;
  const gsdOk = requireGsd ? Object.values(gsd).every((x) => x.ok) : true;
  const ok = cliOk && authOk && modelsOk && gsdOk && proxy.ok;

  if (authOk && c.auth) c.auth = { ...c.auth, verified_at: now() };

  return {
    ok,
    contract: c,
    cli,
    auth,
    gsd,
    proxy,
    cursorModels,
    requireGsd,
    cursorEnabled,
  };
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
  const noCursor = flags["no-cursor"] === true;
  const wantCursor = flags.cursor === true;
  const contract = resolveModelContract({
    profile: flags.profile || "claude",
    buildModel: flags["build-model"],
    lightBuildModel: flags["light-build-model"],
    evaluateModel: flags["evaluate-model"],
    buildEffort: flags["build-effort"],
    evaluateEffort: flags["evaluate-effort"],
    routing: flags.routing || "fixed",
    proxy: flags.proxy === true,
    cursor: noCursor ? false : wantCursor ? true : undefined,
    cursorRoutineModel: flags["cursor-routine-model"],
    cursorHardModel: flags["cursor-hard-model"],
  });
  const result = await runDoctor({ contract });
  if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`\nBGSD doctor — ${result.ok ? "READY" : "SETUP REQUIRED"}\n`);
    process.stdout.write(`  conductor: ${contract.conductor.provider}/${contract.conductor.model}\n`);
    if (result.cursorEnabled) {
      process.stdout.write(`  cursor:    enabled (routine=${contract.cursor.routine.model}, hard=${contract.cursor.hard.model})\n`);
      process.stdout.write(`  evaluate:  deterministic-first; semantic verifier=${contract.evaluate.model}; adjudicator=live-conductor\n`);
      process.stdout.write(`  claude/codex: profile=${(contract.claude_codex || contract.legacy).profile} (equal alternative backend)\n`);
      process.stdout.write(`  workers:   Cursor Agent CLI (Composer routine / Grok hard)\n`);
    } else {
      process.stdout.write(`  cursor:    disabled (default Claude/Codex workers; pass --cursor to opt in)\n`);
      process.stdout.write(`  build:     ${contract.build.provider}/${contract.build.model} (${contract.build.transport})\n`);
      process.stdout.write(`  evaluate:  ${contract.evaluate.provider}/${contract.evaluate.model} (${contract.evaluate.transport})\n`);
    }
    for (const [runtime, row] of Object.entries(result.cli)) process.stdout.write(`  ${runtime} CLI: ${row.ok ? "ready" : "missing"}\n`);
    for (const [provider, row] of Object.entries(result.auth)) process.stdout.write(`  ${provider} subscription: ${row.ok ? "ready" : "login required"}\n`);
    if (result.cursorModels?.probed) {
      process.stdout.write(`  cursor models: ${result.cursorModels.ok ? "ready" : result.cursorModels.reason}\n`);
    }
    for (const [runtime, row] of Object.entries(result.gsd)) process.stdout.write(`  ${runtime} GSD: ${row.ok ? "ready" : "install required"}\n`);
    if (contract.build.transport === "proxy" || contract.claude_codex?.build?.transport === "proxy" || contract.legacy?.build?.transport === "proxy") {
      process.stdout.write(`  proxy: ${result.proxy.ok ? "ready" : result.proxy.reason}\n`);
    }
  }
  process.exitCode = result.ok ? 0 : 2;
}
