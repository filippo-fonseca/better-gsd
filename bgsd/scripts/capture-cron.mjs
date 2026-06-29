#!/usr/bin/env node
/**
 * capture-cron.mjs — Scheduled Hyperpolymath capture wrapper (Phase 4: CAPTURE-03/04)
 *
 * This is the cron-safe entry point for the Hyperpolymath capture→queue drop.
 * It defaults to:
 *   - --dry-run (safe, no writes)
 *   - the mock source (no external calls)
 *
 * The live path requires an explicit --live flag AND configuration of the
 * live source adapter (see capture-live.mjs).
 *
 * ============================================================================
 * SCHEDULING — HUMAN STEP (DO NOT AUTOMATE --live IN CI)
 * ============================================================================
 * To schedule this as a recurring drop, add ONE of the following to your
 * system scheduler. Choose based on your OS:
 *
 * macOS crontab (run every 30 minutes, dry-run only — safe):
 *   crontab -e
 *   # Add:
 *   * /30 * * * * /usr/local/bin/node /path/to/better-gsd/bgsd/scripts/capture-cron.mjs >> /tmp/bgsd-capture.log 2>&1
 *
 * macOS launchd (recommended for macOS — more reliable than crontab):
 *   1. Copy bgsd/docs/com.bgsd.capture-cron.plist to ~/Library/LaunchAgents/
 *   2. Edit the ProgramArguments path to match your repo location.
 *   3. Run: launchctl load ~/Library/LaunchAgents/com.bgsd.capture-cron.plist
 *   (See bgsd/commands/bgsd-capture.md for the full launchd setup walkthrough.)
 *
 * LIVE ENQUEUE (requires human configuration and opt-in):
 *   To enable real Hyperpolymath → queue drops:
 *     1. Configure HYPERPOLYMATH_SOURCE_PATH or HYPERPOLYMATH_API_ENDPOINT.
 *     2. Implement the LIVE WIRING POINT in capture-live.mjs.
 *     3. Test with: node bgsd/scripts/capture-cron.mjs --live
 *        (dry-run by default; add --no-dry-run to actually enqueue)
 *     4. Only add --no-dry-run to the crontab after validating dry-run output.
 *
 * NEVER add --live to an automated CI/CD pipeline (CAPTURE-04, NFR-07).
 * ============================================================================
 *
 * Usage:
 *   node bgsd/scripts/capture-cron.mjs               # dry-run, mock source
 *   node bgsd/scripts/capture-cron.mjs --live        # dry-run, live source (guarded)
 *   node bgsd/scripts/capture-cron.mjs --no-dry-run  # real enqueue, mock source
 *   node bgsd/scripts/capture-cron.mjs --live --no-dry-run  # real enqueue, live source
 *
 * Exit codes:
 *   0 — success (dry-run preview or successful enqueue)
 *   1 — fatal error (source refused, normalisation error, queue write failed)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureToQueue, printCaptureResult } from "./capture.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const dryRun   = !argv.includes("--no-dry-run");
const useLive  = argv.includes("--live");

// ---------------------------------------------------------------------------
// Resolve source
// ---------------------------------------------------------------------------

let source;

if (useLive) {
  // Guarded live adapter — will refuse if --live guard conditions not met
  // or if LIVE WIRING POINT not configured (see capture-live.mjs)
  const { liveCaptureSource } = await import(
    `file://${resolve(__dir, "capture-live.mjs")}`
  );
  source = liveCaptureSource;
} else {
  // Default: deterministic mock source — safe, no external calls (CAPTURE-02)
  const { mockSource } = await import(
    `file://${resolve(__dir, "__fixtures__/hyperpolymath-mock.mjs")}`
  );
  source = mockSource;
}

// ---------------------------------------------------------------------------
// Run capture pass
// ---------------------------------------------------------------------------

process.stdout.write(
  `\nbgsd capture-cron: starting capture pass\n` +
  `  source:  ${useLive ? "live (hyperpolymath)" : "mock (fixture)"}\n` +
  `  dry-run: ${dryRun}\n` +
  `  time:    ${new Date().toISOString()}\n\n`
);

try {
  const result = await captureToQueue({ source, dryRun });
  printCaptureResult(result);

  if (dryRun) {
    process.stdout.write(
      "bgsd capture-cron: dry-run complete — no items written.\n" +
      "  To enqueue for real: node bgsd/scripts/capture-cron.mjs --no-dry-run\n\n"
    );
  } else {
    process.stdout.write(
      `bgsd capture-cron: capture pass complete.\n` +
      `  ${result.enqueued.length} item(s) enqueued, ${result.errors.length} error(s).\n\n`
    );
  }

  // Exit non-zero only on errors (NFR-06: no silent green)
  process.exit(result.errors.length > 0 ? 1 : 0);
} catch (err) {
  process.stderr.write(`capture-cron: fatal error: ${err.message}\n`);
  process.exit(1);
}
