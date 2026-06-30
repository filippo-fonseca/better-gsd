#!/usr/bin/env node
/**
 * gsdinstall.mjs — ensure the user-installed gsd-core is present + current (pure core)
 *
 * bgsd is "gsd-agnostic": it does NOT vendor GSD. It drives the user's own
 * `gsd-core` install. The Conductor must ENSURE gsd-core is installed and up to
 * date at the start of every sesh. This module is the pure, dependency-injected
 * brain for that: it decides WHAT to do, and an injected executor does it.
 *
 * gsd-core is the npm package `@opengsd/gsd-core` (NOT a Claude Code plugin),
 * installed/updated by the same non-interactive command
 * `npx -y @opengsd/gsd-core@latest --claude --global`. The real commands live in
 * gsdinstall-live.mjs; this file has zero side effects so it unit-tests against
 * mocked deps.
 *
 * PURITY (NFR-05)
 * ===============
 * `gsdEnsurePlan(state)` is a pure planner (no I/O). `ensureGsd(deps)` is a DI
 * executor that runs the plan through injected `isInstalled/install/update`.
 * The `--live` guard + real `child_process` seam live in gsdinstall-live.mjs.
 *
 * Usage (library):
 *   import { gsdEnsurePlan, ensureGsd } from './gsdinstall.mjs';
 */

// ---------------------------------------------------------------------------
// Update policy
// ---------------------------------------------------------------------------

/**
 * How aggressively to keep gsd-core current once it is installed:
 *   - "always": update to latest on every sesh start (default for "never stale").
 *   - "never" / anything else: leave an installed gsd-core untouched.
 * A missing gsd-core is ALWAYS installed, regardless of policy.
 */
export const DEFAULT_UPDATE_POLICY = "always";

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

/**
 * Decide the ordered actions to bring gsd-core to a ready state.
 *
 *   installed=false                  -> ["install"]   (policy is irrelevant)
 *   installed=true,  policy="always" -> ["update"]
 *   installed=true,  policy!="always"-> []            (already present, no churn)
 *
 * @param {object} state
 * @param {boolean} state.installed                whether gsd-core is present
 * @param {string}  [state.updatePolicy="always"]  see DEFAULT_UPDATE_POLICY
 * @returns {Array<"install"|"update">} ordered action list (may be empty)
 */
export function gsdEnsurePlan(state) {
  const installed = !!(state && state.installed);
  const policy = (state && state.updatePolicy) ?? DEFAULT_UPDATE_POLICY;
  if (!installed) return ["install"];
  return policy === "always" ? ["update"] : [];
}

// ---------------------------------------------------------------------------
// DI executor — runs the plan through injected side effects (testable)
// ---------------------------------------------------------------------------

/**
 * Ensure gsd-core is installed + (per policy) current, via injected effects.
 * Detects state with `deps.isInstalled()`, plans, then runs `install`/`update`.
 * Runs unmodified against mocked deps in tests and the real CLI seam in
 * gsdinstall-live.mjs.
 *
 * @param {object} deps
 * @param {()=>boolean}   deps.isInstalled            detect gsd-core presence
 * @param {()=>void}      deps.install                install gsd-core (side effect)
 * @param {()=>void}      deps.update                 update gsd-core (side effect)
 * @param {(msg:string)=>void} [deps.log]             narration sink
 * @param {string}        [deps.updatePolicy="always"] see DEFAULT_UPDATE_POLICY
 * @returns {{ installed: boolean, performed: Array<"install"|"update">, alreadyCurrent: boolean }}
 *   - installed: true if gsd-core is present after this call
 *   - performed: the actions actually run, in order
 *   - alreadyCurrent: installed before AND no action was needed
 */
export function ensureGsd(deps) {
  const log = deps.log ?? (() => {});
  const wasInstalled = !!deps.isInstalled();
  const policy = deps.updatePolicy ?? DEFAULT_UPDATE_POLICY;

  const actions = gsdEnsurePlan({ installed: wasInstalled, updatePolicy: policy });
  const performed = [];

  for (const action of actions) {
    switch (action) {
      case "install":
        log("gsd-core not found — installing");
        deps.install();
        performed.push("install");
        break;
      case "update":
        log("gsd-core present — updating to latest");
        deps.update();
        performed.push("update");
        break;
      default:
        // Planner only emits install/update; ignore anything unexpected.
        break;
    }
  }

  if (wasInstalled && performed.length === 0) {
    log("gsd-core present and current — nothing to do");
  }

  return {
    installed: wasInstalled || performed.includes("install"),
    performed,
    alreadyCurrent: wasInstalled && performed.length === 0,
  };
}
