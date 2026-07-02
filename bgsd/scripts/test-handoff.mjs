#!/usr/bin/env node
/**
 * test-handoff.mjs — Integration tests for the compaction-handoff seam in
 * resume-live.mjs, against a real throwaway git repo (mirrors test-init-live.mjs).
 *
 * No external framework. node:assert + a temp `git init` repo. Exits non-zero
 * on any failure (no silent green).
 *
 *   H01 — writeCompactHandoff: valid payload lands; written_at auto-stamped
 *   H02 — writeCompactHandoff: invalid payload throws readable errors; nothing written
 *   H03 — writeCompactHandoff: unknown run id throws
 *   H04 — readCompactHandoff: absent -> null; corrupt JSON / invalid schema -> error
 *   H05 — consumeCompactHandoff: renames to .consumed.json; nothing left to consume -> null
 *   H06 — CLI lifecycle: handoff-write -> resume surfaces + consumes -> next resume clean
 *   H07 — CLI: --plan-only surfaces the handoff but leaves it in place
 *   H08 — CLI: handoff-write with invalid payload exits nonzero, errors on stderr
 *   H09 — CLI: handoff-write reads the payload from stdin when --json is absent
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  handoffPath,
  writeCompactHandoff,
  readCompactHandoff,
  consumeCompactHandoff,
} from "./resume-live.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const RESUME_LIVE = join(SCRIPTS_DIR, "resume-live.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  FAIL  ${name}\n`);
    process.stdout.write(`        ${err.message}\n`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function sh(cwd, args) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`cmd failed: ${args.join(" ")}\n${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bgsd-handoff-"));
  sh(dir, ["git", "init", "-q"]);
  sh(dir, ["git", "symbolic-ref", "HEAD", "refs/heads/main"]);
  sh(dir, ["git", "config", "user.email", "t@example.com"]);
  sh(dir, ["git", "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  sh(dir, ["git", "add", "."]);
  sh(dir, ["git", "commit", "-q", "-m", "init"]);
  return dir;
}

// A run with one in-flight control file, so the run is resumable and the
// resume CLI selects it.
function seedRun(repoRoot, runId) {
  const controlDir = join(repoRoot, ".bgsd", "runs", runId, "control");
  mkdirSync(controlDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(controlDir, "u1.json"),
    JSON.stringify(
      {
        agent_id: "u1",
        run_id: runId,
        worktree: "wt/u1",
        branch: "bgsd/u1",
        unit_id: "search-bar",
        phase: "execute",
        status: "running",
        heartbeat_at: now,
        started_at: now,
        updated_at: now,
      },
      null,
      2
    ),
    "utf8"
  );
}

function withRepo(fn) {
  const dir = makeRepo();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(cwd, args, input = null) {
  return spawnSync(process.execPath, [RESUME_LIVE, ...args], {
    cwd,
    encoding: "utf8",
    input: input ?? undefined,
  });
}

const validPayload = () => ({
  stage: "loop1",
  wave: 1,
  agent_states: [{ id: "u1", phase: "execute", status: "running" }],
  pending_gates: ["review-gate:u1"],
  next_step: "re-check u1's wave, then open the review gate",
  written_at: "2026-07-01T10:00:00.000Z",
});

process.stdout.write("\nbgsd compaction-handoff integration tests\n\n");

test("H01 — writeCompactHandoff: valid payload lands; written_at auto-stamped", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    const { path } = writeCompactHandoff(repo, "run-1", validPayload());
    assert.equal(path, handoffPath(repo, "run-1"));
    assert.ok(existsSync(path));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).stage, "loop1");

    const { written_at, ...noStamp } = validPayload();
    const r = writeCompactHandoff(repo, "run-1", noStamp, () => "2026-07-02T00:00:00.000Z");
    assert.equal(r.handoff.written_at, "2026-07-02T00:00:00.000Z");
  });
});

test("H02 — writeCompactHandoff: invalid payload throws readable errors; nothing written", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    assert.throws(
      () => writeCompactHandoff(repo, "run-1", { stage: "loop1" }),
      (err) =>
        /invalid compaction handoff/.test(err.message) &&
        /"wave"/.test(err.message) &&
        /"next_step"/.test(err.message)
    );
    assert.equal(existsSync(handoffPath(repo, "run-1")), false);
  });
});

test("H03 — writeCompactHandoff: unknown run id throws", () => {
  withRepo((repo) => {
    assert.throws(
      () => writeCompactHandoff(repo, "ghost-run", validPayload()),
      /no run "ghost-run"/
    );
  });
});

test("H04 — readCompactHandoff: absent -> null; corrupt / invalid -> error", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    assert.deepEqual(readCompactHandoff(repo, "run-1"), { handoff: null, error: null });

    writeFileSync(handoffPath(repo, "run-1"), "{ not json", "utf8");
    const corrupt = readCompactHandoff(repo, "run-1");
    assert.equal(corrupt.handoff, null);
    assert.ok(/not valid JSON/.test(corrupt.error));

    writeFileSync(handoffPath(repo, "run-1"), JSON.stringify({ stage: "x" }), "utf8");
    const invalid = readCompactHandoff(repo, "run-1");
    assert.equal(invalid.handoff, null);
    assert.ok(/invalid/.test(invalid.error) && /"wave"/.test(invalid.error));

    writeCompactHandoff(repo, "run-1", validPayload());
    const good = readCompactHandoff(repo, "run-1");
    assert.equal(good.error, null);
    assert.equal(good.handoff.wave, 1);
  });
});

test("H05 — consumeCompactHandoff: renames to .consumed.json; nothing -> null", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    writeCompactHandoff(repo, "run-1", validPayload());
    const consumed = consumeCompactHandoff(repo, "run-1");
    assert.equal(consumed, join(repo, ".bgsd", "runs", "run-1", "compact-handoff.consumed.json"));
    assert.ok(existsSync(consumed));
    assert.equal(existsSync(handoffPath(repo, "run-1")), false);
    assert.equal(consumeCompactHandoff(repo, "run-1"), null);
  });
});

test("H06 — CLI lifecycle: handoff-write -> resume surfaces + consumes -> next resume clean", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    const w = runCli(repo, [
      "handoff-write",
      "--run-id",
      "run-1",
      "--json",
      JSON.stringify(validPayload()),
    ]);
    assert.equal(w.status, 0, w.stderr);
    assert.ok(/Handoff recorded for run-1/.test(w.stdout));

    const r1 = runCli(repo, ["run-1"]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(/Compaction handoff on record/.test(r1.stdout));
    assert.ok(/Stage: loop1 · wave 1/.test(r1.stdout));
    assert.ok(/Pending gates: review-gate:u1/.test(r1.stdout));
    assert.ok(/Next step: re-check u1's wave/.test(r1.stdout));
    assert.ok(/Handoff consumed/.test(r1.stdout));
    assert.equal(existsSync(handoffPath(repo, "run-1")), false);
    assert.ok(
      existsSync(join(repo, ".bgsd", "runs", "run-1", "compact-handoff.consumed.json"))
    );

    const r2 = runCli(repo, ["run-1"]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!/Compaction handoff/.test(r2.stdout), "consumed handoff must not replay");
    assert.ok(/Resuming run run-1/.test(r2.stdout));
  });
});

test("H07 — CLI: --plan-only surfaces the handoff but leaves it in place", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    writeCompactHandoff(repo, "run-1", validPayload());
    const r = runCli(repo, ["run-1", "--plan-only"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/Compaction handoff on record/.test(r.stdout));
    assert.ok(/Handoff left in place/.test(r.stdout));
    assert.ok(existsSync(handoffPath(repo, "run-1")), "plan-only must not consume");
  });
});

test("H08 — CLI: invalid payload exits nonzero, errors on stderr", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    const r = runCli(repo, [
      "handoff-write",
      "--run-id",
      "run-1",
      "--json",
      JSON.stringify({ stage: "loop1", wave: "two" }),
    ]);
    assert.notEqual(r.status, 0);
    assert.ok(/invalid compaction handoff/.test(r.stderr));
    assert.ok(/"wave"/.test(r.stderr));
    assert.equal(existsSync(handoffPath(repo, "run-1")), false);

    const noRunId = runCli(repo, ["handoff-write", "--json", "{}"]);
    assert.notEqual(noRunId.status, 0);
    assert.ok(/--run-id/.test(noRunId.stderr));

    const badJson = runCli(repo, ["handoff-write", "--run-id", "run-1", "--json", "{oops"]);
    assert.notEqual(badJson.status, 0);
    assert.ok(/not valid JSON/.test(badJson.stderr));
  });
});

test("H09 — CLI: handoff-write reads the payload from stdin when --json is absent", () => {
  withRepo((repo) => {
    seedRun(repo, "run-1");
    const r = runCli(repo, ["handoff-write", "--run-id", "run-1"], JSON.stringify(validPayload()));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/Handoff recorded for run-1/.test(r.stdout));
    assert.ok(existsSync(handoffPath(repo, "run-1")));
  });
});

process.stdout.write(`\nhandoff (resume-live.mjs): ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.error}\n`);
  process.exit(1);
}
process.stdout.write("\nAll tests PASSED.\n");
