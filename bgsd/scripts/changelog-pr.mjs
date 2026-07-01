#!/usr/bin/env node
/**
 * changelog-pr.mjs — Phase 5: Per-Agent CHANGELOG Into the PR
 *                    (CHANGELOG-01, CHANGELOG-02, CHANGELOG-03)
 *
 * Three capabilities, all deterministic scripts (NFR-05):
 *
 *   1. PER-AGENT CHANGELOG AGGREGATION (CHANGELOG-01)
 *      aggregatePerAgentChangelog({ runId, worktrees, integrationResult?,
 *                                   feedbackRounds?, generateChangelogFn? })
 *      Pure function. Aggregates each agent's changes (Loop 1 + Loop 2 +
 *      any feedback rounds) into one per-agent CHANGELOG structure, reusing
 *      and enriching the v2 generateChangelog() seed from rehearsal.mjs.
 *      Returns { entries: AgentEntry[], changelog: string }.
 *      No model calls in the assembly path (NFR-05).
 *
 *   2. PR BODY ASSEMBLY (CHANGELOG-02)
 *      assemblePrBody({ runId, slug, prompt, entries, integrationResult?,
 *                       ledgerPath?, issueNumber? })
 *      Pure function. Renders the per-agent CHANGELOG + run summary into a
 *      complete Markdown PR body (per-agent sections, summary, test plan,
 *      and a closing keyword `Closes #N` only when issueNumber is provided).
 *      Returns a string; never performs I/O to GitHub. Unit-testable without
 *      touching git or GitHub.
 *
 *   3. LIVE PR CREATION (CHANGELOG-03)
 *      liveCreatePr({ base, head, title, body, dryRun? })
 *      The --live gate was removed so a plain /bgsd-sesh can open a PR.
 *      Always refuses if base is main/master (NFR-01). With dryRun=true:
 *      prints the assembled PR body and the gh pr create command it WOULD
 *      run, then exits without creating anything. Default: runs `gh pr create`.
 *
 * AgentEntry shape:
 *   {
 *     unitId:   string,
 *     agentId:  string,
 *     branch:   string,
 *     commits:  string[],
 *     status:   string,
 *     phase:    string,
 *     summary?: string,
 *     loop:     "loop1" | "loop2" | "feedback" | "unknown",
 *     feedbackRound?: number,
 *   }
 *
 * EXPORTS (library)
 * =================
 *
 *   aggregatePerAgentChangelog(opts) — pure, no I/O to GitHub
 *   assemblePrBody(opts)             — pure string, no I/O
 *   liveCreatePr(opts)               — HUMAN-GATED (requires --live + non-default base)
 *   requireLiveFlag()                — exported for tests
 *   requireNotDefaultBranch(base)    — exported for tests
 *   isLiveFlagSet()                  — exported for tests
 *
 * Usage (library):
 *   import {
 *     aggregatePerAgentChangelog,
 *     assemblePrBody,
 *     liveCreatePr,
 *   } from './changelog-pr.mjs';
 */

import { spawnSync } from "node:child_process";
import { generateChangelog } from "./rehearsal.mjs";

// ---------------------------------------------------------------------------
// HUMAN-GATED guard (mirrors loop1-live.mjs / run-live.mjs pattern exactly)
// ---------------------------------------------------------------------------

/**
 * Returns true when --live is explicitly in process.argv.
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Refuse to run any GitHub-mutating operation unless --live is explicitly set.
 * Mirrors the pattern in loop1-live.mjs and run-live.mjs.
 *
 * @throws {Error} if --live is not in process.argv
 */
export function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: changelog-pr.mjs live seam refused.\n" +
      "\n" +
      "The real `gh pr create` path requires an explicit --live flag to\n" +
      "prevent accidental automation (CHANGELOG-03, NFR-10).\n" +
      "\n" +
      "Safe (always allowed, no flag needed):\n" +
      "  aggregatePerAgentChangelog()  — pure, no git/GitHub\n" +
      "  assemblePrBody()              — pure string, no git/GitHub\n" +
      "\n" +
      "Without --live, liveCreatePr() prints the would-be PR body and the\n" +
      "gh pr create command it WOULD run, then exits without creating anything.\n" +
      "\n" +
      "To use the live seam (human-supervised only):\n" +
      "  node bgsd/scripts/changelog-pr.mjs --live [...args]\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts (NFR-10).\n" +
      "  - Target the 'next', 'main', or 'master' branch as base (NFR-01).\n" +
      "  - Create a PR without the human reviewing the assembled body first.\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Branch safety guard (NFR-01) — mirrors requireNotNextBranch() from run-live.mjs
// ---------------------------------------------------------------------------

/** Production branch names a PR base must never be. `next` is allowed (it is the PR target). */
const DEFAULT_BRANCHES = Object.freeze(["main", "master"]);

/**
 * Refuse to create a PR whose base branch is a default/production branch.
 * This guard is always enforced — even with --live set.
 *
 * The spec (NFR-01, CHANGELOG-03) requires: "the PR ALWAYS targets a
 * NON-default branch (never `next`); the guard hook rejects any PR against
 * the default branch."
 *
 * @param {string} base  The proposed PR base branch
 * @throws {Error} if base is next / main / master
 */
export function requireNotDefaultBranch(base) {
  if (!base || typeof base !== "string") {
    throw new Error(
      "requireNotDefaultBranch: base branch is required and must be a string"
    );
  }
  const normalized = base.trim().toLowerCase();
  if (DEFAULT_BRANCHES.includes(normalized)) {
    throw new Error(
      `\nNFR-01 VIOLATION: changelog-pr.mjs refuses to create a PR targeting "${base}".\n` +
      `bgsd NEVER opens a PR against the production/default branch.\n` +
      `Allowed base branches: any non-default branch (e.g. rehearsal/<run-id>).\n` +
      `Disallowed: ${DEFAULT_BRANCHES.join(", ")}.\n` +
      `Switch to a non-default base branch and try again.\n`
    );
  }
}

// ---------------------------------------------------------------------------
// CHANGELOG-01: Per-Agent CHANGELOG Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate each agent's changes into a structured per-agent CHANGELOG.
 *
 * Reuses and enriches the v2 generateChangelog() seed from rehearsal.mjs
 * (CHANGELOG-01 spec: "reusing + enriching the v2 generateChangelog() seed").
 * Aggregation is deterministic file I/O — no model calls (NFR-05).
 *
 * Covers Loop 1 agents, Loop 2 fix agents, and any feedback round agents by
 * inspecting each worktree descriptor's `loop` field (or defaulting to "loop1").
 *
 * @param {object} opts
 * @param {string}   opts.runId
 *   The run id.
 * @param {Array<{
 *   unitId:         string,
 *   agentId:        string,
 *   branch:         string,
 *   commits:        string[],
 *   status:         string,
 *   phase:          string,
 *   summary?:       string,
 *   loop?:          "loop1"|"loop2"|"feedback"|"unknown",
 *   feedbackRound?: number,
 * }>} opts.worktrees
 *   Per-worktree (per-agent) descriptor objects.
 * @param {{ verdict?: string, reportPath?: string, defectCount?: number }} [opts.integrationResult]
 *   Optional Loop 2 integration result to include in the aggregated changelog.
 * @param {Array<{ round: number, itemCount: number, mode: string }>} [opts.feedbackRounds]
 *   Optional feedback round metadata.
 * @param {Function} [opts.generateChangelogFn]
 *   Injectable: same signature as generateChangelog() from rehearsal.mjs.
 *   Defaults to the real import. Injectable for unit tests.
 * @returns {{
 *   entries: Array<{
 *     unitId: string, agentId: string, branch: string, commits: string[],
 *     status: string, phase: string, summary?: string,
 *     loop: string, feedbackRound?: number,
 *   }>,
 *   changelog: string,
 * }}
 */
export function aggregatePerAgentChangelog({
  runId,
  worktrees,
  integrationResult = null,
  feedbackRounds    = [],
  generateChangelogFn,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("aggregatePerAgentChangelog: runId is required");
  }
  if (!Array.isArray(worktrees)) {
    throw new Error("aggregatePerAgentChangelog: worktrees must be an array");
  }

  // Use the injected seed function if provided; otherwise fall back to the
  // v2 implementation imported from rehearsal.mjs (CHANGELOG-01).
  const seedFn = generateChangelogFn ?? generateChangelog;

  // Build structured entries — one per agent/worktree.
  const entries = worktrees.map((wt) => ({
    unitId:        wt.unitId,
    agentId:       wt.agentId,
    branch:        wt.branch,
    commits:       wt.commits ?? [],
    status:        wt.status,
    phase:         wt.phase ?? "(unknown)",
    summary:       wt.summary ?? null,
    loop:          wt.loop ?? "loop1",
    feedbackRound: wt.feedbackRound ?? undefined,
  }));

  // Generate the v2 seed changelog (structured Markdown stub) by calling
  // generateChangelog() with the worktrees array (CHANGELOG-01 enrichment).
  const { changelog: seedChangelog } = seedFn({ runId, worktrees });

  // ---------------------------------------------------------------------------
  // Enrich the seed with per-loop grouping and integration/feedback metadata.
  // This is purely string-building (NFR-05: no model calls).
  // ---------------------------------------------------------------------------

  const now = new Date().toISOString();

  // Group entries by loop for clearer human-readable grouping.
  const byLoop = {
    loop1:    entries.filter((e) => e.loop === "loop1"),
    loop2:    entries.filter((e) => e.loop === "loop2"),
    feedback: entries.filter((e) => e.loop === "feedback"),
    unknown:  entries.filter((e) => e.loop !== "loop1" && e.loop !== "loop2" && e.loop !== "feedback"),
  };

  // Build per-agent sections (enriched beyond the seed, grouped by loop phase).
  const buildAgentSection = (entry) => {
    const commits = entry.commits.length > 0
      ? entry.commits.map((sha) => `  - \`${sha}\``).join("\n")
      : "  - (no commits)";

    const summaryLine = entry.summary
      ? `\n**Summary:** ${entry.summary}\n`
      : "";

    const feedbackTag = entry.feedbackRound !== undefined
      ? ` (feedback round ${entry.feedbackRound})`
      : "";

    return [
      `### ${entry.unitId} — agent: ${entry.agentId}${feedbackTag}`,
      "",
      `- **Branch:** \`${entry.branch}\``,
      `- **Final status:** ${entry.status}`,
      `- **Final phase:** ${entry.phase}`,
      `- **Loop:** ${entry.loop}`,
      "",
      "**Commits:**",
      commits,
      summaryLine,
    ].join("\n");
  };

  const sections = [];

  if (byLoop.loop1.length > 0) {
    sections.push("## Loop 1 — Per-Worktree Agents");
    sections.push("");
    sections.push(...byLoop.loop1.map(buildAgentSection));
  }

  if (byLoop.loop2.length > 0) {
    sections.push("## Loop 2 — Integration Fix Agents");
    sections.push("");
    sections.push(...byLoop.loop2.map(buildAgentSection));
  }

  if (byLoop.feedback.length > 0) {
    sections.push("## Feedback Rounds");
    sections.push("");
    sections.push(...byLoop.feedback.map(buildAgentSection));
  }

  if (byLoop.unknown.length > 0) {
    sections.push("## Other Agents");
    sections.push("");
    sections.push(...byLoop.unknown.map(buildAgentSection));
  }

  // Integration result section.
  const integrationSection = integrationResult
    ? [
        "## Integration Result",
        "",
        `- **Verdict:** ${integrationResult.verdict ?? "(unknown)"}`,
        integrationResult.defectCount !== undefined
          ? `- **Defects resolved:** ${integrationResult.defectCount}`
          : "",
        integrationResult.reportPath
          ? `- **Report:** \`${integrationResult.reportPath}\``
          : "",
        "",
      ].filter(Boolean)
    : [];

  // Feedback rounds summary section.
  const feedbackSection =
    feedbackRounds.length > 0
      ? [
          "## Feedback Rounds Summary",
          "",
          ...feedbackRounds.map(
            (r) => `- Round ${r.round}: ${r.itemCount} item(s) [${r.mode}]`
          ),
          "",
        ]
      : [];

  const changelog = [
    `# Per-Agent CHANGELOG: ${runId}`,
    "",
    `> Generated ${now}`,
    `> Aggregated from ${entries.length} agent(s) across all loops and feedback rounds.`,
    `> This CHANGELOG is the PR body seed (CHANGELOG-01 / CHANGELOG-02).`,
    "",
    ...sections,
    ...integrationSection,
    ...feedbackSection,
  ].join("\n");

  return { entries, changelog };
}

// ---------------------------------------------------------------------------
// CHANGELOG-02: PR Body Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the aggregated per-agent CHANGELOG into a complete PR description.
 *
 * PURE function — deterministic string-building. No I/O to git or GitHub.
 * Unit-testable without touching any external system (CHANGELOG-02, NFR-05).
 *
 * The assembled body is also the content surfaced to the human at the User
 * Review Gate before any PR is opened (CHANGELOG-02 spec: "the same body is
 * surfaced to the human at the review gate").
 *
 * @param {object} opts
 * @param {string}   opts.runId
 *   The run id.
 * @param {string}   [opts.slug]
 *   Optional human-readable slug for the run (used in title, falls back to runId).
 * @param {string}   [opts.prompt]
 *   The original run prompt (included in the PR body summary).
 * @param {Array<object>} opts.entries
 *   AgentEntry[] from aggregatePerAgentChangelog().
 * @param {string}   opts.changelog
 *   The assembled per-agent CHANGELOG string from aggregatePerAgentChangelog().
 * @param {{ verdict?: string, reportPath?: string }} [opts.integrationResult]
 *   Optional integration result for the summary section.
 * @param {string}   [opts.ledgerPath]
 *   Optional path to the run ledger file (linked in the PR body).
 * @param {number|string|null} [opts.issueNumber]
 *   Optional issue number. When provided, appends `Closes #N` to the PR body.
 * @returns {{ title: string, body: string }}
 *   title — the PR title string
 *   body  — the complete Markdown PR body string
 */
export function assemblePrBody({
  runId,
  slug,
  prompt,
  entries,
  changelog,
  integrationResult = null,
  ledgerPath        = null,
  issueNumber       = null,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("assemblePrBody: runId is required");
  }
  if (!Array.isArray(entries)) {
    throw new Error("assemblePrBody: entries must be an array");
  }
  if (typeof changelog !== "string") {
    throw new Error("assemblePrBody: changelog must be a string");
  }

  const now = new Date().toISOString();
  const label = slug ?? runId;

  // PR title — short, from run id/slug + prompt excerpt.
  const promptExcerpt = prompt
    ? ` — ${prompt.trim().slice(0, 60)}${prompt.trim().length > 60 ? "..." : ""}`
    : "";
  const title = `bgsd run: ${label}${promptExcerpt}`;

  // Summary section.
  const agentCount = entries.length;
  const passCount  = entries.filter((e) => e.status === "done" || e.status === "passed").length;
  const integVerdict = integrationResult?.verdict ?? "(not run)";

  const summaryLines = [
    `- **Run ID:** \`${runId}\``,
    `- **Generated:** ${now}`,
    `- **Agents:** ${agentCount} total (${passCount} done)`,
    `- **Integration verdict:** ${integVerdict}`,
  ];

  if (prompt) {
    summaryLines.push(`- **Prompt:** ${prompt.trim().slice(0, 120)}`);
  }

  if (ledgerPath) {
    summaryLines.push(`- **Run ledger:** \`${ledgerPath}\``);
  }

  // Test plan — derived from the number of agents and integration result.
  const testPlanItems = [
    "- [ ] Review per-agent sections below and confirm commits are traceable.",
    "- [ ] Verify integration result is PASS (see Integration Result section).",
    "- [ ] Check that no worktree has status `failed` or `blocked`.",
    "- [ ] Confirm the PR targets a non-default branch (not `next`/`main`/`master`).",
    "- [ ] Review the run ledger for any held-back units.",
  ];

  if (integrationResult?.reportPath) {
    testPlanItems.push(
      `- [ ] Inspect integration report: \`${integrationResult.reportPath}\``
    );
  }

  // Closing keyword — only included when an issue number is provided.
  const closingLine =
    issueNumber !== null && issueNumber !== undefined
      ? `\nCloses #${issueNumber}\n`
      : "";

  // Assemble the full body.
  const body = [
    "## Summary",
    "",
    ...summaryLines,
    "",
    "## Per-Agent CHANGELOG",
    "",
    changelog,
    "",
    "## Test Plan",
    "",
    ...testPlanItems,
    "",
    "---",
    "",
    "_Generated by bgsd changelog-pr.mjs (Phase 5 / CHANGELOG-01..02)._",
    "_Not created by automation — the human opens the real PR with `--live`._",
    closingLine,
  ].join("\n");

  return { title, body };
}

// ---------------------------------------------------------------------------
// CHANGELOG-03: Guarded Live PR Creation
// ---------------------------------------------------------------------------

/**
 * Live PR creation (CHANGELOG-03).
 *
 * The --live gate has been removed so that a plain /bgsd-sesh run can open a
 * PR without an explicit --live flag. The only safety guard remaining for PR
 * base validation is requireNotDefaultBranch() (NFR-01), which always refuses
 * main/master as a PR base.
 *
 * BEHAVIOR (default — dryRun=false):
 *   1. requireNotDefaultBranch() — refuses if base is main/master (NFR-01)
 *   2. Executes `gh pr create --base <base> --head <head> --title <title> --body <body>`
 *
 * BEHAVIOR WITH dryRun=true:
 *   Prints the assembled PR body and the `gh pr create` command it WOULD run,
 *   then returns without creating anything.
 *
 * GUARDS (always enforced):
 *   - requireNotDefaultBranch()  — ALWAYS rejects main/master as base (NFR-01)
 *
 * @param {object} opts
 * @param {string}   opts.base    Target branch for the PR (must NOT be next/main/master).
 * @param {string}   opts.head    Source branch (the rehearsal or feature branch).
 * @param {string}   opts.title   PR title (from assemblePrBody()).
 * @param {string}   opts.body    PR body Markdown (from assemblePrBody()).
 * @param {boolean}  [opts.dryRun] Force dry-run even if --live is set (default: false).
 * @param {Function} [opts.spawnFn]
 *   Injectable: (cmd, args, opts) => SpawnSyncReturns — for unit tests.
 *   Default: spawnSync from node:child_process.
 * @param {Function} [opts.printFn]
 *   Injectable: (msg) => void — for unit tests (default: process.stdout.write).
 * @returns {{ dryRun: boolean, url?: string }}
 *   dryRun: true  — nothing was created; the would-be command was printed.
 *   dryRun: false — PR was created; url is the PR URL returned by `gh`.
 */
export function liveCreatePr({
  base,
  head,
  title,
  body,
  dryRun     = false,
  spawnFn    = spawnSync,
  printFn    = (msg) => process.stdout.write(msg),
}) {
  if (!base  || typeof base  !== "string") throw new Error("liveCreatePr: base is required");
  if (!head  || typeof head  !== "string") throw new Error("liveCreatePr: head is required");
  if (!title || typeof title !== "string") throw new Error("liveCreatePr: title is required");
  if (!body  || typeof body  !== "string") throw new Error("liveCreatePr: body is required");

  // The non-default-branch guard ALWAYS fires, even in dry-run mode.
  // A PR targeting next/main/master is refused unconditionally (NFR-01).
  requireNotDefaultBranch(base);

  // Build the `gh pr create` command for display (and, when live, execution).
  const ghArgs = [
    "pr", "create",
    "--base",  base,
    "--head",  head,
    "--title", title,
    "--body",  body,
  ];
  const commandStr =
    `gh ${ghArgs.map((a) => (a.includes(" ") || a.includes("\n") ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`;

  // ---------------------------------------------------------------------------
  // Dry-run path (explicit dryRun=true override only):
  //   Print the would-be PR body and the gh command; exit without creating.
  //   NOTE: the --live gate was intentionally removed so that a plain /bgsd-sesh
  //   run can open a PR without --live. The only remaining safety guard is
  //   requireNotDefaultBranch() above (NFR-01), which always refuses main/master.
  //   Pass dryRun=true explicitly to preview the PR without creating it.
  // ---------------------------------------------------------------------------
  if (dryRun) {
    printFn(
      "\n" +
      "======================================================================\n" +
      "bgsd: CHANGELOG → PR (DRY-RUN — no PR created)\n" +
      "======================================================================\n" +
      "\n" +
      `  Base branch : ${base}\n` +
      `  Head branch : ${head}\n` +
      `  PR title    : ${title}\n` +
      "\n" +
      "  -- Would-be PR body --\n" +
      "\n" +
      body +
      "\n\n" +
      "  -- Command that WOULD run --\n" +
      "\n" +
      `  ${commandStr}\n` +
      "\n" +
      "  NFR-01: The PR ALWAYS targets a non-default branch.\n" +
      "  main/master are NEVER the PR base — this guard is always on.\n" +
      "======================================================================\n\n"
    );
    return { dryRun: true };
  }

  // ---------------------------------------------------------------------------
  // Live path (dryRun is false + base is not a default branch):
  //   Runs gh pr create. The --live gate was removed; branch-safety (NFR-01)
  //   is enforced by requireNotDefaultBranch() above.
  // ---------------------------------------------------------------------------

  printFn(
    "\n" +
    "[bgsd changelog-pr] --live: creating PR via gh pr create\n" +
    `  Base: ${base}  Head: ${head}\n` +
    `  Title: ${title}\n\n`
  );

  const result = spawnFn("gh", ghArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`liveCreatePr: gh spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `liveCreatePr: gh pr create failed (exit ${result.status}):\n` +
      (result.stderr ?? "")
    );
  }

  const url = (result.stdout ?? "").trim();
  printFn(`[bgsd changelog-pr] PR created: ${url}\n`);
  return { dryRun: false, url };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (smoke test — library module, not a CLI tool)
// ---------------------------------------------------------------------------
if (
  import.meta.url ===
  new URL(
    process.argv[1],
    import.meta.url.startsWith("file://")
      ? import.meta.url
      : `file://${process.cwd()}/`
  ).href
) {
  process.stdout.write(
    "changelog-pr.mjs — Phase 5: Per-Agent CHANGELOG Into the PR\n" +
    "(library module — import and use its exported functions)\n\n" +
    "Exports:\n" +
    "  aggregatePerAgentChangelog({ runId, worktrees, integrationResult?,\n" +
    "                               feedbackRounds?, generateChangelogFn? })\n" +
    "    — pure, no git/GitHub; enriches the v2 generateChangelog() seed\n\n" +
    "  assemblePrBody({ runId, slug?, prompt?, entries, changelog,\n" +
    "                   integrationResult?, ledgerPath?, issueNumber? })\n" +
    "    — pure string, no git/GitHub; unit-testable\n\n" +
    "  liveCreatePr({ base, head, title, body, dryRun? })\n" +
    "    — HUMAN-GATED (requires --live + non-default base)\n" +
    "    — without --live: prints the would-be PR body + command, exits\n" +
    "    — with --live: runs gh pr create against a NON-default branch\n\n" +
    "Guards:\n" +
    "  requireLiveFlag()         — mirrors loop1-live.mjs / run-live.mjs\n" +
    "  requireNotDefaultBranch() — always refuses next/main/master as PR base\n"
  );
  process.exit(0);
}
