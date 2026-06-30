# bgsd-escalate — Confidence-Gated Human Escalation via Selectors

**Phase E5 of the bgsd v2 Extension (Conductor Intake + Autonomous Proxy-Q&A)**

When the decision-oracle (E4) scores a question below the configured confidence
threshold, Kiwi does NOT auto-answer. Instead, this module takes over: it
consolidates all pending escalations into ONE batched selector prompt, collects
the human's answers, writes them back into the oracle (so the same question never
re-escalates), and surfaces rarity telemetry in `/bgsd-status`.

---

## Overview

```
Oracle (E4)
  answerQuestion()
      │
      ├── confidence ≥ threshold ──► auto_answer (Kiwi proxies, no human)
      │
      └── confidence < threshold ──► { action:"escalate", reason, confidence }
                                           │
                                     escalate.mjs (E5)
                                           │
                              buildEscalationBatch(escalations)
                                           │  deduplicates same gray-area
                                           │  builds GSD-style selectors
                                           ▼
                              ONE consolidated selector prompt
                              (2–4 options + "type your own" per question)
                                           │
                              runEscalation({ batch, promptFn })
                                           │  human answers
                                           ▼
                              enrichOracleFromAnswers(answers, record, batch)
                                           │  writes back into decisions.json
                                           │  tagged source:"escalation"
                                           ▼
                              Next query of same question → auto_answer
                              (loop closed — never re-escalates, ESCALATE-03)
                                           │
                              renderEscalationTelemetry(counter)
                                           ▼
                              /bgsd-status: "auto-answered 18 / escalated 2"
```

---

## Requirements Addressed

| Req | SC | What it enforces |
|-----|----|-----------------|
| ESCALATE-01 | SC#1 | Below-threshold routes to escalation via `addEscalation` + `needs_input`; never auto-answers below threshold (NFR-06/11) |
| ESCALATE-02 | SC#2 | Exactly ONE consolidated, deduplicated selector question; each item has 2–4 concrete options + "type your own" free-text (NFR-10) |
| ESCALATE-03 | SC#3 | Human's answer written back as `source:"escalation"` decision-record entry; same question auto-answers on re-query (loop closed) |
| ESCALATE-04 | SC#4 | `renderEscalationTelemetry()` exposes auto-answered/escalated counts + threshold for `/bgsd-status` (NFR-06/08) |

---

## Selector Structure (NFR-10)

Every escalation question is a GSD-style selector. No free-form-only prompt is
ever shown to the human. The structure is:

```json
{
  "id": "esc-001",
  "topic": "scope-bound",
  "question": "How tightly should the scope be bounded for the first deliverable?",
  "options": [
    { "id": "thin-mvp",    "label": "Thin MVP",    "description": "One core user flow end-to-end; defer everything else." },
    { "id": "full-scope",  "label": "Full scope",  "description": "All listed surfaces in scope from day one." },
    { "id": "spike-first", "label": "Spike first", "description": "Validate the riskiest assumption before committing to scope." }
  ],
  "freeText": {
    "id": "other",
    "label": "Type your own",
    "placeholder": "Describe your decision for: \"How tightly...\""
  },
  "source_worktrees": ["agent-001", "agent-002"],
  "escalation_ids":   ["escalation-abc", "escalation-def"],
  "confidence": 0.34,
  "reason": "confidence 0.34 < threshold 0.60 (best source: spec)"
}
```

The `assertBatchItemInvariant()` function (exported from `escalate.mjs`) enforces
the NFR-10 invariant on every item before it is surfaced to the human:

- `options.length` must be in `[2, 4]`
- `freeText.id` must be `"other"`

Violation causes an immediate thrown error (fail-fast, no silent green — NFR-06).

---

## Deduplication (ESCALATE-02)

When the same gray-area question is raised by multiple parallel worktrees (common
in a multi-agent run), `buildEscalationBatch()` collapses them into a single item:

- Dedup key: first 4 meaningful non-stop-word tokens of the question text
  (deterministic, no model calls — NFR-05)
- `source_worktrees` and `escalation_ids` accumulate all contributors
- Bias: a false split (keeping two items that should merge) costs one extra
  selector; a false merge (collapsing genuinely distinct questions) hides a real
  unknown. The dedup key is intentionally conservative — it biases toward keeping
  distinct items to avoid the worse failure mode.

---

## Oracle Enrichment / Feedback Loop (ESCALATE-03)

After the human answers an escalation:

1. `enrichOracleFromAnswers(answers, record, batch, { intakeDir })` appends
   a new decision entry to `decisions.json`:

   ```json
   {
     "id":          "esc-001-enriched",
     "topic":       "scope-bound",
     "question":    "How tightly should the scope be bounded?",
     "options":     [...],
     "freeText":    { "id": "other", ... },
     "answer":      "thin-mvp",
     "source":      "escalation",
     "rationale":   "Human answer collected during escalation (E5 enrichment)",
     "spec_section": null
   }
   ```

2. The record is re-sealed (new `sealed_at` timestamp).
3. `decisions.json` is written atomically (write-temp-then-rename).
4. The next call to `answerQuestion()` finds the enriched entry, scores it as a
   `"decision"` source hit (authority weight 0.75), and auto-answers at high
   confidence — without human involvement.

Un-answered escalations (human did not respond) are never written back. The
record remains unchanged. No fabricated decisions are ever created (NFR-06).

---

## Rarity Telemetry (ESCALATE-04)

The `EscalationCounter` tracks how often Kiwi answers itself vs. escalates:

```js
const counter = createEscalationCounter();
// When oracle auto-answers:
incrementCounter(counter, "auto_answered");
// When oracle escalates to human:
incrementCounter(counter, "escalated");

// For /bgsd-status:
renderEscalationTelemetry(counter, { threshold: 0.60 });
// => "auto-answered 18 / escalated 2  [90% auto]  (threshold: 0.60)"
```

With an optional `pending` object:
```js
renderEscalationTelemetry(counter, {
  threshold: 0.60,
  pending: { batchSize: 2 }
});
// => "auto-answered 18 / escalated 2  [90% auto]  (threshold: 0.60)  [2 selectors pending human input]"
```

This line feeds directly into `renderStatus()` in `status.mjs` so the human
can see at a glance that Kiwi is acting as a faithful proxy and that escalations
are genuinely rare — never silently suppressed (NFR-08).

---

## API Reference

All exports are from `bgsd/scripts/escalate.mjs`. Zero external deps; Node 18+
built-ins only.

### `buildEscalationBatch(escalations)`

Pure, deterministic. Consolidates N oracle escalation objects into ONE batch.

```js
import { buildEscalationBatch } from './escalate.mjs';

const batch = buildEscalationBatch([
  { question: "How tightly should scope be bounded?",
    reason: "confidence 0.34 < threshold 0.60", confidence: 0.34,
    agentId: "agent-001" },
  { question: "What is the deployment target?",
    reason: "insufficient_spec", confidence: 0,
    agentId: "agent-002" },
]);
// batch.length: 2 (or fewer if dedup collapses same gray-area)
// batch[0].options.length: 2–4
// batch[0].freeText.id: "other"
```

### `runEscalation({ batch, promptFn })`

Async. Calls `promptFn` for each batch item, collects answers.

```js
const { answers, answered, open } = await runEscalation({
  batch,
  promptFn: async (item) => {
    // Display item.question + item.options to the user
    // Return chosen option id or free text; return null if unanswered
    return "thin-mvp";
  },
});
// answers: Map<itemId, string|null>
// answered: number of non-null answers
// open: number of still-unanswered items
```

### `enrichOracleFromAnswers(answers, record, batch, opts?)`

Synchronous. Writes human answers back into the decision record.

```js
import { enrichOracleFromAnswers } from './escalate.mjs';

const { enrichedCount } = enrichOracleFromAnswers(
  answers,         // Map from runEscalation
  record,          // The mutable decision record object
  batch,           // The escalation batch
  { intakeDir }    // If provided, writes decisions.json atomically
);
```

### `createEscalationCounter() / incrementCounter() / renderEscalationTelemetry()`

```js
import { createEscalationCounter, incrementCounter,
         renderEscalationTelemetry } from './escalate.mjs';

const counter = createEscalationCounter(); // { autoAnswered: 0, escalated: 0 }
incrementCounter(counter, "auto_answered");
incrementCounter(counter, "escalated");
renderEscalationTelemetry(counter, { threshold: 0.60 });
// => "auto-answered 1 / escalated 1  [50% auto]  (threshold: 0.60)"
```

---

## Design Constraints (Hard Rules)

| NFR | Rule |
|-----|------|
| NFR-06 | Un-answered escalations stay open; no fabricated decisions ever written |
| NFR-10 | Every escalation item is a GSD-style selector: ≥2 options + `freeText.id:"other"` |
| NFR-11 | Below-threshold questions MUST escalate; never auto-answer below threshold |
| NFR-05 | All consolidation, dedup, scoring, enrichment writes are deterministic scripts; zero model calls |
| NFR-03/04 | Enrichment writes only to `decisions.json` under `.bgsd/intake/`; zero edits to vendored GSD |

---

## Unit Tests

`bgsd/scripts/test-escalate.mjs` — 36 tests, all passing.

```
node bgsd/scripts/test-escalate.mjs
# Tests: 36 | Passed: 36 | Failed: 0
```

Test coverage:

- **ESCALATE-01**: N escalations consolidate, empty returns empty, throws on bad input, unanswered stays null
- **ESCALATE-02**: Dedup collapses same gray-area, distinct questions stay distinct, NFR-10 invariant enforced on every item, domain-pattern option synthesis
- **ESCALATE-03**: Enrichment appends `source:"escalation"` entry, unanswered not written (NFR-06), record re-sealed, atomic write, full closed-loop demonstration (E25)
- **ESCALATE-04**: Counter starts at zero, increments correctly, telemetry format with threshold and pending, throws on invalid input

---

*Phase E5 — implemented 2026-06-29*
*Requirements: ESCALATE-01..04, SC#1..4*
*NFRs enforced: NFR-05, NFR-06, NFR-10, NFR-11*
