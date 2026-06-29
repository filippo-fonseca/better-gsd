#!/usr/bin/env bash
#
# bgsd runtime-isolate — boot ONE app instance in isolation: deterministic-but-
# collision-safe port + ephemeral SQLite DB, with clean teardown. Never touches
# the app's own .env / .env.local.
#
# Phase 2: ISO-01..04 fully implemented.
#
# USAGE:
#   runtime-isolate.sh up   <app-dir> [--seed <file>] [--keep-db]
#   runtime-isolate.sh down <app-dir>
#   runtime-isolate.sh --help
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="${REPO_ROOT}/.bgsd-tmp"
READY_TIMEOUT=60

usage() {
  cat <<'USAGE'
runtime-isolate.sh — boot one Next.js app instance in isolation

USAGE:
  runtime-isolate.sh up   <app-dir> [--seed <file>] [--keep-db]
  runtime-isolate.sh down <app-dir>
  runtime-isolate.sh --help

SUBCOMMANDS:
  up    Pick a deterministic, collision-safe port (hash of abs app-dir path,
        range 3100-3999). Provision an ephemeral SQLite DB under .bgsd-tmp/.
        Write .env.bgsd in the app dir overriding ONLY PORT and DATABASE_URL.
        Boot `next dev`; signal ready only after the dev-server readiness
        string appears in the log (60 s timeout — never a blind sleep).

        Options:
          --seed <file>   Run/copy this file to seed the DB after provisioning.
          --keep-db       Skip DB removal on `down`.

  down  Kill the tracked server process and remove ephemeral DB (unless
        --keep-db was stored), leaving no orphaned port or state.

OUTPUTS:
  Chosen PORT and DATABASE_URL printed to stdout on `up`.
USAGE
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Portable sha256 → decimal hash of a string (last 4 hex digits → decimal)
path_hash() {
  local input="$1"
  if command -v sha256sum &>/dev/null; then
    printf '%d' "0x$(printf '%s' "$input" | sha256sum | cut -c1-4)"
  else
    # macOS ships shasum
    printf '%d' "0x$(printf '%s' "$input" | shasum -a 256 | cut -c1-4)"
  fi
}

# Find a free port starting at $1
find_free_port() {
  local port="$1"
  while lsof -i :"$port" &>/dev/null 2>&1; do
    port=$(( port + 1 ))
  done
  echo "$port"
}

# Write a file keyed by app-dir hash
meta_file() {
  local hash="$1" suffix="$2"
  echo "${TMP_DIR}/${hash}${suffix}"
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------

cmd_up() {
  local app_dir=""
  local seed_file=""
  local keep_db=0

  # parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --seed)
        shift
        seed_file="${1:-}"
        shift
        ;;
      --keep-db)
        keep_db=1
        shift
        ;;
      -*)
        echo "runtime-isolate.sh up: unknown option '$1'" >&2
        usage >&2
        exit 64
        ;;
      *)
        if [[ -z "$app_dir" ]]; then
          app_dir="$1"
          shift
        else
          echo "runtime-isolate.sh up: unexpected argument '$1'" >&2
          exit 64
        fi
        ;;
    esac
  done

  if [[ -z "$app_dir" ]]; then
    echo "runtime-isolate.sh up: <app-dir> is required" >&2
    usage >&2
    exit 64
  fi

  # Resolve to absolute path
  app_dir="$(cd "$app_dir" && pwd)"

  # Guard: do not boot if already running
  local hash
  hash="$(path_hash "$app_dir")"
  local pidfile
  pidfile="$(meta_file "$hash" ".pid")"
  if [[ -f "$pidfile" ]]; then
    local existing_pid
    existing_pid="$(cat "$pidfile")"
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "runtime-isolate.sh: instance already running for '${app_dir}' (PID ${existing_pid}). Run 'down' first." >&2
      exit 1
    else
      # Stale pidfile
      rm -f "$pidfile"
    fi
  fi

  # ISO-01: deterministic, collision-safe port
  local base_port
  base_port=$(( 3100 + (hash % 900) ))
  local port
  port="$(find_free_port "$base_port")"
  echo "PORT: ${port}"

  # ISO-02: ephemeral SQLite DB + .env.bgsd
  mkdir -p "$TMP_DIR"
  local db_file
  db_file="$(meta_file "$hash" ".sqlite")"
  local log_file
  log_file="$(meta_file "$hash" ".log")"
  local keepdb_file
  keepdb_file="$(meta_file "$hash" ".keepdb")"

  # Track keep-db preference in the tmp dir so `down` honours it
  if [[ "$keep_db" -eq 1 ]]; then
    touch "$keepdb_file"
  else
    rm -f "$keepdb_file"
  fi

  # Create the SQLite file (touch is enough; next dev doesn't need a schema)
  touch "$db_file"
  echo "DATABASE_URL: file:${db_file}"

  # Write .env.bgsd — ONLY PORT and DATABASE_URL
  local env_bgsd="${app_dir}/.env.bgsd"
  cat > "$env_bgsd" <<EOF
PORT=${port}
DATABASE_URL=file:${db_file}
EOF
  echo ".env.bgsd written at ${env_bgsd}"

  # Optional seed
  if [[ -n "$seed_file" ]]; then
    if [[ ! -f "$seed_file" ]]; then
      echo "runtime-isolate.sh: seed file '${seed_file}' not found" >&2
      exit 1
    fi
    echo "Seeding DB from '${seed_file}'..."
    # If executable, run it; otherwise just copy alongside the DB
    if [[ -x "$seed_file" ]]; then
      DATABASE_URL="file:${db_file}" "$seed_file"
    else
      cp "$seed_file" "${db_file}.seed"
    fi
    echo "Seed done."
  fi

  # ISO-03: boot next dev in background
  echo "Booting next dev on port ${port}..."
  # Enable monitor (job-control) mode so that background processes `( ) &` get
  # their own PGID. Without -m, bash in non-interactive mode inherits the
  # caller's PGID for backgrounded jobs, which means `down`'s PGID-kill would
  # propagate back to the caller (e.g. a Node test harness). With -m set,
  # background processes form a new process group that `down` can safely kill
  # without affecting the parent.
  set -m
  (
    cd "$app_dir"
    # Merge .env.bgsd values into the environment for this shell
    # shellcheck disable=SC1090
    set -o allexport
    # Load .env.bgsd manually (no `source` with allexport on older bash)
    while IFS='=' read -r k v; do
      [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      export "$k=$v"
    done < .env.bgsd
    set +o allexport
    exec npx next dev --port "$port"
  ) > "$log_file" 2>&1 &
  local server_pid=$!
  echo "$server_pid" > "$pidfile"
  echo "Server PID: ${server_pid} (logged at ${log_file})"

  # ISO-03: detect readiness — grep log for known readiness strings, with timeout
  local elapsed=0
  local ready=0
  local matched_line=""
  echo "Waiting for readiness (timeout ${READY_TIMEOUT}s)..."
  while [[ $elapsed -lt $READY_TIMEOUT ]]; do
    # Check if server process is still alive
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "runtime-isolate.sh: server process (PID ${server_pid}) exited unexpectedly. Log:" >&2
      tail -20 "$log_file" >&2
      rm -f "$pidfile"
      exit 1
    fi

    if [[ -f "$log_file" ]]; then
      matched_line="$(grep -m1 -E 'Ready in|compiled successfully|ready - started server|Local:' "$log_file" 2>/dev/null || true)"
      if [[ -n "$matched_line" ]]; then
        ready=1
        break
      fi
    fi

    sleep 1
    elapsed=$(( elapsed + 1 ))
  done

  if [[ "$ready" -eq 0 ]]; then
    echo "runtime-isolate.sh: timed out after ${READY_TIMEOUT}s waiting for readiness. Last 20 log lines:" >&2
    tail -20 "$log_file" >&2
    # Kill the hung process
    kill "$server_pid" 2>/dev/null || true
    rm -f "$pidfile"
    exit 1
  fi

  echo ""
  echo "READY — matched: ${matched_line}"
  echo "App is running at http://localhost:${port}"
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------

cmd_down() {
  local app_dir=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -*)
        echo "runtime-isolate.sh down: unknown option '$1'" >&2
        usage >&2
        exit 64
        ;;
      *)
        if [[ -z "$app_dir" ]]; then
          app_dir="$1"
          shift
        else
          echo "runtime-isolate.sh down: unexpected argument '$1'" >&2
          exit 64
        fi
        ;;
    esac
  done

  if [[ -z "$app_dir" ]]; then
    echo "runtime-isolate.sh down: <app-dir> is required" >&2
    usage >&2
    exit 64
  fi

  app_dir="$(cd "$app_dir" && pwd)"

  local hash
  hash="$(path_hash "$app_dir")"
  local pidfile
  pidfile="$(meta_file "$hash" ".pid")"
  local db_file
  db_file="$(meta_file "$hash" ".sqlite")"
  local keepdb_file
  keepdb_file="$(meta_file "$hash" ".keepdb")"
  local log_file
  log_file="$(meta_file "$hash" ".log")"

  # ISO-04: kill server
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    echo "Stopping server (PID ${pid})..."
    # Kill the process group to catch child processes spawned by next dev
    if kill -0 "$pid" 2>/dev/null; then
      # Send SIGTERM to the process group
      kill -- "-$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null || kill "$pid" 2>/dev/null || true
      # Wait up to 5s for it to die
      local wait_elapsed=0
      while kill -0 "$pid" 2>/dev/null && [[ $wait_elapsed -lt 5 ]]; do
        sleep 1
        wait_elapsed=$(( wait_elapsed + 1 ))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$pidfile"
    echo "Server stopped."
  else
    echo "runtime-isolate.sh down: no pidfile found at '${pidfile}' — maybe already stopped." >&2
  fi

  # ISO-04: remove .env.bgsd from app dir
  local env_bgsd="${app_dir}/.env.bgsd"
  if [[ -f "$env_bgsd" ]]; then
    rm -f "$env_bgsd"
    echo "Removed ${env_bgsd}"
  fi

  # ISO-04: remove ephemeral DB (unless --keep-db was set during `up`)
  if [[ -f "$keepdb_file" ]]; then
    echo "Keeping DB (--keep-db was set): ${db_file}"
    rm -f "$keepdb_file"
  else
    if [[ -f "$db_file" ]]; then
      rm -f "$db_file"
      echo "Removed DB: ${db_file}"
    fi
  fi

  # Clean up log
  rm -f "$log_file"

  echo "Teardown complete."
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

case "${1:-}" in
  -h|--help|help|"")
    usage
    exit 0
    ;;
  up)
    shift
    cmd_up "$@"
    ;;
  down)
    shift
    cmd_down "$@"
    ;;
  *)
    echo "runtime-isolate.sh: unknown subcommand '${1}'." >&2
    usage >&2
    exit 64
    ;;
esac
