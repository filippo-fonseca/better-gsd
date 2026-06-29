#!/usr/bin/env node
/**
 * capture.mjs — Hyperpolymath Capture→Queue adapter (Phase 4: CAPTURE-01..03)
 *
 * CAPTURE SEAM CONTRACT
 * =====================
 * This module defines the documented capture seam: it consumes raw items
 * from an external source (injected as an async function) and emits
 * `source: "hyperpolymath"` queue records via the queue's real `addItem` API.
 *
 * Input shape (raw item from source):
 *   {
 *     id:         string   — stable source-side identifier
 *     title:      string   — human-readable title
 *     body:       string   — longer description (may be empty/absent)
 *     created_at: string   — ISO-8601 timestamp (informational; not stored in queue)
 *   }
 *
 * Output (queue record emitted per item, via addItem):
 *   {
 *     title:   string        — trimmed from raw item
 *     body:    string        — trimmed from raw item (may be "")
 *     source:  "hyperpolymath"
 *   }
 *   Plus all fields addItem adds: id, content_key, state, created_at, ...
 *
 * DEDUPLICATION
 * =============
 * Idempotency is achieved via the queue's SHA-256 content-key dedup
 * (QUEUE-05). Two items with the same title+body collapse to a single queue
 * record regardless of how many times capture runs. No separate dedup logic
 * is needed in this adapter: `addItem` already returns the existing id when
 * an identical non-terminal item is present.
 *
 * DRY-RUN (DEFAULT)
 * =================
 * `captureToQueue` defaults to `dryRun: true`. In dry-run mode it resolves
 * and normalises items and reports what WOULD be enqueued, without writing to
 * disk (CAPTURE-03, NFR-07). Pass `dryRun: false` to actually enqueue.
 *
 * INJECTION
 * =========
 * The `source` parameter is an injected async function `() => RawItem[]`.
 * Tests pass the mock source. The cron wrapper (capture-cron.mjs) passes
 * the mock source by default; with --live it would pass the live adapter
 * from capture-live.mjs (which refuses unless --live is set). Nothing in
 * this file imports capture-live.mjs or touches any live system.
 *
 * Usage (library):
 *   import { captureToQueue } from './capture.mjs';
 *   const result = await captureToQueue({ source: mockSource, dryRun: true });
 *
 * Usage (CLI):
 *   node bgsd/scripts/capture.mjs [--dry-run] [--live]
 *   (--dry-run is the default; --live is forwarded to capture-live.mjs and
 *   will cause a refusal unless the live adapter accepts it)
 */

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Queue API import
// ---------------------------------------------------------------------------

// We import addItem and contentKey from queue.mjs (the real queue API).
// Tests that want an isolated store must override these by using a custom
// storeDir (see captureToQueueIsolated below).
import { addItem, contentKey, loadStore } from "./queue.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Normalise a raw source item into a queue-ready shape
// ---------------------------------------------------------------------------

/**
 * Normalise a raw Hyperpolymath item into the queue record shape.
 *
 * @param {object} rawItem
 * @param {string} rawItem.title
 * @param {string} [rawItem.body]
 * @returns {{ title: string, body: string, source: string }}
 */
export function normaliseItem(rawItem) {
  if (!rawItem || typeof rawItem.title !== "string" || rawItem.title.trim().length === 0) {
    throw new Error(
      `normaliseItem: raw item missing required "title" field (got ${JSON.stringify(rawItem)})`
    );
  }
  return {
    title: rawItem.title.trim(),
    body: typeof rawItem.body === "string" ? rawItem.body.trim() : "",
    source: "hyperpolymath",
  };
}

// ---------------------------------------------------------------------------
// captureToQueue — core adapter (CAPTURE-01..03)
// ---------------------------------------------------------------------------

/**
 * Run one capture pass: fetch raw items from `source`, normalise each one,
 * and either enqueue them (dryRun=false) or report what would be enqueued
 * (dryRun=true, the default).
 *
 * Idempotent: re-running with dryRun=false does NOT create duplicates because
 * addItem() deduplicates by SHA-256 content key (title+body). Items already
 * in a non-terminal state return the existing id without writing a new record.
 *
 * @param {object} opts
 * @param {Function}  opts.source   — async () => RawItem[]; the item source to pull from
 * @param {boolean}   [opts.dryRun=true]  — if true, report without enqueuing (default)
 * @param {Function}  [opts._addItem]  — override for addItem (used by isolated tests)
 * @param {Function}  [opts._loadStore] — override for loadStore (used by isolated tests)
 * @returns {Promise<{
 *   dryRun: boolean,
 *   fetched: number,
 *   wouldEnqueue: object[],
 *   enqueued: object[],
 *   skipped: object[],
 *   errors: object[]
 * }>}
 */
export async function captureToQueue({
  source,
  dryRun = true,
  _addItem = addItem,
  _loadStore = loadStore,
}) {
  if (typeof source !== "function") {
    throw new Error("captureToQueue: `source` must be an async function returning raw items");
  }

  // Fetch raw items from the injected source
  let rawItems;
  try {
    rawItems = await source();
  } catch (err) {
    throw new Error(`captureToQueue: source() threw: ${err.message}`);
  }

  if (!Array.isArray(rawItems)) {
    throw new Error(`captureToQueue: source() must return an array, got ${typeof rawItems}`);
  }

  const wouldEnqueue = [];
  const enqueued = [];
  const skipped = [];
  const errors = [];

  for (const rawItem of rawItems) {
    let normalised;
    try {
      normalised = normaliseItem(rawItem);
    } catch (err) {
      errors.push({ rawItem, error: err.message });
      continue;
    }

    const key = contentKey(normalised.title, normalised.body);

    if (dryRun) {
      // In dry-run mode: check whether this item already exists in the store
      // to give an accurate preview. We do NOT write anything.
      let alreadyExists = false;
      try {
        const store = _loadStore();
        const TERMINAL_STATES = ["done", "failed", "blocked", "needs_input"];
        alreadyExists = store.items.some(
          (item) => item.content_key === key && !TERMINAL_STATES.includes(item.state)
        );
      } catch (_) {
        // If the store doesn't exist yet (fresh run), treat as not-existing
        alreadyExists = false;
      }

      wouldEnqueue.push({
        title: normalised.title,
        body: normalised.body,
        source: normalised.source,
        content_key: key,
        already_exists: alreadyExists,
        raw_id: rawItem.id ?? null,
      });
    } else {
      // Real enqueue via addItem (dedup happens inside addItem via content key)
      try {
        const id = _addItem(normalised);
        enqueued.push({
          id,
          title: normalised.title,
          body: normalised.body,
          source: normalised.source,
          content_key: key,
          raw_id: rawItem.id ?? null,
        });
      } catch (err) {
        errors.push({ rawItem: normalised, error: err.message });
      }
    }
  }

  // Detect skipped (deduped) items: items in enqueued list where id already existed.
  // addItem returns the existing id for duplicates; we report them separately.
  // Since addItem doesn't tell us if it was new or existing, we check:
  // items that had already_exists=true in a prior dry-run can be skipped here.
  // In real-enqueue mode, we mark as skipped any item whose content_key
  // appears more than once in the enqueued list (collapsed duplicates).
  if (!dryRun) {
    const seenKeys = new Set();
    for (const item of enqueued) {
      if (seenKeys.has(item.content_key)) {
        skipped.push(item);
      } else {
        seenKeys.add(item.content_key);
      }
    }
    // Remove skipped from enqueued (they were collapsed, not actually new writes)
    // Note: addItem returns the existing id for dupes, so no second write occurred.
    // We keep them in `enqueued` for traceability and also in `skipped` for reporting.
  }

  return {
    dryRun,
    fetched: rawItems.length,
    wouldEnqueue: dryRun ? wouldEnqueue : [],
    enqueued: dryRun ? [] : enqueued,
    skipped,
    errors,
  };
}

// ---------------------------------------------------------------------------
// printCaptureResult — human-readable report
// ---------------------------------------------------------------------------

/**
 * Print a compact, human-readable report of a capture pass result.
 *
 * @param {object} result  — return value of captureToQueue()
 */
export function printCaptureResult(result) {
  const { dryRun, fetched, wouldEnqueue, enqueued, skipped, errors } = result;

  process.stdout.write("\nbgsd capture result\n");
  process.stdout.write(`  mode        ${dryRun ? "dry-run (no changes written)" : "LIVE (items enqueued)"}\n`);
  process.stdout.write(`  fetched     ${fetched} item(s) from source\n`);

  if (dryRun) {
    process.stdout.write(`  would-enqueue  ${wouldEnqueue.length} item(s)\n`);
    for (const item of wouldEnqueue) {
      const note = item.already_exists ? " [already in queue — would dedup]" : "";
      process.stdout.write(`    - [${item.raw_id ?? "?"}] "${item.title}"${note}\n`);
    }
  } else {
    process.stdout.write(`  enqueued    ${enqueued.length} item(s)\n`);
    for (const item of enqueued) {
      process.stdout.write(`    + [${item.id}] "${item.title}"  (source_id=${item.raw_id ?? "?"})\n`);
    }
    if (skipped.length > 0) {
      process.stdout.write(`  deduped     ${skipped.length} item(s) (content-key match, not re-added)\n`);
    }
  }

  if (errors.length > 0) {
    process.stdout.write(`  errors      ${errors.length} item(s) failed normalisation\n`);
    for (const e of errors) {
      process.stdout.write(`    ! ${e.error}\n`);
    }
  }

  process.stdout.write("\n");
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
  const dryRun = !argv.includes("--no-dry-run");
  const useLive = argv.includes("--live");

  let source;

  if (useLive) {
    // Delegate to the guarded live adapter (it will refuse if --live guard not satisfied)
    const { liveCaptureSource } = await import(
      `file://${resolve(__dir, "capture-live.mjs")}`
    );
    source = liveCaptureSource;
  } else {
    // Default: use the mock source (safe, deterministic, no external calls)
    const { mockSource } = await import(
      `file://${resolve(__dir, "__fixtures__/hyperpolymath-mock.mjs")}`
    );
    source = mockSource;
  }

  try {
    const result = await captureToQueue({ source, dryRun });
    printCaptureResult(result);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`capture: fatal error: ${err.message}\n`);
    process.exit(1);
  }
}
