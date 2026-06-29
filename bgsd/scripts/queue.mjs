#!/usr/bin/env node
/**
 * queue.mjs — Fix-Stream Queue core library (Phase 1: QUEUE-01..05)
 *
 * Provides a durable, resumable, single-stream fix queue backed by a JSON file
 * under .bgsd/queue/. All reads and writes are deterministic (no model calls).
 * Writes are atomic (write temp + rename) so the store survives interruption.
 *
 * STATE MACHINE
 * =============
 * Each item moves through exactly these states:
 *
 *   queued -> classified -> routed -> executing -> verifying -> looping
 *          -> done | failed | blocked | needs_input
 *
 * The TRANSITIONS table is the single source of truth. Any attempt to advance
 * to a state not reachable from the current state throws an error.
 *
 * PHASES 2/3 HOOKS
 * ================
 * The `start` drainer advances items through a PLACEHOLDER pipeline. Each
 * step is clearly marked with a comment indicating where Phase 2 (classify/
 * route) and Phase 3 (Loop-1 verify→fix) plug in. No external processes are
 * spawned; no /gsd-* commands are invoked yet.
 *
 * Usage (CLI):
 *   node bgsd/scripts/queue.mjs add --title "Fix nav bug" [--body "..."] [--source manual]
 *   node bgsd/scripts/queue.mjs status
 *   node bgsd/scripts/queue.mjs start
 *
 * Usage (library):
 *   import { addItem, getStatus, startDrainer, loadStore } from './queue.mjs';
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
// Repo root is two directories up from bgsd/scripts/
const REPO_ROOT = resolve(__dir, "../../");
const QUEUE_DIR = join(REPO_ROOT, ".bgsd", "queue");
const QUEUE_FILE = join(QUEUE_DIR, "queue.json");
const QUEUE_FILE_TMP = join(QUEUE_DIR, "queue.json.tmp");

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * All valid states in the per-item lifecycle.
 * @type {readonly string[]}
 */
export const STATES = Object.freeze([
  "queued",       // Item has been added; not yet classified
  "classified",   // [Phase 2] Item has been classified into a route class
  "routed",       // [Phase 2] Item has been assigned a concrete GSD quick path
  "executing",    // [Phase 3] GSD execution is running
  "verifying",    // [Phase 3] bgsd-verify is running against the worktree
  "looping",      // [Phase 3] Verify→fix loop is iterating
  "done",         // TERMINAL: item passed verification cleanly
  "failed",       // TERMINAL: stop condition hit without clean PASS
  "blocked",      // TERMINAL: verification blocked (BLOCKED/ERROR from Tester)
  "needs_input",  // TERMINAL (soft): item needs clarification before it can proceed
]);

/**
 * Terminal states — no further transitions are permitted from these.
 * @type {readonly string[]}
 */
export const TERMINAL_STATES = Object.freeze([
  "done",
  "failed",
  "blocked",
  "needs_input",
]);

/**
 * Allowed transitions table. Key = from-state, value = set of allowed to-states.
 * This is the single source of truth; transition() rejects anything not listed here.
 */
export const TRANSITIONS = Object.freeze({
  queued:      new Set(["classified", "needs_input", "blocked"]),
  classified:  new Set(["routed", "needs_input", "blocked"]),
  routed:      new Set(["executing", "needs_input", "blocked"]),
  executing:   new Set(["verifying", "failed", "blocked"]),
  verifying:   new Set(["looping", "done", "failed", "blocked"]),
  looping:     new Set(["verifying", "done", "failed", "blocked"]),
  // Terminal states have no outgoing transitions
  done:        new Set(),
  failed:      new Set(),
  blocked:     new Set(),
  needs_input: new Set(),
});

// ---------------------------------------------------------------------------
// Store I/O — atomic writes via write-temp-then-rename
// ---------------------------------------------------------------------------

/**
 * Ensure the queue directory exists.
 */
function ensureDir() {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

/**
 * Load the queue store from disk. Returns an empty store if the file does not
 * exist yet.
 *
 * @returns {{ items: object[] }}
 */
export function loadStore() {
  ensureDir();
  if (!existsSync(QUEUE_FILE)) {
    return { items: [] };
  }
  const raw = readFileSync(QUEUE_FILE, "utf8");
  return JSON.parse(raw);
}

/**
 * Write the store atomically: serialize to a temp file, then rename over the
 * real file. Rename is atomic on POSIX; the store is never half-written.
 *
 * @param {{ items: object[] }} store
 */
export function saveStore(store) {
  ensureDir();
  writeFileSync(QUEUE_FILE_TMP, JSON.stringify(store, null, 2), "utf8");
  renameSync(QUEUE_FILE_TMP, QUEUE_FILE);
}

// ---------------------------------------------------------------------------
// Content-key deduplication
// ---------------------------------------------------------------------------

/**
 * Compute a stable content key from an item's title and body so that
 * duplicate submissions collapse to the same key (QUEUE-05).
 *
 * @param {string} title
 * @param {string} body
 * @returns {string}  hex SHA-256 of "title\n\nbody"
 */
export function contentKey(title, body = "") {
  return createHash("sha256")
    .update(`${title.trim()}\n\n${body.trim()}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a short stable ID for a queue item.
 * Format: "item-<8 hex chars>-<timestamp ms>"
 *
 * @returns {string}
 */
function generateId() {
  const hex = randomBytes(4).toString("hex");
  return `item-${hex}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// State transition
// ---------------------------------------------------------------------------

/**
 * Advance an item to a new state, validating the transition and appending
 * an audit trail entry.
 *
 * @param {object} item         The queue item to mutate in place.
 * @param {string} toState      The target state.
 * @param {object} [meta={}]    Optional metadata to attach to the trail entry.
 * @throws {Error} if the transition is illegal.
 */
export function transition(item, toState, meta = {}) {
  if (!STATES.includes(toState)) {
    throw new Error(
      `transition: unknown target state "${toState}". Valid states: ${STATES.join(", ")}`
    );
  }
  const allowed = TRANSITIONS[item.state];
  if (!allowed || !allowed.has(toState)) {
    throw new Error(
      `transition: illegal transition from "${item.state}" to "${toState}". ` +
        `Allowed from "${item.state}": [${[...(allowed ?? [])].join(", ") || "none"}]`
    );
  }
  const previousState = item.state;
  item.state = toState;
  const now = new Date().toISOString();
  item.updated_at = now;

  // Append-only audit trail
  item.trail = item.trail ?? [];
  item.trail.push({
    from: previousState,
    to: toState,
    at: now,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  });
}

// ---------------------------------------------------------------------------
// add — QUEUE-01, QUEUE-02
// ---------------------------------------------------------------------------

/**
 * Enqueue a new fix/feature item. Returns the newly created item's id.
 *
 * Deduplicates by content key (QUEUE-05): if an item with the same
 * title+body already exists in a non-terminal state, returns its existing id
 * without creating a duplicate.
 *
 * @param {object} opts
 * @param {string} opts.title    Short, human-readable title (required)
 * @param {string} [opts.body]   Longer description (optional)
 * @param {string} [opts.source] Provenance — "manual" | "hyperpolymath" (default: "manual")
 * @returns {string}  The item id (new or existing)
 */
export function addItem({ title, body = "", source = "manual" }) {
  if (!title || title.trim().length === 0) {
    throw new Error("addItem: title is required and must be non-empty");
  }

  const store = loadStore();
  const key = contentKey(title, body);

  // Dedup: if a non-terminal item with the same content key exists, return it
  const existing = store.items.find(
    (item) => item.content_key === key && !TERMINAL_STATES.includes(item.state)
  );
  if (existing) {
    return existing.id;
  }

  const now = new Date().toISOString();
  const id = generateId();

  const item = {
    id,
    content_key: key,
    title: title.trim(),
    body: body.trim(),
    source,
    state: "queued",
    attempts: 0,
    created_at: now,
    updated_at: now,
    trail: [
      {
        from: null,
        to: "queued",
        at: now,
      },
    ],
  };

  store.items.push(item);
  saveStore(store);
  return id;
}

// ---------------------------------------------------------------------------
// status — QUEUE-01, QUEUE-02
// ---------------------------------------------------------------------------

/**
 * Compute a summary of the current queue state for display.
 * Zero model calls; reads only from disk (NFR-05).
 *
 * @returns {{
 *   counts: Record<string, number>,
 *   current: object|null,
 *   last_verdict: string|null,
 *   items: object[]
 * }}
 */
export function getStatus() {
  const store = loadStore();
  const items = store.items ?? [];

  // Per-state counts
  const counts = {};
  for (const state of STATES) {
    counts[state] = 0;
  }
  for (const item of items) {
    if (item.state in counts) {
      counts[item.state]++;
    }
  }

  // "Current" item = the first non-terminal item (the one being worked on)
  const current = items.find((i) => !TERMINAL_STATES.includes(i.state)) ?? null;

  // Last verdict = the most recently updated terminal item's state
  const terminals = items.filter((i) => TERMINAL_STATES.includes(i.state));
  let lastVerdict = null;
  if (terminals.length > 0) {
    terminals.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    lastVerdict = terminals[0].state;
  }

  return { counts, current, last_verdict: lastVerdict, items };
}

/**
 * Print a compact, human-readable status to stdout.
 * Stdout discipline: no full JSON (NFR-05, VERIFY-03 pattern).
 */
export function printStatus() {
  const { counts, current, last_verdict, items } = getStatus();

  const total = items.length;
  const done = counts.done ?? 0;
  const failed = (counts.failed ?? 0) + (counts.blocked ?? 0);
  const pending =
    total - done - failed - (counts.needs_input ?? 0);

  process.stdout.write(`\nbgsd queue status\n`);
  process.stdout.write(`  total       ${total}\n`);
  process.stdout.write(`  queued      ${counts.queued ?? 0}\n`);
  process.stdout.write(`  classified  ${counts.classified ?? 0}\n`);
  process.stdout.write(`  routed      ${counts.routed ?? 0}\n`);
  process.stdout.write(`  executing   ${counts.executing ?? 0}\n`);
  process.stdout.write(`  verifying   ${counts.verifying ?? 0}\n`);
  process.stdout.write(`  looping     ${counts.looping ?? 0}\n`);
  process.stdout.write(`  done        ${done}\n`);
  process.stdout.write(`  failed      ${counts.failed ?? 0}\n`);
  process.stdout.write(`  blocked     ${counts.blocked ?? 0}\n`);
  process.stdout.write(`  needs_input ${counts.needs_input ?? 0}\n`);
  if (current) {
    const ageMs = Date.now() - new Date(current.created_at).getTime();
    const ageMins = Math.floor(ageMs / 60000);
    const ageStr =
      ageMins >= 60
        ? `${Math.floor(ageMins / 60)}h ${ageMins % 60}m`
        : `${ageMins}m`;
    process.stdout.write(
      `\n  current     [${current.state}] ${current.id}  "${current.title}"  age=${ageStr}\n`
    );
  } else if (pending === 0 && total > 0) {
    process.stdout.write(`\n  current     (none — all items terminal)\n`);
  } else if (total === 0) {
    process.stdout.write(`\n  current     (queue is empty)\n`);
  }
  if (last_verdict) {
    process.stdout.write(`  last_verdict  ${last_verdict}\n`);
  }
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// start — QUEUE-04, QUEUE-05 (placeholder drainer)
// ---------------------------------------------------------------------------

/**
 * Advance the fix stream. Pulls the first non-terminal item and runs it
 * through the placeholder pipeline until it reaches a terminal state,
 * then repeats for the next item. Honors resumability (QUEUE-05):
 * - Already-done items are skipped.
 * - In-flight items (non-queued non-terminal) are picked up where they left off.
 *
 * SINGLE-STREAM, SINGLE-WORKTREE (QUEUE-04): exactly one item is active at a
 * time; no parallelism; no second worktree.
 *
 * PLACEHOLDER PIPELINE:
 *   queued
 *     -> classified   [PHASE 2 HOOK: classifier plugs in here]
 *     -> routed       [PHASE 2 HOOK: router plugs in here]
 *     -> executing    [PHASE 3 HOOK: GSD quick-path execution plugs in here]
 *     -> verifying    [PHASE 3 HOOK: bgsd-verify spawn plugs in here]
 *     -> looping      [PHASE 3 HOOK: Ralph verify→fix loop plugs in here]
 *     -> done         [PHASE 3 HOOK: clean PASS from Tester lands here]
 *
 * Each placeholder step records metadata on the trail so the pipeline
 * history is auditable even without real execution.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  If true, print what would happen without mutating state.
 */
export function startDrainer({ dryRun = false } = {}) {
  const store = loadStore();
  const items = store.items ?? [];

  const workable = items.filter((i) => !TERMINAL_STATES.includes(i.state));

  if (workable.length === 0) {
    process.stdout.write(
      "bgsd queue start: nothing to do (queue empty or all items terminal).\n"
    );
    return;
  }

  // Process items one at a time (QUEUE-04: single-stream, single-worktree)
  for (const item of workable) {
    process.stdout.write(
      `\nbgsd queue start: processing item ${item.id}  "${item.title}"  [${item.state}]\n`
    );

    if (dryRun) {
      process.stdout.write(
        `  (dry-run) would advance through placeholder pipeline\n`
      );
      continue;
    }

    // Reload the store fresh before each item so concurrent reads see
    // the latest state (defense-in-depth; drainer is single-stream anyway).
    const freshStore = loadStore();
    const liveItem = freshStore.items.find((i) => i.id === item.id);
    if (!liveItem) continue;

    // Increment attempts each time start picks up this item
    liveItem.attempts = (liveItem.attempts ?? 0) + 1;

    try {
      runPlaceholderPipeline(liveItem);
    } catch (err) {
      // Unexpected pipeline error: mark blocked with reason
      if (!TERMINAL_STATES.includes(liveItem.state)) {
        transition(liveItem, "blocked", { reason: err.message });
      }
      process.stderr.write(
        `  ERROR: pipeline threw for ${liveItem.id}: ${err.message}\n`
      );
    }

    // Persist state after each item completes
    const idx = freshStore.items.findIndex((i) => i.id === liveItem.id);
    if (idx !== -1) freshStore.items[idx] = liveItem;
    saveStore(freshStore);

    process.stdout.write(
      `  -> terminal state: ${liveItem.state}\n`
    );
  }

  process.stdout.write("\nbgsd queue start: drain pass complete.\n\n");
}

/**
 * Run the placeholder pipeline for a single item, advancing it from its
 * current state to a terminal state via the Phase 1 stub.
 *
 * Each step prints a one-line trace so the run is visible in the terminal.
 * Phases 2 and 3 replace each stub block with real logic.
 *
 * @param {object} item  The item to advance (mutated in place).
 */
function runPlaceholderPipeline(item) {
  // Resume from wherever the item was last persisted (QUEUE-05)
  if (item.state === "queued") {
    // -----------------------------------------------------------------
    // PHASE 2 HOOK: classify the item (title/body -> route class)
    // Replace this stub with: classify(item) from classify-route.mjs
    // -----------------------------------------------------------------
    process.stdout.write(`  [stub] classify: queued -> classified\n`);
    transition(item, "classified", { phase: "2-stub", note: "placeholder" });
  }

  if (item.state === "classified") {
    // -----------------------------------------------------------------
    // PHASE 2 HOOK: route the item (route class -> GSD quick path)
    // Replace this stub with: route(item) from classify-route.mjs
    // -----------------------------------------------------------------
    process.stdout.write(`  [stub] route: classified -> routed\n`);
    transition(item, "routed", { phase: "2-stub", note: "placeholder" });
  }

  if (item.state === "routed") {
    // -----------------------------------------------------------------
    // PHASE 3 HOOK: execute via GSD quick path (call /gsd-quick or
    // /gsd-fast based on item.route_class)
    // Replace this stub with: execute(item) from loop1.mjs
    // -----------------------------------------------------------------
    process.stdout.write(`  [stub] execute: routed -> executing\n`);
    transition(item, "executing", { phase: "3-stub", note: "placeholder" });
  }

  if (item.state === "executing") {
    // -----------------------------------------------------------------
    // PHASE 3 HOOK: spawn bgsd-verify against the worktree
    // Replace this stub with: verify(item) from loop1.mjs
    // -----------------------------------------------------------------
    process.stdout.write(`  [stub] verify: executing -> verifying\n`);
    transition(item, "verifying", { phase: "3-stub", note: "placeholder" });
  }

  if (item.state === "verifying") {
    // -----------------------------------------------------------------
    // PHASE 3 HOOK: Ralph verify->fix loop
    // On PASS  -> done
    // On FAIL  -> looping (then back to verifying until PASS or stop)
    // On BLOCKED/ERROR -> blocked
    // Replace this stub with: loop1(item) from loop1.mjs
    // -----------------------------------------------------------------
    process.stdout.write(
      `  [stub] loop: verifying -> done (placeholder — Phase 3 will run real Tester)\n`
    );
    transition(item, "done", { phase: "3-stub", note: "placeholder" });
  }

  // If item is still in "looping" (picked up mid-loop after interruption):
  if (item.state === "looping") {
    // -----------------------------------------------------------------
    // PHASE 3 HOOK: continue the in-progress verify→fix loop
    // -----------------------------------------------------------------
    process.stdout.write(
      `  [stub] continue loop: looping -> done (placeholder)\n`
    );
    transition(item, "done", { phase: "3-stub", note: "placeholder-resume" });
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
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
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  function usage() {
    process.stderr.write(
      [
        "Usage:",
        "  node bgsd/scripts/queue.mjs add --title \"<title>\" [--body \"<desc>\"] [--source manual|hyperpolymath]",
        "  node bgsd/scripts/queue.mjs status",
        "  node bgsd/scripts/queue.mjs start [--dry-run]",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  function parseFlags(args) {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        const key = args[i].slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    }
    return flags;
  }

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    usage();
  }

  if (subcommand === "add") {
    const flags = parseFlags(argv.slice(1));
    const title = flags.title;
    if (!title || typeof title !== "string") {
      process.stderr.write("add: --title is required\n");
      process.exit(1);
    }
    const id = addItem({
      title,
      body: typeof flags.body === "string" ? flags.body : "",
      source: typeof flags.source === "string" ? flags.source : "manual",
    });
    process.stdout.write(`${id}\n`);
    process.exit(0);
  }

  if (subcommand === "status") {
    printStatus();
    process.exit(0);
  }

  if (subcommand === "start") {
    const flags = parseFlags(argv.slice(1));
    startDrainer({ dryRun: flags["dry-run"] === true });
    process.exit(0);
  }

  process.stderr.write(`Unknown subcommand: "${subcommand}"\n`);
  usage();
}
