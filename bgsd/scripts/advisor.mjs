#!/usr/bin/env node
/**
 * advisor.mjs — Fable-as-Advisor mode: the gate + duties + Conductor-seed seam.
 *
 * WHAT THIS IS
 * ============
 * Normally the Conductor (Kiwi) is a lean orchestrator: it never reads raw
 * files or reviews diffs — scouts and fresh-Opus agents do — so its context
 * stays small. Fable is leveraged only as a standalone per-unit pre-planner
 * subprocess that seeds the Opus pipeline. When Kiwi's OWN brain is Fable that
 * reasoning is wasted: it holds the same lean discipline regardless of model.
 *
 * Fable-as-Advisor mode fixes that. When the gate is on, Kiwi actively uses its
 * Fable reasoning as a live reviewing ADVISOR across the pipeline:
 *   1. Reviews each wave unit's plan the moment it seals (the seed plan / the
 *      unit's PLAN.md), before execution begins.
 *   2. Steers before execution — injects guidance via the seed + the agent inbox.
 *   3. Checks in on commits as they land — reviews the commit log + verification
 *      report as the unit builds.
 *   4. Authors the next wave's seed plans itself — writing the seed markdown
 *      directly with its own Fable brain instead of spawning the redundant
 *      standalone Fable pre-planner subprocess.
 *
 * DISTILLED ARTIFACTS ONLY. The advisor reviews distilled artifacts — the
 * sealed PLAN.md / fable-plan.md, the commit log, and verification-report.json —
 * NOT raw source or full diffs. Fable's larger context window is exactly what
 * makes live advisory affordable; the lean-context discipline still bounds it.
 *
 * THE GATE (three criteria, OFF by default)
 * =========================================
 * Advisor mode is active when the BGSD.md setting `conductor.fable_advisor` is
 * `"auto"` (the default) AND ANY of:
 *   (a) the Conductor's brain IS Fable (self-checked at session start), OR
 *   (b) `--fable` was passed to the session, OR
 *   (c) the Conductor proposed advisor mode and the user approved it.
 * When none hold, mode is completely OFF and Kiwi behaves exactly as before.
 * The setting overrides the criteria: `true` forces it on, `false` hard-disables
 * it even on Fable. Easily toggled by any of the three criteria (or the setting).
 *
 * REPLACE vs COMPLEMENT
 * =====================
 * When Kiwi IS Fable, the advisor authors seeds itself — the standalone Fable
 * pre-planner subprocess is redundant and is SKIPPED (run-live uses the
 * Conductor-authored seed via conductorSeedPath below). When Kiwi is NOT Fable
 * but `--fable` is on, the subprocess still runs and the advisor duties
 * (review / steer / check-in) layer on top of it.
 *
 * Pure core (zero model calls, NFR-05). The one fs touch is reading a
 * Conductor-authored seed file, and it is injectable for tests.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The concrete Fable model id (Claude). The Conductor's "brain" is Fable when
 *  the live session runs on this. Codex has no distinct Fable tier, so criterion
 *  (a) is a Claude concept; on Codex, enable advisor via `--fable` or approval. */
export const FABLE_MODEL_ID = "claude-fable-5";

/**
 * Is a session model the Fable brain? Matches the canonical id, a bare "fable"
 * substring (covers `/model claude-fable-5`, future Fable ids), or an explicit
 * `harnessModels.claude.fable` mapping if one is supplied.
 *
 * @param {string} [model]         the live session's model id
 * @param {object} [harnessModels] optional { claude:{fable}, codex:{fable} } map
 * @returns {boolean}
 */
export function isFableBrain(model, harnessModels) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (m.includes("fable")) return true;
  const claudeFable = harnessModels?.claude?.fable;
  if (claudeFable && m === String(claudeFable).toLowerCase()) return true;
  return false;
}

/**
 * Normalize the `conductor.fable_advisor` setting to `true | false | "auto"`.
 * Accepts booleans and the strings on/true/yes, off/false/no, auto (default).
 * Anything unrecognized (including undefined) falls back to "auto".
 *
 * @param {boolean|string} [setting]
 * @returns {boolean|"auto"}
 */
export function normalizeAdvisorSetting(setting) {
  if (setting === true || setting === false) return setting;
  const s = String(setting ?? "auto").trim().toLowerCase();
  if (s === "true" || s === "on" || s === "yes") return true;
  if (s === "false" || s === "off" || s === "no") return false;
  return "auto";
}

/**
 * Is Fable-as-Advisor mode active for this session? The single source of truth.
 *
 * Precedence: an explicit `true`/`false` setting wins; on `"auto"` the
 * three-criteria OR gate decides.
 *
 * @param {object}  ctx
 * @param {string}  [ctx.sessionModel]   the Conductor's live model id
 * @param {boolean} [ctx.fableFlag]      was `--fable` passed?
 * @param {boolean} [ctx.approved]       did the user approve an advisor proposal?
 * @param {boolean|string} [ctx.setting] BGSD.md conductor.fable_advisor
 * @param {object}  [ctx.harnessModels]  optional harness model map
 * @returns {boolean}
 */
export function fableAdvisorActive(ctx = {}) {
  const { sessionModel, fableFlag = false, approved = false, setting = "auto", harnessModels } = ctx;
  const norm = normalizeAdvisorSetting(setting);
  if (norm === true) return true;
  if (norm === false) return false;
  return isFableBrain(sessionModel, harnessModels) || !!fableFlag || !!approved;
}

/**
 * Explain the gate decision — for narration + the dashboard. Returns the boolean
 * plus which criterion fired (or why it's off).
 *
 * @param {object} ctx  same shape as fableAdvisorActive
 * @returns {{ active: boolean, reason: string }}
 */
export function advisorGateReason(ctx = {}) {
  const { sessionModel, fableFlag = false, approved = false, setting = "auto", harnessModels } = ctx;
  const norm = normalizeAdvisorSetting(setting);
  if (norm === true) return { active: true, reason: "forced on by BGSD.md conductor.fable_advisor=true" };
  if (norm === false) return { active: false, reason: "disabled by BGSD.md conductor.fable_advisor=false" };
  if (isFableBrain(sessionModel, harnessModels))
    return { active: true, reason: `Conductor brain is Fable (${sessionModel})` };
  if (fableFlag) return { active: true, reason: "--fable flag" };
  if (approved) return { active: true, reason: "user approved advisor proposal" };
  return { active: false, reason: "not on Fable, no --fable, no approved proposal" };
}

/**
 * The four advisor duties + their pipeline hook-points and the distilled
 * artifacts each is allowed to read. Keeps the code, the dashboard, and the
 * bgsd-sesh.md instructions in sync — narration can iterate these.
 */
export const ADVISOR_DUTIES = [
  {
    id: "review-plan",
    label: "Review the sealed plan",
    hook: "after a unit's plan seals (seed plan / PLAN.md), before execution",
    reads: ["fable-plan.md", "PLAN.md"],
  },
  {
    id: "steer-pre-exec",
    label: "Steer before execution",
    hook: "inject guidance via the seed + <agent-id>.inbox.md before the Opus agent runs",
    reads: ["fable-plan.md", "bgsd-unit.json"],
  },
  {
    id: "checkin-commits",
    label: "Check in on commits",
    hook: "as commits land during execute, review the distilled record",
    reads: ["git log --oneline", "verification-report.json"],
  },
  {
    id: "author-seeds",
    label: "Author the next wave's seed plans",
    hook: "at a wave boundary, write the downstream units' seeds directly (Fable brain)",
    reads: ["upstream commit log", "verification-report.json"],
  },
];

// ---------------------------------------------------------------------------
// Conductor-authored seed seam
// ---------------------------------------------------------------------------

/**
 * Where the Conductor writes a seed plan it authored itself (advisor duty #4).
 * run-live copies this into the unit's worktree as fable-plan.md and skips the
 * standalone Fable pre-planner subprocess.
 *
 * @param {string} runId
 * @param {string} unitId
 * @param {object} [opts]
 * @param {string} [opts.bgsdDir]  the .bgsd dir (default ".bgsd")
 * @returns {string}  absolute-ish path to the seed file
 */
export function conductorSeedPath(runId, unitId, { bgsdDir = ".bgsd" } = {}) {
  return join(bgsdDir, "runs", runId, "seeds", `${unitId}.md`);
}

/**
 * Return the Conductor-authored seed path if one exists, else null. Injectable
 * `existsFn` for tests.
 *
 * @param {string} runId
 * @param {string} unitId
 * @param {object} [opts]  { bgsdDir?, existsFn? }
 * @returns {string|null}
 */
export function readConductorSeed(runId, unitId, { bgsdDir = ".bgsd", existsFn = existsSync } = {}) {
  const p = conductorSeedPath(runId, unitId, { bgsdDir });
  return existsFn(p) ? p : null;
}

// ---------------------------------------------------------------------------
// CLI — quick gate check for the Conductor / dashboards
//   node advisor.mjs gate --model claude-fable-5 [--fable] [--approved] [--setting auto]
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" && /[\\/]advisor\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const flag = (name) => argv.includes(`--${name}`);
  const val = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (sub === "gate") {
    const ctx = {
      sessionModel: val("model"),
      fableFlag: flag("fable"),
      approved: flag("approved"),
      setting: val("setting") ?? "auto",
    };
    const { active, reason } = advisorGateReason(ctx);
    process.stdout.write(`fable-advisor: ${active ? "ON" : "off"} — ${reason}\n`);
    process.exit(0);
  }

  process.stderr.write(
    "Usage: node advisor.mjs gate --model <id> [--fable] [--approved] [--setting auto|true|false]\n"
  );
  process.exit(1);
}
