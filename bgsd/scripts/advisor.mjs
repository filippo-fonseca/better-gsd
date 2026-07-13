#!/usr/bin/env node
/** Model-agnostic live Conductor advisor and durable seed-plan seam. */

import { existsSync } from "node:fs";
import { join } from "node:path";

export function normalizeAdvisorSetting(setting) {
  if (setting === true || setting === false) return setting;
  const value = String(setting ?? "auto").trim().toLowerCase();
  if (["true", "on", "yes"].includes(value)) return true;
  if (["false", "off", "no"].includes(value)) return false;
  return "auto";
}

/** The live Conductor is the advisor in v2, regardless of provider or model. */
export function advisorActive({ setting = "auto" } = {}) {
  return normalizeAdvisorSetting(setting) !== false;
}

export function advisorGateReason({ setting = "auto", conductor } = {}) {
  const normalized = normalizeAdvisorSetting(setting);
  if (normalized === false) return { active: false, reason: "disabled by BGSD.md conductor.advisor=false" };
  const identity = conductor?.provider && conductor?.model
    ? `${conductor.provider}/${conductor.model}`
    : "live session model";
  return {
    active: true,
    reason: normalized === true
      ? `forced on for ${identity}`
      : `the live Conductor (${identity}) owns advisory reasoning`,
  };
}

export const ADVISOR_DUTIES = Object.freeze([
  {
    id: "review-plan",
    label: "Review the sealed plan",
    hook: "after a unit plan seals and before execution",
    reads: ["seed-plan.md", "PLAN.md"],
  },
  {
    id: "steer-pre-exec",
    label: "Steer before execution",
    hook: "inject guidance through the seed and agent inbox",
    reads: ["seed-plan.md", "bgsd-unit.json"],
  },
  {
    id: "checkin-commits",
    label: "Check in on commits",
    hook: "review distilled progress as commits land",
    reads: ["git log --oneline", "verification-report.json"],
  },
  {
    id: "author-seeds",
    label: "Author downstream seed plans",
    hook: "at wave boundaries, synthesize upstream results for downstream units",
    reads: ["upstream commit log", "verification-report.json"],
  },
]);

export function conductorSeedPath(runId, unitId, { bgsdDir = ".bgsd" } = {}) {
  return join(bgsdDir, "runs", runId, "seeds", `${unitId}.md`);
}

export function readConductorSeed(runId, unitId, { bgsdDir = ".bgsd", existsFn = existsSync } = {}) {
  const path = conductorSeedPath(runId, unitId, { bgsdDir });
  return existsFn(path) ? path : null;
}

const invokedDirectly = typeof process.argv[1] === "string" && /[\\/]advisor\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv[0] === "gate") {
    const conductor = { provider: value("provider"), model: value("model") };
    const decision = advisorGateReason({ setting: value("setting") ?? "auto", conductor });
    process.stdout.write(`advisor: ${decision.active ? "ON" : "off"} - ${decision.reason}\n`);
    process.exit(0);
  }
  process.stderr.write("Usage: node advisor.mjs gate [--provider claude|openai] [--model <id>] [--setting auto|true|false]\n");
  process.exit(1);
}
