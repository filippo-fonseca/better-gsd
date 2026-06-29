# canary-next — the make-or-break proof fixture

This minimal Next.js app is bgsd's Phase 5 proof target. It has two routes:

| Route | State | Expected `/bgsd-verify` verdict |
|-------|-------|---------------------------------|
| `/` | Clean — valid markup, no console errors | **PASS** |
| `/buggy` | A `<div>` illegally nested inside a `<p>` | **FAIL** (`source: console`, `validateDOMNesting`) |

The point: `/buggy` looks **identical to a working page in a screenshot** — the text
renders fine. The only evidence of the defect is the React `validateDOMNesting` error in
the browser console. If bgsd catches it (FAIL on `/buggy`) and does not cry wolf (PASS on
`/`), the core value of v0 is proven.

## Running the proof (requires Playwright MCP loaded — restart Claude Code first)

```bash
# Boot the fixture in isolation and verify the clean route → expect PASS
/bgsd-verify --boot bgsd/fixtures/canary-next --criteria bgsd/fixtures/canary-next/acceptance.md
#   (then point the run at /buggy for the FAIL case — see usage docs)
```

`build_mode` must be `development` for this proof: React's `validateDOMNesting` warning is
stripped from production builds (the classifier flags console assertions `UNRELIABLE` in
production — see DRIVER-04).
