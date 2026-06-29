#!/usr/bin/env node
/**
 * classify-item.mjs — Phase 2: ROUTE-01
 *
 * Classifies a queue item (title + body) into one of four route classes using a
 * cheap, deterministic, keyword/heuristic rule-based function. Zero model calls,
 * zero network calls. Fully unit-testable in isolation.
 *
 * ROUTE CLASSES
 * =============
 *   trivial-fix        — small, self-contained bug fixes (typo, style, copy)
 *   scoped-fix         — bounded bug fixes with clear scope (crash, regression)
 *   feature            — new capability, enhancement, or non-trivial change
 *   needs-clarification — item is ambiguous; must park in needs_input
 *
 * SEAM FOR LOW-COST MODEL (HAIKU)
 * ================================
 * The function `classifyWithModel(title, body)` below is a clearly-marked stub.
 * When Part 11's Haiku classify row is activated, replace the body of that
 * function with a Haiku API call. The heuristic path remains as a fast fallback
 * / offline path. Do NOT remove it.
 *
 * Usage (library):
 *   import { classifyItem } from './classify-item.mjs';
 *   const result = classifyItem({ title, body });
 *   // => { route_class: 'trivial-fix', confidence: 'heuristic', signals: [...] }
 *
 * Usage (CLI, for manual testing):
 *   node bgsd/scripts/classify-item.mjs --title "Fix typo in README" [--body "..."]
 */

// ---------------------------------------------------------------------------
// Route class constants — single source of truth
// ---------------------------------------------------------------------------

/**
 * All valid route classes for Phase 2.
 * @type {readonly string[]}
 */
export const ROUTE_CLASSES = Object.freeze([
  "trivial-fix",
  "scoped-fix",
  "feature",
  "needs-clarification",
]);

// ---------------------------------------------------------------------------
// Keyword/heuristic rule tables
// ---------------------------------------------------------------------------

/**
 * Signals that strongly suggest a trivial, cosmetic fix.
 * Match against the lower-cased concatenation of title + body.
 *
 * Each pattern here is a HIGH-CONFIDENCE trivial indicator. Even a single
 * match is sufficient to classify as trivial-fix (it takes priority over
 * scoped-fix signals of equal weight), because these terms rarely appear
 * in non-trivial work items.
 */
const TRIVIAL_SIGNALS = [
  /\btypo\b/,
  /\bspelling\b/,           // "spelling error", "spelling fix", "fix spelling"
  /\bcopy[- ]?(fix|error|update|change)\b/,
  /\brename\b.*\b(file|var|variable|func|function|class|const|let)\b/,
  /\bwhitespace\b/,
  /\bindentation\b/,
  /\bformatting\b/,
  /\bcomment(s)?\b.*\b(fix|update|add|remove)\b/,
  /\bremove unused\b/,
  /\bdeadcode\b/,
  /\bdead[- ]code\b/,
  /\bconsole\.log\b/,
  /\bcosmetic\b/,
  /\bminor\b.*\b(fix|change|update|tweak)\b/,
  /\bstyle[- ]?(fix|change|tweak|only)\b/,
  /\bwording\b/,
  /\blabel[- ]?fix\b/,
  /\btext[- ]?fix\b/,
];

/**
 * Signals that suggest a bounded, scoped bug fix.
 */
const SCOPED_FIX_SIGNALS = [
  /\bfix\b/,
  /\bbug\b/,
  /\bbroken\b/,
  /\bbreaking\b/,
  /\bcrash(es|ing)?\b/,
  /\bregression\b/,
  /\berror\b/,
  /\bexception\b/,
  /\bfail(s|ing|ure)?\b/,
  /\bnot working\b/,
  /\bdoesn't work\b/,
  /\bdoes not work\b/,
  /\bincorrect(ly)?\b/,
  /\bwrong\b/,
  /\bunexpected\b/,
  /\bpatch\b/,
  /\bhot-?fix\b/,
  /\b404\b/,
  /\b500\b/,
  /\bnull pointer\b/,
  /\bundefined\b.*\b(error|is not)\b/,
  /\btypeError\b/i,
  /\brevert\b/,
  /\bflaky\b/,
];

/**
 * Signals that suggest a new feature or non-trivial change.
 */
const FEATURE_SIGNALS = [
  /\badd\b/,
  /\bnew\b/,
  /\bfeature\b/,
  /\bimplement\b/,
  /\bcreate\b/,
  /\bbuild\b/,
  /\benhancement\b/,
  /\benhance\b/,               // "enhance search", "enhance UI"
  /\bimprove(ment)?\b/,
  /\brefactor\b/,
  /\bmigrat(e|ion)\b/,
  /\bupgrade\b/,
  /\bintegrat(e|ion)\b/,
  /\bsupport\b/,
  /\benable\b/,
  /\ballow\b/,
  /\bintroduce\b/,
  /\bextend\b/,
  /\bexpose\b/,
  /\bendpoint\b/,
  /\bapi\b/,
  /\bui\b.*\b(for|component|screen|page|view)\b/,
  /\bdashboard\b/,
  /\bdeploy\b/,
  /\bperformance\b/,
  /\boptimiz(e|ation)\b/,
  /\bcaching\b/,
  /\barchitecture\b/,
];

/**
 * Signals that indicate the item is too vague to classify.
 */
const CLARIFICATION_SIGNALS = [
  /^\s*fix\s*\.?\s*$/i,         // just the word "fix" alone
  /^\s*bug\s*\.?\s*$/i,         // just the word "bug" alone
  /^\s*update\s*\.?\s*$/i,      // just "update"
  /^\s*change\s*\.?\s*$/i,      // just "change"
  /^\s*improve\s*\.?\s*$/i,
  /^\s*todo\s*:?\s*$/i,
  /^\s*tbd\s*\.?\s*$/i,
  /^\s*misc\s*\.?\s*$/i,
  /^\s*various\s*\.?\s*$/i,
  /^\s*stuff\s*\.?\s*$/i,
  /^\s*things\s*\.?\s*$/i,
  /^\s*work\s*\.?\s*$/i,
  /\?\s*$/, // title ends in a question mark (literal question, not a task)
];

// ---------------------------------------------------------------------------
// Heuristic classifier
// ---------------------------------------------------------------------------

/**
 * Count how many patterns from a list match the text.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {{ count: number, matched: string[] }}
 */
function matchSignals(text, patterns) {
  const matched = [];
  for (const pat of patterns) {
    if (pat.test(text)) {
      matched.push(pat.source);
    }
  }
  return { count: matched.length, matched };
}

/**
 * Heuristic classifier. Given title + body strings, returns a classification
 * result using deterministic keyword rules — no model, no network.
 *
 * @param {string} title
 * @param {string} [body]
 * @returns {{ route_class: string, confidence: 'heuristic', signals: string[], clarification_question: string|null }}
 */
export function classifyHeuristic(title, body = "") {
  const titleLower = title.trim().toLowerCase();
  const combined = `${titleLower} ${body.trim().toLowerCase()}`;

  // 1. Hard-fail on clarification triggers first (title-only check)
  for (const pat of CLARIFICATION_SIGNALS) {
    if (pat.test(titleLower)) {
      return {
        route_class: "needs-clarification",
        confidence: "heuristic",
        signals: [`clarification_trigger:${pat.source}`],
        clarification_question:
          "The item title is too vague to classify. Please describe what needs to change, what is broken, and what the expected behavior is.",
      };
    }
  }

  // 2. Score each class
  const trivial = matchSignals(combined, TRIVIAL_SIGNALS);
  const scopedFix = matchSignals(combined, SCOPED_FIX_SIGNALS);
  const feature = matchSignals(combined, FEATURE_SIGNALS);

  // Priority order (deliberate design — matches the expected routing bias):
  //
  //   TRIVIAL-FIX wins if ANY trivial signal fires AND feature.count <= trivial.count.
  //     Rationale: trivial signals are high-confidence cosmetic/mechanical indicators
  //     (e.g. "spelling", "typo", "dead code"). Even one such signal strongly
  //     implies the item is trivial; scoped-fix counter-signals (like "fix", "error")
  //     are too broad to override a specific trivial indicator.
  //
  //   FEATURE wins if feature.count > scoped-fix.count AND feature.count > trivial.count.
  //     Rationale: feature signals that dominate indicate a new capability, not a fix.
  //
  //   SCOPED-FIX wins otherwise (the safe conservative default for bug-like items).
  //
  //   NEEDS-CLARIFICATION if nothing matched.

  let route_class;
  let signals;

  if (trivial.count > 0 && feature.count <= trivial.count) {
    // Any trivial signal + features don't dominate -> trivial-fix
    route_class = "trivial-fix";
    signals = trivial.matched;
  } else if (feature.count > scopedFix.count && feature.count > trivial.count) {
    route_class = "feature";
    signals = feature.matched;
  } else if (scopedFix.count > 0) {
    route_class = "scoped-fix";
    signals = scopedFix.matched;
  } else {
    // No signals matched at all: conservative default is needs-clarification
    route_class = "needs-clarification";
    signals = [];
  }

  return {
    route_class,
    confidence: "heuristic",
    signals,
    clarification_question:
      route_class === "needs-clarification"
        ? "Unable to determine item type from title and body. Please clarify: is this a bug fix, a new feature, or a chore? And describe the expected behavior."
        : null,
  };
}

// ---------------------------------------------------------------------------
// SEAM: low-cost model (Haiku) — plug in here for Part 11 "queue classify" row
// ---------------------------------------------------------------------------
/**
 * Model-backed classifier (STUB — Part 11 Haiku seam).
 *
 * To activate:
 *   1. Install the Anthropic SDK (or use the Claude API via fetch).
 *   2. Replace the body below with a Haiku API call that returns one of
 *      ROUTE_CLASSES as `route_class`. Pass ONLY title + body (NFR-05:
 *      never the whole repo).
 *   3. Fall back to classifyHeuristic() if the model call fails or
 *      returns an unrecognized class.
 *
 * @param {string} _title
 * @param {string} _body
 * @returns {Promise<{ route_class: string, confidence: 'model', signals: string[], clarification_question: string|null }>}
 */
// eslint-disable-next-line no-unused-vars
async function classifyWithModel(_title, _body) {
  // --- HAIKU SEAM: replace this stub with a real API call ---
  // Example (not wired up):
  //
  //   const client = new Anthropic();
  //   const msg = await client.messages.create({
  //     model: "claude-haiku-4-5",
  //     max_tokens: 64,
  //     messages: [{ role: "user", content: `Classify this task:\nTitle: ${_title}\nBody: ${_body}\nReply with ONE of: trivial-fix | scoped-fix | feature | needs-clarification` }],
  //   });
  //   const raw = msg.content[0].text.trim().toLowerCase();
  //   const route_class = ROUTE_CLASSES.includes(raw) ? raw : "needs-clarification";
  //   return { route_class, confidence: "model", signals: [], clarification_question: null };
  //
  throw new Error("classifyWithModel: Haiku seam not yet activated (Part 11 TODO)");
}

// ---------------------------------------------------------------------------
// Public API — classifyItem
// ---------------------------------------------------------------------------

/**
 * Classify a queue item into a route class. Uses the heuristic classifier
 * (no model, no network). When the Haiku seam is activated (Part 11), this
 * function will delegate to classifyWithModel() for borderline cases.
 *
 * The function records its result directly on the item object and advances
 * its state from `queued` to `classified` via the provided `transition`
 * function from queue.mjs.
 *
 * @param {object} item        — queue item to classify (mutated in place)
 * @param {Function} transitionFn — transition() from queue.mjs
 * @returns {{ route_class: string, confidence: string, signals: string[], clarification_question: string|null }}
 */
export function classifyItem(item, transitionFn) {
  if (item.state !== "queued") {
    throw new Error(
      `classifyItem: item "${item.id}" is in state "${item.state}", expected "queued"`
    );
  }

  const result = classifyHeuristic(item.title, item.body ?? "");

  // Record the classification on the item (visible in the audit trail)
  item.route_class = result.route_class;
  item.classify_confidence = result.confidence;
  item.classify_signals = result.signals;
  if (result.clarification_question) {
    item.clarification_question = result.clarification_question;
  }

  if (result.route_class === "needs-clarification") {
    // ROUTE-03: park in needs_input; drainer advances to next item
    transitionFn(item, "needs_input", {
      phase: "2-classify",
      route_class: result.route_class,
      clarification_question: result.clarification_question,
    });
  } else {
    transitionFn(item, "classified", {
      phase: "2-classify",
      route_class: result.route_class,
      confidence: result.confidence,
      signals: result.signals,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entrypoint (for manual testing/inspection)
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

  const flags = parseFlags(process.argv.slice(2));
  const title = typeof flags.title === "string" ? flags.title : "";
  const body = typeof flags.body === "string" ? flags.body : "";

  if (!title) {
    process.stderr.write("Usage: classify-item.mjs --title \"<title>\" [--body \"<body>\"]\n");
    process.exit(1);
  }

  const result = classifyHeuristic(title, body);
  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write("\n");
}
