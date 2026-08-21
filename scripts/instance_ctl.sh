#!/usr/bin/env bash
#
# instance_ctl.sh — spin up / tear down a named flowpad instance from THIS checkout.
#
# A named instance (e.g. "dev-1") is a second, fully-isolated backend+frontend
# pair running out of the same repo the script lives in. It gets its own
# ~/.flow/instances/<name>/ data dir (DB, sodot, singleton lock), its own ports,
# and its own hub user <name>@local.test — so it can stand in for the separate
# "bob"/app checkout in conversation/collaboration testing.
#
# Port scheme (per the spec): frontend 500X, backend 600X, where X is the
# trailing number in the instance name (dev-1 -> 5001 / 6001). If the preferred
# port is busy the launcher scans upward within the band and warns. Backend
# never uses 6000 (Chrome/Firefox block it as ERR_UNSAFE_PORT); frontend never
# uses 5000 (macOS AirPlay).
#
# Usage:
#   scripts/instance_ctl.sh launch <name> [--email E] [--password P] [--hub URL]
#   scripts/instance_ctl.sh kill   <name> [--keep-env]
#   scripts/instance_ctl.sh status [<name>]
#   scripts/instance_ctl.sh list
#   scripts/instance_ctl.sh gc     [--yes] [--age DAYS]
#
# The launch writes FLOW_INSTANCE=<name> into .env.<name>.local, so `flow`
# commands run against that instance target it: `FLOW_INSTANCE=<name> flow ...`
# (reads ~/.flow/instances/<name>/server.json). Spawned agentic workers inherit
# FLOW_INSTANCE from the backend automatically.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW_HOME="${FLOW_HOME:-$HOME/.flow}"
HUB_URL_DEFAULT="${FLOWPAD_HUB_URL:-http://localhost:8093}"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
log()  { printf '\033[36m[instance_ctl]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[instance_ctl] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[instance_ctl] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

instance_dir() { echo "$FLOW_HOME/instances/$1"; }
registry()     { echo "$(instance_dir "$1")/launcher.json"; }
env_file()     { echo "$REPO_ROOT/.env.$1.local"; }   # vite reads this via --mode <name>

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# in_list <item> <space-separated-list>
in_list() {
  local x
  for x in $2; do [ "$x" = "$1" ] && return 0; done
  return 1
}

# Ports we must never hand out even if nothing is currently listening on them,
# because another well-known service owns them on this machine:
#   5001 -> neo4j
RESERVED_PORTS="5001"
port_reserved() { in_list "$1" "$RESERVED_PORTS"; }

# find_free_port <band_base> <preferred>  -> echoes a free port in [preferred, band_base+99]
find_free_port() {
  local base="$1" pref="$2" p
  for (( p=pref; p<=base+99; p++ )); do
    port_reserved "$p" && continue
    port_in_use "$p" || { echo "$p"; return 0; }
  done
  return 1
}

# derive the numeric index from a name's trailing digits ("dev-1" -> 1)
name_index() {
  local n="$1" idx
  idx="$(echo "$n" | grep -oE '[0-9]+$' || true)"
  [ -n "$idx" ] && echo $((10#$idx)) || echo 1
}

require_uv()  { command -v uv  >/dev/null 2>&1 || die "uv not found on PATH"; }
require_npm() { command -v npm >/dev/null 2>&1 || die "npm not found on PATH"; }

# Detached background spawn that works on both Linux (setsid) and macOS (no
# setsid). Detaching from the controlling terminal so the child survives this
# shell. With MINIHUB_RELOAD=False the backend is a single process (no uvicorn
# reloader fork), so PID + port-based kill is enough — we don't need a process
# group. Echoes the child PID.
spawn_detached() {
  local logfile="$1"; shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$logfile" 2>&1 < /dev/null &
  else
    nohup "$@" >"$logfile" 2>&1 < /dev/null &
  fi
  echo $!
}

# ---------------------------------------------------------------------------
# gc — remove data dirs (and env files) of dead, abandoned instances.
#
# An instance is garbage when ALL of:
#   * it is not on the protected list (long-lived instances),
#   * no live process carries FLOW_INSTANCE=<name> in its environment
#     (ownership check — port checks lie once the 500X/600X band is recycled),
#   * no file under its data dir was touched within the age window.
# Runs automatically (with --yes) at the start of every launch, so leftovers
# from abandoned scratch instances can't accumulate again.
# ---------------------------------------------------------------------------
PROTECTED_INSTANCES="${PROTECTED_INSTANCES:-prod oss dev-1 dev-2}"

cmd_gc() {
  local yes=0 age_days=7
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes) yes=1; shift;;
      --age) age_days="$2"; shift 2;;
      *) die "unknown gc flag: $1";;
    esac
  done

  local root="$FLOW_HOME/instances"
  [ -d "$root" ] || { log "gc: no instances dir — nothing to do"; return 0; }

  # One env-visible process dump for all liveness checks (own processes only,
  # which is exactly who launches instances).
  local ps_env_dump
  ps_env_dump="$(ps eww -ax -o command= 2>/dev/null || true)"

  # An ARRAY, not a whitespace-joined string. The previous accumulation assumed
  # "names are plain tokens" and word-split on read, which destroyed a live
  # instance on 2026-08-18: a mis-quoted launch had left a directory literally
  # named `prod TESTING=true SQLITE_DATABASE_PATH=/tmp/flowpad_test.db`. It
  # passed the protection check (that full string is not in the list), then the
  # delete loop split it on spaces and `rm -rf`'d the FIRST word — the real
  # `prod` instance, database included. `launch` runs `cmd_gc --yes`, so it
  # happened with no prompt.
  local candidates=() count=0 d name
  for d in "$root"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    # A well-formed instance name is one plain token. Anything else is residue
    # from a mis-quoted launch and is NEVER a gc candidate: it cannot be deleted
    # by name safely, and its words may name real instances.
    case "$name" in
      *[[:space:]]*|*/*) log "gc: skipping malformed instance dir: $name"; continue;;
    esac
    in_list "$name" "$PROTECTED_INSTANCES" && continue
    [[ "$ps_env_dump" =~ (^|[[:space:]])FLOW_INSTANCE=$name([[:space:]]|$) ]] && continue
    [ -n "$(find "$d" -type f -mtime "-$age_days" -print -quit 2>/dev/null)" ] && continue
    candidates[${#candidates[@]}]="$name"; count=$((count + 1))
  done

  if [ "$count" = 0 ]; then
    log "gc: nothing to clean (dead + idle >${age_days}d; protected: $PROTECTED_INSTANCES)"
    return 0
  fi

  log "gc: dead instances idle >${age_days}d:"
  local n
  for n in "${candidates[@]}"; do echo "    $n"; done

  if [ "$yes" != 1 ]; then
    printf 'Delete these %d instance dir(s)? [y/N] ' "$count"
    local reply; read -r reply
    case "$reply" in y|Y|yes) ;; *) log "gc: aborted"; return 0;; esac
  fi

  for n in "${candidates[@]}"; do
    # Re-checked at the point of deletion, not only at selection. This is the
    # last gate before an irreversible `rm -rf`, so it must not rely on the
    # selection loop having been right.
    if in_list "$n" "$PROTECTED_INSTANCES"; then
      log "gc: refusing to delete protected instance '$n'"
      continue
    fi
    rm -rf "$(instance_dir "$n")"
    rm -f "$(env_file "$n")"
  done
  log "gc: removed $count instance dir(s)"
}

# ---------------------------------------------------------------------------
# launch
# ---------------------------------------------------------------------------
cmd_launch() {
  local name="${1:-}"; shift || true
  [ -n "$name" ] || die "launch needs an instance name, e.g. 'launch dev-1'"

  local email="" password="" hub="$HUB_URL_DEFAULT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --email)    email="$2"; shift 2;;
      --password) password="$2"; shift 2;;
      --hub)      hub="$2"; shift 2;;
      *) die "unknown flag: $1";;
    esac
  done
  email="${email:-$name@local.test}"
  password="${password:-$name-pw-1234}"

  require_uv; require_npm

  # Sweep dead, abandoned instances before allocating a new one.
  cmd_gc --yes || true

  # If already running, tear it down first (idempotent relaunch).
  if [ -f "$(registry "$name")" ]; then
    warn "instance '$name' already has a registry — killing it first"
    cmd_kill "$name" --keep-env || true
  fi

  local idx; idx="$(name_index "$name")"
  local pref_fe=$((5000 + idx)) pref_be=$((6000 + idx))
  local fe_port be_port
  fe_port="$(find_free_port 5000 "$pref_fe")" || die "no free frontend port in 50xx band"
  be_port="$(find_free_port 6000 "$pref_be")" || die "no free backend port in 60xx band"
  [ "$fe_port" = "$pref_fe" ] || warn "frontend pref $pref_fe busy -> using $fe_port"
  [ "$be_port" = "$pref_be" ] || warn "backend  pref $pref_be busy -> using $be_port"

  local dir; dir="$(instance_dir "$name")"; mkdir -p "$dir"
  local ef; ef="$(env_file "$name")"

  log "instance   : $name"
  log "frontend   : http://localhost:$fe_port"
  log "backend    : http://localhost:$be_port"
  log "hub        : $hub"
  log "user       : $email"
  log "data dir   : $dir"
  log "env file   : $ef"

  # ---- 1. create the hub user (idempotent: 'Email already exists' is fine) ----
  log "creating hub user on $hub ..."
  local signup
  signup="$(curl -s -m 8 -X POST "$hub/api/v1/signup" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"$name\",\"email\":\"$email\",\"password\":\"$password\"}" || true)"
  if echo "$signup" | grep -qi 'already exists'; then
    log "hub user already exists — reusing"
  elif echo "$signup" | grep -qi '"SUCCESS"'; then
    log "hub user created"
  else
    warn "signup response was unexpected (continuing): ${signup:0:160}"
  fi

  # ---- 2. write the single per-instance env file (vite + backend both read it) ----
  # FLOWPAD_SKIP_DOTENV=true is load-bearing: run.py does load_dotenv(override=True)
  # on .env.local, which would otherwise clobber the values we inject here.
  cat > "$ef" <<EOF
# Auto-generated by instance_ctl.sh for instance '$name'. Safe to delete.
FLOW_INSTANCE=$name
LOCAL_SERVER_PORT=$be_port
VITE_PORT=$fe_port
VITE_API_URL=http://localhost:$be_port
FLOWPAD_HUB_URL=$hub
FLOWPAD_CLOUD_USER_EMAIL=$email
FLOWPAD_CLOUD_USER_PASSWORD=$password
MINIHUB_RELOAD=False
FLOWPAD_SKIP_DOTENV=true
EOF
  # The isolated backend intentionally skips the repo dotenv so its injected
  # ports/identity cannot be clobbered. Carry the explicitly exported E2B
  # credential through that boundary so provider-backed QA instances retain
  # the same sandbox capability as the source checkout. Never print it.
  if [ -n "${E2B_KEY:-}" ]; then
    printf 'E2B_KEY=%s\n' "$E2B_KEY" >> "$ef"
  fi

  # ---- 3. launch backend (detached) ----
  local be_log="$dir/launcher-backend.log" fe_log="$dir/launcher-frontend.log"
  log "starting backend -> $be_log"
  local be_pid
  be_pid=$(spawn_detached "$be_log" bash -c "
    set -a; source '$ef'; set +a
    cd '$REPO_ROOT'
    exec uv run -m flow_sdk.server.run
  ")

  # ---- 4. launch frontend (vite), detached ----
  # --mode '$name' makes vite loadEnv pick up .env.$name.local with HIGHER
  # precedence than the repo's .env.local, so our VITE_PORT/VITE_API_URL win.
  log "starting frontend -> $fe_log"
  local fe_pid
  fe_pid=$(spawn_detached "$fe_log" bash -c "
    set -a; source '$ef'; set +a
    cd '$REPO_ROOT/ui'
    exec npm run dev -- --mode '$name' --port $fe_port
  ")

  # ---- 5. record registry ----
  cat > "$(registry "$name")" <<EOF
{
  "name": "$name",
  "frontend_port": $fe_port,
  "backend_port": $be_port,
  "hub_url": "$hub",
  "email": "$email",
  "env_file": "$ef",
  "backend_pid": $be_pid,
  "frontend_pid": $fe_pid,
  "backend_log": "$be_log",
  "frontend_log": "$fe_log"
}
EOF

  # ---- 6. wait for backend health, then fire env-mode cloud login ----
  log "waiting for backend to come up ..."
  local up=0 i
  for i in $(seq 1 40); do
    if curl -s -m 2 "http://localhost:$be_port/api/v1/graph/bootstrap" >/dev/null 2>&1; then
      up=1; break
    fi
    sleep 1
  done
  if [ "$up" = 1 ]; then
    log "backend is up — triggering cloud login"
    curl -s -m 10 -X POST "http://localhost:$be_port/api/v1/cloud/login" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null 2>&1 || \
      warn "cloud login call failed (check $be_log)"
    local st
    st="$(curl -s -m 5 "http://localhost:$be_port/api/v1/cloud/status" || true)"
    log "cloud status: ${st:0:200}"
  else
    warn "backend did not respond within 40s — see $be_log"
  fi

  echo
  log "DONE. '$name' is up:"
  echo "    Frontend : http://localhost:$fe_port"
  echo "    Backend  : http://localhost:$be_port  (instance=$name, user=$email)"
  echo "    Stop with: scripts/instance_ctl.sh kill $name"
}

# ---------------------------------------------------------------------------
# kill
# ---------------------------------------------------------------------------
cmd_kill() {
  local name="${1:-}"; shift || true
  [ -n "$name" ] || die "kill needs an instance name"
  local keep_env=0
  [ "${1:-}" = "--keep-env" ] && keep_env=1

  local reg; reg="$(registry "$name")"
  local fe_port="" be_port="" be_pid="" fe_pid="" ef=""
  if [ -f "$reg" ]; then
    fe_port=$(grep -oE '"frontend_port": *[0-9]+' "$reg" | grep -oE '[0-9]+' || true)
    be_port=$(grep -oE '"backend_port": *[0-9]+'  "$reg" | grep -oE '[0-9]+' || true)
    be_pid=$( grep -oE '"backend_pid": *[0-9]+'   "$reg" | grep -oE '[0-9]+' || true)
    fe_pid=$( grep -oE '"frontend_pid": *[0-9]+'  "$reg" | grep -oE '[0-9]+' || true)
    ef=$(     grep -oE '"env_file": *"[^"]+"'      "$reg" | sed -E 's/.*"env_file": *"([^"]+)".*/\1/' || true)
  else
    warn "no registry for '$name' — will fall back to port-based kill"
  fi

  # Kill the recorded child PIDs. If setsid was used at launch, the child is a
  # group leader and a negative PID reaps the whole group (vite's esbuild helper
  # etc.); fall back to a plain PID kill where group-kill isn't available. With
  # MINIHUB_RELOAD=False the backend is a single process, so the port-based
  # fallback below covers any stray regardless.
  local p
  for p in "$be_pid" "$fe_pid"; do
    [ -n "$p" ] || continue
    kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
    log "sent TERM to pid $p"
  done
  sleep 1
  # Port-based fallback (handles re-parented strays not under the recorded PIDs).
  for p in "$be_port" "$fe_port"; do
    [ -n "$p" ] || continue
    local pids; pids=$(lsof -nP -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      log "killing leftover PIDs on port $p: $pids"
      # shellcheck disable=SC2086
      kill -TERM $pids 2>/dev/null || true
    fi
  done

  rm -f "$reg"
  # The backend deletes its own server.json on graceful shutdown, but the
  # TERM→port-kill sequence above doesn't guarantee one. A leftover
  # server.json is poison: hook broadcasts (flow hooks report) POST to every
  # file, and once the port band is recycled the stale entries all hit
  # whatever live server owns the port now.
  rm -f "$(instance_dir "$name")/server.json"
  if [ "$keep_env" = 0 ] && [ -n "$ef" ] && [ -f "$ef" ]; then
    rm -f "$ef"; log "removed env file $ef"
  fi
  log "instance '$name' stopped"
}

# ---------------------------------------------------------------------------
# status / list
# ---------------------------------------------------------------------------
# status / list are served by `flow instance ctl`, which decides liveness by
# process OWNERSHIP rather than port occupancy. The bash implementation these
# replace reported "[UP]" whenever anything listened on a recorded port, so on
# a machine where four stale registries all claimed :5007 it printed four UPs
# for one unrelated vite.
#
# The text output is NOT a contract. Callers that need a value must use
# `flow instance ctl status --json`, `... port <name>` or `... is-up <name>`.
_ctl_py() {
  if command -v flow >/dev/null 2>&1; then
    flow instance ctl "$@"
  else
    (cd "$REPO_ROOT" && uv run flow instance ctl "$@")
  fi
}

cmd_status() { _ctl_py status "$@"; }
cmd_list()   { _ctl_py list "$@"; }

# ---------------------------------------------------------------------------
main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    launch) cmd_launch "$@";;
    kill)   cmd_kill   "$@";;
    status) cmd_status "$@";;
    list)   cmd_list   "$@";;
    gc)     cmd_gc     "$@";;
    *) cat >&2 <<EOF
usage:
  scripts/instance_ctl.sh launch <name> [--email E] [--password P] [--hub URL]
  scripts/instance_ctl.sh kill   <name> [--keep-env]
  scripts/instance_ctl.sh status [<name>]
  scripts/instance_ctl.sh list
  scripts/instance_ctl.sh gc     [--yes] [--age DAYS]
EOF
       exit 2;;
  esac
}
main "$@"
