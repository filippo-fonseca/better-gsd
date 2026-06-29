# bgsd — Phase 1 Integration Notes

Phase 1 is a de-risking spike. Its job is to **resolve two open integration unknowns**
cheaply before anything is built on them, and to stand up the additive `bgsd/` skeleton.
This file is the decision record (SKEL-04 requires the working invocation path to be documented).

_Resolved: 2026-06-29 on branch `feat/bgsd-v0`._

---

## Decision 1 — How bgsd loads as a second plugin (SKEL-01, SKEL-03)

**Question:** Can Claude Code load bgsd as a second, additive plugin alongside the vendored
GSD fork, with zero edits to GSD's `.claude-plugin/plugin.json`?

**Answer: Yes — via a local *Directory*-source marketplace.** Verified empirically:

```bash
claude plugin validate ./bgsd            # ✔ Validation passed
claude plugin marketplace add ./bgsd     # ✔ added marketplace: bgsd-local (Directory source)
claude plugin install bgsd@bgsd-local    # ✔ installed: bgsd@bgsd-local (scope: user, enabled)
```

The marketplace is registered as a **Directory** source pointing at the live `bgsd/` dir,
so it always reads the in-repo files. **No edits to vendored GSD were needed.** GSD itself
runs from user-level `~/.claude/` (skills + hooks), not as a repo plugin — so there is no
GSD *plugin* to collide with, and `/bgsd-verify` cannot collide with any `/gsd-*` command
(distinct prefix, distinct namespace).

**Manifest gotchas found during the spike (now fixed):**
- `marketplace.json` root rejects `$schema` and `description`. The marketplace description
  belongs under `metadata.description`.
- `plugin.json` does **not** accept directory strings for `agents` (and we don't need them
  for `commands` either). Commands and agents are **auto-discovered** from the conventional
  `commands/` and `agents/` dirs. Declaring `"agents": "./agents/"` fails validation with
  `agents: Invalid input`. Both keys were removed.

**Activation for a fresh machine** (documented in `bgsd/README.md`):
```bash
claude plugin marketplace add ./bgsd
claude plugin install bgsd@bgsd-local
# restart Claude Code — plugin commands bind at startup, so /bgsd-verify appears after restart
```

**Fallback (not needed):** if marketplace install ever breaks, project-level `.claude/commands/`
+ `.claude/agents/` (or CLAUDE.md `@`-includes) would activate the same files. Not required —
the marketplace path works.

---

## Decision 2 — Whether the tester can reach Playwright MCP (SKEL-04)

**Question:** Can the tester reach Playwright MCP browser tools, given Claude Code bugs
#13254 / #13605 (custom **plugin** subagents not seeing MCP tools)?

**Findings from the spike:**
- `claude mcp list` shows **no browser-driving MCP** currently registered. Connected servers
  are all claude.ai-hosted (Remote, Vercel, Figma, Granola, Drive, Gmail, Calendar) plus the
  supabase plugin. There is **no Playwright/Chrome MCP** and no `browser_*` tool in scope.
- Therefore Playwright MCP is a **runtime prerequisite** the tester must check for, not assume.

**Decision (the working invocation path):**
1. **Install Playwright MCP** before verification can run (pinned):
   ```bash
   claude mcp add playwright -- npx @playwright/mcp@0.0.76
   ```
2. **Do not rely on the plugin-defined `bgsd-tester` subagent to reach MCP tools.** Per the
   known CC bugs, plugin subagents may not see MCP tools. Instead, `/bgsd-verify` drives the
   browser via an invocation path that **does** reach MCP — a `general-purpose` subagent (or a
   foreground turn) seeded with the `bgsd-tester` persona in `bgsd/agents/tester.md`. The
   `tester.md` file stays the canonical persona/spec; it is loaded as context, not necessarily
   spawned as the plugin subagent.
3. **Pre-flight MCP probe is mandatory (DRIVER-03 / NFR-06).** Before any verification, run a
   no-op `browser_snapshot`. If it fails, emit `BLOCKED: mcp_unavailable` with the install
   command above — **never** a fabricated `PASS`.

This is carried into Phase 3 (DRIVER-03) and Phase 4 (VERIFY-02) as a hard requirement.

---

## Note — keeping `.planning/` and `.bgsd*` tracked without editing GSD's `.gitignore`

The vendored GSD `.gitignore` ignores `.planning/`. To honor "never edit vendored GSD"
(NFR-03), planning docs are tracked with `git add -f` rather than by editing `.gitignore`.
The `.bgsd/` and `.bgsd-tmp/` runtime dirs each carry a self-ignoring `.gitignore`
(`*` + `!.gitignore`), so the dirs exist in the repo while their runtime contents stay
untracked — again with no edit to GSD's root `.gitignore`.
