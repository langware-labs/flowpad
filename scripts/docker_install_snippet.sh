#!/usr/bin/env bash
# One-click install from a machine that has nothing: run the hub's install
# snippet inside an isolated container against the host's hub.
#
#   scripts/docker_install_snippet.sh <typeid> [wheel]
#
# Needs: the local hub on $FLOWPAD_HUB_URL (default :8093), a hub user
# (HUB_EMAIL/HUB_PW, default dev-2), the asset published by a project that
# user can read, and a wheel (default: newest in dist/ — `python build_ui.py
# && uv build --wheel`). Builds docker/Dockerfile.install-snippet on first use.
set -euo pipefail
TYPEID="${1:?typeid}"
WHEEL="${2:-$(ls -t dist/flowpad-*.whl | head -1)}"
HUB="${FLOWPAD_HUB_URL:-http://localhost:8093}"
HUB_EMAIL="${HUB_EMAIL:-dev-2@local.test}"
HUB_PW="${HUB_PW:-dev-2-pw-1234}"
IMAGE=flowpad-install-snippet:test

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -f docker/Dockerfile.install-snippet -t "$IMAGE" docker/
TOKEN=$(curl -sf -X POST "$HUB/api/v1/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$HUB_EMAIL\",\"password\":\"$HUB_PW\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token') or d['data']['token'])")

exec docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$(cd "$(dirname "$WHEEL")" && pwd):/dist:ro" \
  -v "$(pwd)/scripts/docker_install_snippet:/rig:ro" \
  -e WHEEL="/dist/$(basename "$WHEEL")" -e HUB_TOKEN="$TOKEN" -e TYPEID="$TYPEID" \
  ${IN_CONTAINER_EXTRA_ENV:-} "$IMAGE" bash /rig/in_container.sh
