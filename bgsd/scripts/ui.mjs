/**
 * bgsd/scripts/ui.mjs
 *
 * Dependency-free terminal-UI helper for the bgsd Conductor (Kiwi).
 * Node built-ins only. Respects NO_COLOR and non-TTY environments.
 *
 * Usage:
 *   import { banner, stage, badge, dim, bold } from './ui.mjs';
 *
 * Self-test / demo:
 *   node bgsd/scripts/ui.mjs --demo
 */

import process from 'node:process';
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
const PILL_LEFT_CAP = "";
const PILL_RIGHT_CAP = "";

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
// Kiwi banner
// ---------------------------------------------------------------------------

/**
 * Print the Kiwi (bgsd Conductor) banner to stdout.
 *
 * @param {object} [opts]
 * @param {string} [opts.subtitle] - Optional subtitle line below the banner.
 */
/** Wrap text in the kiwi-green 256-color foreground (plain when color is off). */
function kiwiGreen(t) {
  if (!COLOR_OK) return t;
  return `\x1b[38;5;${KIWI_GREEN_256}m${t}\x1b[39m`;
}

// Block-letter "bgsd" logo (shown in the splash).
const BGSD_ART = [
  '██████╗   ██████╗  ███████╗ ██████╗ ',
  '██╔══██╗ ██╔════╝  ██╔════╝ ██╔══██╗',
  '██████╔╝ ██║  ███╗ ███████╗ ██║  ██║',
  '██╔══██╗ ██║   ██║ ╚════██║ ██║  ██║',
  '██████╔╝ ╚██████╔╝ ███████║ ██████╔╝',
  '╚═════╝   ╚═════╝  ╚══════╝ ╚═════╝ ',
];

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

/**
 * Print the branded bgsd splash: a block-letter logo, the tagline, the version,
 * and a "ready" line. Shown at the start of every /bgsd-sesh and on /bgsd-init.
 * Degrades to plain text under NO_COLOR / non-TTY.
 *
 * @param {object} [opts]
 * @param {string} [opts.subtitle]  Tagline line under the logo.
 * @param {string} [opts.ready]     Ready line (e.g. "Kiwi online").
 * @param {string} [opts.version]   Version string; defaults to pluginVersion().
 */
export function splash({ subtitle, ready = 'Kiwi online, at your service.', version } = {}) {
  const ver = version ?? pluginVersion();
  const tag = subtitle
    ?? 'Autonomous, self-verifying orchestration on top of GSD. Talk to the Conductor; it handles everything.';
  process.stdout.write('\n');
  for (const line of BGSD_ART) process.stdout.write('  ' + kiwiGreen(line) + '\n');
  process.stdout.write('\n');
  process.stdout.write('  ' + bold('better-gsd') + (ver ? '  ' + dim(ver) : '') + '\n');
  process.stdout.write('  ' + dim(tag) + '\n');
  if (ready) process.stdout.write('\n  ' + kiwiGreen('✓') + ' ' + ready + '\n');
  process.stdout.write('\n');
}

export function banner({ subtitle } = {}) {
  const top    = bold(cyan('╔════════════════════════════════════════╗'));
  const mid    = bold(cyan('║')) + bold(brightCyan('  bgsd · Kiwi  '))
               + dim(cyan('(Conductor v1)'))
               + '               '
               + bold(cyan('║'));
  const bot    = bold(cyan('╚════════════════════════════════════════╝'));

  process.stdout.write('\n' + top + '\n');
  process.stdout.write(mid + '\n');
  process.stdout.write(bot + '\n');

  if (subtitle) {
    process.stdout.write(dim('  ' + subtitle) + '\n');
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Stage renderer
// ---------------------------------------------------------------------------

/**
 * Print a stage/step header — signals which phase of the pipeline is active.
 *
 * @param {string} name    - Stage name, e.g. "Loading context"
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
// Self-test / demo (node ui.mjs --demo)
// ---------------------------------------------------------------------------

if (process.argv.includes('--demo')) {
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
  process.stdout.write(
    dim("I'm afraid two paths did not pass, sir. Full report follows.") + '\n\n'
  );
}
