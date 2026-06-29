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
// Kiwi banner
// ---------------------------------------------------------------------------

/**
 * Print the Kiwi (bgsd Conductor) banner to stdout.
 *
 * @param {object} [opts]
 * @param {string} [opts.subtitle] - Optional subtitle line below the banner.
 */
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
