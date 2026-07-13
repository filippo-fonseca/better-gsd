#!/usr/bin/env node
/**
 * test-session.mjs — Unit tests for session.mjs (Unification U1/U2/U3).
 *
 * No external framework: node:assert/strict only. Fully mocked — no spawns, no
 * merges, no PRs, no model calls. Run with:
 *   node bgsd/scripts/test-session.mjs
 * Exits 0 on all-pass, non-zero on any failure (no silent green).
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import {
  SCALES,
  SESSION_MODES,
  classifyScale,
  naturalLanguageMode,
  buildDepthPlan,
  startSession,
  resolveUsageTesting,
  resolveMode,
  resolveHeadless,
  EXECUTION_MODES,
  explainScale,
} from "./session.mjs";

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function tmpBgsd() {
  return mkdtempSync(join(tmpdir(), "bgsd-sesh-"));
}

console.log("\nbgsd session (U1/U2/U3) tests\n");

// ---------------------------------------------------------------------------
// U1 — classifyScale rules/thresholds
// ---------------------------------------------------------------------------

await test("U1: constants — SCALES + SESSION_MODES", () => {
  assert.deepEqual(SCALES, ["quick", "feature", "project"]);
  assert.deepEqual(SESSION_MODES, ["auto", "quick", "feature", "project"]);
});

await test("U1: natural-language mode requests are explicit but narrow", () => {
  assert.equal(naturalLanguageMode("Treat this as a project; it needs migration, API, UI, and launch work."), "project");
  assert.equal(naturalLanguageMode("Run it as a feature."), "feature");
  assert.equal(naturalLanguageMode("Use quick mode for this copy correction."), "quick");
  assert.equal(naturalLanguageMode("This is a quick fix."), null);
  assert.equal(naturalLanguageMode("Make this quick, not project mode."), null);
});

await test("U1: selection precedence is flag, natural language, then Conductor sizing", async () => {
  const natural = await classifyScale({ prompt: "Treat this as a project, even though it is only a typo." });
  assert.equal(natural.scale, "project");
  assert.equal(natural.selectionSource, "natural-language");
  const flag = await classifyScale({ prompt: "Treat this as a project.", mode: "quick" });
  assert.equal(flag.scale, "quick");
  assert.equal(flag.selectionSource, "flag");
  const automatic = await classifyScale({ prompt: "Fix the typo in the README." });
  assert.equal(automatic.selectionSource, "conductor-auto");
});

// ---------------------------------------------------------------------------
// resolveUsageTesting — verification depth (--no-usage-verification + config knob)
// ---------------------------------------------------------------------------

await test("UV: default (no flag, no config) → usage testing ON", () => {
  assert.equal(resolveUsageTesting({}), true);
  assert.equal(resolveUsageTesting({ config: null, noUsageVerification: false }), true);
});

await test("UV: --no-usage-verification flag forces code-only", () => {
  assert.equal(resolveUsageTesting({ noUsageVerification: true }), false);
  // flag wins even when config enables usage testing
  assert.equal(
    resolveUsageTesting({ config: { verification: { usage_testing: true } }, noUsageVerification: true }),
    false
  );
});

await test("UV: BGSD.md verification.usage_testing=false disables it (no flag)", () => {
  assert.equal(
    resolveUsageTesting({ config: { verification: { usage_testing: false } } }),
    false
  );
});

await test("UV: config usage_testing=true keeps it on", () => {
  assert.equal(
    resolveUsageTesting({ config: { verification: { usage_testing: true } } }),
    true
  );
});

await test("MODE: default is adaptive; flag beats config beats default", () => {
  assert.deepEqual([...EXECUTION_MODES], ["fast", "thorough", "adaptive"]);
  assert.equal(resolveMode({}), "adaptive");
  assert.equal(resolveMode({ configMode: "thorough" }), "thorough");
  // flag wins over config, always
  assert.equal(resolveMode({ flagMode: "fast", configMode: "thorough" }), "fast");
  // unknown values are ignored (fall through)
  assert.equal(resolveMode({ flagMode: "bogus", configMode: "fast" }), "fast");
  assert.equal(resolveMode({ configMode: "nope" }), "adaptive");
});

await test("HEADLESS: flag forces on; else config decides (default headed)", () => {
  assert.equal(resolveHeadless({}), false);
  assert.equal(resolveHeadless({ headlessFlag: true }), true);
  assert.equal(resolveHeadless({ config: { verification: { headless: true } } }), true);
  // flag wins even if config says headed
  assert.equal(
    resolveHeadless({ config: { verification: { headless: false } }, headlessFlag: true }),
    true
  );
});

await test("U1: trivial single-surface fix → quick", async () => {
  const r = await classifyScale({ prompt: "Fix the typo in the README" });
  assert.equal(r.scale, "quick");
  assert.equal(r.action, "route");
});

await test("U1: scoped single-surface fix → quick", async () => {
  const r = await classifyScale({ prompt: "Fix the 404 error on the pricing page" });
  assert.equal(r.scale, "quick");
});

await test("U1: many clauses → project (≥4 units)", async () => {
  const r = await classifyScale({
    prompt: "Add login, add signup, add a settings page, and add a billing dashboard",
  });
  assert.equal(r.scale, "project");
  assert.ok(r.unitCountEstimate >= 4, `unitCountEstimate=${r.unitCountEstimate}`);
});

await test("U1: many surfaces → project (≥3 surfaces)", async () => {
  const r = await classifyScale({
    prompt: "Build an api endpoint backed by a database schema and wire it to the ui",
  });
  assert.equal(r.scale, "project");
  assert.ok(r.depthBreadth >= 3, `depthBreadth=${r.depthBreadth}`);
});

await test("U1: classifiable middle → feature", async () => {
  const r = await classifyScale({ prompt: "Add a search component to the ui" });
  assert.equal(r.scale, "feature");
});

await test("U1: needs-clarification → clarify, scale=null, NEVER guessed", async () => {
  const r = await classifyScale({ prompt: "fix" });
  assert.equal(r.scale, null);
  assert.equal(r.action, "clarify");
  assert.ok(r.clarification_question && r.clarification_question.length > 0);
});

await test("U1: --quick forces quick unconditionally", async () => {
  const r = await classifyScale({
    prompt: "Add login, signup, settings, billing, deploy, api, db, ui",
    mode: "quick",
  });
  assert.equal(r.scale, "quick");
  assert.equal(r.confidence, "forced");
});

await test("U1: --project forces project unconditionally", async () => {
  const r = await classifyScale({ prompt: "Fix the typo", mode: "project" });
  assert.equal(r.scale, "project");
  assert.equal(r.confidence, "forced");
});

await test("U1: --feature forces feature unconditionally (even on a tiny 1-unit prompt)", async () => {
  // A tiny prompt would auto-classify as quick — --feature must override it.
  const r = await classifyScale({ prompt: "Fix the typo", mode: "feature" });
  assert.equal(r.scale, "feature");
  assert.equal(r.confidence, "forced");
  assert.equal(r.action, "route");
});

await test("U2: startSession --feature forces feature depth plan on a tiny prompt", async () => {
  const res = await startSession({
    prompt: "Fix the typo in the footer",   // would be quick in auto mode
    mode: "feature",
    bgsdDir: tmpBgsd(),
    decomposeFn: async () => ([{ id: "f1" }]),
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
  });
  assert.equal(res.scale, "feature", "--feature must force feature scale regardless of prompt size");
  assert.equal(res.plan.discuss, false, "feature must not discuss");
  assert.equal(res.plan.verified, true, "verification is never skipped");
  const ids = res.plan.stages.map((s) => s.id);
  assert.ok(ids.includes("decompose"), "feature plan must include decompose");
  assert.ok(ids.includes("verify_fix"), "feature plan must include verify_fix");
  assert.equal(res.outcome, "done");
});

await test("U1: Haiku seam nudges at most one step and never overrides a flag", async () => {
  // Heuristic says feature; seam proposes project (one step up) — allowed.
  const up = await classifyScale(
    { prompt: "Add a search component to the ui" },
    { refine: true, refineFn: async () => ({ scale: "project" }) }
  );
  assert.equal(up.scale, "project");
  assert.equal(up.confidence, "model");

  // Seam proposes a 2-step jump (quick) from a project heuristic — clamped to 1 step.
  const clamped = await classifyScale(
    { prompt: "Build api, db, ui, and auth all together" }, // project heuristic
    { refine: true, refineFn: async () => ({ scale: "quick" }) }
  );
  assert.notEqual(clamped.scale, "quick", "must not jump two steps to quick");

  // Forced flag never reaches the seam.
  const forced = await classifyScale(
    { prompt: "Fix typo", mode: "quick" },
    { refine: true, refineFn: async () => ({ scale: "project" }) }
  );
  assert.equal(forced.scale, "quick");
});

// ---------------------------------------------------------------------------
// U1 — buildDepthPlan table (quick STILL verifies)
// ---------------------------------------------------------------------------

await test("U1: buildDepthPlan(quick) stays Conductor-direct and verifies", () => {
  const plan = buildDepthPlan("quick");
  assert.equal(plan.discuss, false);
  assert.equal(plan.verified, true);
  const ids = plan.stages.map((s) => s.id);
  assert.deepEqual(ids, ["conductor_plan", "conductor_execute", "verify_fix"]);
  assert.ok(ids.includes("verify_fix"), "quick MUST include verify_fix");
  const vf = plan.stages.find((s) => s.id === "verify_fix");
  assert.equal(vf.entry, "runConductorVerifyFix");
  assert.equal(ids.includes("schedule"), false, "quick must not schedule a GSD worker");
});

await test("U1: buildDepthPlan(feature) — engines + verification, no discuss", () => {
  const plan = buildDepthPlan("feature");
  assert.equal(plan.discuss, false);
  assert.equal(plan.verified, true);
  const ids = plan.stages.map((s) => s.id);
  for (const need of ["decompose", "schedule", "verify_fix", "merge", "integrate", "review"]) {
    assert.ok(ids.includes(need), `feature plan missing "${need}"`);
  }
});

await test("U1: buildDepthPlan(project) — discuss FIRST + full pipeline + verification", () => {
  const plan = buildDepthPlan("project");
  assert.equal(plan.discuss, true);
  assert.equal(plan.verified, true);
  const ids = plan.stages.map((s) => s.id);
  // Discuss stages come before decompose.
  assert.ok(ids.indexOf("intake") < ids.indexOf("decompose"), "intake must precede decompose");
  assert.ok(ids.indexOf("brainstorm") < ids.indexOf("decompose"));
  assert.ok(ids.indexOf("oracle") < ids.indexOf("decompose"));
  for (const need of ["decompose", "verify_fix", "integrate", "review", "changelog"]) {
    assert.ok(ids.includes(need), `project plan missing "${need}"`);
  }
});

await test("U1: EVERY scale's plan has verified=true (verification never skipped)", () => {
  for (const scale of SCALES) {
    assert.equal(buildDepthPlan(scale).verified, true, `${scale} must be verified`);
  }
});

// ---------------------------------------------------------------------------
// U2 — startSession quick path: only reaches done on a Tester PASS
// ---------------------------------------------------------------------------

await test("U2: quick path runs Loop 1 and reaches done ONLY on Tester PASS", async () => {
  const calls = [];
  const res = await startSession({
    prompt: "Fix the typo in the footer",
    bgsdDir: tmpBgsd(),
    quickPlanFn: async () => { calls.push("plan"); return { steps: ["edit footer"] }; },
    quickExecuteFn: async () => { calls.push("execute"); },
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
  });
  assert.equal(res.scale, "quick");
  assert.equal(res.outcome, "done");
  assert.equal(res.verified, true);
  assert.equal(res.itemState, "done");
  assert.equal(res.execution, "conductor-direct");
  assert.deepEqual(calls, ["plan", "execute"]);
});

await test("U2: quick path with FAIL→fix→PASS still ends done (verified)", async () => {
  let calls = 0;
  const res = await startSession({
    prompt: "Fix the broken nav link",
    bgsdDir: tmpBgsd(),
    verifyFn: async () => {
      calls++;
      // First verify FAILs (distinct defect), then PASS after a fix.
      return calls === 1
        ? { verdict: "FAIL", defects: [{ id: "d1" }] }
        : { verdict: "PASS", defects: [] };
    },
    fixFn: async () => {},
  });
  assert.equal(res.outcome, "done");
  assert.ok(calls >= 2, "must re-verify after a fix");
});

await test("U2: quick path NEVER reports done on a non-PASS verdict", async () => {
  const res = await startSession({
    prompt: "Fix the crash on startup",
    bgsdDir: tmpBgsd(),
    verifyFn: async () => ({ verdict: "BLOCKED", defects: [] }),
  });
  assert.notEqual(res.outcome, "done");
  assert.equal(res.outcome, "blocked");
});

// ---------------------------------------------------------------------------
// U2 — project path runs discussion BEFORE the build pipeline
// ---------------------------------------------------------------------------

await test("U2: project path runs discuss (intake/brainstorm/oracle) BEFORE build", async () => {
  const order = [];
  const res = await startSession({
    prompt: "Build a billing dashboard with Stripe and a settings page",
    mode: "project",
    bgsdDir: tmpBgsd(),
    discussFn: async () => { order.push("discuss"); return { sources: { decisions: [], spec: [], profile: [] } }; },
    decomposeFn: async () => { order.push("decompose"); return [{ id: "u1" }, { id: "u2" }]; },
    verifyFn: async () => { order.push("verify"); return { verdict: "PASS", defects: [] }; },
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
  });
  assert.equal(res.scale, "project");
  assert.equal(res.discussed, true);
  assert.ok(order.indexOf("discuss") < order.indexOf("decompose"), "discuss must precede decompose");
  assert.ok(order.indexOf("decompose") < order.indexOf("verify"), "decompose must precede verify");
  assert.equal(res.outcome, "done");
});

await test("U2: --plan-only returns the plan and invokes ZERO boundaries", async () => {
  let touched = false;
  const res = await startSession({
    prompt: "Build a billing dashboard with Stripe",
    mode: "project",
    planOnly: true,
    bgsdDir: tmpBgsd(),
    discussFn: async () => { touched = true; return {}; },
    decomposeFn: async () => { touched = true; return []; },
    verifyFn: async () => { touched = true; return { verdict: "PASS", defects: [] }; },
  });
  assert.equal(res.action, "plan");
  assert.equal(res.plan.verified, true);
  assert.equal(touched, false, "plan-only must not invoke any boundary");
});

// ---------------------------------------------------------------------------
// DEFAULT = RUN (the flip): no planOnly flag → startSession executes
// ---------------------------------------------------------------------------

await test("DEFAULT: startSession with no planOnly runs the orchestration (reaches done/checkpoint)", async () => {
  // No planOnly flag — the new default is RUN, not plan-only.
  let verifyInvoked = false;
  const res = await startSession({
    prompt: "Fix the typo in the footer",
    // planOnly: not set (defaults to false per startSession signature)
    bgsdDir: tmpBgsd(),
    verifyFn: async () => { verifyInvoked = true; return { verdict: "PASS", defects: [] }; },
  });
  assert.equal(res.action, "run", "default (no planOnly) must produce action=run, not plan");
  assert.equal(verifyInvoked, true, "default run must invoke boundaries (verifyFn called)");
  assert.equal(res.outcome, "done");
});

await test("DEFAULT: planOnly=false explicitly also runs the orchestration", async () => {
  let verifyInvoked = false;
  const res = await startSession({
    prompt: "Fix the broken nav link",
    planOnly: false,
    bgsdDir: tmpBgsd(),
    verifyFn: async () => { verifyInvoked = true; return { verdict: "PASS", defects: [] }; },
  });
  assert.equal(res.action, "run");
  assert.equal(verifyInvoked, true, "planOnly=false must execute boundaries");
  assert.equal(res.outcome, "done");
});

await test("DEFAULT: planOnly=true (dry-run alias semantics) still returns plan, no boundaries", async () => {
  // --dry-run is an alias for --plan-only at the CLI layer; in the API, planOnly:true covers both.
  let touched = false;
  const res = await startSession({
    prompt: "Fix the broken nav link",
    planOnly: true,
    bgsdDir: tmpBgsd(),
    verifyFn: async () => { touched = true; return { verdict: "PASS", defects: [] }; },
    decomposeFn: async () => { touched = true; return []; },
  });
  assert.equal(res.action, "plan");
  assert.equal(touched, false, "planOnly=true (--plan-only or --dry-run) must not invoke any boundary");
});

await test("SAFETY: irreversible merge/PR boundaries are still gated (not silently passed)", async () => {
  // The merge and PR fns are NOT injected here; runDecomposed only calls them when injected.
  // This verifies that a default run without a mergeFn/prFn does not silently skip or crash —
  // it reaches done on the units that passed Loop 1 and records prResult=null (no silent merge).
  const res = await startSession({
    prompt: "Add a search component and filter panel to the ui",
    mode: "auto",
    bgsdDir: tmpBgsd(),
    decomposeFn: async () => ([{ id: "s1" }, { id: "s2" }]),
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    // prFn intentionally omitted — real PR is --live-gated; no silent PR
  });
  assert.equal(res.outcome, "done", "units reach done without a prFn");
  assert.equal(res.prResult, null, "prResult must be null when prFn is not injected (no silent PR)");
});

await test("U2: needs-clarification short-circuits startSession (no guess)", async () => {
  const res = await startSession({ prompt: "fix", bgsdDir: tmpBgsd() });
  assert.equal(res.action, "clarify");
  assert.equal(res.scale, null);
});

// ---------------------------------------------------------------------------
// U3 — THE NON-BLOCKING PROOF: one unit needs_input while others advance
// ---------------------------------------------------------------------------

await test("U3: one unit parked needs_input — OTHER units still advance same session", async () => {
  const renderedFrames = [];
  // Three units: u-block raises a question the oracle CANNOT answer (parks it);
  // u-a and u-b have no question and must reach done.
  const res = await startSession({
    prompt: "Build api, db, and ui",
    mode: "project",
    bgsdDir: tmpBgsd(),
    discussFn: async () => ({ sources: { decisions: [], spec: [], profile: [] } }),
    decomposeFn: async () => ([
      { id: "u-a" },
      { id: "u-block", needsInput: true, question: "Which auth provider?" },
      { id: "u-b" },
    ]),
    // Oracle ABSTAINS on the gray-area question → u-block parks; others proceed.
    oracleFn: () => ({ action: "escalate", confidence: 0.1 }),
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
    escalateFn: async (batch) => ({ batched: batch.length }),
    renderStatusFn: (view) => { renderedFrames.push(view); return "frame"; },
  });

  const byId = Object.fromEntries(res.units.map((u) => [u.id, u.status]));
  // PROOF: the blocking unit is parked needs_input...
  assert.equal(byId["u-block"], "needs_input", "u-block must park needs_input");
  // ...while EVERY OTHER unit advanced to done in the SAME session.
  assert.equal(byId["u-a"], "done", "u-a must advance while u-block waits");
  assert.equal(byId["u-b"], "done", "u-b must advance while u-block waits");
  // The escalation was batched to the user (non-blocking, never a silent guess).
  assert.ok(res.escalations.length >= 1, "the parked question must be escalated");
  assert.deepEqual(res.escalationResult, { batched: res.escalations.length });
  // Live tracking ran (the always-on view was rendered across ticks).
  assert.ok(renderedFrames.length >= 1, "the live view must render during the session");
  // Session reports needs_input overall because a unit is still awaiting input.
  assert.equal(res.outcome, "needs_input");
});

await test("U3: oracle AUTO-ANSWER clears a question — no escalation, all units done", async () => {
  const res = await startSession({
    prompt: "Build api, db, and ui",
    mode: "project",
    bgsdDir: tmpBgsd(),
    discussFn: async () => ({ sources: { decisions: [], spec: [], profile: [] } }),
    decomposeFn: async () => ([
      { id: "u-a" },
      { id: "u-ask", needsInput: true, question: "Default page size?" },
    ]),
    oracleFn: () => ({ action: "auto_answer", answer: "25", confidence: 0.9 }),
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
  });
  const byId = Object.fromEntries(res.units.map((u) => [u.id, u.status]));
  assert.equal(byId["u-ask"], "done", "oracle auto-answer should unblock the unit");
  assert.equal(byId["u-a"], "done");
  assert.equal(res.escalations.length, 0, "auto-answered → no escalation");
  assert.equal(res.outcome, "done");
});

await test("U3: interjected inbox message is INGESTED without halting + can answer a parked unit", async () => {
  let delivered = false;
  // The inbox delivers an answer for u-block on the SECOND read; before that it
  // is parked. The interjection unblocks ONLY that unit; nothing else halts.
  const inboxReaderFn = () => {
    if (!delivered) { delivered = true; return []; }
    return [{ answersUnit: "u-block", text: "use Clerk" }];
  };
  const res = await startSession({
    prompt: "Build api and db",
    mode: "project",
    bgsdDir: tmpBgsd(),
    discussFn: async () => ({ sources: { decisions: [], spec: [], profile: [] } }),
    decomposeFn: async () => ([
      { id: "u-a" },
      { id: "u-block", needsInput: true, question: "Which auth provider?" },
    ]),
    oracleFn: () => ({ action: "escalate", confidence: 0.1 }),
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
    escalateFn: async (b) => ({ batched: b.length }),
    inboxReaderFn,
  });
  // The interjected message was ingested (recorded) without halting the loop.
  assert.ok(res.ingestedMessages.some((m) => m.answersUnit === "u-block"), "inbox message must be ingested");
  // And it unblocked u-block, which then reached done; u-a was never blocked.
  const byId = Object.fromEntries(res.units.map((u) => [u.id, u.status]));
  assert.equal(byId["u-a"], "done");
  assert.equal(byId["u-block"], "done", "interjected answer should unblock + complete the unit");
  assert.equal(res.outcome, "done");
});

// ---------------------------------------------------------------------------
// U2 — feature path reuses project engines at small N
// ---------------------------------------------------------------------------

await test("U2: feature path skips discuss, runs Loop 2 only if >1 unit merged", async () => {
  let discussCalled = false;
  const res = await startSession({
    prompt: "Add a search component and a filter panel to the ui",
    mode: "auto",
    bgsdDir: tmpBgsd(),
    discussFn: async () => { discussCalled = true; return {}; },
    decomposeFn: async () => ([{ id: "f1" }, { id: "f2" }]),
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
  });
  assert.equal(res.scale, "feature");
  assert.equal(discussCalled, false, "feature must NOT discuss");
  assert.equal(res.ranLoop2, true, "2 units merged → Loop 2 runs");
  assert.equal(res.outcome, "done");
});

// ---------------------------------------------------------------------------
// Preflight wiring (sesh start: ensure init + sync integration branch)
// ---------------------------------------------------------------------------

await test("PF: startSession runs preflightFn once on a real run and records it", async () => {
  let called = 0;
  const res = await startSession({
    prompt: "Fix the typo in the footer",
    mode: "feature",
    bgsdDir: tmpBgsd(),
    preflightFn: async () => {
      called++;
      return {
        integrationBranch: "next",
        baseBranch: "main",
        performed: ["create_integration_branch:next"],
        notes: [],
      };
    },
    decomposeFn: async () => [{ id: "f1" }],
    verifyFn: async () => ({ verdict: "PASS", defects: [] }),
    reviewFn: async () => "approve",
    prFn: async () => ({ pr: "mock" }),
  });
  assert.equal(called, 1, "preflight runs exactly once on a real run");
  assert.equal(res.session.preflight.integration_branch, "next");
  assert.equal(res.session.preflight.base_branch, "main");
  assert.deepEqual(res.session.preflight.performed, ["create_integration_branch:next"]);
});

await test("PF: startSession does NOT run preflightFn in plan-only", async () => {
  let called = 0;
  const res = await startSession({
    prompt: "Fix the typo in the footer",
    mode: "feature",
    planOnly: true,
    bgsdDir: tmpBgsd(),
    preflightFn: async () => {
      called++;
      return {};
    },
  });
  assert.equal(called, 0, "plan-only invokes zero boundaries, including preflight");
  assert.equal(res.planOnly, true);
});

await test("EXPLAIN: classifyScale exposes the fired rule", async () => {
  const quick = await classifyScale({ prompt: "fix the typo on the pricing page" });
  assert.equal(typeof quick.rule, "number");
  const forced = await classifyScale({ prompt: "anything", mode: "project" });
  assert.equal(forced.rule, "forced");
});

await test("EXPLAIN: explainScale narrates scale, signals, and rule", async () => {
  const r = await classifyScale({ prompt: "build a billing dashboard with stripe and an admin ui" });
  const line = explainScale(r);
  assert.ok(line.includes(`auto-scaled to ${r.scale}`), line);
  assert.ok(line.includes(`rule ${r.rule}`), line);
  assert.ok(line.includes("surface"), line);
  const forced = explainScale(await classifyScale({ prompt: "x y z", mode: "quick" }));
  assert.ok(forced.includes("forced to quick"), forced);
  assert.throws(() => explainScale(null));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed;
console.log(`\n${total} test(s): ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nFailed tests:");
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  process.exit(1);
} else {
  console.log("\nAll tests PASSED.");
  process.exit(0);
}
