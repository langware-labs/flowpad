#!/usr/bin/env bash
# Start the Spora end-to-end container: Flowpad on :$PORT, Spora's ports published at +10000
# (the host may be running its own Spora on the standard ones), sibling chat sandboxes on a
# shared network. Usage: docker/spora-e2e/run.sh [up|down]
set -euo pipefail
NAME=flowpad-spora NET=spora-e2e PORT=${PORT:-9110} IMAGE=${IMAGE:-flowpad-spora-e2e:latest}

if [ "${1:-up}" = down ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker ps -aq --filter label=spora.chat | xargs -r docker rm -f >/dev/null
  exit 0
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
# Spora's ports inside → +10000 on the host. What the BROWSER dials must name the host port.
publish=(-p "$PORT:$PORT")
for p in 3300 8090 8080 9099 9199 4000 8300 8302 8099; do publish+=(-p "$((p + 10000)):$p"); done

docker run -d --name "$NAME" --network "$NET" "${publish[@]}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e LOCAL_SERVER_PORT="$PORT" -e IS_SANDBOX=1 \
  -e GITHUB_TOKEN="${GITHUB_TOKEN:?export GITHUB_TOKEN (e.g. \$(gh auth token))}" \
  -e SPORA_SANDBOX_NETWORK="$NET" -e SPORA_SANDBOX_HOST="$NAME" \
  -e NEXT_PUBLIC_SIM_WS_URL="ws://localhost:18090/api/sim/ws" \
  -e NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL="http://localhost:19099" \
  "$IMAGE"
echo "Flowpad: http://localhost:$PORT   Spora Admin (once started): http://localhost:13300"
