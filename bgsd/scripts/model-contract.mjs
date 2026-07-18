#!/usr/bin/env node
/** BGSD session model contract: Conductor, Cursor workers, legacy Claude/Codex. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProxyConfig } from "./proxy.mjs";

export const CONTRACT_VERSION = 3;
export const PROVIDERS = Object.freeze(["claude", "openai", "cursor"]);
export const TRANSPORTS = Object.freeze(["direct", "proxy"]);
export const ROUTING_MODES = Object.freeze(["fixed", "adaptive", "cursor"]);
export const ASSIGNMENT_TIERS = Object.freeze(["routine", "hard", "legacy", "heavy", "light"]);

/** Validated local Cursor selectors (non-Fast). Overridable via BGSD.md / env. */
export const DEFAULT_CURSOR_MODELS = Object.freeze({
  routine: "composer-2.5",
  hard: "cursor-grok-4.5-high",
});

export const DEFAULT_MODELS = Object.freeze({
  claude: { model: "claude-opus-4-8", lightModel: "sonnet", effort: "high", harness: "claude" },
  openai: { model: "gpt-5.6-sol", lightModel: "gpt-5.5", effort: "medium", harness: "codex" },
  cursor: {
    model: DEFAULT_CURSOR_MODELS.routine,
    lightModel: DEFAULT_CURSOR_MODELS.routine,
    effort: null,
    harness: "cursor",
  },
});

export const PIPELINE_PROFILES = Object.freeze({
  claude: { build: "claude", evaluate: "claude" },
  openai: { build: "openai", evaluate: "openai" },
  "claude-openai": { build: "claude", evaluate: "openai" },
  "openai-claude": { build: "openai", evaluate: "claude" },
});

/** API billing credentials scrubbed from subscription-only child processes. */
export const SCRUBBED_API_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "CURSOR_API_KEY",
]);

export function providerHarness(provider) {
  if (provider === "claude") return "claude";
  if (provider === "openai") return "codex";
  if (provider === "cursor") return "cursor";
  throw new Error(`Unsupported provider "${provider}"; expected claude, openai, or cursor`);
}

/** A proxy exposes a Claude-compatible endpoint, so Claude Code is its host harness. */
export function harnessForLane(lane) {
  if (!lane || typeof lane !== "object") {
    throw new Error("harnessForLane requires a lane object");
  }
  if (lane.transport === "proxy") return "claude";
  if (lane.harness) return lane.harness;
  if (lane.provider) return providerHarness(lane.provider);
  throw new Error("harnessForLane: lane has no harness or provider");
}

export function normalizeProvider(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "codex" || v === "openai") return "openai";
  if (v === "claude" || v === "anthropic") return "claude";
  if (v === "cursor") return "cursor";
  return null;
}

/**
 * Fast variants and Auto are never silently selected. Fail closed when the
 * selector is ambiguous or explicitly Fast.
 */
export function isForbiddenCursorSelector(model) {
  const id = String(model ?? "").trim().toLowerCase();
  if (!id) return { forbidden: true, reason: "empty_model" };
  if (id === "auto") return { forbidden: true, reason: "auto_forbidden" };
  if (/-fast(?:$|[^a-z0-9])/i.test(id) || /(?:^|[^a-z0-9])fast(?:$|[^a-z0-9])/i.test(id)) {
    return { forbidden: true, reason: "fast_variant_forbidden" };
  }
  return { forbidden: false, reason: null };
}

export function validateModelId(provider, model) {
  const p = normalizeProvider(provider);
  const id = String(model ?? "").trim();
  if (!p) return { ok: false, reason: "unknown_provider" };
  if (!id || id.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) {
    return { ok: false, reason: "invalid_model_id" };
  }
  if (p === "openai" && /^(claude|anthropic|composer|cursor-grok)/i.test(id)) {
    return { ok: false, reason: "provider_model_mismatch" };
  }
  if (p === "claude" && /^(gpt|o[0-9]|openai|composer|cursor-grok)/i.test(id)) {
    return { ok: false, reason: "provider_model_mismatch" };
  }
  if (p === "cursor") {
    const fast = isForbiddenCursorSelector(id);
    if (fast.forbidden) return { ok: false, reason: fast.reason };
  }
  return { ok: true, reason: null };
}

export function detectConductor(env = process.env) {
  const explicit = normalizeProvider(env.BGSD_CONDUCTOR_PROVIDER || env.BGSD_HARNESS);
  let provider = explicit;
  if (!provider) {
    if (env.AGENT === "cursor" || env.CURSOR_AGENT) provider = "cursor";
    else if (env.AGENT === "codex" || env.CODEX_HOME) provider = "openai";
    else provider = "claude";
  }
  const model = String(
    env.BGSD_CONDUCTOR_MODEL ||
      env.CODEX_MODEL ||
      env.CLAUDE_CODE_MODEL ||
      env.CURSOR_MODEL ||
      "unknown"
  );
  return { provider, harness: providerHarness(provider), model, source: "live-session" };
}

function legacyLane(provider, model, transport) {
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

function cursorLane(role, model) {
  const selected = String(model || DEFAULT_CURSOR_MODELS[role] || "").trim();
  const valid = validateModelId("cursor", selected);
  if (!valid.ok) {
    throw new Error(`Invalid cursor ${role} model "${selected}" (${valid.reason})`);
  }
  return {
    provider: "cursor",
    harness: "cursor",
    model: selected,
    effort: null,
    transport: "direct",
  };
}

/**
 * Explicit CLI / env precedence for Cursor enablement:
 *   1. opts.cursor === false (--no-cursor) → disabled (flag wins)
 *   2. opts.cursor === true → enabled (explicit enable wins over ambient env)
 *   3. BGSD_NO_CURSOR=1 → disabled
 *   4. BGSD_CURSOR=0 → disabled
 *   5. BGSD_CURSOR=1 → enabled
 *   6. default → enabled
 */
export function resolveCursorEnabled({ cursor, env = process.env } = {}) {
  if (cursor === false) return false;
  if (cursor === true) return true;
  if (env.BGSD_NO_CURSOR === "1" || env.BGSD_NO_CURSOR === "true") return false;
  if (env.BGSD_CURSOR === "0" || env.BGSD_CURSOR === "false") return false;
  if (env.BGSD_CURSOR === "1" || env.BGSD_CURSOR === "true") return true;
  return true;
}

function resolveCursorModels({ cursorRoutineModel, cursorHardModel, env = process.env, config } = {}) {
  const fromConfig = config?.cursor?.models ?? {};
  return {
    routine:
      cursorRoutineModel ||
      env.BGSD_CURSOR_ROUTINE_MODEL ||
      fromConfig.routine ||
      DEFAULT_CURSOR_MODELS.routine,
    hard:
      cursorHardModel ||
      env.BGSD_CURSOR_HARD_MODEL ||
      fromConfig.hard ||
      DEFAULT_CURSOR_MODELS.hard,
  };
}

function wrapLegacyBlock({ profile, routing, build, adaptive, evaluate }) {
  return {
    profile,
    routing,
    build: { ...build },
    adaptive: {
      heavy: { ...adaptive.heavy },
      light: { ...adaptive.light },
    },
    evaluate: { ...evaluate },
  };
}

/**
 * Resolve the session model contract.
 *
 * Default (no flag): Cursor-backed execution (v3) — Composer routine, Grok hard.
 * `--no-cursor` / cursor:false: legacy Claude/Codex lanes only (still version 3
 * with cursor.enabled=false so resume persists the disabled state).
 */
export function resolveModelContract({
  profile = "claude",
  buildModel,
  lightBuildModel,
  evaluateModel,
  routing = "fixed",
  conductor,
  proxy = false,
  cursor,
  cursorRoutineModel,
  cursorHardModel,
  config,
  env = process.env,
} = {}) {
  const selected = PIPELINE_PROFILES[profile];
  if (!selected) {
    throw new Error(`Unknown pipeline profile "${profile}"; expected ${Object.keys(PIPELINE_PROFILES).join(", ")}`);
  }
  const legacyRouting = ROUTING_MODES.includes(routing) && routing !== "cursor" ? routing : "fixed";
  if (!ROUTING_MODES.includes(legacyRouting)) {
    throw new Error(`Unknown routing mode "${routing}"; expected ${ROUTING_MODES.join(", ")}`);
  }

  const transport = proxy ? "proxy" : "direct";
  const build = legacyLane(selected.build, buildModel, transport);
  const evaluate = legacyLane(selected.evaluate, evaluateModel, transport);
  const adaptive = adaptiveCatalog(build, lightBuildModel);
  const conductorIdentity = conductor || detectConductor(env);
  const auth = { policy: "subscription-only", verified_at: null };
  const legacy = wrapLegacyBlock({
    profile,
    routing: legacyRouting,
    build,
    adaptive,
    evaluate,
  });

  const cursorEnabled = resolveCursorEnabled({ cursor, env });
  if (!cursorEnabled) {
    return {
      version: CONTRACT_VERSION,
      profile,
      conductor: conductorIdentity,
      routing: legacyRouting,
      build,
      adaptive,
      evaluate,
      cursor: { enabled: false, routine: null, hard: null },
      legacy,
      verification: {
        policy: "evaluation-lane",
        deterministic_first: false,
        adjudicator: "evaluation-lane",
      },
      auth,
    };
  }

  const models = resolveCursorModels({ cursorRoutineModel, cursorHardModel, env, config });
  const routine = cursorLane("routine", models.routine);
  const hard = cursorLane("hard", models.hard);

  return {
    version: CONTRACT_VERSION,
    profile,
    conductor: conductorIdentity,
    // Cursor sessions use auditable routine/hard/legacy assignment vocabulary.
    routing: "cursor",
    build: { ...routine },
    adaptive: {
      routine: { model: routine.model, effort: null },
      hard: { model: hard.model, effort: null },
      // Preserve legacy catalog for exceptional explicit fallback.
      heavy: { ...adaptive.heavy },
      light: { ...adaptive.light },
    },
    // Semantic verifier uses Composer Standard; Conductor adjudicates.
    evaluate: { ...routine },
    cursor: { enabled: true, routine, hard },
    legacy,
    verification: {
      policy: "deterministic-first",
      deterministic_first: true,
      semantic_verifier: "composer-routine",
      adjudicator: "live-conductor",
    },
    auth,
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
    cursor: resolveCursorEnabled({ env }),
    cursorRoutineModel: env.BGSD_CURSOR_ROUTINE_MODEL,
    cursorHardModel: env.BGSD_CURSOR_HARD_MODEL,
    env,
  });
}

function assertProxyFailClosed(contract, env) {
  const transports = [
    contract.build?.transport,
    contract.evaluate?.transport,
    contract.legacy?.build?.transport,
    contract.legacy?.evaluate?.transport,
  ];
  if (transports.some((t) => t === "proxy")) {
    resolveProxyConfig(env);
  }
}

/**
 * Rehydrate a stored v2 contract into the current shape while preserving
 * Claude/Codex-only behavior (Cursor stays disabled).
 */
export function migrateV2Contract(stored, { env = process.env } = {}) {
  const contract = resolveModelContract({
    profile: stored.profile,
    buildModel: stored.build?.model,
    lightBuildModel: stored.adaptive?.light?.model,
    evaluateModel: stored.evaluate?.model,
    routing: stored.routing || "fixed",
    conductor: stored.conductor,
    proxy: stored.build?.transport === "proxy",
    cursor: false,
    env,
  });
  if (stored.build?.effort) contract.build.effort = stored.build.effort;
  if (stored.evaluate?.effort) contract.evaluate.effort = stored.evaluate.effort;
  if (stored.auth) contract.auth = stored.auth;
  // Keep version marker that this run originated as v2 for auditability.
  contract.migrated_from = 2;
  return contract;
}

/**
 * Rehydrate a stored v3 contract. Never reinterpret Cursor-disabled runs as
 * Cursor-enabled, and never flip Cursor back on during resume.
 */
export function rehydrateV3Contract(stored, { env = process.env } = {}) {
  const cursorEnabled = stored.cursor?.enabled === true;
  const contract = resolveModelContract({
    profile: stored.legacy?.profile || stored.profile || "claude",
    buildModel: stored.legacy?.build?.model || stored.build?.model,
    lightBuildModel: stored.legacy?.adaptive?.light?.model || stored.adaptive?.light?.model,
    evaluateModel: stored.legacy?.evaluate?.model || stored.evaluate?.model,
    routing: stored.legacy?.routing || (stored.routing === "cursor" ? "fixed" : stored.routing) || "fixed",
    conductor: stored.conductor,
    proxy:
      stored.legacy?.build?.transport === "proxy" ||
      (!cursorEnabled && stored.build?.transport === "proxy"),
    cursor: cursorEnabled,
    cursorRoutineModel: stored.cursor?.routine?.model,
    cursorHardModel: stored.cursor?.hard?.model,
    env: {
      ...env,
      // Persist disabled state across process boundaries.
      ...(cursorEnabled ? {} : { BGSD_NO_CURSOR: "1" }),
    },
  });
  if (stored.auth) contract.auth = stored.auth;
  if (stored.verification) contract.verification = stored.verification;
  if (Array.isArray(stored.escalation_history)) {
    contract.escalation_history = stored.escalation_history;
  }
  return contract;
}

/**
 * Rehydrate the session's model contract across the process boundary.
 *
 * session.mjs resolves the contract once, exports it into ITS OWN env, and
 * records it as `model_contract` in run.json — then exits. Downstream
 * entrypoints rehydrate from run.json so they never silently revert to defaults.
 *
 * Proxy stays FAIL-CLOSED across rehydration.
 */
export function loadContractForRun(runDir, { env = process.env } = {}) {
  let stored = null;
  if (runDir) {
    try {
      stored = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))?.model_contract ?? null;
    } catch (_) {
      stored = null;
    }
  }

  let contract;
  if (stored && stored.version === 2 && stored.profile) {
    contract = migrateV2Contract(stored, { env });
  } else if (stored && stored.version >= 3) {
    contract = rehydrateV3Contract(stored, { env });
  } else if (stored && stored.profile && !stored.version) {
    // Pre-version records treated as v2.
    contract = migrateV2Contract({ ...stored, version: 2 }, { env });
  } else {
    contract = contractFromEnv(env);
  }

  assertProxyFailClosed(contract, env);
  return contract;
}

export function exportContractEnv(contract, env = process.env) {
  const cursorEnabled = contract.cursor?.enabled === true;
  const legacy = contract.legacy || {
    profile: contract.profile,
    routing: contract.routing,
    build: contract.build,
    adaptive: contract.adaptive,
    evaluate: contract.evaluate,
  };
  return {
    ...env,
    BGSD_PIPELINE_PROFILE: legacy.profile || contract.profile,
    BGSD_BUILD_PROVIDER: cursorEnabled ? "cursor" : contract.build.provider,
    BGSD_BUILD_MODEL: contract.build.model,
    BGSD_BUILD_LIGHT_MODEL: contract.adaptive?.light?.model || contract.adaptive?.routine?.model || "",
    BGSD_EVALUATE_PROVIDER: cursorEnabled ? "cursor" : contract.evaluate.provider,
    BGSD_EVALUATE_MODEL: contract.evaluate.model,
    BGSD_PROXY: (!cursorEnabled && contract.build.transport === "proxy") ||
      legacy.build?.transport === "proxy"
      ? "1"
      : "0",
    BGSD_ROUTING: contract.routing,
    BGSD_CURSOR: cursorEnabled ? "1" : "0",
    BGSD_NO_CURSOR: cursorEnabled ? "0" : "1",
    ...(cursorEnabled && contract.cursor?.routine?.model
      ? { BGSD_CURSOR_ROUTINE_MODEL: contract.cursor.routine.model }
      : {}),
    ...(cursorEnabled && contract.cursor?.hard?.model
      ? { BGSD_CURSOR_HARD_MODEL: contract.cursor.hard.model }
      : {}),
  };
}

/** Subscription-only children must not inherit provider API billing credentials. */
export function scrubApiKeyEnv(env = process.env) {
  const clean = { ...env };
  for (const key of SCRUBBED_API_KEYS) delete clean[key];
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

/**
 * Parse Cursor CLI auth. Requires browser-login subscription auth.
 * Rejects API-key authentication sources.
 */
export function parseCursorAuth(value, { env = {} } = {}) {
  if (env.CURSOR_API_KEY) {
    return {
      ok: false,
      provider: "cursor",
      mode: "api-key-rejected",
      detail: "CURSOR_API_KEY is set; BGSD requires cursor-agent login",
      apiKeySource: "env",
    };
  }
  const data = typeof value === "string"
    ? (() => { try { return JSON.parse(value); } catch (_) { return null; } })()
    : value;
  if (!data || typeof data !== "object") {
    return { ok: false, provider: "cursor", mode: "invalid", detail: null, apiKeySource: null };
  }
  const apiKeySource = data.apiKeySource ?? null;
  if (apiKeySource && apiKeySource !== "login") {
    return {
      ok: false,
      provider: "cursor",
      mode: "api-key-rejected",
      detail: `apiKeySource=${apiKeySource}`,
      apiKeySource,
    };
  }
  const ok =
    data.isAuthenticated === true ||
    data.status === "authenticated" ||
    data.loggedIn === true;
  return {
    ok,
    provider: "cursor",
    mode: ok ? "subscription" : "missing",
    detail: data.userInfo?.email ?? data.email ?? null,
    apiKeySource: apiKeySource || (ok ? "login" : null),
  };
}

/** Parse Cursor stream-json init event for apiKeySource: "login". */
export function parseCursorStreamInitAuth(lineOrObj) {
  const obj = typeof lineOrObj === "string"
    ? (() => { try { return JSON.parse(lineOrObj); } catch (_) { return null; } })()
    : lineOrObj;
  if (!obj || typeof obj !== "object") {
    return { ok: false, reason: "invalid_event" };
  }
  const source = obj.apiKeySource ?? obj.message?.apiKeySource ?? null;
  if (source === "login") return { ok: true, apiKeySource: "login", model: obj.model ?? null };
  if (source) return { ok: false, reason: `apiKeySource=${source}`, apiKeySource: source };
  // Init without apiKeySource is inconclusive — caller may use status probe.
  return { ok: null, apiKeySource: source, model: obj.model ?? null };
}

export function laneFor(contract, role) {
  return role === "evaluate" ? contract.evaluate : contract.build;
}

export function isCursorContract(contract) {
  return contract?.cursor?.enabled === true && contract?.version >= 3;
}

function normalizeAssignmentTier(tier, { cursorEnabled }) {
  const t = String(tier ?? "").trim().toLowerCase();
  if (cursorEnabled) {
    if (t === "routine" || t === "light") return "routine";
    if (t === "hard" || t === "heavy") return "hard";
    if (t === "legacy") return "legacy";
    return null;
  }
  if (t === "light") return "light";
  if (t === "heavy") return "heavy";
  return null;
}

/**
 * Apply a Conductor-authored per-unit assignment.
 *
 * Cursor-enabled (v3 default):
 *   - Unassigned → routine (Composer), recorded as session default.
 *   - hard / legacy require a non-empty Conductor reason.
 *   - No worker may choose its own model; no automatic legacy fallback.
 *
 * Legacy / --no-cursor:
 *   - Preserves v2 fixed/adaptive heavy/light behavior.
 */
export function buildLaneForUnit(contract, assignment = null) {
  if (isCursorContract(contract)) {
    const reason = typeof assignment?.reason === "string" ? assignment.reason.trim() : "";
    const requested = normalizeAssignmentTier(assignment?.tier, { cursorEnabled: true });

    // Default / missing → routine (visible session default).
    if (!assignment || !requested || requested === "routine") {
      const useDefault = !assignment || !requested;
      if (requested === "routine" && reason.length === 0 && assignment?.source !== "session") {
        // Explicit routine without reason is allowed as the default tier, but
        // record that it was the session default when reason was omitted.
      }
      return {
        ...contract.cursor.routine,
        assignment: {
          tier: "routine",
          backend: "cursor",
          model: contract.cursor.routine.model,
          reason: reason || "session default: Cursor Composer routine",
          source: useDefault || !reason ? "session" : "conductor",
          attempt: assignment?.attempt ?? 1,
        },
      };
    }

    if (reason.length === 0) {
      throw new Error(
        `Cursor ${requested} assignment requires a non-empty Conductor reason`
      );
    }

    if (requested === "hard") {
      return {
        ...contract.cursor.hard,
        assignment: {
          tier: "hard",
          backend: "cursor",
          model: contract.cursor.hard.model,
          reason,
          source: "conductor",
          attempt: assignment?.attempt ?? 1,
        },
      };
    }

    if (requested === "legacy") {
      const legacyBuild = contract.legacy?.build;
      if (!legacyBuild) {
        throw new Error("Legacy assignment requested but no legacy profile is recorded");
      }
      return {
        ...legacyBuild,
        assignment: {
          tier: "legacy",
          backend: legacyBuild.harness || providerHarness(legacyBuild.provider),
          model: assignment.model || legacyBuild.model,
          reason,
          source: "conductor",
          attempt: assignment?.attempt ?? 1,
        },
      };
    }

    throw new Error(`Unknown Cursor assignment tier "${assignment?.tier}"`);
  }

  // --- Legacy Claude/Codex path (v2 / --no-cursor) ---
  const base = contract.build;
  if (contract.routing !== "adaptive") {
    return {
      ...base,
      assignment: {
        tier: "heavy",
        backend: base.harness || providerHarness(base.provider),
        model: base.model,
        reason: "fixed session routing",
        source: "session",
        attempt: 1,
      },
    };
  }

  const reason = typeof assignment?.reason === "string" ? assignment.reason.trim() : "";
  if (!assignment || reason.length === 0) {
    return {
      ...base,
      assignment: {
        tier: "heavy",
        backend: base.harness || providerHarness(base.provider),
        model: base.model,
        reason: assignment
          ? "adaptive assignment rejected (missing Conductor reason); heavy fail-safe"
          : "no Conductor assignment; heavy fail-safe",
        source: "fail-safe",
        attempt: 1,
      },
    };
  }

  const requestedTier = assignment.tier === "light" ? "light" : "heavy";
  const requestedModel = assignment.model || contract.adaptive[requestedTier].model;
  const valid = validateModelId(base.provider, requestedModel);
  if (!valid.ok) {
    throw new Error(`Invalid adaptive ${base.provider} model "${requestedModel}" (${valid.reason})`);
  }
  return {
    ...base,
    model: requestedModel,
    effort: assignment.effort || contract.adaptive[requestedTier].effort,
    assignment: {
      tier: requestedTier,
      backend: base.harness || providerHarness(base.provider),
      model: requestedModel,
      reason,
      source: "conductor",
      attempt: assignment?.attempt ?? 1,
    },
  };
}

/**
 * Record a Conductor escalation (e.g. routine → hard after inspecting evidence).
 * Does not mutate the worker; the next buildLaneForUnit call uses the new assignment.
 */
export function recordEscalation(contract, { from, to, reason, unitId, attempt } = {}) {
  const entry = {
    at: new Date().toISOString(),
    unit_id: unitId ?? null,
    from: from ?? null,
    to: to ?? null,
    reason: String(reason ?? "").trim(),
    attempt: attempt ?? null,
  };
  if (!entry.reason) throw new Error("Escalation requires a non-empty reason");
  if (!entry.to) throw new Error("Escalation requires a target tier");
  const history = Array.isArray(contract.escalation_history) ? [...contract.escalation_history] : [];
  history.push(entry);
  return { ...contract, escalation_history: history };
}

/** Doctor/runtime helpers: which harness CLIs this contract needs. */
export function contractRuntimes(contract) {
  if (isCursorContract(contract)) {
    return ["cursor"];
  }
  const lanes = [contract.build, contract.evaluate].filter(Boolean);
  return [...new Set(lanes.map((l) => harnessForLane(l)))];
}

/** Doctor helpers: which subscription providers this contract needs. */
export function contractProviders(contract) {
  if (isCursorContract(contract)) {
    return ["cursor"];
  }
  const lanes = [contract.build, contract.evaluate].filter(Boolean);
  return [...new Set(lanes.map((l) => l.provider))];
}
