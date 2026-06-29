#!/usr/bin/env node
/**
 * classify-capture.mjs — DRIVER-02/04
 *
 * Reads a captured-evidence JSON file produced by the bgsd tester after
 * collecting MCP browser-tool output, and emits a classified findings JSON
 * containing only the "failing slice" (matched/failing items).
 *
 * Usage:
 *   node bgsd/scripts/classify-capture.mjs <path-to-capture.json>
 *   node bgsd/scripts/classify-capture.mjs <path-to-capture.json> --pretty
 *
 * Input shape (capture.json):
 * {
 *   "console":    [ { "type": "error|warning|log|info", "text": "..." } ],
 *   "pageErrors": [ { "message": "...", "stack": "..." } ],
 *   "network":    [ { "url": "...", "status": 200, "ok": true } ],
 *   "build_mode": "development|production"
 * }
 *
 * Output shape:
 * {
 *   "findings":        [...],   // merged list of all actionable findings
 *   "buckets": {
 *     "errors":        [...],   // console entries with type=="error"
 *     "warnings":      [...],   // console entries with type=="warning"
 *     "pageErrors":    [...]    // uncaught page-level errors
 *   },
 *   "react_flags":     [...],   // React-pattern matches (subset of errors+warnings)
 *   "network_failures":[...],   // network entries with ok==false || status>=400
 *   "build_mode":      "development|production",
 *   "console_reliable": bool    // false when build_mode=="production" (DRIVER-04)
 * }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// REACT WARNING REGEX TABLE
// Each entry: { id, pattern, description }
// Add new rows here to extend detection without touching classifier logic.
// ---------------------------------------------------------------------------
const REACT_WARNING_REGEXES = [
  {
    id: "validateDOMNesting",
    // Matches the React 17 form:
    //   "Warning: validateDOMNesting(...): <div> cannot appear as a descendant of <p>."
    // AND the React 18 / Next.js 14 form:
    //   "Warning: In HTML, <div> cannot be a descendant of <p>."
    //   "Warning: In HTML, %s cannot be a descendant of <%s>."
    // Both indicate an invalid DOM nesting that a screenshot would miss.
    pattern: /validateDOMNesting|in html,.*cannot be a descendant of/i,
    description: "Invalid DOM nesting (e.g. <div> inside <p>)",
  },
  {
    id: "hydration_mismatch",
    // Matches React 18 hydration failure messages in multiple forms:
    //   "Hydration failed because the initial UI does not match what was rendered on the server."
    //   "Text content does not match server-rendered HTML."
    //   "Error: Hydration failed"
    //   "Warning: Expected server HTML to contain a matching ..."
    //   "did not match" (shorter variant used in some React 17 messages)
    pattern:
      /hydration failed|text content does not match server-rendered html|did not match.*server|expected server html/i,
    description:
      "Hydration mismatch between server-rendered HTML and client render",
  },
  {
    id: "missing_key_prop",
    // Matches: "Warning: Each child in a list should have a unique \"key\" prop."
    // and the shorter "missing key" variant.
    pattern: /each child in a list should have a unique.*key|missing.*key prop/i,
    description: 'Missing "key" prop on list children',
  },
];

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

/**
 * @param {object} capture — parsed capture.json object
 * @returns classified findings object
 */
export function classify(capture) {
  const console_ = Array.isArray(capture.console) ? capture.console : [];
  const pageErrors = Array.isArray(capture.pageErrors)
    ? capture.pageErrors
    : [];
  const network = Array.isArray(capture.network) ? capture.network : [];
  const buildMode =
    capture.build_mode === "production" ? "production" : "development";

  // DRIVER-04: console assertions are unreliable in production builds because
  // minification and dead-code elimination remove React's warning code paths.
  const consoleReliable = buildMode !== "production";

  // --- Bucket console messages ---
  const bucketErrors = console_.filter((e) => e.type === "error");
  const bucketWarnings = console_.filter((e) => e.type === "warning");

  // --- React-flag matching ---
  // Apply each regex against errors AND warnings (React sometimes uses
  // console.warn for these, sometimes console.error depending on version).
  const reactFlags = [];
  const candidateMessages = [...bucketErrors, ...bucketWarnings];

  for (const entry of candidateMessages) {
    const text = entry.text ?? "";
    for (const rule of REACT_WARNING_REGEXES) {
      if (rule.pattern.test(text)) {
        reactFlags.push({
          rule_id: rule.id,
          description: rule.description,
          source: entry,
        });
        // Only flag each entry once per rule (break inner loop on first match
        // for this entry, but keep iterating entries).
        break;
      }
    }
  }

  // --- Network failures ---
  // A network entry is a failure if ok===false OR status >= 400.
  // We treat missing/null `ok` as a failure only when status is also >= 400.
  const networkFailures = network.filter(
    (req) =>
      req.ok === false || (typeof req.status === "number" && req.status >= 400)
  );

  // --- Aggregate findings ---
  // findings is the master list of everything actionable from this run.
  const findings = [];

  for (const e of bucketErrors) {
    findings.push({ kind: "console_error", entry: e });
  }
  for (const e of pageErrors) {
    findings.push({ kind: "page_error", entry: e });
  }
  for (const f of reactFlags) {
    findings.push({ kind: "react_flag", rule_id: f.rule_id, entry: f.source });
  }
  for (const n of networkFailures) {
    findings.push({ kind: "network_failure", entry: n });
  }

  return {
    findings,
    buckets: {
      errors: bucketErrors,
      warnings: bucketWarnings,
      pageErrors,
    },
    react_flags: reactFlags,
    network_failures: networkFailures,
    build_mode: buildMode,
    console_reliable: consoleReliable,
  };
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
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const pretty = flags.includes("--pretty");

  if (args.length === 0) {
    process.stderr.write(
      "Usage: classify-capture.mjs <capture.json> [--pretty]\n"
    );
    process.exit(1);
  }

  const inputPath = resolve(process.cwd(), args[0]);
  let raw;
  try {
    raw = readFileSync(inputPath, "utf8");
  } catch (err) {
    process.stderr.write(`Error reading file: ${err.message}\n`);
    process.exit(1);
  }

  let capture;
  try {
    capture = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Error parsing JSON: ${err.message}\n`);
    process.exit(1);
  }

  const result = classify(capture);
  process.stdout.write(
    pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)
  );
  process.stdout.write("\n");
}
