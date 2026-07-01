/**
 * bgsd/scripts/ui.mjs
 *
 * Dependency-free terminal-UI helper for the bgsd Conductor (Kiwi).
 * Node built-ins only (plus an optional npx oh-my-logo shell-out).
 * Respects NO_COLOR and non-TTY environments.
 *
 * Exports (ESM):
 *   renderLogo, splash, banner, stage, finishBanner, kiwiPill,
 *   badge, statusLine, verdictLine, hr, pluginVersion,
 *   bold, dim, italic, under, green, cyan, …
 *
 * CLI (node ui.mjs <verb> [args] [--palette <name>]):
 *   splash    — big branded splash (oh-my-logo logo + tagline)
 *   init      — init-flavoured splash
 *   banner    — compact boxed banner
 *   stage     — stage header:  node ui.mjs stage "Loop 1" "3 agents running"
 *   finish    — celebratory done banner
 *
 * Self-test / demo:
 *   node bgsd/scripts/ui.mjs --demo
 */

import process from 'node:process';
import { spawnSync as _spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/** True when the terminal supports ANSI color sequences. */
const COLOR_OK =
  !process.env['NO_COLOR'] &&
  !process.env['CI']?.match(/^(true|1)$/i) &&
  process.stdout.isTTY;

// ---------------------------------------------------------------------------
// Low-level ANSI helpers
// ---------------------------------------------------------------------------

/**
 * Wrap `text` in an ANSI SGR sequence.
 * Falls back to plain text when color is disabled.
 *
 * @param {string} text
 * @param {number} open  - SGR open code
 * @param {number} close - SGR close code
 * @returns {string}
 */
function ansi(text, open, close) {
  if (!COLOR_OK) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

// Text styles
export const bold   = (t) => ansi(t, 1, 22);
export const dim    = (t) => ansi(t, 2, 22);
export const italic = (t) => ansi(t, 3, 23);
export const under  = (t) => ansi(t, 4, 24);

// Foreground colors
export const black   = (t) => ansi(t, 30, 39);
export const red     = (t) => ansi(t, 31, 39);
export const green   = (t) => ansi(t, 32, 39);
export const yellow  = (t) => ansi(t, 33, 39);
export const blue    = (t) => ansi(t, 34, 39);
export const magenta = (t) => ansi(t, 35, 39);
export const cyan    = (t) => ansi(t, 36, 39);
export const white   = (t) => ansi(t, 37, 39);

// Bright foreground colors
export const brightRed    = (t) => ansi(t, 91, 39);
export const brightGreen  = (t) => ansi(t, 92, 39);
export const brightYellow = (t) => ansi(t, 93, 39);
export const brightBlue   = (t) => ansi(t, 94, 39);
export const brightCyan   = (t) => ansi(t, 96, 39);
export const brightWhite  = (t) => ansi(t, 97, 39);

// ---------------------------------------------------------------------------
// Kiwi pill — the colored `kiwi · conductor` label on Kiwi's messages
// ---------------------------------------------------------------------------

// Kiwi green, as 256-color index 35 (a leafy mid-green). Used for both the
// pill background and the foreground of the rounded end-caps so the half-circle
// glyphs read as the rounded ends of a single pill.
const KIWI_GREEN_256 = 35;

// Rounded end-cap glyphs (Powerline). Left = U+E0B6, right = U+E0B4.
const PILL_LEFT_CAP = "";
const PILL_RIGHT_CAP = "";

/**
 * Render Kiwi's conversational pill: a rounded, kiwi-green label with bold
 * white text reading `kiwi · conductor`. Prefix EVERY user-facing
 * conversational / narration message from Kiwi with this, mirroring how
 * gsd-verifier / gsd-executor tag their terminal output. Structured outputs
 * (verdict lines, JSON reports, status signals) stay literal and pill-free.
 *
 * Pure: a string in, a string out. Color is gated on an injectable env so the
 * helper stays testable without touching the real terminal. When NO_COLOR is
 * set or output is not a TTY, it degrades to a plain `[kiwi · conductor]`
 * bracket form with no ANSI.
 *
 * @param {string} [label="kiwi · conductor"] - Text inside the pill.
 * @param {object} [opts]
 * @param {object} [opts.env=process.env] - Env source (for NO_COLOR / CI).
 * @param {boolean} [opts.isTTY] - TTY override; defaults to process.stdout.isTTY.
 * @returns {string}
 */
export function kiwiPill(label = "kiwi · conductor", { env = process.env, isTTY } = {}) {
  const tty = isTTY ?? Boolean(process.stdout.isTTY);
  const colorOk = !env["NO_COLOR"] && !env["CI"]?.match?.(/^(true|1)$/i) && tty;

  if (!colorOk) return `[${label}]`;

  // Bold white text (1;97) on a kiwi-green 256-color background (48;5;35),
  // padded with a leading and trailing space.
  const body = `\x1b[1;97;48;5;${KIWI_GREEN_256}m ${label} \x1b[0m`;
  // End-caps: green foreground (38;5;35) on default background so the half
  // circles colour-match the body and read as rounded ends.
  const leftCap = `\x1b[38;5;${KIWI_GREEN_256}m${PILL_LEFT_CAP}\x1b[0m`;
  const rightCap = `\x1b[38;5;${KIWI_GREEN_256}m${PILL_RIGHT_CAP}\x1b[0m`;

  return `${leftCap}${body}${rightCap}`;
}

// ---------------------------------------------------------------------------
// oh-my-logo integration
// ---------------------------------------------------------------------------

/** Wrap text in the kiwi-green 256-color foreground (plain when color is off). */
function kiwiGreen(t) {
  if (!COLOR_OK) return t;
  return `\x1b[38;5;${KIWI_GREEN_256}m${t}\x1b[39m`;
}

// Block-letter "bgsd" logo (shown in the splash when oh-my-logo is unavailable).
const BGSD_ART = [
  '██████╗   ██████╗  ███████╗ ██████╗ ',
  '██╔══██╗ ██╔════╝  ██╔════╝ ██╔══██╗',
  '██████╔╝ ██║  ███╗ ███████╗ ██║  ██║',
  '██╔══██╗ ██║   ██║ ╚════██║ ██║  ██║',
  '██████╔╝ ╚██████╔╝ ███████║ ██████╔╝',
  '╚═════╝   ╚═════╝  ╚══════╝ ╚═════╝ ',
];

/**
 * Render the bgsd logo via `npx --yes oh-my-logo`, falling back gracefully to
 * BGSD_ART on any failure (timeout, non-zero exit, non-TTY, error).
 *
 * Never throws — a banner must never break a run.
 *
 * @param {string}   [text="BGSD"]
 * @param {object}   [opts]
 * @param {string}   [opts.palette="sunset"]       oh-my-logo palette name
 * @param {boolean}  [opts.filled=true]            pass --filled to oh-my-logo
 * @param {Function} [opts.spawnImpl=spawnSync]    injectable for tests
 * @returns {string}  rendered logo (may contain ANSI) or BGSD_ART fallback
 */
export function renderLogo(text = 'BGSD', { palette = 'sunset', filled = true, spawnImpl = _spawnSync } = {}) {
  try {
    const args = ['--yes', 'oh-my-logo', text, palette];
    if (filled) args.push('--filled');

    const result = spawnImpl('npx', args, {
      encoding: 'utf8',
      timeout: 8000,        // 8 s: generous but bounded
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    // Any error or non-zero exit: fall back.
    if (result.error || result.status !== 0 || !result.stdout) {
      return _fallbackLogo();
    }

    // Strip trailing cursor-hide / line-clear / reset escape codes that
    // oh-my-logo emits after its last line so they do not pollute the terminal.
    // Sequences to strip: \x1b[?25h (cursor-show), \x1b[K (erase-to-EOL),
    // standalone \x1b[0m resets at the very end, and stray trailing whitespace.
    const cleaned = result.stdout
      .replace(/\x1b\[\?25[hl]/g, '')  // cursor show/hide
      .replace(/\x1b\[K/g, '')         // erase-to-EOL
      .replace(/(\x1b\[0m\s*)+$/, '')  // trailing resets + blank space
      .trimEnd();

    return cleaned || _fallbackLogo();
  } catch (_) {
    return _fallbackLogo();
  }
}

/** Build the kiwi-green BGSD_ART string (shared by fallback paths). */
function _fallbackLogo() {
  return BGSD_ART.map((line) => '  ' + kiwiGreen(line)).join('\n');
}

// ---------------------------------------------------------------------------
// Plugin version
// ---------------------------------------------------------------------------

/** Read the installed plugin version from ../.claude-plugin/plugin.json. */
export function pluginVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pj = JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return pj.version ? `v${pj.version}` : '';
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Lifecycle banners
// ---------------------------------------------------------------------------

/**
 * Print the branded bgsd splash: a block-letter logo (oh-my-logo when
 * available, kiwi-green BGSD_ART otherwise), the tagline, the version,
 * and a "ready" line. Shown at the start of every /bgsd-sesh.
 * Degrades to plain text under NO_COLOR / non-TTY.
 *
 * @param {object} [opts]
 * @param {string} [opts.subtitle]   Tagline line under the logo.
 * @param {string} [opts.ready]      Ready line (e.g. "Kiwi online").
 * @param {string} [opts.version]    Version string; defaults to pluginVersion().
 * @param {string} [opts.palette]    oh-my-logo palette; defaults to "sunset".
 * @param {Function} [opts.spawnImpl] Injectable spawnSync for tests.
 */
export function splash({ subtitle, ready = 'Kiwi online, at your service.', version, palette = 'sunset', spawnImpl } = {}) {
  const ver = version ?? pluginVersion();
  const tag = subtitle
    ?? 'Autonomous, self-verifying orchestration on top of GSD. Talk to the Conductor; it handles everything.';

  const logoStr = renderLogo('BGSD', { palette, spawnImpl });

  process.stdout.write('\n');
  process.stdout.write(logoStr + '\n');
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('better-gsd') + (ver ? '  ' + dim(ver) : '') + '\n');
  process.stdout.write('  ' + dim(tag) + '\n');
  if (ready) process.stdout.write('\n  ' + kiwiGreen('✓') + ' ' + ready + '\n');
  process.stdout.write('\n');
}

/**
 * Print the compact boxed banner (used between-stage or in tighter contexts).
 *
 * @param {object} [opts]
 * @param {string} [opts.subtitle]
 * @param {string} [opts.palette]    oh-my-logo palette; defaults to "sunset".
 * @param {Function} [opts.spawnImpl]
 */
export function banner({ subtitle, palette = 'sunset', spawnImpl } = {}) {
  const logoStr = renderLogo('BGSD', { palette, spawnImpl });

  // If the logo rendered something meaningful (not just fallback lines), print
  // it. Either way we also print the compact box for structure.
  process.stdout.write('\n');
  process.stdout.write(logoStr + '\n\n');

  const top = bold(cyan('╔════════════════════════════════════════╗'));
  const mid = bold(cyan('║')) + bold(brightCyan('  bgsd · Kiwi  '))
            + dim(cyan('(Conductor v1)'))
            + '               '
            + bold(cyan('║'));
  const bot = bold(cyan('╚════════════════════════════════════════╝'));

  process.stdout.write(top + '\n');
  process.stdout.write(mid + '\n');
  process.stdout.write(bot + '\n');

  if (subtitle) {
    process.stdout.write(dim('  ' + subtitle) + '\n');
  }
  process.stdout.write('\n');
}

/**
 * Print the init-flavoured splash — same as splash() but with init-specific
 * ready text. Shown at the start of /bgsd-init.
 *
 * @param {object} [opts]
 * @param {string} [opts.palette]
 * @param {Function} [opts.spawnImpl]
 */
export function initBanner({ palette = 'ocean', spawnImpl } = {}) {
  splash({
    subtitle: 'Setting up this repository for bgsd. One moment, sir.',
    ready: 'Init sequence starting.',
    palette,
    spawnImpl,
  });
}

/**
 * Print a celebratory "session done" banner. Shown at session FINISH.
 *
 * @param {object} [opts]
 * @param {string} [opts.summary]    One-line summary of what shipped.
 * @param {string} [opts.palette]    oh-my-logo palette; defaults to "fire".
 * @param {Function} [opts.spawnImpl]
 */
export function finishBanner({ summary, palette = 'fire', spawnImpl } = {}) {
  const logoStr = renderLogo('BGSD', { palette, spawnImpl });

  process.stdout.write('\n');
  process.stdout.write(logoStr + '\n\n');

  const top = bold(brightGreen('╔════════════════════════════════════════╗'));
  const mid = bold(brightGreen('║')) + bold(brightWhite('  ✓  Session complete — shipped, sir.  '))
            + bold(brightGreen('║'));
  const bot = bold(brightGreen('╚════════════════════════════════════════╝'));

  process.stdout.write(top + '\n');
  process.stdout.write(mid + '\n');
  process.stdout.write(bot + '\n');

  if (summary) {
    process.stdout.write('\n  ' + brightGreen('✓') + '  ' + bold(summary) + '\n');
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Stage renderer
// ---------------------------------------------------------------------------

/**
 * Print a stage/step header — signals which phase of the pipeline is active.
 *
 * @param {string} name    - Stage name, e.g. "Loop 1"
 * @param {string} [note]  - Optional short parenthetical note
 */
export function stage(name, note) {
  const prefix = bold(blue('▶'));
  const label  = bold(white(name));
  const suffix = note ? dim(`  (${note})`) : '';
  process.stdout.write(`${prefix}  ${label}${suffix}\n`);
}

// ---------------------------------------------------------------------------
// Color-coded state badges
// ---------------------------------------------------------------------------

/** @typedef {'running'|'blocked'|'needs-input'|'done'|'failed'} BadgeState */

const BADGE_DEFS = {
  'running':     { color: brightYellow, symbol: '⟳', label: 'RUNNING'     },
  'blocked':     { color: yellow,       symbol: '⏸', label: 'BLOCKED'     },
  'needs-input': { color: brightCyan,   symbol: '?', label: 'NEEDS INPUT' },
  'done':        { color: brightGreen,  symbol: '✓', label: 'DONE'        },
  'failed':      { color: brightRed,    symbol: '✗', label: 'FAILED'      },
};

/**
 * Render a color-coded state badge inline (returns a string, does not print).
 *
 * @param {BadgeState} state
 * @returns {string}
 */
export function badge(state) {
  const def = BADGE_DEFS[state];
  if (!def) return `[${state}]`;
  return def.color(`[${def.symbol} ${def.label}]`);
}

/**
 * Print a status line: badge + agent/task name + optional detail.
 *
 * @param {BadgeState} state
 * @param {string}     name   - Agent or task name
 * @param {string}     [detail]
 */
export function statusLine(state, name, detail) {
  const b     = badge(state);
  const label = bold(name);
  const tail  = detail ? '  ' + dim(detail) : '';
  process.stdout.write(`  ${b}  ${label}${tail}\n`);
}

// ---------------------------------------------------------------------------
// Verdict line printer (ALWAYS plain — no ANSI, no butler persona)
// ---------------------------------------------------------------------------

/**
 * Print a machine-parseable verdict line.
 * This is the ONLY output format allowed for structured results.
 * No color, no personality. Format: `PASS|FAIL|ERROR  <path>`
 *
 * @param {'PASS'|'FAIL'|'ERROR'} verdict
 * @param {string} path
 */
export function verdictLine(verdict, path) {
  // Two spaces between verdict and path — contract format.
  process.stdout.write(`${verdict}  ${path}\n`);
}

// ---------------------------------------------------------------------------
// Utility: horizontal rule
// ---------------------------------------------------------------------------

/**
 * Print a dim horizontal rule.
 *
 * @param {number} [width=44]
 */
export function hr(width = 44) {
  process.stdout.write(dim('─'.repeat(width)) + '\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint — node ui.mjs <verb> [args] [--palette <name>]
//
// verb ∈ splash | init | banner | stage | finish
//
// Follows the same CLI-guard pattern as phaseconfig.mjs: only activates when
// this file is the main entry-point (import.meta.url === resolved argv[1]).
// ---------------------------------------------------------------------------

function _isMain() {
  try {
    const base = import.meta.url.startsWith('file://')
      ? import.meta.url
      : `file://${process.cwd()}/`;
    return import.meta.url === new URL(process.argv[1], base).href;
  } catch (_) {
    return false;
  }
}

if (_isMain()) {
  // Parse positional args + --palette / --demo flags.
  const rawArgs = process.argv.slice(2);

  // Handle legacy --demo flag.
  if (rawArgs.includes('--demo')) {
    banner({ subtitle: 'At your service, sir. Ready to run the verification suite.' });
    process.stdout.write(kiwiPill() + ' Very good, sir. Let us cook.\n\n');
    stage('Loading context', 'phase 3 / milestone-alpha');
    stage('Running probes');
    stage('Assembling verification report');
    process.stdout.write('\n');
    hr();
    process.stdout.write(bold('Active subagents') + '\n');
    hr();
    statusLine('running',     'bgsd-tester',    'probe-auth.sh');
    statusLine('running',     'bgsd-verifier',  'truth #2 wiring check');
    statusLine('blocked',     'bgsd-reporter',  'waiting on tester');
    statusLine('needs-input', 'bgsd-conductor', 'override decision required');
    statusLine('done',        'bgsd-scanner',   '7 files scanned');
    statusLine('failed',      'bgsd-prober',    'exit 1 — probe-db.sh');
    process.stdout.write('\n');
    hr();
    process.stdout.write(bold('Structured verdict output (always plain)') + '\n');
    hr();
    verdictLine('PASS',  'src/components/MessageList.tsx');
    verdictLine('FAIL',  'src/api/messages/route.ts');
    verdictLine('ERROR', 'src/lib/db.ts');
    process.stdout.write('\n');
    process.stdout.write(dim("I'm afraid two paths did not pass, sir. Full report follows.") + '\n\n');
    process.exit(0);
  }

  // Parse --palette <name> out of rawArgs; remaining args are positional.
  const positional = [];
  let palette = 'sunset';
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--palette' && rawArgs[i + 1]) {
      palette = rawArgs[++i];
    } else if (!rawArgs[i].startsWith('--')) {
      positional.push(rawArgs[i]);
    }
  }

  const verb = positional[0];

  switch (verb) {
    case 'splash': {
      splash({ palette });
      break;
    }
    case 'init': {
      initBanner({ palette: palette === 'sunset' ? 'ocean' : palette });
      break;
    }
    case 'banner': {
      banner({ subtitle: positional[1], palette });
      break;
    }
    case 'stage': {
      // node ui.mjs stage "Loop 1" "3 agents running"
      const name = positional[1] ?? 'Stage';
      const note = positional[2];
      stage(name, note);
      break;
    }
    case 'finish': {
      finishBanner({ summary: positional[1], palette: palette === 'sunset' ? 'fire' : palette });
      break;
    }
    default: {
      process.stderr.write(
        'bgsd ui — print branded banners\n\n' +
        'Usage: node ui.mjs <verb> [args] [--palette <name>]\n\n' +
        'Verbs:\n' +
        '  splash                          big branded splash (session start)\n' +
        '  init                            init-flavoured splash (/bgsd-init)\n' +
        '  banner [subtitle]               compact boxed banner\n' +
        '  stage  <name> [note]            stage/step header\n' +
        '  finish [summary]                celebratory done banner\n\n' +
        'Options:\n' +
        '  --palette <name>                oh-my-logo palette (sunset|ocean|fire|mono…)\n\n' +
        'Example:\n' +
        '  node ui.mjs stage "Loop 1" "3 agents running"\n' +
        '  node ui.mjs finish "auth + search shipped"\n'
      );
      process.exit(1);
    }
  }
}
