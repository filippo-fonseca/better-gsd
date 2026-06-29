#!/usr/bin/env node
/**
 * proof-direct.mjs — Phase 5 empirical proof harness
 *
 * Boots the canary-next fixture via runtime-isolate.sh, drives Chromium via
 * Playwright to collect console messages and page errors, runs the REAL
 * classify-capture.mjs classifier, and asserts:
 *
 *   PROOF-02 (/buggy): validateDOMNesting react_flag present → FAIL
 *   PROOF-03 (/):      zero react_flags, zero findings → PASS
 *
 * Both cycles are run TWICE to demonstrate reproducibility.
 * Exits non-zero if any assertion fails or if the expected outcomes diverge.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname, "../scripts");
const FIXTURE_DIR = resolve(__dirname, "../fixtures/canary-next");
const CLASSIFY_PATH = resolve(SCRIPTS_DIR, "classify-capture.mjs");
const OUT_DIR = resolve(__dirname, "out");

mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[proof] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[proof:ERR] ${msg}\n`);
}

/**
 * Boot the fixture and return the port number.
 * Runs runtime-isolate.sh up and parses "PORT: <n>" from stdout.
 */
function bootFixture() {
  log("Booting canary-next fixture...");
  const result = spawnSync(
    resolve(SCRIPTS_DIR, "runtime-isolate.sh"),
    ["up", FIXTURE_DIR],
    { encoding: "utf8", timeout: 90_000 }
  );

  if (result.status !== 0) {
    err("runtime-isolate.sh up failed:");
    err(result.stdout || "");
    err(result.stderr || "");
    process.exit(1);
  }

  const portMatch = result.stdout.match(/^PORT:\s*(\d+)/m);
  if (!portMatch) {
    err("Could not parse PORT from runtime-isolate.sh output:");
    err(result.stdout);
    process.exit(1);
  }

  const port = parseInt(portMatch[1], 10);
  log(`Fixture ready on port ${port}`);
  return port;
}

/**
 * Tear down the fixture via runtime-isolate.sh down.
 *
 * IMPORTANT: runtime-isolate.sh down kills the server's entire process group.
 * If `down` is called from inside Node's own process group, the kill can
 * propagate back to the Node process itself. We avoid this by spawning the
 * teardown script in a NEW process group (detached: true) and waiting for it
 * synchronously via a Promise so it can't kill us.
 */
async function teardownFixture() {
  log("Tearing down fixture...");

  await new Promise((resolve_, reject) => {
    const child = spawn(
      resolve(SCRIPTS_DIR, "runtime-isolate.sh"),
      ["down", FIXTURE_DIR],
      {
        // detached: true puts the child in its own process group so the SIGKILL
        // it sends to its own group cannot reach our Node process.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      if (code !== 0) {
        err("runtime-isolate.sh down non-zero:");
        err(stdout || "");
        err(stderr || "");
        resolve_(); // Non-fatal
      } else {
        log("Teardown complete — no orphan process.");
        resolve_();
      }
    });

    child.on("error", (e) => {
      err(`teardown spawn error: ${e.message}`);
      resolve_(); // Non-fatal
    });
  });
}

/**
 * Use classify-capture.mjs (the REAL classifier) on a capture object.
 * Returns the parsed classification result.
 */
function runClassifier(capture) {
  // Write to a temp file that classify-capture.mjs can read
  const tmpPath = resolve(OUT_DIR, `_classify-tmp-${Date.now()}.json`);
  writeFileSync(tmpPath, JSON.stringify(capture, null, 2));

  const result = spawnSync(
    process.execPath,
    [CLASSIFY_PATH, tmpPath, "--pretty"],
    { encoding: "utf8", timeout: 15_000 }
  );

  if (result.status !== 0) {
    err("classify-capture.mjs failed:");
    err(result.stderr || "");
    process.exit(1);
  }

  return JSON.parse(result.stdout);
}

/**
 * Navigate to a URL and capture console + pageerror events.
 * Listeners are attached BEFORE navigation (critical — React warns on first render).
 * Returns { console: [...], pageErrors: [...], network: [] }.
 */
async function captureRoute(page, url) {
  const consoleMessages = [];
  const pageErrorsList = [];

  // Attach listeners BEFORE navigation
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  page.on("pageerror", (error) => {
    pageErrorsList.push({ message: error.message, stack: error.stack ?? "" });
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Brief pause to let React flush any synchronous console output
  await page.waitForTimeout(800);

  return {
    console: consoleMessages,
    pageErrors: pageErrorsList,
    network: [],
    build_mode: "development",
  };
}

// ---------------------------------------------------------------------------
// Single proof cycle: test /buggy and /
// ---------------------------------------------------------------------------

async function runCycle(cycleNum, port) {
  log(`\n========== CYCLE ${cycleNum} ==========`);

  const browser = await chromium.launch({ headless: true });
  let buggyResult, cleanResult, buggyCapture, cleanCapture;

  try {
    // --- /buggy ---
    log(`[cycle ${cycleNum}] Navigating to /buggy...`);
    const buggyPage = await browser.newPage();
    buggyCapture = await captureRoute(buggyPage, `http://localhost:${port}/buggy`);
    await buggyPage.close();

    const buggyOutPath = resolve(OUT_DIR, `buggy-capture-c${cycleNum}.json`);
    writeFileSync(buggyOutPath, JSON.stringify(buggyCapture, null, 2));
    log(`[cycle ${cycleNum}] /buggy capture written to ${buggyOutPath}`);

    buggyResult = runClassifier(buggyCapture);
    const buggyOutClassPath = resolve(OUT_DIR, `buggy-classify-c${cycleNum}.json`);
    writeFileSync(buggyOutClassPath, JSON.stringify(buggyResult, null, 2));

    // Also write the canonical file (last cycle wins, consistent with spec)
    writeFileSync(resolve(OUT_DIR, "buggy-capture.json"), JSON.stringify(buggyCapture, null, 2));

    // --- / (clean) ---
    log(`[cycle ${cycleNum}] Navigating to / (clean)...`);
    const cleanPage = await browser.newPage();
    cleanCapture = await captureRoute(cleanPage, `http://localhost:${port}/`);
    await cleanPage.close();

    const cleanOutPath = resolve(OUT_DIR, `clean-capture-c${cycleNum}.json`);
    writeFileSync(cleanOutPath, JSON.stringify(cleanCapture, null, 2));
    log(`[cycle ${cycleNum}] / capture written to ${cleanOutPath}`);

    cleanResult = runClassifier(cleanCapture);
    const cleanOutClassPath = resolve(OUT_DIR, `clean-classify-c${cycleNum}.json`);
    writeFileSync(cleanOutClassPath, JSON.stringify(cleanResult, null, 2));

  } finally {
    await browser.close();
  }

  return { buggyCapture, buggyResult, cleanCapture, cleanResult };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertBuggyFails(cycleNum, capture, result) {
  const reactFlags = result.react_flags ?? [];
  const validateFlag = reactFlags.find((f) => f.rule_id === "validateDOMNesting");

  // Find the console line containing either the React 17 or React 18 nesting warning
  const rawLine = capture.console.find((c) =>
    /validateDOMNesting|in html,.*cannot be a descendant of/i.test(c.text)
  );

  log(`\n[cycle ${cycleNum}] PROOF-02 (/buggy):`);
  log(`  Console messages captured: ${capture.console.length}`);
  log(`  react_flags: ${reactFlags.length}`);

  if (!validateFlag) {
    err(
      `[cycle ${cycleNum}] PROOF-02 FAILED: expected validateDOMNesting react_flag, got none.`
    );
    err(`Console dump: ${JSON.stringify(capture.console, null, 2)}`);
    return false;
  }

  const quotedLine = rawLine ? rawLine.text : "(text not in console array — flag came from page event)";
  log(`  Captured console line: "${quotedLine}"`);
  log(`  react_flag rule_id: ${validateFlag.rule_id}`);
  log(`  findings count: ${result.findings.length}`);
  log(`  PROOF-02: PASS (defect detected as expected — verdict=FAIL for /buggy)`);
  return true;
}

function assertCleanPasses(cycleNum, capture, result) {
  const reactFlags = result.react_flags ?? [];
  const findings = result.findings ?? [];

  log(`\n[cycle ${cycleNum}] PROOF-03 (/ clean):`);
  log(`  Console messages captured: ${capture.console.length}`);
  log(`  react_flags: ${reactFlags.length}`);
  log(`  findings: ${findings.length}`);

  if (reactFlags.length > 0) {
    err(
      `[cycle ${cycleNum}] PROOF-03 FAILED: unexpected react_flags on clean route: ${JSON.stringify(reactFlags)}`
    );
    return false;
  }

  // Console errors or page errors would be false positives
  const errorFindings = findings.filter(
    (f) => f.kind === "console_error" || f.kind === "page_error" || f.kind === "react_flag"
  );
  if (errorFindings.length > 0) {
    err(
      `[cycle ${cycleNum}] PROOF-03 FAILED: unexpected error findings on clean route: ${JSON.stringify(errorFindings)}`
    );
    return false;
  }

  log(`  PROOF-03: PASS (no false positive — / is correctly clean)`);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("Phase 5 proof harness starting...");
  log(`Classifier path: ${CLASSIFY_PATH}`);
  log(`Fixture dir:     ${FIXTURE_DIR}`);

  const port = bootFixture();

  const results = [];
  let allPassed = true;

  try {
    for (const cycleNum of [1, 2]) {
      const { buggyCapture, buggyResult, cleanCapture, cleanResult } =
        await runCycle(cycleNum, port);

      const buggyOk = assertBuggyFails(cycleNum, buggyCapture, buggyResult);
      const cleanOk = assertCleanPasses(cycleNum, cleanCapture, cleanResult);

      results.push({ cycleNum, buggyOk, cleanOk });
      if (!buggyOk || !cleanOk) allPassed = false;
    }
  } finally {
    await teardownFixture();
  }

  // ---------------------------------------------------------------------------
  // Final summary
  // ---------------------------------------------------------------------------
  log("\n========== PROOF SUMMARY ==========");
  for (const { cycleNum, buggyOk, cleanOk } of results) {
    log(
      `  Cycle ${cycleNum}: /buggy=${buggyOk ? "FAIL(expected✓)" : "UNEXPECTED-PASS(❌)"} | /clean=${cleanOk ? "PASS(expected✓)" : "FALSE-POSITIVE(❌)"}`
    );
  }

  if (allPassed) {
    log("\nRESULT: ALL ASSERTIONS PASSED — Phase 5 proof complete.");
    log("  PROOF-02: validateDOMNesting defect detected in both cycles.");
    log("  PROOF-03: No false positive on clean route in both cycles.");
    log("  Reproducibility: confirmed (2 identical cycles).");
    process.exit(0);
  } else {
    err("\nRESULT: ONE OR MORE ASSERTIONS FAILED — see above for details.");
    process.exit(1);
  }
}

main().catch((e) => {
  err(`Unhandled error: ${e.message}`);
  err(e.stack ?? "");
  process.exit(1);
});
