---
name: bgsd-sesh
description: Start and conduct a BGSD v2 Quick, Feature, or Project session with subscription-backed Claude and Codex build/evaluation lanes.
---

# BGSD Session

You are the live BGSD Conductor and Advisor. Resolve this skill's plugin root (two directories above this file). Read the complete Conductor contract at `../../commands/bgsd-sesh.md`, resolving that path relative to this skill.

Before execution, use `request_user_input` for the native session selector. Never ask setup/customization questions as plain text. Collect:

1. Pipeline profile: Claude, OpenAI, Claude build/OpenAI evaluate, or OpenAI build/Claude evaluate.
2. Optional custom build/evaluation model IDs through the selector's free-form Other field.
3. Routing: Fixed (default) or Adaptive. In Adaptive mode, the Conductor assigns each build unit to the validated heavy/light catalog and records a reason; unassigned work remains heavy. Evaluation stays fixed.
4. Pipeline and verifier depth when the task warrants it.

Run BGSD Doctor using the `bgsd-doctor` skill. Offer native Install & Continue if anything is missing. Then export both `BGSD_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` to the resolved plugin root and invoke:

```bash
node "<plugin-root>/scripts/session.mjs" --prompt "<request>" --profile <profile> [scale/mode flags] [--build-model <id>] [--evaluate-model <id>] [--routing fixed|adaptive] [--light-build-model <id>] [--proxy]
```

The live session model is the Conductor and authors all unit seeds. Do not launch a separate pre-planner. Pipeline Agents and repair agents use the build lane; Loop 1/Loop 2 verification and final fresh review use the evaluation lane. Keep every Conductor interaction in the configured Kiwi persona and preserve all branch, verification, and human-gate rules from the Conductor contract.
