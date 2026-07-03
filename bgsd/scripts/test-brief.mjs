#!/usr/bin/env node
/**
 * test-brief.mjs — Unit tests for brief.mjs (/bgsd-generate-brief core).
 *
 * No external framework. node:assert + a local runner. Exits non-zero on any
 * failure (no silent green).
 *
 * B01 — buildBrief: non-empty brief with runId, prompt, and the paste line
 * B02 — buildBrief: omits sections with no data (no empty headers)
 * B03 — buildBrief: renders per-unit sections (title, summary, planning docs)
 * B04 — buildBrief: throws without a runId
 * B05 — gatherSeshRecord: assembles a record from seshs + ledger + runJson
 * B06 — gatherSeshRecord: run.json overrides ledger; missing data is tolerated
 * B07 — parseLedger: parses the table, skipping header + separator
 * B08 — latestRunId: newest ledger row wins; falls back to seshs
 * B09 — buildBriefLive: end-to-end against a temp .bgsd (live seam)
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildBrief,
  gatherSeshRecord,
  parseLedger,
  latestRunId,
  buildBriefLive,
} from "./brief.mjs";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

process.stdout.write("\nbgsd brief unit tests\n\n");

test("B01 — buildBrief: non-empty brief with runId, prompt, and paste line", () => {
  const md = buildBrief({
    runId: "bgsd-0007-auth",
    title: "Auth refactor",
    prompt: "rewire the JWT middleware",
    scale: "project",
    at: "2026-06-30",
    outcome: "merged",
  });
  assert.ok(md.length > 0, "brief must be non-empty");
  assert.ok(md.includes("bgsd-0007-auth"), "brief must include the run id");
  assert.ok(md.includes("rewire the JWT middleware"), "brief must include the prompt");
  assert.ok(md.includes("What was requested"));
  assert.ok(
    /\/bgsd-sesh "based on the brief at \.bgsd\/briefs\/bgsd-0007-auth-brief\.md/.test(md),
    "brief must end with the ready-to-paste continue line"
  );
  assert.ok(md.includes("How to continue"));
});

test("B02 — buildBrief: omits sections with no data", () => {
  const md = buildBrief({ runId: "bgsd-0001-x" });
  assert.ok(!md.includes("What was requested"), "no prompt -> no request section");
  assert.ok(!md.includes("What was done"), "no units -> no done section");
  assert.ok(!md.includes("## Agents"), "no agentsMd -> no agents section");
  assert.ok(!md.includes("## Run notes"), "no runMd -> no run-notes section");
  assert.ok(!md.includes("What changed"), "no branches/pr -> no changed section");
  assert.ok(!md.includes("Outstanding"), "no outstanding -> no outstanding section");
  // How to continue is ALWAYS present.
  assert.ok(md.includes("How to continue"));
});

test("B03 — buildBrief: renders per-unit sections", () => {
  const md = buildBrief({
    runId: "bgsd-0009-multi",
    units: [
      {
        id: "auth-core",
        title: "Auth core",
        summary: "Added refresh-token rotation.",
        planningDocs: [{ name: "PLAN.md", text: "Plan body for auth." }],
      },
      { id: "search-bar", summary: "Wired the search input." },
    ],
  });
  assert.ok(md.includes("## What was done"));
  assert.ok(md.includes("Auth core"));
  assert.ok(md.includes("(auth-core)"));
  assert.ok(md.includes("Added refresh-token rotation."));
  assert.ok(md.includes("PLAN.md"));
  assert.ok(md.includes("Plan body for auth."));
  assert.ok(md.includes("(search-bar)"));
});

test("B04 — buildBrief: throws without a runId", () => {
  assert.throws(() => buildBrief({}), /runId is required/);
  assert.throws(() => buildBrief({ runId: "" }), /runId is required/);
});

test("B05 — gatherSeshRecord: assembles record from seshs + ledger + runJson", () => {
  const seshs = [
    {
      runId: "bgsd-0012-auth",
      docs: [
        { path: "seshs/bgsd-0012-auth/RUN.md", unitId: null, text: "Run-level notes." },
        { path: "seshs/bgsd-0012-auth/AGENTS.md", unitId: null, text: "Agent log." },
        {
          path: "seshs/bgsd-0012-auth/auth-core/planning/PLAN.md",
          unitId: "auth-core",
          text: "The auth plan.",
        },
        {
          path: "seshs/bgsd-0012-auth/auth-core/planning/SPEC.md",
          unitId: "auth-core",
          text: "The auth spec.",
        },
      ],
    },
  ];
  const ledgerRows = [
    { runId: "bgsd-0012-auth", prompt: "do auth", scale: "project", outcome: "merged", at: "2026-06-30" },
  ];
  const rec = gatherSeshRecord({ runId: "bgsd-0012-auth", seshs, ledgerRows, runJson: null });
  assert.equal(rec.runId, "bgsd-0012-auth");
  assert.equal(rec.prompt, "do auth");
  assert.equal(rec.scale, "project");
  assert.equal(rec.outcome, "merged");
  assert.equal(rec.at, "2026-06-30");
  assert.equal(rec.runMd, "Run-level notes.");
  assert.equal(rec.agentsMd, "Agent log.");
  assert.equal(rec.units.length, 1);
  assert.equal(rec.units[0].id, "auth-core");
  assert.equal(rec.units[0].planningDocs.length, 2);
  assert.deepEqual(
    rec.units[0].planningDocs.map((d) => d.name).sort(),
    ["PLAN.md", "SPEC.md"]
  );
  // The whole record round-trips through buildBrief cleanly.
  const md = buildBrief(rec);
  assert.ok(md.includes("auth-core"));
  assert.ok(md.includes("Run notes"));
  assert.ok(md.includes("Agents"));
});

test("B06 — gatherSeshRecord: run.json overrides ledger; missing data tolerated", () => {
  const seshs = [{ runId: "bgsd-0013-x", docs: [] }];
  const ledgerRows = [{ runId: "bgsd-0013-x", prompt: "ledger prompt", scale: "quick", outcome: "", at: "" }];
  const runJson = {
    title: "Fancy title",
    prompt: "runjson prompt",
    branches_merged: ["feat/x"],
    pr: "https://example.com/pr/1",
    outstanding: ["deferred thing"],
    next_steps: ["do the next thing"],
  };
  const rec = gatherSeshRecord({ runId: "bgsd-0013-x", seshs, ledgerRows, runJson });
  assert.equal(rec.title, "Fancy title");
  assert.equal(rec.prompt, "runjson prompt", "run.json prompt wins over ledger");
  assert.deepEqual(rec.branchesMerged, ["feat/x"]);
  assert.equal(rec.pr, "https://example.com/pr/1");
  assert.deepEqual(rec.outstanding, ["deferred thing"]);
  assert.deepEqual(rec.nextSteps, ["do the next thing"]);

  // Absent run id in the corpus is tolerated (empty units, defaults).
  const rec2 = gatherSeshRecord({ runId: "ghost", seshs: [], ledgerRows: [], runJson: null });
  assert.equal(rec2.runId, "ghost");
  assert.deepEqual(rec2.units, []);
  assert.throws(() => gatherSeshRecord({}), /runId is required/);
});

test("B07 — parseLedger: parses the table, skipping header + separator", () => {
  const text = `# bgsd sesh ledger

| run_id | prompt | scale | outcome | at |
|--------|--------|-------|---------|----|
| bgsd-0001-a | build a | quick | merged | 2026-01-01 |
| bgsd-0002-b | build b | project | shipped | 2026-02-02 |
`;
  const rows = parseLedger(text);
  assert.equal(rows.length, 2, "two data rows (header + separator skipped)");
  assert.equal(rows[0].runId, "bgsd-0001-a");
  assert.equal(rows[0].prompt, "build a");
  assert.equal(rows[1].scale, "project");
  assert.equal(rows[1].at, "2026-02-02");
  assert.deepEqual(parseLedger(""), []);
});

test("B08 — latestRunId: newest ledger row wins; falls back to seshs", () => {
  const rows = [
    { runId: "bgsd-0001-a", prompt: "", scale: "", outcome: "", at: "" },
    { runId: "bgsd-0002-b", prompt: "", scale: "", outcome: "", at: "" },
  ];
  assert.equal(latestRunId([], rows), "bgsd-0002-b", "last ledger row is newest");
  const seshs = [{ runId: "bgsd-0005-e", docs: [] }, { runId: "bgsd-0003-c", docs: [] }];
  assert.equal(latestRunId(seshs, []), "bgsd-0005-e", "fall back to greatest sesh id");
  assert.equal(latestRunId([], []), null);
});

test("B09 — buildBriefLive: end-to-end against a temp .bgsd (live seam)", () => {
  const root = mkdtempSync(join(tmpdir(), "bgsd-brief-"));
  const bgsdDir = join(root, ".bgsd");
  const runId = "bgsd-0042-live";
  const planDir = join(bgsdDir, "seshs", runId, "core", "planning");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(bgsdDir, "seshs", runId, "RUN.md"), "Live run notes.", "utf8");
  writeFileSync(join(planDir, "PLAN.md"), "Live plan body.", "utf8");
  mkdirSync(join(bgsdDir, "runs", runId), { recursive: true });
  writeFileSync(
    join(bgsdDir, "runs", runId, "run.json"),
    JSON.stringify({ title: "Live sesh", prompt: "do the live thing", scale: "project" }),
    "utf8"
  );
  writeFileSync(
    join(bgsdDir, "ledger.md"),
    `| run_id | prompt | scale | outcome | at |\n|--|--|--|--|--|\n| ${runId} | do the live thing | project | merged | 2026-07-01 |\n`,
    "utf8"
  );

  // Latest-by-default.
  const { runId: picked, brief } = buildBriefLive({ bgsdDir });
  assert.equal(picked, runId);
  assert.ok(brief.includes("do the live thing"));
  assert.ok(brief.includes("Live run notes."));
  assert.ok(brief.includes("PLAN.md"));
  assert.ok(brief.includes("(core)"));

  // Explicit run id path too.
  const explicit = buildBriefLive({ bgsdDir, runId });
  assert.equal(explicit.runId, runId);

  // No sessions -> a clear error.
  const empty = mkdtempSync(join(tmpdir(), "bgsd-brief-empty-"));
  assert.throws(() => buildBriefLive({ bgsdDir: join(empty, ".bgsd") }), /No sessions found/);
});

process.stdout.write(`\nbrief.mjs: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("\nAll tests PASSED.\n");
