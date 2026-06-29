#!/usr/bin/env bash
#
# bgsd runtime-isolate — boot ONE app instance in isolation: a deterministic-but-
# collision-safe port + an ephemeral DB, with clean teardown. Never touches the
# app's own .env / .env.local.
#
# Status: v0 skeleton (Phase 1). The interface below is declared; the implementation
# lands in Phase 2 (ISO-01..04). Running it now prints the planned interface and
# refuses to pretend it booted anything ("no silent green").
#
set -euo pipefail

usage() {
  cat <<'USAGE'
runtime-isolate.sh — boot one app instance in isolation (Phase 2; not yet implemented)

USAGE:
  runtime-isolate.sh up   <app-dir> [--seed <file>] [--keep-db]
  runtime-isolate.sh down <app-dir>
  runtime-isolate.sh --help

PLANNED BEHAVIOR (Phase 2 — ISO-01..04):
  up    Pick a deterministic port (hash of app-dir path), collision-checked via lsof.
        Provision an ephemeral SQLite DB; write .env.bgsd overriding ONLY PORT and
        DATABASE_URL. Boot `next dev` in development mode; signal ready only after the
        dev-server readiness string appears in the log (timeout-guarded — never a blind sleep).
  down  Kill the server process and remove the ephemeral DB (unless --keep-db),
        leaving no orphaned port or state.

Outputs (planned): chosen PORT and DATABASE_URL on stdout; .env.bgsd alongside the app.
USAGE
}

case "${1:-}" in
  -h|--help|help|"")
    usage
    exit 0
    ;;
  up|down)
    echo "runtime-isolate.sh: '$1' not yet implemented (Phase 2 — ISO-01..04)." >&2
    exit 64
    ;;
  *)
    echo "runtime-isolate.sh: unknown subcommand '$1'." >&2
    usage >&2
    exit 64
    ;;
esac
