#!/usr/bin/env node
/**
 * init.mjs — Phase 1 (v0-init): /bgsd-init repo bootstrap (pure core)
 *
 * One-time, idempotent setup that prepares a TARGET repo (the user's own repo,
 * resolved from cwd — NOT the plugin location) for bgsd seshs:
 *   - the standing integration branch (`next`, configurable) created off the
 *     auto-detected base branch when missing
 *   - the `.bgsd/` master folder (config.json, seshs/, ledger.md) — persistent
 *     and committed; the ephemeral runtime zone (.bgsd/runs/, run-counter) is
 *     gitignored
 *   - `BGSD.md` — the user-editable settings file (every knob, shipped with
 *     defaults), read by the Conductor at sesh start
 *   - GSD config made bgsd-compatible (branching_strategy: none, base_branch:
 *     the integration branch) without clobbering existing keys
 *
 * PURITY (NFR-05)
 * ===============
 * This module is pure + dependency-injected. The default-config builder, the
 * BGSD.md render/parse, the gitignore merge, and the idempotent action planner
 * have NO side effects. `executeInit(deps)` runs the plan through injected I/O
 * so it is unit-testable against a temp dir with mocked git. The real git/fs
 * seam + the `--live` guard live in init-live.mjs.
 *
 * Usage (library):
 *   import { defaultBgsdConfig, renderBgsdMd, parseBgsdMd,
 *            mergeGitignore, planInit, executeInit } from './init.mjs';
 */

// ---------------------------------------------------------------------------
// Default configuration (every knob, shipped with defaults)
// ---------------------------------------------------------------------------

/**
 * The shipped bgsd defaults. BGSD.md renders these; the user edits the file to
 * override. The model-posture matrix here is the configurable home of what is
 * currently hardcoded in decompose.mjs (deriveModelPosture / POSTURE_TIERS).
 *
 * @returns {object} a fresh deep copy of the default config
 */
export function defaultBgsdConfig() {
  return {
    version: 1,
    // The standing integration branch. It IS the rehearsal/integration mirror
    // of main; worktree branches merge here; next -> main is human-only.
    integration_branch: "next",
    // null = auto-detect from origin/HEAD (falls back to main, then master).
    base_branch: null,
    git: {
      // ff-update the integration branch from base at the start of every sesh.
      sync_integration_from_base: true,
      // next -> main is NEVER automated. Recorded here as a hard rule.
      integration_to_main: "manual",
    },
    env: {
      // Git worktrees do NOT carry gitignored files. The Conductor must copy
      // these env files from the repo root into every worktree (and onto the
      // integration branch's checkout) so the spawned apps actually boot.
      propagate: true,
      files: [".env", ".env.local", ".env.*.local"],
    },
    github: {
      // File one atomic issue per work unit + one epic per sesh; PRs close them.
      issues: true,
      // Skip all issue/PR machinery when the repo has no GitHub remote.
      require_remote: true,
    },
    // Configurable model posture — defaults mirror decompose.mjs today.
    // Four difficulty bands map to executor model + effort.
    model_posture: {
      thresholds: { xhigh: 0.7, high: 0.4, mid: 0.2 },
      tiers: {
        xhigh: { model: "opus", effort: "xhigh" },
        high: { model: "opus", effort: "high" },
        mid: { model: "sonnet", effort: "high" },
        low: { model: "haiku", effort: "high" },
      },
      // executor uses the unit's own tier; researcher is one tier below
      // (floored at haiku/high); verifier is fixed.
      researcher: "one-tier-below",
      verifier: { model: "haiku", effort: "low" },
    },
    // How thoroughly bgsd verifies. The goal-backward code verification
    // (gsd-verifier: "did it build what was asked, is everything proper") ALWAYS
    // runs. usage_testing toggles the heavier Playwright/vision rung (driving the
    // real app: console -> network -> DOM -> vision). Turn it off for repos or
    // sessions where browser UI testing is overkill (a quick fix, a non-UI
    // change). headless runs Playwright without popping a visible browser/server
    // window (more discreet). Both are per-session flippable
    // (--no-usage-verification, --headless-ui) or persisted here. Never disables
    // code verification; "no silent green" still holds via the gsd-verifier.
    verification: {
      usage_testing: true,
      headless: false,
    },
    // Execution "modes" — how much work each role does. Three levels each:
    //   fast     — pipeline: skip research; verifier: code-only, quick checks.
    //   thorough — pipeline: research every unit; verifier: full driver ladder.
    //   adaptive — the Conductor decides per unit and adapts (DEFAULT, recommended).
    // Override per-session (--mode, --verify-mode) or persist here.
    modes: {
      pipeline: "adaptive",
      verifier: "adaptive",
    },
    conductor: {
      persona: "kiwi",
      // Live, stage-aware narration using the canonical pipeline names.
      narrate: true,
      // At every human gate, suggest the exact command to run next.
      suggest_gate_commands: true,
    },
    // Per-subagent context-window management. Each Pipeline Agent runs in its
    // own large window; the Conductor watches each agent's recorded usage and
    // proactively compacts/relaunches before overflow (see context.mjs).
    context: {
      // The model's full context window, in tokens. Pipeline Agents run on a
      // ~1M-token window today; bump this if the underlying model grows.
      max_window_tokens: 1_000_000,
      // Fraction of the window at which the Conductor proactively compacts.
      compact_at: 0.70,
      // Fraction of the window at which the Conductor clears + relaunches the
      // agent from its handoff manifest (a fresh, small window).
      relaunch_at: 0.90,
    },
  };
}

// ---------------------------------------------------------------------------
// Deep merge (plain objects only) — used to layer BGSD.md overrides on defaults
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively merge `override` onto `base`. Arrays and scalars from `override`
 * replace; nested plain objects merge. Neither input is mutated.
 */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    if (isPlainObject(base[key]) && isPlainObject(override[key])) {
      out[key] = deepMerge(base[key], override[key]);
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BGSD.md render + parse
// ---------------------------------------------------------------------------

const SETTINGS_FENCE_RE = /```json bgsd-settings\n([\s\S]*?)\n```/;

/**
 * Render BGSD.md: human-readable prose explaining each knob, plus a single
 * authoritative ```json bgsd-settings``` block (the source of truth the
 * Conductor parses). Editing the block changes behavior; the prose is docs.
 *
 * @param {object} config
 * @returns {string} BGSD.md contents
 */
export function renderBgsdMd(config) {
  const json = JSON.stringify(config, null, 2);
  return `# BGSD.md — bgsd settings

This file configures how bgsd (the Conductor, "Kiwi") runs in this repo. Every
knob lives in the \`bgsd-settings\` block below and ships with a sensible default.
Edit the block to override; Kiwi reads it at the start of every sesh. You can
also write prose preferences (tone, risk appetite, "always ask before X") in the
Notes section and Kiwi will respect them.

## Settings

- **integration_branch** — the standing branch that acts as the rehearsal /
  integration mirror of \`main\`. Worktree branches merge here; \`integration ->
  main\` is always a manual, human-only merge.
- **base_branch** — \`null\` auto-detects from \`origin/HEAD\` (falls back to
  \`main\`, then \`master\`). Set explicitly to pin it.
- **git.sync_integration_from_base** — ff-update the integration branch from the
  base branch at the start of every sesh, so it never falls behind production.
- **git.integration_to_main** — kept \`manual\`: no agent ever commits to
  \`main\`. Kiwi only suggests the merge command for you to run.
- **github.issues** — file one atomic issue per work unit plus one epic issue
  per sesh; each PR closes its issue on merge.
- **github.require_remote** — when there's no GitHub remote, skip all issue/PR
  machinery and just branch + merge locally.
- **env.propagate / env.files** — git worktrees don't carry gitignored files, so
  Kiwi copies these env files from the repo root into every worktree (and onto
  the integration branch) so your apps actually run. Edit the globs to match
  this repo's env files.
- **model_posture** — the per-unit model + effort routing, in four difficulty
  bands: \`xhigh\` (opus/xhigh), \`high\` (opus/high), \`mid\` (sonnet/high),
  \`low\` (haiku/high). Executor uses the unit's band; researcher drops one band
  (floored at haiku/high); verifier is fixed at haiku/low. Override any tier,
  threshold, or role here.
- **verification.usage_testing** — \`true\` runs the full Tester ladder including
  the Playwright/vision rung (driving the real app). \`false\` skips that UI
  usage-testing but STILL runs the goal-backward code verification
  (gsd-verifier), so quick fixes and non-UI changes don't pay for browser
  testing. Toggle per-session with \`--no-usage-verification\`, or tell Kiwi
  ("stop UI-testing quick fixes") and it sets this for you. It never disables
  code verification — "no silent green" still holds.
- **verification.headless** — \`true\` drives Playwright headless, no visible
  browser or server window pops up on your machine (discreet). \`false\` lets it
  run headed. Toggle per-session with \`--headless-ui\`, or tell Kiwi ("always
  verify headless").
- **modes.pipeline / modes.verifier** — how much work each role does, three
  levels: \`fast\` (pipeline skips research; verifier code-only), \`thorough\`
  (pipeline researches every unit; verifier full driver ladder), or \`adaptive\`
  (the Conductor decides per unit and adapts). \`adaptive\` is the default and
  recommended. Override per-session with \`--mode\` / \`--verify-mode\`, or
  persist here. A manually-passed flag always wins over this file.
- **conductor** — persona + narration. \`narrate\` streams stage-aware live
  updates; \`suggest_gate_commands\` makes Kiwi hand you the exact command at
  every human gate.
- **context** — per-subagent context-window management. \`max_window_tokens\`
  is the model's full window (Pipeline Agents run on ~1M tokens). When an
  agent's usage crosses \`compact_at\` (fraction of the window) Kiwi compacts it
  proactively; crossing \`relaunch_at\` clears and relaunches the agent from its
  handoff manifest, into a fresh small window. Raise the fractions to let agents
  run longer before Kiwi intervenes.

\`\`\`json bgsd-settings
${json}
\`\`\`

## Notes

<!-- Free-form preferences for Kiwi. Examples:
- Never use haiku for verification.
- Always ask before deleting files.
- Prefer terse PR descriptions. -->
`;
}

/**
 * Parse BGSD.md back into a config object, layered over the defaults so any
 * missing or removed key falls back to its default. Returns the defaults if the
 * settings block is absent or unparseable (best-effort, never throws on bad
 * user edits — Kiwi degrades to defaults).
 *
 * @param {string} text  BGSD.md contents
 * @returns {object} resolved config
 */
export function parseBgsdMd(text) {
  const defaults = defaultBgsdConfig();
  const match = typeof text === "string" ? text.match(SETTINGS_FENCE_RE) : null;
  if (!match) return defaults;
  let override;
  try {
    override = JSON.parse(match[1]);
  } catch (_) {
    return defaults;
  }
  return deepMerge(defaults, override);
}

// ---------------------------------------------------------------------------
// .gitignore merge (idempotent)
// ---------------------------------------------------------------------------

const GITIGNORE_SENTINEL = "# bgsd — runtime artifacts (local only)";

/**
 * The block bgsd appends to .gitignore. Allowlist form: ignore ALL runtime
 * children of .bgsd/ (runs/, queue/, cache/, run-counter, ...) and commit only
 * the persistent records (seshs/, ledger.md, config.json). BGSD.md sits at the
 * repo root and is committed by default.
 */
const GITIGNORE_BLOCK = [
  GITIGNORE_SENTINEL,
  "# Ignore all runtime artifacts; commit only the persistent records.",
  ".bgsd/*",
  "!.bgsd/seshs/",
  "!.bgsd/memory/",
  "!.bgsd/ledger.md",
  "!.bgsd/config.json",
  ".bgsd-tmp/",
].join("\n");

/**
 * Return the .gitignore contents with the bgsd block present exactly once.
 * Idempotent: if the sentinel is already present, the input is returned
 * unchanged.
 *
 * @param {string} existing  current .gitignore contents ("" if none)
 * @returns {{ content: string, changed: boolean }}
 */
export function mergeGitignore(existing) {
  const text = existing ?? "";
  if (text.includes(GITIGNORE_SENTINEL)) {
    return { content: text, changed: false };
  }
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  const lead = text.length === 0 ? "" : "\n";
  return { content: `${text}${sep}${lead}${GITIGNORE_BLOCK}\n`, changed: true };
}

// ---------------------------------------------------------------------------
// CLAUDE.md merge — teach any Claude (in or out of a session) about this repo
// ---------------------------------------------------------------------------

const CLAUDE_MD_SENTINEL = "<!-- bgsd:managed -->";

/** The bgsd-managed block appended to the repo's CLAUDE.md. */
export function bgsdClaudeMdBlock() {
  return [
    CLAUDE_MD_SENTINEL,
    "## bgsd (this is a bgsd repo)",
    "",
    'This repository is orchestrated by **bgsd** (the Conductor, "Kiwi"), an',
    "autonomous, self-verifying layer on top of GSD.",
    "",
    "**Where the history lives.** Every bgsd session is logged under `.bgsd/`.",
    "When you need context on what was built or changed, read there, even outside",
    "a bgsd session:",
    "- `.bgsd/ledger.md`: an index of every session (the request and the outcome).",
    "- `.bgsd/seshs/<run-id>/`: the per-session record (RUN.md, AGENTS.md for what",
    "  each subagent did, plus the aggregated planning markdown).",
    '- Search it all with `node "${CLAUDE_PLUGIN_ROOT}/scripts/kb.mjs" --query "<terms>"`',
    '  (for example, "auth middleware").',
    "",
    "**Before building.** If the user asks you to build, change, or fix something",
    "and has NOT already started a session, first ask whether they want to run it",
    'as a bgsd session (`/bgsd-sesh "<their request>"`) for the full verified,',
    "parallel pipeline. If yes, start it. If they decline or want something quick,",
    "just do it directly as normal Claude Code. Default to asking; never silently",
    "force a session.",
    CLAUDE_MD_SENTINEL,
  ].join("\n");
}

/**
 * Return CLAUDE.md contents with the bgsd block present exactly once.
 * Idempotent: if the sentinel is already present, the input is returned
 * unchanged.
 *
 * @param {string} existing  current CLAUDE.md contents ("" if none)
 * @returns {{ content: string, changed: boolean }}
 */
export function mergeClaudeMd(existing) {
  const text = existing ?? "";
  if (text.includes(CLAUDE_MD_SENTINEL)) {
    return { content: text, changed: false };
  }
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  const lead = text.length === 0 ? "" : "\n";
  return { content: `${text}${sep}${lead}${bgsdClaudeMdBlock()}\n`, changed: true };
}

// ---------------------------------------------------------------------------
// Idempotent action planner
// ---------------------------------------------------------------------------

/**
 * Given the detected repo state, return the ordered list of actions to bring it
 * to a bgsd-ready state. Idempotent: actions whose target already exists are
 * omitted, EXCEPT the always-on sesh-preflight actions (ensure dir, sync
 * integration branch) which are included every time.
 *
 * @param {object} state
 * @param {boolean} state.bgsdConfigExists
 * @param {boolean} state.bgsdMdExists
 * @param {boolean} state.ledgerExists
 * @param {boolean} state.seshsDirExists
 * @param {boolean} state.integrationBranchExists
 * @param {boolean} state.planningConfigExists
 * @param {boolean} state.gitignoreHasBlock
 * @param {string}  state.integrationBranch
 * @param {string}  state.baseBranch
 * @param {object}  state.config
 * @returns {{ alreadyInitialized: boolean, actions: Array<object> }}
 */
export function planInit(state) {
  const actions = [];
  const cfg = state.config ?? defaultBgsdConfig();

  // Always ensure the master folder exists.
  actions.push({ type: "ensure_bgsd_dir" });

  if (!state.seshsDirExists) actions.push({ type: "ensure_seshs_dir" });
  if (!state.ledgerExists) actions.push({ type: "init_ledger" });
  if (!state.bgsdConfigExists) actions.push({ type: "write_config" });
  if (!state.bgsdMdExists) actions.push({ type: "write_bgsd_md" });
  if (!state.gitignoreHasBlock) actions.push({ type: "update_gitignore" });
  if (!state.claudeMdHasBlock) actions.push({ type: "write_claude_md" });
  if (!state.planningConfigExists) {
    actions.push({ type: "ensure_gsd_config", integrationBranch: state.integrationBranch });
  }
  if (!state.integrationBranchExists) {
    actions.push({
      type: "create_integration_branch",
      branch: state.integrationBranch,
      base: state.baseBranch,
    });
  }
  // Always-on preflight: keep the integration branch current with base.
  if (cfg.git?.sync_integration_from_base !== false) {
    actions.push({
      type: "sync_integration_branch",
      branch: state.integrationBranch,
      base: state.baseBranch,
    });
  }

  return { alreadyInitialized: !!state.bgsdConfigExists, actions };
}

// ---------------------------------------------------------------------------
// Path + state detection (shared by executeInit and the live dry-run preview)
// ---------------------------------------------------------------------------

/** Compute all init-relevant absolute paths under a target repo root. */
export function initPaths(root) {
  const j = (...parts) => parts.join("/").replace(/\/+/g, "/");
  return {
    bgsdDir: j(root, ".bgsd"),
    bgsdMd: j(root, "BGSD.md"),
    config: j(root, ".bgsd", "config.json"),
    ledger: j(root, ".bgsd", "ledger.md"),
    seshsDir: j(root, ".bgsd", "seshs"),
    gitignore: j(root, ".gitignore"),
    claudeMd: j(root, "CLAUDE.md"),
    planningConfig: j(root, ".planning", "config.json"),
  };
}

/**
 * Read-only detection of the target repo's init state via injected deps.
 * Resolves config (explicit > BGSD.md > defaults), the integration branch, and
 * the base branch. Shared so paths + detection never drift between the executor
 * and the live preview.
 */
export function detectInitState(deps) {
  const paths = initPaths(deps.repoRoot);
  let config = deps.config;
  if (!config) {
    config = deps.exists(paths.bgsdMd)
      ? parseBgsdMd(deps.readFile(paths.bgsdMd))
      : defaultBgsdConfig();
  }
  const integrationBranch = config.integration_branch || "next";
  const baseBranch = config.base_branch || deps.detectBaseBranch();
  const state = {
    bgsdConfigExists: deps.exists(paths.config),
    bgsdMdExists: deps.exists(paths.bgsdMd),
    ledgerExists: deps.exists(paths.ledger),
    seshsDirExists: deps.exists(paths.seshsDir),
    integrationBranchExists: deps.branchExists(integrationBranch),
    planningConfigExists: deps.exists(paths.planningConfig),
    gitignoreHasBlock:
      deps.exists(paths.gitignore) &&
      deps.readFile(paths.gitignore).includes(GITIGNORE_SENTINEL),
    claudeMdHasBlock:
      deps.exists(paths.claudeMd) &&
      deps.readFile(paths.claudeMd).includes(CLAUDE_MD_SENTINEL),
    integrationBranch,
    baseBranch,
    config,
  };
  return { paths, config, integrationBranch, baseBranch, state };
}

// ---------------------------------------------------------------------------
// DI executor — runs the plan through injected I/O (testable)
// ---------------------------------------------------------------------------

const LEDGER_HEADER =
  "# bgsd sesh ledger\n\n" +
  "| run_id | prompt | scale | outcome | at |\n" +
  "|--------|--------|-------|---------|----|\n";

/**
 * Execute the init plan. All I/O is injected so this runs unmodified against a
 * temp dir with mocked git in tests, and against real git/fs in init-live.mjs.
 *
 * @param {object} deps
 * @param {string}   deps.repoRoot                 absolute path to the TARGET repo
 * @param {object}   [deps.config]                 resolved config (else parsed from BGSD.md / defaults)
 * @param {(p:string)=>boolean}        deps.exists
 * @param {(p:string)=>string}         deps.readFile
 * @param {(p:string,s:string)=>void}  deps.writeFile     atomic write
 * @param {(p:string)=>void}           deps.mkdirp
 * @param {()=>string}                 deps.detectBaseBranch
 * @param {(branch:string)=>boolean}   deps.branchExists
 * @param {(branch:string, base:string)=>void}  deps.createBranch
 * @param {(branch:string, base:string)=>{updated:boolean, reason?:string}} deps.syncBranch
 * @param {(repoRoot:string, integrationBranch:string)=>boolean} deps.ensureGsdConfig
 * @param {(msg:string)=>void}         [deps.log]
 * @returns {{ alreadyInitialized:boolean, baseBranch:string, integrationBranch:string, performed:string[], notes:string[] }}
 */
export function executeInit(deps) {
  const log = deps.log ?? (() => {});
  const { paths, config, integrationBranch, baseBranch, state } = detectInitState(deps);
  const root = deps.repoRoot;
  const join = (...parts) => parts.join("/").replace(/\/+/g, "/");
  const bgsdDir = paths.bgsdDir;
  const bgsdMdPath = paths.bgsdMd;
  const configPath = paths.config;
  const ledgerPath = paths.ledger;
  const seshsDir = paths.seshsDir;
  const gitignorePath = paths.gitignore;

  const { alreadyInitialized, actions } = planInit(state);
  const performed = [];
  const notes = [];

  for (const action of actions) {
    switch (action.type) {
      case "ensure_bgsd_dir":
        deps.mkdirp(bgsdDir);
        break;
      case "ensure_seshs_dir":
        deps.mkdirp(seshsDir);
        deps.writeFile(join(seshsDir, ".gitkeep"), "");
        performed.push("ensure_seshs_dir");
        break;
      case "init_ledger":
        deps.writeFile(ledgerPath, LEDGER_HEADER);
        performed.push("init_ledger");
        break;
      case "write_config":
        deps.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
        performed.push("write_config");
        break;
      case "write_bgsd_md":
        deps.writeFile(bgsdMdPath, renderBgsdMd(config));
        performed.push("write_bgsd_md");
        break;
      case "update_gitignore": {
        const existing = deps.exists(gitignorePath) ? deps.readFile(gitignorePath) : "";
        const { content, changed } = mergeGitignore(existing);
        if (changed) {
          deps.writeFile(gitignorePath, content);
          performed.push("update_gitignore");
        }
        break;
      }
      case "write_claude_md": {
        const existing = deps.exists(paths.claudeMd) ? deps.readFile(paths.claudeMd) : "";
        const { content, changed } = mergeClaudeMd(existing);
        if (changed) {
          deps.writeFile(paths.claudeMd, content);
          performed.push("write_claude_md");
        }
        break;
      }
      case "ensure_gsd_config": {
        const wrote = deps.ensureGsdConfig(root, integrationBranch);
        if (wrote) performed.push("ensure_gsd_config");
        break;
      }
      case "create_integration_branch":
        deps.createBranch(action.branch, action.base);
        performed.push(`create_integration_branch:${action.branch}`);
        log(`created integration branch '${action.branch}' off '${action.base}'`);
        break;
      case "sync_integration_branch": {
        const res = deps.syncBranch(action.branch, action.base) ?? {};
        if (res.updated) {
          performed.push(`sync_integration_branch:${action.branch}`);
          log(`fast-forwarded '${action.branch}' to '${action.base}'`);
        } else if (res.reason) {
          notes.push(`integration branch not synced: ${res.reason}`);
        }
        break;
      }
      default:
        notes.push(`unknown action: ${action.type}`);
    }
  }

  return { alreadyInitialized, baseBranch, integrationBranch, performed, notes };
}
