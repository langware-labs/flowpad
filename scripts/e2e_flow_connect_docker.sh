#!/usr/bin/env bash
# e2e_flow_connect_docker.sh — `flow connect` device-code enrollment from a FRESH machine.
#
# A clean python:3.12 container is enrolled with `flow connect --docker <container>`
# run on the HOST: it installs flow from a wheel built out of this working tree, starts
# `flow connect` inside the container and — when the host holds a hub login — approves
# the container's device code itself (no human step). The hub creates the user_machine
# ComputeNode, the container gets its key, attaches, and the hub drives it: status, a
# command, and `workspace-ready` (which starts the workspace app in the container on 9007).
#
# Usage:
#   scripts/e2e_flow_connect_docker.sh                 # against http://localhost:8093, auto-approve as a fresh user
#   HUB_URL=http://localhost:8000 scripts/e2e_flow_connect_docker.sh
#   APPROVE=manual scripts/e2e_flow_connect_docker.sh   # host not logged in: the container's code/QR is printed for YOU to approve
#   HUB_TOKEN=<jwt or api key> ...                      # approve as an existing user (e.g. yourself)
#   KEEP=0 ...                                          # tear the container down at the end (default: keep it)
#
# Requirements: docker, uv, curl, python3 on the host; the hub reachable from the container
# as host.docker.internal:<port> (Docker Desktop / --add-host=host-gateway).
set -euo pipefail

HUB_URL="${HUB_URL:-http://localhost:8093}"
HUB_PORT="${HUB_URL##*:}"
CONTAINER="${CONTAINER:-flow-connect-e2e}"
IMAGE="${IMAGE:-python:3.12-slim}"
HOST_PORT="${HOST_PORT:-9007}"        # published container port for the workspace app
APPROVE="${APPROVE:-auto}"            # auto | manual
KEEP="${KEEP:-1}"
API="$HUB_URL/api/v1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# --- 0. preflight ------------------------------------------------------------
curl -fsS -o /dev/null "$API/current-user" || die "hub not reachable at $HUB_URL"
command -v docker >/dev/null || die "docker not found"

# --- 1. wheel from the working tree ------------------------------------------
log "Building flow wheel from $ROOT"
(cd "$ROOT" && uv build --wheel --out-dir dist/ >/dev/null 2>&1) || die "uv build failed"
WHEEL="$(ls -t "$ROOT"/dist/flowpad-*.whl | head -1)"
echo "  $WHEEL"

# --- 2. fresh container --------------------------------------------------------
log "Starting fresh container $CONTAINER ($IMAGE)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  --add-host=host.docker.internal:host-gateway \
  -p "$HOST_PORT:9007" \
  "$IMAGE" sleep infinity >/dev/null   # env comes from /etc/flowpad/machine.env, written by flow connect --docker
# curl: the hub's workspace-ready probes the app with curl inside the box; procps: ghost-kill/ps.
docker exec "$CONTAINER" bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq curl procps >/dev/null 2>&1' || true

# --- 3+4+5. enroll the container with `flow connect --docker` -----------------
# The HOST cli does the install + start-detached + approval. With a hub key in the
# host's environment (FLOWPAD_CLOUD_API_KEY) it approves the container's code itself;
# without one it prints the container's code/QR and waits for a human.
if [ "$APPROVE" = "manual" ]; then
  log "Enrolling $CONTAINER with 'flow connect --docker' (host NOT logged in → code shown; approve it in the hub UI)"
  (cd "$ROOT" && FLOWPAD_HUB_URL="$HUB_URL" FLOWPAD_CLOUD_API_KEY= uv run flow connect --docker "$CONTAINER" --name @docker-e2e) || die "flow connect --docker failed"
  log "Approved by hand — skipping the API-driven checks (use the hub UI: Open the machine)."
  exit 0
fi
if [ -z "${HUB_TOKEN:-}" ]; then
  EMAIL="connect-e2e-$(date +%s)@example.com"
  log "Signing up a throwaway hub user $EMAIL (the host's login that will approve the container)"
  curl -fsS -X POST "$API/signup" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"Passw0rd!e2e\",\"name\":\"E2E Connect\"}" >/dev/null
  HUB_TOKEN="$(curl -fsS -X POST "$API/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"Passw0rd!e2e\"}" | j "d['data']['token']")"
fi
AUTH=(-H "Authorization: Bearer $HUB_TOKEN" -H 'content-type: application/json')
log "Enrolling $CONTAINER with 'flow connect --docker' (host logged in → auto-approve, no code shown)"
CONNECT_OUT="$(cd "$ROOT" && FLOWPAD_HUB_URL="$HUB_URL" FLOWPAD_CLOUD_API_KEY="$HUB_TOKEN" uv run flow connect --docker "$CONTAINER" --name @docker-e2e 2>&1)" || { echo "$CONNECT_OUT"; die "flow connect --docker failed"; }
echo "$CONNECT_OUT" | sed 's/^/  /'
NODE_ID="$(echo "$CONNECT_OUT" | grep -oE 'Connected: [^(]*\(([0-9a-f-]+)\)' | sed -E 's/.*\(([0-9a-f-]+)\).*/\1/' | head -1)"
[ -n "$NODE_ID" ] || die "could not parse the node id from flow connect output"
echo "  node: $NODE_ID"
echo "$CONNECT_OUT" | grep -q "enter code" && die "a code was shown although the host was logged in"

# --- 6. hub drives the machine -------------------------------------------------
NODE="$API/graph/compute_node/$NODE_ID"
log "ops/status"
curl -fsS -X POST "$NODE/ops/status" "${AUTH[@]}" | j "d['data']"
log "ops/command uname -a (runs INSIDE the container)"
curl -fsS -X POST "$NODE/ops/command" "${AUTH[@]}" -d '{"command":"uname -a; whoami; hostname","stream":false}' | j "d['data'][:400]"
log "ops/workspace-ready (hub starts the workspace app in the container on 9007 and signs it in)"
curl -fsS -X POST "$NODE/ops/workspace-ready" "${AUTH[@]}" | j "d['data']"
log "workspace app reachable from the host via the published port"
printf '  http://127.0.0.1:%s/health/status → ' "$HOST_PORT"; curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$HOST_PORT/health/status" || true

log "DONE — machine @docker-e2e ($NODE_ID) is attached."
echo "  Hub UI (dev):  http://localhost:4098/dock/hub/home   → the machine card → Open"
echo "  Container:     docker exec -it $CONTAINER bash    logs: docker exec $CONTAINER tail -f /tmp/flowpad-connect.log"
if [ "$KEEP" != "1" ]; then docker rm -f "$CONTAINER" >/dev/null; echo "  (container removed)"; fi
