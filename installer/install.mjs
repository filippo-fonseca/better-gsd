#!/usr/bin/env node
// better-gsd launcher: a tiny installer for the bgsd Claude Code plugin.
// It does NOT bundle the plugin source. The plugin ships from the public
// GitHub marketplace filippo-fonseca/better-gsd; this script just wires it up.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const HELP = args.includes("--help") || args.includes("-h");

// ANSI helpers (kept minimal, no external deps).
const c = (code, s) => `[${code}m${s}[0m`;
const bold = (s) => c("1", s);
const cyan = (s) => c("36", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);

// The commands this launcher runs, in order.
const STEPS = [
  {
    label: "Add the bgsd marketplace (idempotent)",
    cmd: "claude",
    cmdArgs: ["plugin", "marketplace", "add", "filippo-fonseca/better-gsd"],
    needsClaude: true,
  },
  {
    label: "Install the bgsd plugin (user scope)",
    cmd: "claude",
    cmdArgs: ["plugin", "install", "bgsd@better-gsd", "--scope", "user"],
    needsClaude: true,
  },
  {
    label: "Install the gsd-core engine (global, non-interactive)",
    cmd: "npx",
    cmdArgs: ["-y", "@opengsd/gsd-core@latest", "--claude", "--global"],
    needsClaude: false,
  },
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
  console.log("Usage: " + bold("npx better-gsd@latest") + " [--dry-run] [--help]");
  console.log("");
  console.log("  Installs the bgsd Claude Code plugin and the gsd-core engine.");
  console.log("");
  console.log("Flags:");
  console.log("  --dry-run   Print the commands that would run, then exit.");
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
  console.log("    1. In Claude Code, run " + bold("/reload-plugins"));
  console.log("    2. In your repo, run " + bold("/bgsd-init"));
  console.log("    3. Kick off a session: " + bold('/bgsd-sesh "build me X"'));
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
  for (const step of STEPS) run(step);
  nextSteps();
}

main();
