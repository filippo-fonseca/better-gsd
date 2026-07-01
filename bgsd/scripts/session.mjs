#!/usr/bin/env node
/**
 * session.mjs — Unification Phases U1/U2/U3: the /bgsd-sesh front door.
 *
 * This is the SINGLE user-facing surface for bgsd. Kiwi, the Conductor, is
 * always on. The user chats; they never invoke /bgsd-verify, /bgsd-queue,
 * /bgsd-run, /bgsd-integrate, /bgsd-user-eval, /bgsd-feedback directly. Those
 * become INTERNAL stages this orchestrator sequences.
 *
 * It adds NO new engine logic. It is a thin, deterministic orchestrator that:
 *   1. classifyScale(prompt)        — picks quick | feature | project   (U1)
 *   2. buildDepthPlan(scale)        — the §4 routing table per scale     (U1)
 *   3. startSession({ ...injected }) — drives the depth plan over the    (U2/U3)
 *      real engine controllers under DEPENDENCY-INJECTED boundaries
 *
 * THE NON-BLOCKING LIVE SESSION (U3, hard requirement)
 * ====================================================
 * The session loop is fully async / non-blocking:
 *   - LIVE TRACKING: the loop renders the live view via status.renderStatus.
 *   - INTERJECT ANYTIME: a user-message inbox (.bgsd/runs/<id>/session-inbox/)
 *     is read between orchestration steps; an interjected message is INGESTED
 *     without halting agents.
 *   - NON-BLOCKING QUESTIONS: when the Conductor must ask the user, it marks
 *     ONLY the dependent unit `needs_input` (via control.mjs) and posts the
 *     question to the live view + escalation inbox. EVERY OTHER unit keeps
 *     progressing. Never a global blocking prompt.
 *
 * All live boundaries are dependency-injected (clock, spawn, inbox readers,
 * verify, fix, discuss, merge, review, pr, oracle) so the orchestrator is
 * deterministic and unit-testable WITHOUT real processes. By default (no flag)
 * the session EXECUTES; `--plan-only` / `--dry-run` previews without running.
 * Real spawns/merges/PRs stay behind the existing `*-live.mjs` `requireLiveFlag()`
 * guards at merge-boundary checkpoints — never `next`, never a default branch.
 *
 * Usage (CLI):
 *   node bgsd/scripts/session.mjs --prompt "Change the CTA to 'Get started'"         # executes (default)
 *   node bgsd/scripts/session.mjs --prompt "Fix the 404 on /pricing" --quick          # executes, quick scale
 *   node bgsd/scripts/session.mjs --prompt "Build a billing dashboard" --project       # executes, discuss first
 *   node bgsd/scripts/session.mjs --prompt "..." --plan-only                           # preview only (no run)
 *   node bgsd/scripts/session.mjs --prompt "..." --dry-run                             # alias for --plan-only
 *
 * DEFAULT BEHAVIOR: a session EXECUTES by default. Pass --plan-only (or --dry-run) to preview
 * without running. Real irreversible actions (git merge, gh pr create) remain human-gated at
 * merge-boundary checkpoints via the existing *-live.mjs requireLiveFlag guards — the flip is
 * default="run" vs default="plan only", NOT a removal of the irreversible-action gates.
 *
 * @module session
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyHeuristic } from "./classify-item.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "../../");

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** The three scales the Conductor can resolve a request to. */
export const SCALES = Object.freeze(["quick", "feature", "project"]);

/** The four session modes (flag → mode mapping). */
export const SESSION_MODES = Object.freeze(["auto", "quick", "feature", "project"]);

// ---------------------------------------------------------------------------
// U1 — cheap, zero-model decompose-shape signals (§3.1)
// ---------------------------------------------------------------------------

/**
 * Distinct surface/area keywords used to estimate breadth (§3.1 "surface breadth").
 * Mirrors the FEATURE_SIGNALS vocabulary in classify-item.mjs but tuned to NAMED
 * surfaces (areas of the system), not action verbs.
 */
const SURFACE_KEYWORDS = [
  // Each entry is a genuinely DISTINCT system area. Synonyms that name the SAME
  // surface (e.g. "ui"/"page"/"screen"/"component") are grouped so they count
  // ONCE — depthBreadth measures how many independent areas of the system the
  // request touches, not how many words for one area appear.
  ["ui", "page", "screen", "view", "component", "frontend", "front-end"],
  ["api", "endpoint", "route", "server", "backend", "back-end"],
  ["db", "database", "schema", "migration"],
  ["auth", "login", "permission"],
  ["billing", "payment", "stripe", "checkout", "subscription"],
  ["deploy", "ci", "pipeline", "infra"],
  ["dashboard", "admin"],
  ["settings"],
  ["search"],
  ["notification", "email"],
];

/**
 * Feature-signal verbs (a subset/echo of classify-item.mjs FEATURE_SIGNALS) used
 * to count distinct scope verbs in the prompt (§3.1 "scope verbs").
 */
const SCOPE_VERBS = [
  "add", "build", "create", "implement", "migrate", "integrate",
  "refactor", "introduce", "extend", "expose", "support", "enable",
  "dashboard", "api", "endpoint", "deploy", "optimize", "cache",
];

/**
 * Count distinct top-level work clauses in a prompt. Splits on " and ",
 * commas, semicolons, newlines, and bullet markers (`- `, `* `, `1.`), then
 * keeps non-empty fragments. Floored at 1.
 *
 * @param {string} prompt
 * @returns {number}
 */
export function clauseCount(prompt) {
  const text = (prompt ?? "").trim();
  if (!text) return 1;
  // Normalize bullet + ordered-list markers to newlines (real clause breaks).
  const normalized = text
    .replace(/^[ \t]*[-*][ \t]+/gm, "\n")   // "- " / "* " bullets
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "\n"); // "1. " / "1) " ordered
  const fragments = normalized
    .split(/\n|;|,|\sand\s/i)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return Math.max(1, fragments.length);
}

/**
 * Count distinct named surfaces/areas referenced in the prompt (§3.1).
 *
 * @param {string} prompt
 * @returns {number}
 */
export function distinctSurfaces(prompt) {
  const text = (prompt ?? "").toLowerCase();
  let count = 0;
  for (const group of SURFACE_KEYWORDS) {
    // A surface group counts ONCE if ANY of its synonyms appear.
    const hit = group.some((kw) => {
      const re = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
      return re.test(text);
    });
    if (hit) count++;
  }
  return count;
}

/**
 * Count distinct scope verbs present (§3.1 "scope verbs").
 *
 * @param {string} prompt
 * @returns {number}
 */
export function distinctScopeVerbs(prompt) {
  const text = (prompt ?? "").toLowerCase();
  const found = new Set();
  for (const v of SCOPE_VERBS) {
    const re = new RegExp(`\\b${v}\\b`, "i");
    if (re.test(text)) found.add(v);
  }
  return found.size;
}

/**
 * Bucket the prompt length into one of three bands (§3.1 "prompt length band").
 *
 * @param {string} prompt
 * @returns {"<160"|"<600"|"≥600"}
 */
export function lengthBand(prompt) {
  const n = (prompt ?? "").length;
  if (n < 160) return "<160";
  if (n < 600) return "<600";
  return "≥600";
}

// ---------------------------------------------------------------------------
// U1 — MODEL SEAM (Haiku scale-refiner), clearly marked stub (§3.2)
// ---------------------------------------------------------------------------

/**
 * SEAM (Part 11 Haiku row): nudge a BORDERLINE heuristic result by AT MOST ONE
 * step (quick↔feature or feature↔project). Mirrors classify-item.mjs's
 * `classifyWithModel` stub and brainstorm.mjs's invariant-guarded refineFn.
 *
 * INVARIANTS this seam must never break:
 *   - never moves more than one step on the SCALES ladder,
 *   - never overrides an explicit flag (forced modes never reach here),
 *   - never turns a needs-clarification (scale=null) into a silent guess,
 *   - the deterministic heuristic is ALWAYS computed first and is the fallback.
 *
 * Until activated this throws; classifyScale catches and keeps the heuristic.
 *
 * @param {string} _prompt
 * @param {{ scale: string }} _heuristicResult
 * @returns {Promise<{ scale: string }>}
 */
// eslint-disable-next-line no-unused-vars
export async function refineScaleWithModel(_prompt, _heuristicResult) {
  // --- HAIKU SEAM: replace with a real one-step nudge call. ---
  throw new Error("refineScaleWithModel: Haiku scale-refiner seam not yet activated (Part 11 TODO)");
}

/**
 * Clamp a model-proposed scale to at most one step from the heuristic scale.
 * Guards the seam invariant even if a future activation misbehaves.
 *
 * @param {string} heuristicScale
 * @param {string} proposedScale
 * @returns {string}
 */
function clampOneStep(heuristicScale, proposedScale) {
  const hi = SCALES.indexOf(heuristicScale);
  const pi = SCALES.indexOf(proposedScale);
  if (hi === -1 || pi === -1) return heuristicScale;
  if (Math.abs(pi - hi) <= 1) return proposedScale;
  // More than one step away → clamp to one step in the proposed direction.
  return SCALES[hi + Math.sign(pi - hi)];
}

// ---------------------------------------------------------------------------
// U1 — classifyScale (§3.2 deterministic rules)
// ---------------------------------------------------------------------------

/**
 * Deterministic scale classifier. Maps a prompt + mode to quick | feature |
 * project (or a clarify action). Zero required model calls.
 *
 * @param {object} input
 * @param {string} input.prompt          The user's request.
 * @param {string} [input.mode="auto"]   auto | quick | feature | project (flag override).
 * @param {object} [opts]
 * @param {boolean} [opts.refine=false]  Activate the marked Haiku one-step seam.
 * @param {Function} [opts.refineFn]     Inject a refiner (tests); defaults to refineScaleWithModel.
 * @returns {Promise<{
 *   scale: string|null,
 *   action: "route"|"clarify",
 *   mode: string,
 *   signals: { routeClass: string, unitCountEstimate: number, depthBreadth: number,
 *              scopeVerbs: number, lengthBand: string },
 *   unitCountEstimate: number,
 *   depthBreadth: number,
 *   confidence: "forced"|"heuristic"|"model",
 *   clarification_question?: string,
 *   modelSeam?: object,
 * }>}
 */
export async function classifyScale({ prompt, mode = "auto" }, opts = {}) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("classifyScale: prompt must be a non-empty string");
  }
  if (!SESSION_MODES.includes(mode)) {
    throw new Error(`classifyScale: unknown mode "${mode}". Valid: ${SESSION_MODES.join(", ")}`);
  }

  // Forced modes short-circuit the heuristic (flag overrides — §3.1.3 / §5).
  if (mode === "quick") {
    return forcedResult("quick", mode, prompt);
  }
  if (mode === "feature") {
    return forcedResult("feature", mode, prompt);
  }
  if (mode === "project") {
    return forcedResult("project", mode, prompt);
  }

  // --- auto mode: compute the cheap signals (§3.1) ---
  const lines = prompt.trim().split(/\n/);
  const firstLine = lines[0] ?? "";
  const rest = lines.slice(1).join("\n");
  const routeClass = classifyHeuristic(firstLine, rest).route_class;

  const unitCountEstimate = clauseCount(prompt);
  const depthBreadth = distinctSurfaces(prompt);
  const scopeVerbs = distinctScopeVerbs(prompt);
  const band = lengthBand(prompt);

  const signals = { routeClass, unitCountEstimate, depthBreadth, scopeVerbs, lengthBand: band };

  // Rule 1: needs-clarification → ASK, never guess (NFR-06).
  if (routeClass === "needs-clarification") {
    return {
      scale: null,
      action: "clarify",
      mode,
      signals,
      unitCountEstimate,
      depthBreadth,
      confidence: "heuristic",
      clarification_question:
        "I can't tell the size of this yet. Is it a quick fix, a feature, or a whole project? " +
        "Tell me what changes, where, and what 'done' looks like.",
    };
  }

  // Rules 2–7 (evaluated in order — §3.2).
  let scale;
  if (routeClass === "trivial-fix" && unitCountEstimate === 1 && depthBreadth <= 1) {
    scale = "quick"; // rule 2
  } else if (routeClass === "scoped-fix" && unitCountEstimate <= 2 && depthBreadth <= 1) {
    scale = "quick"; // rule 3
  } else if (
    unitCountEstimate >= 4 ||
    depthBreadth >= 3 ||
    (routeClass === "feature" && band === "≥600")
  ) {
    scale = "project"; // rule 4
  } else if (
    routeClass === "feature" &&
    unitCountEstimate >= 1 && unitCountEstimate <= 3 &&
    depthBreadth >= 1 && depthBreadth <= 2
  ) {
    scale = "feature"; // rule 5
  } else if (unitCountEstimate >= 2 && unitCountEstimate <= 3 && depthBreadth === 2) {
    scale = "feature"; // rule 6
  } else {
    scale = "feature"; // rule 7 — the safe default
  }

  const result = {
    scale,
    action: "route",
    mode,
    signals,
    unitCountEstimate,
    depthBreadth,
    confidence: "heuristic",
  };

  // --- MODEL SEAM (optional, marked): one-step nudge of a BORDERLINE case. ---
  if (opts.refine) {
    const refineFn = typeof opts.refineFn === "function" ? opts.refineFn : refineScaleWithModel;
    try {
      const refined = await refineFn(prompt, { scale });
      if (refined && typeof refined.scale === "string" && SCALES.includes(refined.scale)) {
        const clamped = clampOneStep(scale, refined.scale);
        if (clamped !== scale) {
          result.scale = clamped;
          result.confidence = "model";
          result.modelSeam = { heuristicScale: scale, modelScale: clamped };
        }
      }
    } catch (_err) {
      // Seam inactive or failed → heuristic stands (the floor).
    }
  }

  return result;
}

/**
 * Build a forced-scale classifier result (flag override).
 * @param {string} scale
 * @param {string} mode
 * @param {string} prompt
 */
function forcedResult(scale, mode, prompt) {
  return {
    scale,
    action: "route",
    mode,
    signals: {
      routeClass: "(forced)",
      unitCountEstimate: clauseCount(prompt),
      depthBreadth: distinctSurfaces(prompt),
      scopeVerbs: distinctScopeVerbs(prompt),
      lengthBand: lengthBand(prompt),
    },
    unitCountEstimate: clauseCount(prompt),
    depthBreadth: distinctSurfaces(prompt),
    confidence: "forced",
  };
}

// ---------------------------------------------------------------------------
// U1 — buildDepthPlan (§4 routing table)
// ---------------------------------------------------------------------------

/**
 * Map a resolved scale to the ordered engine plan (§4 depth-routing table).
 *
 * INVARIANT: `verified` is ALWAYS true. Quick STILL VERIFIES — Loop 1 runs and
 * quick can only reach `done` on a Tester PASS. Verification is never skipped
 * at any scale. `discuss` is true ONLY for project.
 *
 * @param {string} scale  one of SCALES.
 * @param {object} [ctx]
 * @param {string} [ctx.prompt]
 * @returns {{
 *   scale: string,
 *   discuss: boolean,
 *   verified: true,
 *   stages: Array<{ id: string, engine: string, entry: string, depth: string }>,
 * }}
 */
export function buildDepthPlan(scale, { prompt } = {}) {
  if (!SCALES.includes(scale)) {
    throw new Error(`buildDepthPlan: unknown scale "${scale}". Valid: ${SCALES.join(", ")}`);
  }

  const stages = [];

  if (scale === "quick") {
    stages.push(
      { id: "classify", engine: "classify-item.mjs", entry: "classifyItem", depth: "single" },
      { id: "route", engine: "route-item.mjs", entry: "routeItem", depth: "single" },
      { id: "execute", engine: "run-live.mjs", entry: "liveSpawnFn", depth: "single-agent" },
      // VERIFY→FIX (Loop 1) — NEVER skipped, even for quick (§4.1).
      { id: "verify_fix", engine: "loop1.mjs", entry: "runLoop1", depth: "single-worktree" },
    );
    return { scale, discuss: false, verified: true, stages };
  }

  if (scale === "feature") {
    stages.push(
      { id: "decompose", engine: "decompose.mjs", entry: "buildUnits", depth: "small-1to3" },
      { id: "graph", engine: "graph.mjs", entry: "buildGraph/topoWaves", depth: "small" },
      { id: "fanout", engine: "worktree.mjs", entry: "planWorktrees", depth: "low-concurrency" },
      { id: "schedule", engine: "scheduler.mjs", entry: "runScheduler", depth: "low-concurrency" },
      { id: "lifecycle", engine: "run.mjs", entry: "runLifecycle", depth: "few-unit" },
      // VERIFY→FIX (Loop 1) per worktree — NEVER skipped.
      { id: "verify_fix", engine: "loop1.mjs", entry: "runLoop1", depth: "per-worktree" },
      { id: "merge", engine: "conflict.mjs", entry: "preCheckMerge/executeMerges", depth: "light" },
      { id: "rehearsal", engine: "rehearsal.mjs", entry: "executeRehearsalAssembly", depth: "assemble" },
      // Loop 2 only if more than one unit merged.
      { id: "integrate", engine: "loop2.mjs", entry: "runLoop2", depth: "if->1-unit" },
      { id: "review", engine: "review.mjs", entry: "openReviewGate", depth: "interactive" },
      { id: "changelog", engine: "changelog-pr.mjs", entry: "aggregatePerAgentChangelog/assemblePrBody", depth: "light" },
    );
    return { scale, discuss: false, verified: true, stages };
  }

  // project — full, discuss-first
  stages.push(
    // Discuss WITH THE USER FIRST (intake → brainstorm → profile → oracle).
    { id: "intake", engine: "intake.mjs", entry: "generateIntentSpec", depth: "full" },
    { id: "brainstorm", engine: "brainstorm.mjs", entry: "runBrainstorm/sealDecisionRecord", depth: "full" },
    { id: "profile", engine: "profile.mjs", entry: "buildPreferenceProfile", depth: "full" },
    { id: "oracle", engine: "oracle.mjs", entry: "buildOracle", depth: "full" },
    { id: "decompose", engine: "decompose.mjs", entry: "parseDecompositionResponse/buildUnits", depth: "full" },
    { id: "graph", engine: "graph.mjs", entry: "buildGraph/topoWaves/verifyGraph", depth: "full" },
    { id: "fanout", engine: "worktree.mjs", entry: "planWorktrees", depth: "full-waves" },
    { id: "schedule", engine: "scheduler.mjs", entry: "runScheduler", depth: "full-waves" },
    { id: "lifecycle", engine: "run.mjs", entry: "runLifecycle", depth: "full" },
    // VERIFY→FIX (Loop 1) per worktree — NEVER skipped.
    { id: "verify_fix", engine: "loop1.mjs", entry: "runLoop1", depth: "per-worktree" },
    { id: "merge", engine: "conflict.mjs", entry: "computeMergeOrder/executeMerges", depth: "dep-ordered" },
    { id: "rehearsal", engine: "rehearsal.mjs", entry: "executeRehearsalAssembly/aggregateDocs", depth: "full" },
    { id: "integrate", engine: "loop2.mjs", entry: "runLoop2", depth: "full" },
    { id: "review", engine: "review.mjs", entry: "openReviewGate", depth: "mandatory" },
    { id: "changelog", engine: "changelog-pr.mjs", entry: "aggregatePerAgentChangelog/liveCreatePr", depth: "full" },
  );
  return { scale, discuss: true, verified: true, stages };
}

// ---------------------------------------------------------------------------
// session.json — atomic pointer store (NFR-09: pointers, not blobs)
// ---------------------------------------------------------------------------

/**
 * Mint a session id: sesh-<8 hex>-<ts>. Deterministic when idFn is injected.
 * @param {object} [opts]
 * @param {Function} [opts.idFn] () => string  (tests inject a fixed id)
 * @returns {string}
 */
export function mintSessionId({ idFn } = {}) {
  if (typeof idFn === "function") return idFn();
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `sesh-${hex}-${Date.now()}`;
}

function sessionDir(bgsdDir, sessionId) {
  return join(bgsdDir, "sessions", sessionId);
}

function writeSessionAtomic(path, data) {
  const tmp = path + ".tmp";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// U3 — user-message inbox (non-blocking interjection)
// ---------------------------------------------------------------------------

/**
 * Default inbox reader: read + drain (delete) any *.json messages under
 * .bgsd/runs/<id>/session-inbox/. Returns the parsed messages. Non-blocking:
 * if the dir is missing it returns []. Tests inject a mock instead.
 *
 * @param {string} inboxDir
 * @returns {Array<object>}
 */
export function defaultInboxReader(inboxDir) {
  if (!existsSync(inboxDir)) return [];
  const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json")).sort();
  const messages = [];
  for (const f of files) {
    const p = join(inboxDir, f);
    try {
      messages.push(JSON.parse(readFileSync(p, "utf8")));
    } catch (_) {
      // ignore a malformed inbox message; never block the loop on it
    }
    try { unlinkSync(p); } catch (_) { /* best-effort drain */ }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// U2/U3 — startSession orchestrator
// ---------------------------------------------------------------------------

/**
 * The orchestrator entrypoint behind /bgsd-sesh.
 *
 * Classifies (or honors a flag), builds the depth plan, and drives the matching
 * engine sequence under INJECTED boundaries. planOnly returns the plan without
 * invoking any live boundary.
 *
 * Non-blocking session loop (U3): between every orchestration step it (a) renders
 * the live view via renderStatusFn, (b) ingests any inbox messages WITHOUT
 * halting, and (c) when a question must be asked, marks ONLY the dependent unit
 * `needs_input` while every other unit keeps progressing.
 *
 * @param {object} opts
 * @param {string}  opts.prompt
 * @param {string}  [opts.mode="auto"]      auto | quick | feature | project
 * @param {boolean} [opts.planOnly=false]   return the plan, invoke ZERO boundaries
 * @param {string}  [opts.bgsdDir]          .bgsd dir (tests point this at a tmp dir)
 *
 * Injected boundaries (all default to deterministic mocks where safe; the real
 * ones live behind the *-live.mjs requireLiveFlag guards and are wired in U3):
 * @param {Function} [opts.verifyFn]        async () => { verdict, defects }
 * @param {Function} [opts.fixFn]           async (defects, {effort,model}) => void
 * @param {Function} [opts.discussFn]       async () => oracle manifest (project)
 * @param {Function} [opts.oracleFn]        (question) => { action, ... }  (answerQuestion)
 * @param {Function} [opts.decomposeFn]     async (prompt) => units[]
 * @param {Function} [opts.spawnFn]         scheduler spawn boundary
 * @param {Function} [opts.readStatusFn]    scheduler status boundary
 * @param {Function} [opts.mergeFn]         merge boundary
 * @param {Function} [opts.reviewFn]        async () => verdict
 * @param {Function} [opts.prFn]            async () => prResult
 * @param {Function} [opts.renderStatusFn]  ({run,agents,telemetry}) => string  (status.renderStatus)
 * @param {Function} [opts.inboxReaderFn]   (inboxDir) => messages[]   (defaultInboxReader)
 * @param {Function} [opts.escalateFn]      async (batch) => answers   (runEscalation)
 * @param {Function} [opts.clockFn]         () => Date  (deterministic time)
 * @param {Function} [opts.idFn]            () => string (deterministic session id)
 * @returns {Promise<object>}  session result with resolved scale, plan, outcome,
 *   per-unit states, the rendered live frames, and ingested inbox messages.
 */
export async function startSession(opts = {}) {
  const {
    prompt,
    mode = "auto",
    planOnly = false,
    preflightFn,
    bgsdDir = join(REPO_ROOT, ".bgsd"),
    verifyFn,
    fixFn,
    discussFn,
    oracleFn,
    decomposeFn,
    reviewFn,
    prFn,
    renderStatusFn,
    inboxReaderFn = defaultInboxReader,
    clockFn = () => new Date(),
    idFn,
  } = opts;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("startSession: prompt must be a non-empty string");
  }

  // --- classify (U1) ---
  const classification = await classifyScale({ prompt, mode }, opts);

  // needs-clarification: ask ONE question, never guess (NFR-06).
  if (classification.action === "clarify") {
    return {
      sessionId: null,
      scale: null,
      action: "clarify",
      clarification_question: classification.clarification_question,
      classification,
    };
  }

  const scale = classification.scale;
  const plan = buildDepthPlan(scale, { prompt });

  const sessionId = mintSessionId({ idFn });
  const seshDir = sessionDir(bgsdDir, sessionId);
  const inboxDir = join(seshDir, "session-inbox");

  // Pointer record (NFR-09: pointers, not blobs).
  const sessionRecord = {
    session_id: sessionId,
    prompt,
    mode,
    scale,
    plan_stages: plan.stages.map((s) => s.id),
    discuss: plan.discuss,
    verified: plan.verified,
    created_at: clockFn().toISOString(),
    pointers: {
      session_dir: seshDir,
      inbox_dir: inboxDir,
      run_json: null,      // set when feature/project mints a run
      queue_item: null,    // set when quick enqueues an item
    },
    outcome: null,
  };

  // --- plan-only: return the plan, invoke ZERO boundaries (the safe default). ---
  if (planOnly) {
    return {
      sessionId,
      scale,
      action: "plan",
      planOnly: true,
      plan,
      classification,
      session: sessionRecord,
      // No boundary invoked, nothing written for plan-only beyond the in-memory record.
    };
  }

  // --- sesh preflight: ensure init + ff-sync the integration branch from base.
  // Default is no boundary (pure/testable); the CLI injects the real init-live
  // preflight so a real run keeps `next` current with `main` before fanning out.
  if (typeof preflightFn === "function") {
    const pf = await preflightFn();
    if (pf) {
      sessionRecord.preflight = {
        integration_branch: pf.integrationBranch,
        base_branch: pf.baseBranch,
        performed: pf.performed,
        notes: pf.notes,
      };
    }
  }

  // From here we actually orchestrate (under injected/mocked boundaries).
  writeSessionAtomic(join(seshDir, "session.json"), sessionRecord);

  // The live-frame log + ingested-message log the session loop maintains.
  const liveFrames = [];
  const ingestedMessages = [];

  /**
   * One non-blocking session tick: render the live view, drain the inbox.
   * Called between orchestration steps. NEVER blocks on a question.
   */
  function tick(view) {
    // (1) Live tracking — render the always-on view.
    if (typeof renderStatusFn === "function") {
      liveFrames.push(renderStatusFn(view));
    } else {
      liveFrames.push({ run: view.run, agents: view.agents });
    }
    // (2) Interject anytime — ingest inbox messages WITHOUT halting.
    const msgs = inboxReaderFn(inboxDir) ?? [];
    for (const m of msgs) ingestedMessages.push(m);
    return msgs;
  }

  let result;
  if (scale === "quick") {
    result = await runQuick({ prompt, classification, plan, verifyFn, fixFn, tick });
  } else {
    result = await runDecomposed({
      prompt, scale, classification, plan, bgsdDir, sessionRecord,
      verifyFn, fixFn, discussFn, oracleFn, decomposeFn, reviewFn, prFn,
      escalateFn: opts.escalateFn, tick,
    });
  }

  sessionRecord.outcome = result.outcome;
  if (result.runId) sessionRecord.pointers.run_json = result.runJsonPath ?? null;
  writeSessionAtomic(join(seshDir, "session.json"), sessionRecord);

  return {
    sessionId,
    scale,
    action: "run",
    plan,
    classification,
    session: sessionRecord,
    liveFrames,
    ingestedMessages,
    ...result,
  };
}

// ---------------------------------------------------------------------------
// quick path — classify → route → Loop 1 (still verifies; §4.1)
// ---------------------------------------------------------------------------

/**
 * Drive the quick path: a single item through the real Loop 1 controller.
 * Reuses queue.transition + classifyItem + routeItem + runLoop1 exactly.
 * Terminates `done` ONLY on a Tester PASS (NFR-06).
 */
async function runQuick({ prompt, classification, plan, verifyFn, fixFn, tick }) {
  const { transition } = await import("./queue.mjs");
  const { classifyItem } = await import("./classify-item.mjs");
  const { routeItem } = await import("./route-item.mjs");
  const { runLoop1 } = await import("./loop1.mjs");

  if (typeof verifyFn !== "function") {
    throw new Error("runQuick: verifyFn must be injected (mock in tests; loop1-live in --live)");
  }

  const lines = prompt.trim().split(/\n/);
  const title = lines[0];
  const body = lines.slice(1).join("\n");

  // Build a single in-memory queue item (the orchestrator stores a pointer to
  // it; quick is single-stream, single-worktree).
  const now = new Date().toISOString();
  const item = {
    id: `sesh-quick-${Date.now()}`,
    title, body, source: "session",
    state: "queued", attempts: 1,
    created_at: now, updated_at: now,
    trail: [{ from: null, to: "queued", at: now }],
  };

  // classify → (needs_input stops here) → route → Loop 1.
  classifyItem(item, transition);
  tick({ run: { state: "executing", run_id: item.id }, agents: [{ agent_id: item.id, status: "running", phase: "execute" }] });

  if (item.state === "needs_input") {
    return {
      outcome: "needs_input",
      itemState: item.state,
      clarification_question: item.clarification_question,
    };
  }

  routeItem(item, transition, { skipConfigWrite: true });

  // VERIFY→FIX. fixFn defaults to a no-op (verifyFn drives PASS/FAIL in tests).
  const loopResult = await runLoop1({
    item,
    transitionFn: transition,
    verify: verifyFn,
    fix: typeof fixFn === "function" ? fixFn : async () => {},
    maxIterations: 5,
  });

  tick({ run: { state: item.state === "done" ? "done" : item.state, run_id: item.id }, agents: [{ agent_id: item.id, status: item.state, phase: "verify" }] });

  return {
    outcome: loopResult.outcome,   // done | failed | blocked
    reason: loopResult.reason,
    iterations: loopResult.iterations,
    itemState: item.state,
    verified: true,
  };
}

// ---------------------------------------------------------------------------
// feature / project path — decompose → (discuss first if project) → pipeline
// with a NON-BLOCKING multi-unit loop (per-unit needs_input; others progress).
// ---------------------------------------------------------------------------

/**
 * Drive the decomposed path. For `project`, discussion (intake→brainstorm→
 * oracle) runs FIRST. Then each unit advances through Loop 1, and the loop is
 * NON-BLOCKING: when a unit needs input it is parked `needs_input` while every
 * other unit keeps advancing in the SAME tick.
 */
async function runDecomposed({
  prompt, scale, classification, plan, bgsdDir, sessionRecord,
  verifyFn, fixFn, discussFn, oracleFn, decomposeFn, reviewFn, prFn, escalateFn, tick,
}) {
  // --- DISCUSS FIRST (project only) ---
  let oracle = null;
  if (plan.discuss) {
    if (typeof discussFn !== "function") {
      throw new Error("runDecomposed: project scale requires discussFn (intake→brainstorm→oracle) to be injected");
    }
    oracle = await discussFn({ prompt });   // returns an oracle manifest (mocked in tests)
    sessionRecord.discussed = true;
  }

  // --- DECOMPOSE into units (small for feature, full for project). ---
  if (typeof decomposeFn !== "function") {
    throw new Error("runDecomposed: decomposeFn must be injected (mock in tests; decompose.mjs in live)");
  }
  const units = await decomposeFn({ prompt, scale });
  if (!Array.isArray(units) || units.length === 0) {
    throw new Error("runDecomposed: decomposeFn must return a non-empty units array");
  }

  if (typeof verifyFn !== "function") {
    throw new Error("runDecomposed: verifyFn must be injected for per-unit Loop 1");
  }

  // Per-unit state. Each unit gets its OWN status so the live view + the
  // non-blocking loop can advance them independently.
  const unitStates = units.map((u) => ({
    id: u.id ?? u.title ?? `unit-${Math.random().toString(36).slice(2, 7)}`,
    status: "pending",          // pending → running → done | failed | blocked | needs_input
    needsInput: u.needsInput === true,   // a pending question (test/live signal)
    question: u.question ?? null,
    iterations: 0,
  }));

  // -------------------------------------------------------------------------
  // NON-BLOCKING orchestration loop. On EACH tick:
  //   - render the live view (per-unit status),
  //   - ingest inbox messages without halting,
  //   - advance EVERY unit that is NOT parked on a pending question,
  //   - a unit needing input is marked needs_input (via control semantics)
  //     and SKIPPED — but every other unit still advances THIS tick.
  // The loop runs until all units are terminal OR all remaining are needs_input.
  // -------------------------------------------------------------------------
  const escalations = [];
  let guard = 0;
  const MAX_TICKS = units.length * 8 + 16;   // bounded (NFR-08)

  while (guard++ < MAX_TICKS) {
    // Drain inbox first: an interjected message can ANSWER a pending question,
    // un-parking exactly one unit (without halting anything else).
    const msgs = tick(renderView(scale, unitStates));
    for (const m of msgs) {
      if (m && m.answersUnit) {
        const target = unitStates.find((u) => u.id === m.answersUnit);
        if (target && target.status === "needs_input") {
          target.needsInput = false;
          target.question = null;
          target.status = "pending";   // re-enters orchestration next step
        }
      }
    }

    // Pick the work set: every non-terminal, non-parked unit. A unit flagged
    // with a pending question still enters here so the oracle is consulted; it
    // is parked (needs_input) ONLY if the oracle abstains. Crucially, parking
    // one unit does NOT stop the others in this same tick.
    const advanceable = unitStates.filter(
      (u) => u.status === "pending" || u.status === "running"
    );

    if (advanceable.length === 0) break;   // all terminal or all parked needs_input

    // Advance EVERY advanceable unit ONE step this tick (concurrent in spirit;
    // we resolve them in-loop deterministically). This is the proof that other
    // units progress while one waits.
    for (const u of advanceable) {
      // A unit that should ask a question: mark ONLY this unit needs_input.
      // Try the oracle first — it auto-answers most (escalation is rare).
      if (u.needsInput) {
        let handled = false;
        if (typeof oracleFn === "function" && u.question) {
          const ans = oracleFn(u.question, oracle);
          if (ans && ans.action === "auto_answer") {
            // Oracle cleared it — keep advancing, no user prompt.
            u.needsInput = false;
            u.question = null;
            handled = true;
          }
        }
        if (!handled) {
          // Oracle abstained → park THIS unit only; collect the escalation.
          u.status = "needs_input";
          escalations.push({ question: u.question ?? "Need a decision.", agentId: u.id });
          continue;   // other advanceable units still get their step below
        }
      }

      // Drive one Loop 1 step for this unit (real controller, mocked verify).
      await advanceUnitOneStep(u, { verifyFn, fixFn });
    }
  }

  // Batch the rare escalations to the user (non-blocking; never a silent guess).
  let escalationResult = null;
  if (escalations.length > 0 && typeof escalateFn === "function") {
    escalationResult = await escalateFn(escalations);
  }

  // Loop 2 only if more than one unit merged (feature) / always (project, when units merged).
  const doneUnits = unitStates.filter((u) => u.status === "done");
  const ranLoop2 = (scale === "project" && doneUnits.length > 0) ||
                   (scale === "feature" && doneUnits.length > 1);

  // Review gate (interactive; never auto-passed) — invoked when units assembled.
  let reviewVerdict = null;
  if (doneUnits.length > 0 && typeof reviewFn === "function") {
    reviewVerdict = await reviewFn({ scale, doneUnits: doneUnits.map((u) => u.id) });
  }

  // Changelog / PR (real PR is --live-gated; here injected/mocked).
  let prResult = null;
  if (doneUnits.length > 0 && typeof prFn === "function") {
    prResult = await prFn({ scale, doneUnits: doneUnits.map((u) => u.id) });
  }

  const anyNeedsInput = unitStates.some((u) => u.status === "needs_input");
  const anyFailed = unitStates.some((u) => u.status === "failed" || u.status === "blocked");
  const outcome = anyNeedsInput ? "needs_input"
    : anyFailed ? "blocked"
    : "done";

  return {
    outcome,
    discussed: plan.discuss,
    units: unitStates.map((u) => ({ id: u.id, status: u.status, iterations: u.iterations })),
    ranLoop2,
    reviewVerdict,
    prResult,
    escalations,
    escalationResult,
    verified: true,
  };
}

/**
 * Advance one unit by a single Loop 1 step. Reuses runLoop1 with a per-unit
 * item; updates the unit's status from the loop outcome. Mocked verify drives
 * PASS/FAIL deterministically in tests.
 */
async function advanceUnitOneStep(unitState, { verifyFn, fixFn }) {
  const { transition } = await import("./queue.mjs");
  const { runLoop1 } = await import("./loop1.mjs");

  const now = new Date().toISOString();
  const item = {
    id: unitState.id, title: unitState.id, body: "", source: "session",
    state: "routed", attempts: 1, created_at: now, updated_at: now,
    trail: [{ from: null, to: "routed", at: now }],
  };

  unitState.status = "running";
  const r = await runLoop1({
    item,
    transitionFn: transition,
    verify: () => verifyFn(unitState.id),
    fix: typeof fixFn === "function" ? fixFn : async () => {},
    maxIterations: 5,
  });
  unitState.iterations += r.iterations;
  unitState.status = r.outcome;   // done | failed | blocked
  return r;
}

/**
 * Build the live-status view input for a tick from per-unit states.
 */
function renderView(scale, unitStates) {
  const statusMap = { pending: "running", running: "running", done: "done", failed: "failed", blocked: "blocked", needs_input: "needs_input" };
  return {
    run: {
      run_id: `sesh-${scale}`,
      state: unitStates.every((u) => u.status === "done") ? "done"
        : unitStates.some((u) => u.status === "needs_input") ? "needs_input"
        : "executing",
      units: unitStates.map((u) => u.id),
    },
    agents: unitStates.map((u) => ({
      agent_id: u.id,
      status: statusMap[u.status] ?? "running",
      phase: u.status === "needs_input" ? "blocked" : "execute",
      progress: { iteration: u.iterations, max_iterations: 5, note: "" },
      blockers: u.status === "needs_input" && u.question
        ? [{ id: `bk-${u.id}`, question: u.question, severity: "medium", resolved: false }]
        : [],
      escalations: [],
    })),
    telemetry: null,
  };
}

/**
 * Resolve the effective verification mode for a session: whether the heavy
 * Playwright/vision usage-testing rung runs. The goal-backward code verification
 * (gsd-verifier) ALWAYS runs regardless; this only governs the UI usage testing.
 *
 * Precedence: an explicit per-session `--no-usage-verification` flag forces
 * code-only. Otherwise the BGSD.md `verification.usage_testing` knob decides
 * (default true). A missing config defaults to full usage testing.
 *
 * @param {object} opts
 * @param {object|null} [opts.config]                resolved BGSD.md config (or null)
 * @param {boolean}     [opts.noUsageVerification]   the per-session flag
 * @returns {boolean} true = run Playwright usage testing; false = code-only
 */
export function resolveUsageTesting({ config, noUsageVerification } = {}) {
  if (noUsageVerification) return false;
  return config?.verification?.usage_testing !== false;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://") ? import.meta.url : `file://${process.cwd()}/`
  ).href
) {
  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith("--")) continue;
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    }
    return flags;
  }

  (async () => {
    const flags = parseFlags(process.argv.slice(2));
    const prompt = typeof flags.prompt === "string" ? flags.prompt : "";
    if (!prompt) {
      process.stderr.write(
        'Usage: session.mjs --prompt "<request>" [--quick | --feature | --project] [--no-usage-verification] [--gui] [--plan-only | --dry-run]\n' +
        '  Default (no flag): executes the session. --plan-only / --dry-run: preview only. --gui: open the live dashboard.\n'
      );
      process.exit(1);
    }
    const scaleFlags = [flags.quick, flags.feature, flags.project].filter(Boolean).length;
    if (scaleFlags > 1) {
      process.stderr.write("session.mjs: --quick, --feature, and --project are mutually exclusive\n");
      process.exit(1);
    }
    const mode = flags.quick ? "quick" : flags.feature ? "feature" : flags.project ? "project" : "auto";
    // plan-only is ONLY when explicitly requested; default (no flag) = run the session.
    const planOnly = flags["plan-only"] === true || flags["dry-run"] === true;
    const noUsageVerification = flags["no-usage-verification"] === true;
    const gui = flags.gui === true;

    // Resolve the verification mode: flag overrides the BGSD.md verification knob.
    // Best-effort config load — a missing/unreadable BGSD.md falls back to defaults
    // (full usage testing). Code verification (gsd-verifier) always runs either way.
    let bgsdConfig = null;
    try {
      const { resolveRepoRoot } = await import("./init-live.mjs");
      const { parseBgsdMd } = await import("./init.mjs");
      const { existsSync, readFileSync } = await import("node:fs");
      const bgsdMdPath = `${resolveRepoRoot()}/BGSD.md`;
      if (existsSync(bgsdMdPath)) bgsdConfig = parseBgsdMd(readFileSync(bgsdMdPath, "utf8"));
    } catch (_) { bgsdConfig = null; }
    const usageTesting = resolveUsageTesting({ config: bgsdConfig, noUsageVerification });

    // CLI: classify + build the depth plan always; then either preview (--plan-only / --dry-run)
    // or execute (the default). Real irreversible actions (git merge, gh pr create) remain
    // human-gated at merge-boundary checkpoints behind the existing *-live.mjs requireLiveFlag guards.
    const classification = await classifyScale({ prompt, mode });
    if (classification.action === "clarify") {
      process.stdout.write(`\nKiwi needs one clarification:\n  ${classification.clarification_question}\n\n`);
      process.exit(0);
    }
    const plan = buildDepthPlan(classification.scale, { prompt });

    try { const { splash } = await import("./ui.mjs"); splash(); } catch (_) { /* splash is cosmetic */ }
    process.stdout.write(`\nKiwi · bgsd Conductor   [lock] main-protected\n`);
    process.stdout.write(`  prompt:  ${prompt}\n`);
    process.stdout.write(`  scale:   ${classification.scale}   (mode=${mode}, confidence=${classification.confidence})\n`);
    process.stdout.write(`  signals: units≈${classification.unitCountEstimate}, surfaces=${classification.depthBreadth}\n`);
    process.stdout.write(`  discuss: ${plan.discuss}   verified: ${plan.verified} (Loop 1 always runs)\n`);
    process.stdout.write(
      `  verify:  ${usageTesting
        ? "full (gsd-verifier code check + Playwright usage testing)"
        : "code-only (gsd-verifier; Playwright UI usage testing OFF)"}\n`
    );
    process.stdout.write(`\n  depth plan (engine sequence):\n`);
    for (const s of plan.stages) {
      process.stdout.write(`    - ${s.id.padEnd(11)} → ${s.engine} :: ${s.entry}  [${s.depth}]\n`);
    }
    if (planOnly) {
      process.stdout.write(`\n  preview (--plan-only) — classified and planned; nothing spawned. Pass no flag to execute.\n\n`);
    } else {
      // Propagate the verification mode to every spawned agent + Tester. Children
      // inherit process.env; the Tester (tester.md) and /bgsd-verify honor
      // BGSD_USAGE_TESTING=0 by skipping the Playwright ladder (code-only).
      process.env.BGSD_USAGE_TESTING = usageTesting ? "1" : "0";
      // sesh preflight: ensure init + ff-sync the integration branch from base.
      try {
        const { resolveRepoRoot, seshPreflight } = await import("./init-live.mjs");
        const pf = seshPreflight(resolveRepoRoot());
        const did = pf.performed.length ? pf.performed.join(", ") : "already current";
        process.stdout.write(`  preflight: integration '${pf.integrationBranch}' <- base '${pf.baseBranch}'  [${did}]\n`);
        for (const n of pf.notes) process.stdout.write(`  preflight note: ${n}\n`);
      } catch (err) {
        process.stdout.write(`  preflight skipped (${err.message})\n`);
      }
      // Conductor dependency preflight: ENSURE the engine is present + current,
      // out of the box. gsd-core is the npm package @opengsd/gsd-core, installed
      // (and updated) by the same non-interactive command. If it is missing we
      // install it now; if present we refresh it to latest. Resilient: any
      // failure is reported, never crashes the session.
      try {
        const { isGsdInstalled, ensureGsdLive, GSD_NPM_PACKAGE } = await import("./gsdinstall-live.mjs");
        const wasInstalled = isGsdInstalled();
        if (wasInstalled) {
          process.stdout.write(`  deps: gsd-core (engine) installed ✓ — refreshing to latest\n`);
        } else {
          process.stdout.write(`  deps: gsd-core (engine) missing — installing ${GSD_NPM_PACKAGE} now\n`);
        }
        const res = ensureGsdLive({ log: (m) => process.stdout.write(`        ${m}\n`) });
        const did = res.performed.length ? res.performed.join(", ") : "already current";
        process.stdout.write(`  deps: gsd-core ready ✓  [${did}]\n`);
      } catch (err) {
        process.stdout.write(
          `  deps: gsd-core ensure FAILED (${err.message}). ` +
          `Install manually: npx -y @opengsd/gsd-core@latest --claude --global\n`
        );
      }
      if (usageTesting) {
        process.stdout.write(`  deps: Playwright (UI verification) ships with the plugin; Kiwi runs 'npx playwright install' before verifying.\n`);
      } else {
        process.stdout.write(`  deps: Playwright skipped — code-only verification (gsd-verifier). No browser/UI usage testing this session.\n`);
      }
      // Write an initial run-state so the dashboard shows the pipeline stage even
      // before any agent (and thus any control file) exists: discuss and
      // decompose happen before fan-out. The Conductor advances the stage as it
      // progresses via `gui-live.mjs stage <name>`.
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { resolveRepoRoot } = await import("./init-live.mjs");
        const seshRunId = `sesh-${Date.now()}`;
        const initialStage =
          classification.scale === "project" ? "discuss"
          : classification.scale === "feature" ? "decompose"
          : "loop1";
        const runDir = `${resolveRepoRoot()}/.bgsd/runs/${seshRunId}`;
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          `${runDir}/run.json`,
          JSON.stringify({
            run_id: seshRunId,
            scale: classification.scale,
            state: "executing",
            stage: initialStage,
            note: plan.discuss ? "discussing decisions before fan-out" : "planning the work",
            started_at: new Date().toISOString(),
          }, null, 2) + "\n",
          "utf8"
        );
        process.stdout.write(`  run: ${seshRunId}  (stage: ${initialStage})\n`);
      } catch (_) { /* run-state is best-effort */ }
      // --gui: open the live dashboard (a detached, read-only observability
      // server) and hand the user the clickable URL. Close it any time with
      // `gui-live.mjs stop`. The dashboard outlives this harness on purpose.
      if (gui) {
        try {
          const { spawn } = await import("node:child_process");
          const { existsSync, readFileSync } = await import("node:fs");
          const { resolveRepoRoot } = await import("./init-live.mjs");
          const guiScript = new URL("./gui-live.mjs", import.meta.url).pathname;
          spawn(process.execPath, [guiScript, "start"], { detached: true, stdio: "ignore" }).unref();
          const ptr = `${resolveRepoRoot()}/.bgsd/gui.json`;
          let url = null;
          for (let i = 0; i < 20 && !url; i++) {
            if (existsSync(ptr)) { try { url = JSON.parse(readFileSync(ptr, "utf8")).url; } catch (_) { /* not ready */ } }
            if (!url) await new Promise((r) => setTimeout(r, 100));
          }
          process.stdout.write(
            `  gui: live dashboard ${url ? `at ${url}` : "starting (see .bgsd/gui.json)"} — close it with: node "\${CLAUDE_PLUGIN_ROOT}/scripts/gui-live.mjs" stop\n`
          );
        } catch (err) {
          process.stdout.write(`  gui: could not open the dashboard (${err.message})\n`);
        }
      }
      process.stdout.write(`\n  executing session: orchestration running. Real merges/PRs are human-gated at merge-boundary checkpoints (requireLiveFlag-guarded, never next).\n\n`);
    }
    process.exit(0);
  })().catch((err) => {
    process.stderr.write(`session.mjs: ${err.message}\n`);
    process.exit(1);
  });
}
