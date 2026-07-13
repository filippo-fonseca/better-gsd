#!/usr/bin/env node
// Tests for compact-continue.mjs — the SessionStart(compact) hook.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findInFlightRun, directive } from "./compact-continue.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "compact-continue.mjs");
let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}
function makeRepo() {
  return mkdtempSync(join(tmpdir(), "bgsd-cc-"));
}
function runHook(cwd, source = "compact") {
  return execFileSync("node", [SCRIPT], { input: JSON.stringify({ source, cwd }), encoding: "utf8" });
}

// C01: no .bgsd at all → silent
{
  const repo = makeRepo();
  ok(runHook(repo) === "", "C01 no .bgsd → silent");
  rmSync(repo, { recursive: true, force: true });
}

// C02: unconsumed compact-handoff.json → directive names the run + handoff
{
  const repo = makeRepo();
  const runDir = join(repo, ".bgsd", "runs", "run-abc");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "compact-handoff.json"), "{}");
  const out = runHook(repo);
  ok(out.includes("run-abc") && out.includes("compact-handoff.json"), "C02 handoff → directive with run id + handoff path");
  ok(out.includes("/bgsd-resume"), "C02 directive orders /bgsd-resume");
  rmSync(repo, { recursive: true, force: true });
}

// C03: in-flight control file (status running), no handoff → directive
{
  const repo = makeRepo();
  const controlDir = join(repo, ".bgsd", "runs", "run-live", "control");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(controlDir, "u1.json"), JSON.stringify({ agent_id: "u1", status: "running" }));
  const out = runHook(repo);
  ok(out.includes("run-live"), "C03 non-terminal control → directive");
  rmSync(repo, { recursive: true, force: true });
}

// C04: all agents terminal → silent
{
  const repo = makeRepo();
  const controlDir = join(repo, ".bgsd", "runs", "run-done", "control");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(controlDir, "u1.json"), JSON.stringify({ agent_id: "u1", status: "done" }));
  writeFileSync(join(controlDir, "u2.json"), JSON.stringify({ agent_id: "u2", status: "failed" }));
  ok(runHook(repo) === "", "C04 terminal run → silent");
  rmSync(repo, { recursive: true, force: true });
}

// C05: paused run → silent (a pause is deliberate; never auto-continue)
{
  const repo = makeRepo();
  const runDir = join(repo, ".bgsd", "runs", "run-paused");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ state: "paused" }));
  ok(runHook(repo) === "", "C05 paused run → silent");
  rmSync(repo, { recursive: true, force: true });
}

// C06: non-compact source → silent even with an in-flight run
{
  const repo = makeRepo();
  const runDir = join(repo, ".bgsd", "runs", "run-abc");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "compact-handoff.json"), "{}");
  ok(runHook(repo, "startup") === "", "C06 source=startup → silent");
  rmSync(repo, { recursive: true, force: true });
}

// C08: run.json terminal (done) but a stale non-terminal control file → silent.
//      run.json state is authoritative; a leftover control file can't resurrect it.
{
  const repo = makeRepo();
  const runDir = join(repo, ".bgsd", "runs", "run-terminal");
  const controlDir = join(runDir, "control");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ state: "done" }));
  writeFileSync(join(controlDir, "u1.json"), JSON.stringify({ agent_id: "u1", status: "running" }));
  ok(runHook(repo) === "", "C08 done run.json + stale running control → silent");
  rmSync(repo, { recursive: true, force: true });
}

// C09: run.json failed but a leftover handoff → silent (stale handoff not resurrected).
{
  const repo = makeRepo();
  const runDir = join(repo, ".bgsd", "runs", "run-failed");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ state: "failed" }));
  writeFileSync(join(runDir, "compact-handoff.json"), "{}");
  ok(runHook(repo) === "", "C09 failed run.json + stale handoff → silent");
  rmSync(repo, { recursive: true, force: true });
}

// C07: pure helpers
ok(findInFlightRun("/nonexistent-path-xyz") === null, "C07 findInFlightRun missing dir → null");
ok(directive({ runId: "r1", hasHandoff: false }).includes("control files"), "C07 directive without handoff cites control files");

console.log(`\ncompact-continue: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
