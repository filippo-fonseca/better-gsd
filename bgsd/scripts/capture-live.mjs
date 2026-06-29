#!/usr/bin/env node
/**
 * capture-live.mjs — Guarded live Hyperpolymath source seam (Phase 4: CAPTURE-04)
 *
 * HUMAN-GATED — NEVER EXECUTED AUTOMATICALLY
 * ===========================================
 * This module is the real Hyperpolymath source adapter. It MUST NOT be called
 * without an explicit --live flag. Without it, every exported function throws
 * an immediate, human-readable refusal (NFR-07).
 *
 * The mock path (capture.mjs + hyperpolymath-mock.mjs) is the ONLY path that
 * automated tests use. This file is never imported by tests and is never
 * executed in CI (CAPTURE-04).
 *
 * WHAT THIS FILE PROVIDES
 * =======================
 * - isLiveFlagSet()      — returns true only if "--live" is in process.argv
 * - liveCaptureSource()  — the real item-fetch function; refuses without --live
 *
 * LIVE WIRING POINT (human-gated, off by default)
 * ================================================
 * To connect this seam to the real Hyperpolymath system:
 *
 *   1. Set HYPERPOLYMATH_SOURCE_PATH (or endpoint/credential) in your
 *      environment or .env.local — never commit credentials to the repo.
 *
 *   2. Implement the fetch logic inside the "LIVE WIRING POINT" block below
 *      (currently a documented stub that throws). The function must return
 *      an array matching the raw-item shape:
 *        [ { id, title, body, created_at }, ... ]
 *
 *   3. Invoke with the explicit --live flag:
 *        node bgsd/scripts/capture-cron.mjs --live
 *      or
 *        node bgsd/scripts/capture.mjs --live --no-dry-run
 *
 *   4. Validate results with a --dry-run first (the default). Only remove
 *      --no-dry-run once you have confirmed the items look correct.
 *
 * NEVER:
 *   - Add --live to CI/CD pipelines or scheduled automation.
 *   - Commit real credentials to this file or to the repo.
 *   - Run this against the `next` branch (NFR-01).
 *   - Skip the dry-run validation step before the first live enqueue.
 *
 * CONFIGURATION
 * =============
 * The live adapter reads its source configuration from environment variables
 * (documented below). No config is baked into this file; all live wiring is
 * operator-supplied at invocation time.
 *
 * Environment variables (all optional until live wiring is implemented):
 *   HYPERPOLYMATH_SOURCE_PATH   — path to a local hyperpolymath export file
 *                                  (e.g. ~/hyperpolymath/captures/latest.json)
 *   HYPERPOLYMATH_API_ENDPOINT  — URL of the hyperpolymath capture API
 *                                  (if using network fetch)
 *   HYPERPOLYMATH_API_KEY       — API key/token for the endpoint
 *                                  (NEVER commit this; load from env only)
 *
 * Usage (human, supervised only):
 *   node bgsd/scripts/capture-cron.mjs --live
 *   node bgsd/scripts/capture.mjs --live --no-dry-run
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// HUMAN-GATED GUARD (NFR-07) — must be the first executable code
// ---------------------------------------------------------------------------

/**
 * Check whether the --live flag was explicitly passed on the command line.
 * Returns true only if "--live" appears in process.argv (not in env vars,
 * which can be accidentally injected by CI).
 *
 * @returns {boolean}
 */
export function isLiveFlagSet() {
  return process.argv.includes("--live");
}

/**
 * Throw a human-readable refusal if --live is not explicitly set.
 * Called by every exported live function before doing any real work.
 *
 * @throws {Error} if --live is not in process.argv
 */
function requireLiveFlag() {
  if (!isLiveFlagSet()) {
    throw new Error(
      "\n" +
      "======================================================================\n" +
      "HUMAN-GATED: capture-live.mjs refused to run.\n" +
      "\n" +
      "The live Hyperpolymath capture path requires an explicit --live flag\n" +
      "to prevent accidental external calls from automation or CI.\n" +
      "\n" +
      "What you must configure before running live:\n" +
      "  1. Set HYPERPOLYMATH_SOURCE_PATH or HYPERPOLYMATH_API_ENDPOINT\n" +
      "     (see comments in capture-live.mjs for the full list).\n" +
      "  2. Implement the fetch logic inside the LIVE WIRING POINT block.\n" +
      "  3. Run with --dry-run first to confirm items look correct.\n" +
      "  4. Only then add --no-dry-run for a real enqueue.\n" +
      "\n" +
      "To run dry-run against the mock (safe, no config needed):\n" +
      "  node bgsd/scripts/capture-cron.mjs\n" +
      "\n" +
      "To run live (supervised only, after configuration):\n" +
      "  node bgsd/scripts/capture-cron.mjs --live\n" +
      "\n" +
      "DO NOT:\n" +
      "  - Add --live to CI/CD scripts or scheduled automation.\n" +
      "  - Run live against the 'next' branch (NFR-01).\n" +
      "  - Skip the dry-run validation step.\n" +
      "======================================================================\n"
    );
  }
}

// ---------------------------------------------------------------------------
// Live capture source — the real Hyperpolymath adapter
// ---------------------------------------------------------------------------

/**
 * Fetch raw capture items from the real Hyperpolymath system.
 *
 * HUMAN-GATED: refuses without --live (NFR-07). NEVER call from CI.
 *
 * Returns an array of raw items in the capture seam's input shape:
 *   [ { id, title, body, created_at }, ... ]
 *
 * LIVE WIRING POINT
 * =================
 * The implementation below is a documented stub that throws a clear error
 * directing the operator to configure the source. Replace it with the real
 * fetch logic once the live source is set up:
 *
 *   Option A — local file source:
 *     const path = process.env.HYPERPOLYMATH_SOURCE_PATH;
 *     if (!path) throw new Error("HYPERPOLYMATH_SOURCE_PATH not set");
 *     const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
 *     return raw.items ?? raw;   // adjust to match the real export shape
 *
 *   Option B — API endpoint (requires Node 18+ built-in fetch):
 *     const endpoint = process.env.HYPERPOLYMATH_API_ENDPOINT;
 *     const apiKey   = process.env.HYPERPOLYMATH_API_KEY;
 *     if (!endpoint) throw new Error("HYPERPOLYMATH_API_ENDPOINT not set");
 *     const resp = await fetch(endpoint, {
 *       headers: { Authorization: `Bearer ${apiKey}` },
 *     });
 *     if (!resp.ok) throw new Error(`API error: ${resp.status} ${resp.statusText}`);
 *     const data = await resp.json();
 *     return data.items ?? data;
 *
 * @returns {Promise<Array<{id: string, title: string, body: string, created_at: string}>>}
 * @throws {Error} always — until the LIVE WIRING POINT is implemented
 */
export async function liveCaptureSource() {
  requireLiveFlag();

  // ------------------------------------------------------------------
  // LIVE WIRING POINT — replace the throw below with the real fetch.
  // See the Option A / Option B examples in the JSDoc above.
  // ------------------------------------------------------------------
  const sourcePath = process.env.HYPERPOLYMATH_SOURCE_PATH;
  const apiEndpoint = process.env.HYPERPOLYMATH_API_ENDPOINT;

  if (!sourcePath && !apiEndpoint) {
    throw new Error(
      "capture-live: LIVE WIRING POINT not configured.\n" +
      "\n" +
      "Set one of the following environment variables to enable live capture:\n" +
      "  HYPERPOLYMATH_SOURCE_PATH   — path to a local hyperpolymath export\n" +
      "  HYPERPOLYMATH_API_ENDPOINT  — URL of the hyperpolymath capture API\n" +
      "\n" +
      "Then implement the fetch logic inside the LIVE WIRING POINT block in\n" +
      "bgsd/scripts/capture-live.mjs. See comments for Option A / Option B.\n" +
      "\n" +
      "Until then, use the mock source (the default):\n" +
      "  node bgsd/scripts/capture-cron.mjs        # dry-run against mock\n" +
      "  node bgsd/scripts/capture.mjs             # same\n"
    );
  }

  // If HYPERPOLYMATH_SOURCE_PATH is set: read a local file
  if (sourcePath) {
    const absPath = resolve(sourcePath);
    if (!existsSync(absPath)) {
      throw new Error(
        `capture-live: HYPERPOLYMATH_SOURCE_PATH="${sourcePath}" does not exist (resolved: ${absPath})`
      );
    }
    const raw = JSON.parse(readFileSync(absPath, "utf8"));
    // Accommodate both { items: [...] } and bare array shapes
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    return items;
  }

  // If HYPERPOLYMATH_API_ENDPOINT is set: fetch from API
  // (Requires HYPERPOLYMATH_API_KEY to be set for authenticated endpoints.)
  const apiKey = process.env.HYPERPOLYMATH_API_KEY ?? "";
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  // Built-in fetch (Node 18+). If running on Node <18, install node-fetch.
  const resp = await fetch(apiEndpoint, { headers });
  if (!resp.ok) {
    throw new Error(
      `capture-live: API error from ${apiEndpoint}: ${resp.status} ${resp.statusText}`
    );
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

// ---------------------------------------------------------------------------
// CLI entrypoint (human-supervised only)
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
  try {
    requireLiveFlag();
  } catch (err) {
    process.stderr.write(err.message);
    process.exit(1);
  }

  process.stderr.write(
    "\n[capture-live] --live flag detected.\n" +
    "  Call liveCaptureSource() programmatically via capture-cron.mjs --live.\n" +
    "  This CLI entrypoint is for guard verification only.\n\n"
  );
  process.exit(0);
}
