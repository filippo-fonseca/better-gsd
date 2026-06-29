# /bgsd-capture — Hyperpolymath Capture→Queue Cron

## Overview

`bgsd-capture` turns external Hyperpolymath items into `/bgsd-queue` entries
via a documented capture seam. It ships with a safe, deterministic mock source
and a mandatory `--dry-run` default so you can preview what would be enqueued
before writing anything.

The live external hookup (real Hyperpolymath credentials, real cron registration
that enqueues for real) is **human-gated**: it is off by default, requires explicit
opt-in, and is never run by automated tests or CI (CAPTURE-04, NFR-07).

---

## Quick start

```bash
# Dry-run against the mock source (safe, no writes, no external calls)
node bgsd/scripts/capture-cron.mjs

# Enqueue for real against the mock (writes to .bgsd/queue/queue.json)
node bgsd/scripts/capture-cron.mjs --no-dry-run

# (HUMAN-GATED) Dry-run against the live Hyperpolymath source
node bgsd/scripts/capture-cron.mjs --live

# (HUMAN-GATED) Real enqueue from the live source
node bgsd/scripts/capture-cron.mjs --live --no-dry-run
```

---

## Capture seam contract

The seam consumes raw items in this shape:

```json
{
  "id":         "hp-source-001",
  "title":      "Fix login crash on Safari",
  "body":       "TypeError thrown at auth.js:42 on Safari 17.",
  "created_at": "2026-06-29T08:00:00.000Z"
}
```

And emits queue records (via `addItem`) with `source: "hyperpolymath"`:

```json
{
  "id":          "item-ab12cd34-1751234567890",
  "title":       "Fix login crash on Safari",
  "body":        "TypeError thrown at auth.js:42 on Safari 17.",
  "source":      "hyperpolymath",
  "state":       "queued",
  "content_key": "<sha256 of title\\n\\nbody>",
  "created_at":  "2026-06-29T08:00:01.000Z"
}
```

**Idempotency**: the adapter relies on the queue's SHA-256 content-key dedup
(QUEUE-05). Re-running capture does not create duplicate entries: `addItem`
returns the existing id when an identical non-terminal item is present.

---

## Files

| File | Purpose |
|------|---------|
| `bgsd/scripts/capture.mjs` | Core adapter: `captureToQueue({ source, dryRun })` |
| `bgsd/scripts/capture-live.mjs` | Guarded live source seam (refuses without `--live`) |
| `bgsd/scripts/capture-cron.mjs` | Cron entry point (defaults: mock + dry-run) |
| `bgsd/scripts/__fixtures__/hyperpolymath-mock.mjs` | Deterministic mock source for tests |
| `bgsd/scripts/test-capture.mjs` | Unit tests (all run against mock only) |

---

## Scheduling (human step)

**Do not add `--live` to any automated cron or CI pipeline.** Scheduling the
dry-run mock path is safe and useful for testing the scheduling mechanism before
wiring the live source.

### macOS crontab (every 30 minutes, dry-run against mock)

```cron
*/30 * * * * /usr/local/bin/node /absolute/path/to/better-gsd/bgsd/scripts/capture-cron.mjs >> /tmp/bgsd-capture.log 2>&1
```

To install: run `crontab -e` and paste the line above (adjust the path).

### macOS launchd (recommended)

Create `~/Library/LaunchAgents/com.bgsd.capture-cron.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.bgsd.capture-cron</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/better-gsd/bgsd/scripts/capture-cron.mjs</string>
  </array>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>StandardOutPath</key>
  <string>/tmp/bgsd-capture.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/bgsd-capture-err.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.bgsd.capture-cron.plist
```

Unload it:

```bash
launchctl unload ~/Library/LaunchAgents/com.bgsd.capture-cron.plist
```

---

## Enabling the live hookup (human-gated steps)

> **Safety caveat**: the live path hits a real external system, enqueues real
> items, and writes to `.bgsd/queue/queue.json`. It can only be triggered by
> explicit human action with `--live`. Never automate this flag.

1. **Configure the source** — set one of these environment variables (never
   commit credentials to the repo):

   ```bash
   # Option A: local file export
   export HYPERPOLYMATH_SOURCE_PATH=~/hyperpolymath/captures/latest.json

   # Option B: API endpoint
   export HYPERPOLYMATH_API_ENDPOINT=https://api.hyperpolymath.example/captures
   export HYPERPOLYMATH_API_KEY=<your-api-key>
   ```

2. **Implement the fetch logic** — open `bgsd/scripts/capture-live.mjs` and
   replace the documented stub inside `liveCaptureSource()` with the real
   fetch (see the "Option A / Option B" code examples in that file).

3. **Validate with dry-run first** — always confirm the items look correct
   before writing:

   ```bash
   node bgsd/scripts/capture-cron.mjs --live
   ```

4. **Enqueue for real** — once the dry-run output looks correct:

   ```bash
   node bgsd/scripts/capture-cron.mjs --live --no-dry-run
   ```

5. **Add to scheduler** (optional) — only after validating steps 3 and 4:

   ```cron
   */30 * * * * /usr/local/bin/node /path/to/capture-cron.mjs --live --no-dry-run >> /tmp/bgsd-capture-live.log 2>&1
   ```

   Even then, keep a human watching the first few live runs.

---

## Testing

All automated tests run against the mock source only (CAPTURE-04). The live
source is never hit in CI.

```bash
node bgsd/scripts/test-capture.mjs   # capture tests (Phase 4)
node bgsd/scripts/test-queue.mjs     # queue tests (Phase 1)
node bgsd/scripts/test-route.mjs     # route tests (Phase 2)
node bgsd/scripts/test-loop1.mjs     # loop1 tests (Phase 3)
```
