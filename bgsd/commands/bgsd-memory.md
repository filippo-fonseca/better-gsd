# /bgsd-memory — tell Kiwi what to remember for this repo

> **Kiwi · bgsd Conductor — persist a preference or setting**
> `/bgsd-memory "<whatever you want remembered>"` saves it to this repo's
> `BGSD.md` so it holds for every future session. Tell it a concrete setting
> ("always verify headless", "default the pipeline to thorough", "never use the
> cheap model for verification") and Kiwi writes the exact knob. Tell it a
> free-form preference ("keep PR descriptions terse", "always ask before deleting
> files") and Kiwi appends it to the Notes section. Either way it reports what it
> changed, the same way Claude Code edits its own `CLAUDE.md`.

---

## Usage

```
/bgsd-memory "always verify headless"
/bgsd-memory "default the pipeline mode to thorough"
/bgsd-memory "keep PR descriptions to one paragraph"
/bgsd-memory                       # with no argument: show what's currently remembered
```

## How Kiwi handles it

1. **Parse the request** and decide whether it maps to a **structured setting**
   (a known `BGSD.md` knob) or a **free-form preference** (prose).
2. **Structured setting** → set the exact dotted-path knob with
   `bgsdmd.mjs:editSettingLive(repoRoot, "<dot.path>", <value>)`, which surgically
   updates the `bgsd-settings` JSON block and preserves everything else. Common
   mappings:

   | You say | Knob set |
   |---------|----------|
   | "always verify headless" | `verification.headless` → `true` |
   | "stop UI-testing quick fixes" | `verification.usage_testing` → `false` |
   | "default the pipeline to thorough" | `modes.pipeline` → `"thorough"` |
   | "verifiers should be fast" | `modes.verifier` → `"fast"` |
   | "never use haiku for verification" | `model_posture.verifier.model` → (a stronger model) |
   | "pin the base branch to main" | `base_branch` → `"main"` |

3. **Free-form preference** → append it with
   `bgsdmd.mjs:addPreferenceLive(repoRoot, "<note>")`, which adds a bullet to the
   `BGSD.md` Notes section. Kiwi reads those notes at the start of every session.
4. **Report the change**: state the knob (old → new) or the note added, and where
   it now lives, so it is transparent.

```sh
# Structured knob (example): always verify headless, for the whole repo.
node "${CLAUDE_PLUGIN_ROOT}/scripts/bgsdmd.mjs" set verification.headless true

# Free-form preference:
node "${CLAUDE_PLUGIN_ROOT}/scripts/bgsdmd.mjs" remember "Keep PR descriptions terse."
```

> If the `bgsdmd.mjs` CLI does not expose a subcommand you need, Kiwi calls the
> exported `editSettingLive` / `addPreferenceLive` functions directly. The point
> is: whatever you tell `/bgsd-memory`, it lands in `BGSD.md` and sticks.

---

## The one hard rule: a typed flag always wins

Anything saved here is a **default**. A flag the user passes on a specific
`/bgsd-sesh` (`--headless-ui`, `--mode fast`, `--no-usage-verification`, …)
**overrides** the `BGSD.md` value for that session, always. Precedence is
absolute: **flag > BGSD.md > built-in default.** Kiwi never lets a remembered
setting override a flag the user typed for that run.

---

## Related

- `BGSD.md` — the settings file this writes to (settings block + Notes).
- `bgsd/scripts/bgsdmd.mjs` — `editSettingLive`, `addPreferenceLive`, `rememberLive`.
- Every knob is also documented inline in `BGSD.md` and in `/bgsd-init`.
