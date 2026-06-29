#!/usr/bin/env node
/**
 * hyperpolymath-mock.mjs — Mock/fixture Hyperpolymath source (Phase 4: CAPTURE-02)
 *
 * Returns a deterministic set of sample capture items for use in automated
 * tests and dry-run demonstrations. Zero live external dependency: no network
 * calls, no credentials, no filesystem reads outside this file.
 *
 * Shape of each raw item returned by this source:
 *   {
 *     id:         string   — stable identifier in the mock source
 *     title:      string   — short human-readable title
 *     body:       string   — longer description (may be empty)
 *     created_at: string   — ISO-8601 timestamp
 *   }
 *
 * The capture adapter (capture.mjs) normalises these into queue records with
 * source: "hyperpolymath" and deduplicates by SHA-256 content key.
 *
 * Usage (as an injected source):
 *   import { mockSource } from './__fixtures__/hyperpolymath-mock.mjs';
 *   const items = await mockSource();
 *
 * Usage (direct invocation for demo):
 *   node bgsd/scripts/__fixtures__/hyperpolymath-mock.mjs
 */

/**
 * A deterministic set of sample capture items that exercises every
 * classification path:
 *   - scoped-fix  (crash/bug keywords)
 *   - trivial-fix (typo/cosmetic keywords)
 *   - feature     (add/implement keywords)
 *   - one duplicate of item[0] to exercise dedup logic in tests
 *
 * @returns {Promise<Array<{id: string, title: string, body: string, created_at: string}>>}
 */
export async function mockSource() {
  return [
    {
      id: "hp-mock-001",
      title: "Fix login crash on Safari after OAuth redirect",
      body: "Clicking 'Sign in with Google' on Safari 17 throws a TypeError in auth.js:42. Reproducible on mobile and desktop.",
      created_at: "2026-06-29T08:00:00.000Z",
    },
    {
      id: "hp-mock-002",
      title: "Fix typo in onboarding copy",
      body: "The word 'recieve' appears on the welcome screen. Should be 'receive'.",
      created_at: "2026-06-29T08:01:00.000Z",
    },
    {
      id: "hp-mock-003",
      title: "Add dark mode toggle to settings page",
      body: "Users should be able to switch between light and dark themes from Settings > Appearance. Persist selection to localStorage.",
      created_at: "2026-06-29T08:02:00.000Z",
    },
    {
      id: "hp-mock-004",
      title: "Remove unused console.log statements in api/client.ts",
      body: "Several debug console.log calls were left in during development. They should be removed before the next release.",
      created_at: "2026-06-29T08:03:00.000Z",
    },
    {
      id: "hp-mock-005",
      title: "Bug: 404 returned for /api/user when session expires mid-request",
      body: "When a session token expires between the auth check and the DB query, the endpoint returns 404 instead of 401. Should return 401 with a WWW-Authenticate header.",
      created_at: "2026-06-29T08:04:00.000Z",
    },
  ];
}

// ---------------------------------------------------------------------------
// CLI entrypoint — pretty-prints the mock items for demo/inspection
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
  const items = await mockSource();
  process.stdout.write(JSON.stringify(items, null, 2));
  process.stdout.write("\n");
}
