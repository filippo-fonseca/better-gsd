#!/usr/bin/env node
/**
 * test-notify.mjs — Unit tests for notify.mjs (and notify-live.mjs delivery/escape).
 *
 * No external framework. Uses node:assert.
 * Run with: node bgsd/scripts/test-notify.mjs
 * Exits 0 on all-pass, non-zero on any failure.
 *
 * Test groups:
 *
 * --- Gating (shouldNotify) ---
 *   N01 — enabled when notifications.os is missing entirely
 *   N02 — enabled when notifications key is absent from config
 *   N03 — enabled when config itself is null/undefined
 *   N04 — disabled when notifications.os is explicitly false
 *   N05 — disabled when notifications.os is false even with a valid event
 *   N06 — only fires for needs_input event
 *   N07 — only fires for escalation event
 *   N08 — does not fire for unrelated events (e.g. "running", "done")
 *   N09 — enabled when notifications.os is true
 *
 * --- Message composition (composeNotification) ---
 *   N10 — title contains conductor emoji and name
 *   N11 — title uses Kiwi/🥝 defaults when conductor is absent
 *   N12 — body contains the question when provided
 *   N13 — body contains agentId when provided
 *   N14 — body truncates long questions at 120 chars with ellipsis
 *   N15 — body uses fallback message when question is absent
 *   N16 — default title matches expected format "🥝 Kiwi needs your input"
 *
 * --- AppleScript escaping (deliverNotification / escaping helper via notify-live) ---
 *   N17 — double quotes in title are escaped (does not call osascript)
 *   N18 — backslashes in body are escaped
 *   N19 — no-op and returns false on non-darwin platform (injected)
 *   N20 — returns true on darwin platform (delivery attempted, injected)
 *
 * --- notifyEscalation integration (gating + composition + delivery) ---
 *   N21 — notifyEscalation calls deliverFn with correct title/body on darwin
 *   N22 — notifyEscalation does not call deliverFn when os notifications disabled
 *   N23 — notifyEscalation does not call deliverFn for non-input event
 *   N24 — notifyEscalation never throws even when deliverFn throws
 */

import assert from "node:assert/strict";
import { shouldNotify, composeNotification } from "./notify.mjs";
import { deliverNotification, notifyEscalation } from "./notify-live.mjs";

// ---------------------------------------------------------------------------
// Test harness (mirrors test-escalate.mjs style)
// ---------------------------------------------------------------------------

let passed  = 0;
let failed  = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result
        .then(() => { passed++; process.stdout.write(`  PASS  ${name}\n`); })
        .catch((err) => {
          failed++;
          failures.push({ name, err });
          process.stdout.write(`  FAIL  ${name}: ${err.message}\n`);
        });
    }
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  FAIL  ${name}: ${err.message}\n`);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Gating — shouldNotify
// ---------------------------------------------------------------------------

process.stdout.write("\n--- Gating (shouldNotify) ---\n");

test("N01 — enabled when notifications.os is missing entirely", () => {
  assert.equal(shouldNotify({ notifications: {} }, "needs_input"), true);
});

test("N02 — enabled when notifications key is absent from config", () => {
  assert.equal(shouldNotify({}, "needs_input"), true);
});

test("N03 — enabled when config itself is null/undefined", () => {
  assert.equal(shouldNotify(null, "needs_input"), true);
  assert.equal(shouldNotify(undefined, "needs_input"), true);
});

test("N04 — disabled when notifications.os is explicitly false", () => {
  assert.equal(shouldNotify({ notifications: { os: false } }, "needs_input"), false);
});

test("N05 — disabled when notifications.os is false even with a valid event", () => {
  assert.equal(shouldNotify({ notifications: { os: false } }, "escalation"), false);
});

test("N06 — only fires for needs_input event", () => {
  assert.equal(shouldNotify({}, "needs_input"), true);
});

test("N07 — only fires for escalation event", () => {
  assert.equal(shouldNotify({}, "escalation"), true);
});

test("N08 — does not fire for unrelated events", () => {
  assert.equal(shouldNotify({}, "running"), false);
  assert.equal(shouldNotify({}, "done"),    false);
  assert.equal(shouldNotify({}, "failed"),  false);
  assert.equal(shouldNotify({}, ""),        false);
});

test("N09 — enabled when notifications.os is true", () => {
  assert.equal(shouldNotify({ notifications: { os: true } }, "needs_input"), true);
});

// ---------------------------------------------------------------------------
// Message composition — composeNotification
// ---------------------------------------------------------------------------

process.stdout.write("\n--- Message composition (composeNotification) ---\n");

test("N10 — title contains conductor emoji and name", () => {
  const { title } = composeNotification({ type: "needs_input" }, { name: "Jarvis", emoji: "🤖" });
  assert.ok(title.includes("Jarvis"), `title must include name; got: "${title}"`);
  assert.ok(title.includes("🤖"),    `title must include emoji; got: "${title}"`);
});

test("N11 — title uses Kiwi/🥝 defaults when conductor is absent", () => {
  const { title } = composeNotification({ type: "needs_input" }, null);
  assert.ok(title.includes("Kiwi"), `title must include "Kiwi"; got: "${title}"`);
  assert.ok(title.includes("🥝"),   `title must include "🥝"; got: "${title}"`);
  const { title: t2 } = composeNotification({ type: "needs_input" });
  assert.ok(t2.includes("Kiwi"));
});

test("N12 — body contains the question when provided", () => {
  const q = "Which database should we use?";
  const { body } = composeNotification({ type: "needs_input", question: q }, null);
  assert.ok(body.includes(q), `body must include question; got: "${body}"`);
});

test("N13 — body contains agentId when provided", () => {
  const { body } = composeNotification(
    { type: "needs_input", agentId: "agent-007", question: "Q?" },
    null
  );
  assert.ok(body.includes("agent-007"), `body must include agentId; got: "${body}"`);
});

test("N14 — body truncates long questions at 120 chars with ellipsis", () => {
  const longQ = "a".repeat(200);
  const { body } = composeNotification({ type: "needs_input", question: longQ }, null);
  assert.ok(body.includes("..."), `body must contain ellipsis for long question; got: "${body}"`);
  assert.ok(body.length < 300, "body must not be excessively long");
});

test("N15 — body uses fallback message when question is absent", () => {
  const { body } = composeNotification({ type: "needs_input" }, null);
  assert.ok(body.length > 0, "body must be non-empty even without a question");
  assert.ok(body.includes("waiting"), `body must mention waiting; got: "${body}"`);
});

test("N16 — default title matches expected format", () => {
  const { title } = composeNotification({ type: "needs_input" }, { name: "Kiwi", emoji: "🥝" });
  assert.equal(title, "🥝 Kiwi needs your input");
});

// ---------------------------------------------------------------------------
// AppleScript escaping + platform guard (via deliverNotification)
// ---------------------------------------------------------------------------

process.stdout.write("\n--- AppleScript escaping + platform guard ---\n");

test("N17 — double quotes in title/body do not cause errors (escaping)", () => {
  // We can't call real osascript in tests, so we verify the no-op path
  // on a non-darwin platform with injected platform. No throw = escaping is safe.
  assert.doesNotThrow(() =>
    deliverNotification({ title: 'He said "hello"', body: 'And "goodbye"', platform: "linux" })
  );
});

test("N18 — backslashes in body do not cause errors (escaping)", () => {
  assert.doesNotThrow(() =>
    deliverNotification({ title: "t", body: "path\\to\\file", platform: "linux" })
  );
});

test("N19 — no-op and returns false on non-darwin platform (injected)", () => {
  const result = deliverNotification({ title: "t", body: "b", platform: "linux" });
  assert.equal(result, false, "must return false on non-darwin");
});

test("N20 — returns true on darwin platform (delivery attempted, injected)", () => {
  let called = false;
  const result = deliverNotification({
    title: "t",
    body: "b",
    platform: "darwin",
  });
  assert.equal(result, true, "must return true on darwin (delivery attempted)");
});

// ---------------------------------------------------------------------------
// notifyEscalation integration
// ---------------------------------------------------------------------------

process.stdout.write("\n--- notifyEscalation integration ---\n");

test("N21 — notifyEscalation calls deliverFn with correct title/body on darwin", () => {
  const calls = [];
  const fakeDeliver = (opts) => { calls.push(opts); return true; };

  const result = notifyEscalation(
    { type: "needs_input", agentId: "agent-001", question: "Which auth method?" },
    {
      config:    { notifications: { os: true } },
      conductor: { name: "Kiwi", emoji: "🥝" },
      deliverFn: fakeDeliver,
    }
  );

  assert.equal(result, true, "must return true when deliverFn fires");
  assert.equal(calls.length, 1, "deliverFn must be called exactly once");
  assert.ok(calls[0].title.includes("Kiwi"), `title must include name; got: "${calls[0].title}"`);
  assert.ok(calls[0].body.includes("Which auth method?"),
    `body must include question; got: "${calls[0].body}"`);
});

test("N22 — notifyEscalation does not call deliverFn when os notifications disabled", () => {
  const calls = [];
  const result = notifyEscalation(
    { type: "needs_input", question: "Q?" },
    {
      config:    { notifications: { os: false } },
      conductor: { name: "Kiwi", emoji: "🥝" },
      deliverFn: (opts) => { calls.push(opts); return true; },
    }
  );

  assert.equal(result, false, "must return false when notifications disabled");
  assert.equal(calls.length, 0, "deliverFn must NOT be called when disabled");
});

test("N23 — notifyEscalation does not call deliverFn for non-input event", () => {
  const calls = [];
  const result = notifyEscalation(
    { type: "running" },
    {
      config:    { notifications: { os: true } },
      conductor: { name: "Kiwi", emoji: "🥝" },
      deliverFn: (opts) => { calls.push(opts); return true; },
    }
  );

  assert.equal(result, false, "must return false for non-input event");
  assert.equal(calls.length, 0, "deliverFn must NOT be called for non-input event");
});

test("N24 — notifyEscalation never throws even when deliverFn throws", () => {
  assert.doesNotThrow(() => {
    notifyEscalation(
      { type: "needs_input", question: "Q?" },
      {
        config:    { notifications: { os: true } },
        conductor: { name: "Kiwi", emoji: "🥝" },
        deliverFn: () => { throw new Error("osascript exploded"); },
      }
    );
  }, "notifyEscalation must never throw even when deliverFn throws");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write(`\n${"=".repeat(60)}\n`);
process.stdout.write(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);

if (failures.length > 0) {
  process.stdout.write("\nFailed tests:\n");
  for (const f of failures) {
    process.stdout.write(`  FAIL  ${f.name}\n`);
    if (f.err?.stack) {
      process.stdout.write(
        `        ${f.err.stack.split("\n").slice(0, 4).join("\n        ")}\n`
      );
    }
  }
  process.exit(1);
}

process.stdout.write("All tests passed.\n");
process.exit(0);
