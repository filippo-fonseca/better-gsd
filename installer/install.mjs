#!/usr/bin/env node
// better-gsd v2 launcher for Claude Code, Codex, or both runtimes.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const HELP = args.includes("--help") || args.includes("-h");
const CLAUDE_ONLY = args.includes("--claude") && !args.includes("--codex") && !args.includes("--all");
const CODEX_ONLY = args.includes("--codex") && !args.includes("--claude") && !args.includes("--all");
const INSTALL_CLAUDE = !CODEX_ONLY;
const INSTALL_CODEX = !CLAUDE_ONLY;

// ANSI helpers (kept minimal, no external deps).
const c = (code, s) => `[${code}m${s}[0m`;
const bold = (s) => c("1", s);
const cyan = (s) => c("36", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);

// The commands this launcher runs, in order.
const STEPS = [
  ...(INSTALL_CLAUDE ? [{
    label: "Add the bgsd marketplace (idempotent)",
    cmd: "claude",
    cmdArgs: ["plugin", "marketplace", "add", "filippo-fonseca/better-gsd"],
    needsClaude: true,
  }, {
    label: "Install the bgsd plugin (user scope)",
    cmd: "claude",
    cmdArgs: ["plugin", "install", "bgsd@better-gsd", "--scope", "user"],
    needsClaude: true,
  }, {
    label: "Install GSD for Claude Code",
    cmd: "npx",
    cmdArgs: ["-y", "@opengsd/gsd-core@latest", "--claude", "--global"],
    needsClaude: false,
  }] : []),
  ...(INSTALL_CODEX ? [{
    label: "Add the bgsd Codex marketplace (idempotent)",
    cmd: "codex",
    cmdArgs: ["plugin", "marketplace", "add", "filippo-fonseca/better-gsd"],
    needsCodex: true,
  }, {
    label: "Install the bgsd Codex plugin",
    cmd: "codex",
    cmdArgs: ["plugin", "add", "bgsd@better-gsd"],
    needsCodex: true,
  }, {
    label: "Install GSD for Codex",
    cmd: "npx",
    cmdArgs: ["-y", "@opengsd/gsd-core@latest", "--codex", "--global"],
    needsCodex: false,
  }] : []),
];

function banner() {
  console.log("");
  console.log(bold(cyan("  better-gsd")) + dim("  ·  the bgsd launcher"));
  console.log(dim("  Autonomous, self-verifying orchestration on top of GSD."));
  console.log("");
}

// Big branded splash, shown after a successful install. The npm launcher runs
// in a real terminal (outside Claude Code), where the full-width block art
// renders properly — unlike inside a Claude Code session, where it gets clipped.
function splash() {
  const art = [
    "██████╗   ██████╗  ███████╗ ██████╗ ",
    "██╔══██╗ ██╔════╝  ██╔════╝ ██╔══██╗",
    "██████╔╝ ██║  ███╗ ███████╗ ██║  ██║",
    "██╔══██╗ ██║   ██║ ╚════██║ ██║  ██║",
    "██████╔╝ ╚██████╔╝ ███████║ ██████╔╝",
    "╚═════╝   ╚═════╝  ╚══════╝ ╚═════╝ ",
  ];
  console.log("");
  for (const line of art) console.log("  " + green(line));
  console.log("");
  console.log("  " + bold("better-gsd") + dim("  ·  talk to the Conductor; it handles everything."));
  console.log("");
}

function help() {
  banner();
  console.log("Usage: " + bold("npx better-gsd@latest") + " [--all | --claude | --codex] [--dry-run]");
  console.log("");
  console.log("  Installs BGSD v2 and GSD for Claude Code, Codex, or both (default).");
  console.log("");
  console.log("Flags:");
  console.log("  --dry-run   Print the commands that would run, then exit.");
  console.log("  --all       Install both runtimes (default).");
  console.log("  --claude    Install only Claude Code support.");
  console.log("  --codex     Install only Codex support.");
  console.log("  --help, -h  Show this help.");
  console.log("");
}

function fmt(step) {
  return [step.cmd, ...step.cmdArgs].join(" ");
}

function fail(message) {
  console.error("");
  console.error(red("  Install failed: ") + message);
  console.error("");
  process.exit(1);
}

function ensureClaude() {
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    fail(
      "the 'claude' CLI was not found. Install Claude Code first: " +
        "https://docs.anthropic.com/en/docs/claude-code"
    );
  }
}

function ensureCodex() {
  const probe = spawnSync("codex", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    fail("the 'codex' CLI was not found. Install Codex first: https://developers.openai.com/codex/cli");
  }
}

function run(step) {
  console.log(cyan("  → ") + step.label);
  console.log(dim("    " + fmt(step)));
  const res = spawnSync(step.cmd, step.cmdArgs, { stdio: "inherit" });
  if (res.error) fail(`could not run '${step.cmd}': ${res.error.message}`);
  if (res.status !== 0) fail(`'${fmt(step)}' exited with code ${res.status}.`);
  console.log("");
}

function nextSteps() {
  splash();
  console.log(green("  bgsd is installed."));
  console.log("");
  console.log("  Next steps:");
  if (INSTALL_CLAUDE) console.log("    Claude Code: /reload-plugins, then " + bold('/bgsd-sesh "build me X"'));
  if (INSTALL_CODEX) console.log("    Codex: start a new task, then " + bold('$bgsd-sesh "build me X"'));
  console.log("    Check setup any time with " + bold("$bgsd-doctor") + " or the Claude doctor command.");
  console.log("");
}

function main() {
  if (HELP) {
    help();
    return;
  }
  banner();

  if (DRY_RUN) {
    console.log(dim("  --dry-run: showing commands without running them."));
    console.log("");
    for (const step of STEPS) {
      console.log(cyan("  → ") + step.label);
      console.log("    " + fmt(step));
    }
    console.log("");
    return;
  }

  if (STEPS.some((s) => s.needsClaude)) ensureClaude();
  if (STEPS.some((s) => s.needsCodex)) ensureCodex();
  for (const step of STEPS) run(step);
  nextSteps();
}

main();
