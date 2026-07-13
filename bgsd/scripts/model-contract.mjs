#!/usr/bin/env node
/** BGSD v2 session model contract: conductor, build lane, evaluation lane. */

export const PROVIDERS = Object.freeze(["claude", "openai"]);
export const TRANSPORTS = Object.freeze(["direct", "proxy"]);
export const ROUTING_MODES = Object.freeze(["fixed", "adaptive"]);

export const DEFAULT_MODELS = Object.freeze({
  claude: { model: "claude-opus-4-8", lightModel: "sonnet", effort: "high", harness: "claude" },
  openai: { model: "gpt-5.6-sol", lightModel: "gpt-5.5", effort: "medium", harness: "codex" },
});

export const PIPELINE_PROFILES = Object.freeze({
  claude: { build: "claude", evaluate: "claude" },
  openai: { build: "openai", evaluate: "openai" },
  "claude-openai": { build: "claude", evaluate: "openai" },
  "openai-claude": { build: "openai", evaluate: "claude" },
});

export function providerHarness(provider) {
  if (provider === "claude") return "claude";
  if (provider === "openai") return "codex";
  throw new Error(`Unsupported provider "${provider}"; expected claude or openai`);
}

/** A proxy exposes a Claude-compatible endpoint, so Claude Code is its host harness. */
export function harnessForLane(lane) {
  return lane.transport === "proxy" ? "claude" : lane.harness;
}

export function normalizeProvider(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "codex" || v === "openai") return "openai";
  if (v === "claude" || v === "anthropic") return "claude";
  return null;
}

export function validateModelId(provider, model) {
  const p = normalizeProvider(provider);
  const id = String(model ?? "").trim();
  if (!p) return { ok: false, reason: "unknown_provider" };
  if (!id || id.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) {
    return { ok: false, reason: "invalid_model_id" };
  }
  if (p === "openai" && /^(claude|anthropic)/i.test(id)) {
    return { ok: false, reason: "provider_model_mismatch" };
  }
  if (p === "claude" && /^(gpt|o[0-9]|openai)/i.test(id)) {
    return { ok: false, reason: "provider_model_mismatch" };
  }
  return { ok: true, reason: null };
}

export function detectConductor(env = process.env) {
  const explicit = normalizeProvider(env.BGSD_CONDUCTOR_PROVIDER || env.BGSD_HARNESS);
  const provider = explicit || (env.AGENT === "codex" || env.CODEX_HOME ? "openai" : "claude");
  const model = String(env.BGSD_CONDUCTOR_MODEL || env.CODEX_MODEL || env.CLAUDE_CODE_MODEL || "unknown");
  return { provider, harness: providerHarness(provider), model, source: "live-session" };
}

function lane(provider, model, transport) {
  const base = DEFAULT_MODELS[provider];
  const selectedModel = model || base.model;
  const valid = validateModelId(provider, selectedModel);
  if (!valid.ok) throw new Error(`Invalid ${provider} model "${selectedModel}" (${valid.reason})`);
  return { provider, harness: base.harness, model: selectedModel, effort: base.effort, transport };
}

function adaptiveCatalog(buildLane, lightModel) {
  const selectedLight = lightModel || DEFAULT_MODELS[buildLane.provider].lightModel;
  const valid = validateModelId(buildLane.provider, selectedLight);
  if (!valid.ok) {
    throw new Error(`Invalid ${buildLane.provider} light model "${selectedLight}" (${valid.reason})`);
  }
  return {
    heavy: { model: buildLane.model, effort: buildLane.effort },
    light: { model: selectedLight, effort: "high" },
  };
}

export function resolveModelContract({
  profile = "claude",
  buildModel,
  lightBuildModel,
  evaluateModel,
  routing = "fixed",
  conductor,
  proxy = false,
  env = process.env,
} = {}) {
  const selected = PIPELINE_PROFILES[profile];
  if (!selected) {
    throw new Error(`Unknown pipeline profile "${profile}"; expected ${Object.keys(PIPELINE_PROFILES).join(", ")}`);
  }
  if (!ROUTING_MODES.includes(routing)) {
    throw new Error(`Unknown routing mode "${routing}"; expected ${ROUTING_MODES.join(", ")}`);
  }
  const transport = proxy ? "proxy" : "direct";
  const build = lane(selected.build, buildModel, transport);
  return {
    version: 2,
    profile,
    conductor: conductor || detectConductor(env),
    routing,
    build,
    adaptive: adaptiveCatalog(build, lightBuildModel),
    evaluate: lane(selected.evaluate, evaluateModel, transport),
    auth: { policy: "subscription-only", verified_at: null },
  };
}

export function contractFromEnv(env = process.env) {
  return resolveModelContract({
    profile: env.BGSD_PIPELINE_PROFILE || "claude",
    buildModel: env.BGSD_BUILD_MODEL,
    lightBuildModel: env.BGSD_BUILD_LIGHT_MODEL,
    evaluateModel: env.BGSD_EVALUATE_MODEL,
    routing: env.BGSD_ROUTING || "fixed",
    proxy: env.BGSD_PROXY === "1",
    env,
  });
}

export function exportContractEnv(contract, env = process.env) {
  return {
    ...env,
    BGSD_PIPELINE_PROFILE: contract.profile,
    BGSD_BUILD_PROVIDER: contract.build.provider,
    BGSD_BUILD_MODEL: contract.build.model,
    BGSD_BUILD_LIGHT_MODEL: contract.adaptive.light.model,
    BGSD_EVALUATE_PROVIDER: contract.evaluate.provider,
    BGSD_EVALUATE_MODEL: contract.evaluate.model,
    BGSD_PROXY: contract.build.transport === "proxy" ? "1" : "0",
    BGSD_ROUTING: contract.routing,
  };
}

/** Subscription-only children must not inherit provider API billing credentials. */
export function scrubApiKeyEnv(env = process.env) {
  const clean = { ...env };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]) delete clean[key];
  return clean;
}

export function parseClaudeAuth(value) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  const ok = data?.loggedIn === true && data?.authMethod === "claude.ai";
  return { ok, provider: "claude", mode: ok ? "subscription" : "unsupported", detail: data?.subscriptionType ?? null };
}

export function parseCodexAuth(value) {
  const text = String(value ?? "").trim();
  const ok = /logged in using chatgpt/i.test(text);
  return { ok, provider: "openai", mode: ok ? "subscription" : "unsupported", detail: ok ? "ChatGPT" : null };
}

export function laneFor(contract, role) {
  return role === "evaluate" ? contract.evaluate : contract.build;
}

/**
 * Apply a Conductor-authored per-unit assignment to the build lane. Adaptive
 * mode never guesses: without an assignment it keeps the heavy model.
 */
export function buildLaneForUnit(contract, assignment = null) {
  const base = contract.build;
  if (contract.routing !== "adaptive") {
    return { ...base, assignment: { tier: "heavy", reason: "fixed session routing", source: "session" } };
  }

  const requestedTier = assignment?.tier === "light" ? "light" : "heavy";
  const requestedModel = assignment?.model || contract.adaptive[requestedTier].model;
  const valid = validateModelId(base.provider, requestedModel);
  if (!valid.ok) {
    throw new Error(`Invalid adaptive ${base.provider} model "${requestedModel}" (${valid.reason})`);
  }
  return {
    ...base,
    model: requestedModel,
    effort: assignment?.effort || contract.adaptive[requestedTier].effort,
    assignment: {
      tier: requestedTier,
      reason: String(assignment?.reason || "no Conductor assignment; heavy fail-safe"),
      source: assignment ? "conductor" : "fail-safe",
    },
  };
}
