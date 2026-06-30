#!/usr/bin/env node
/**
 * issues.mjs — atomic GitHub issues per work unit + one epic per sesh (pure core).
 *
 * Mirrors the user's global "new bug → issue → branch → PR (Closes #n)" workflow,
 * scaled to a parallel run: each work unit gets its OWN issue, and its PR into
 * the integration branch closes it (`Closes #N`). The sesh has one epic issue
 * that tracks every unit.
 *
 * Pure + DI: the real `gh` calls and remote detection live in issues-live.mjs
 * behind --live. When there is no GitHub remote, issue creation is SKIPPED and
 * the run proceeds with plain branch+merge (same fallback as the global rule).
 *
 * Usage (library):
 *   import { formatEpic, formatUnit, createIssues, collectCloses } from './issues.mjs';
 */

/** Truncate to `max` chars on a word boundary where possible. */
export function truncate(s, max = 60) {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + "…";
}

/** Build the epic (sesh-level) issue payload. */
export function formatEpic({ runId, prompt, units }) {
  const list = (units ?? []).map((u) => `- [ ] ${u.title}`).join("\n");
  return {
    title: `bgsd: ${truncate(prompt, 60)} (${runId})`,
    body:
      `Tracking issue for bgsd sesh \`${runId}\`.\n\n` +
      `> ${(prompt ?? "").trim()}\n\n` +
      `## Work units\n${list}\n`,
  };
}

/** Build one work-unit issue payload, linked to its epic. */
export function formatUnit({ unit, runId, epicNumber }) {
  const lines = [];
  if (epicNumber) lines.push(`Part of #${epicNumber} (bgsd sesh \`${runId}\`).`, "");
  if (unit.scope) lines.push(`**Scope:** ${unit.scope}`, "");
  if (unit.touched && unit.touched.length) lines.push(`**Touches:** ${unit.touched.join(", ")}`, "");
  if (unit.deps && unit.deps.length) lines.push(`**Depends on:** ${unit.deps.join(", ")}`, "");
  return { title: unit.title, body: lines.join("\n").trim() + "\n" };
}

/**
 * Create the epic + per-unit issues through injected deps.
 *
 * @param {object} opts
 * @param {string}   opts.runId
 * @param {string}   opts.prompt
 * @param {Array<{id,title,scope?,touched?,deps?}>} opts.units
 * @param {object}   opts.deps
 * @param {()=>boolean}                       opts.deps.hasRemote
 * @param {(payload:{title,body,labels?})=>(number|Promise<number>)} opts.deps.createIssue
 * @param {(result:object)=>void}             [opts.deps.persist]
 * @param {string[]}                          [opts.deps.labels]
 * @param {(msg:string)=>void}                [opts.deps.log]
 * @returns {Promise<{skipped:boolean, reason?:string, epic:number|null, units:Record<string,number>}>}
 */
export async function createIssues({ runId, prompt, units, deps }) {
  const log = deps.log ?? (() => {});
  if (!deps.hasRemote()) {
    log("no GitHub remote — skipping issue creation (branch + merge only)");
    return { skipped: true, reason: "no GitHub remote", epic: null, units: {} };
  }

  const labels = deps.labels;
  const epicNumber = await deps.createIssue({ ...formatEpic({ runId, prompt, units }), labels });

  const map = {};
  for (const unit of units) {
    map[unit.id] = await deps.createIssue({
      ...formatUnit({ unit, runId, epicNumber }),
      labels,
    });
  }

  const result = { skipped: false, epic: epicNumber, units: map };
  if (typeof deps.persist === "function") deps.persist(result);
  log(`created epic #${epicNumber} + ${units.length} unit issue(s)`);
  return result;
}

/**
 * Build the `Closes #N` block for a PR that lands the given units (and
 * optionally the epic). Returns "" when issues were skipped / unknown.
 */
export function collectCloses(result, unitIds, { includeEpic = false } = {}) {
  if (!result || result.skipped) return "";
  const nums = [];
  for (const id of unitIds ?? []) {
    const n = result.units?.[id];
    if (n) nums.push(n);
  }
  if (includeEpic && result.epic) nums.push(result.epic);
  return nums.map((n) => `Closes #${n}`).join("\n");
}
