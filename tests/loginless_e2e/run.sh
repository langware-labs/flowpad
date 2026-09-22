#!/usr/bin/env bash
# Loginless agentic-process proof: a clean container, a PUBLIC hub endpoint, two commands.
#
#   HUB=http://localhost:8094 OPENROUTER_API_KEY=... tests/loginless_e2e/run.sh
#
# HUB is a hub YOU started for this (it must run code that knows `public` endpoints, and it
# gets a throwaway owner + endpoint). Reuse an endpoint with ENDPOINT_ID=<id> to skip creating one.
# SCRIPT='worker_matrix.py [harness...]' runs every harness x cheap models instead of the snippet.
set -euo pipefail
cd "$(dirname "$0")/../.."

HUB="${HUB:-http://localhost:8094}"
IMAGE="${IMAGE:-flowpad-loginless:test}"
# The container reaches the host's hub through the docker host alias.
HUB_IN_CONTAINER="${HUB_IN_CONTAINER:-${HUB/localhost/host.docker.internal}}"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  rm -f dist/flowpad-*.whl
  uv build --wheel --out-dir dist/ >/dev/null
  cp tests/loginless_e2e/agentic_process_snippet.py tests/loginless_e2e/worker_matrix.py dist/
  docker build -q -f tests/loginless_e2e/Dockerfile -t "$IMAGE" . >/dev/null
fi

ENDPOINT_ID="${ENDPOINT_ID:-$(HUB="$HUB" uv run python tests/loginless_e2e/make_public_endpoint.py)}"
echo "public endpoint: $ENDPOINT_ID" >&2

# THE two commands. Nothing before them, nothing between them.
docker run --rm --add-host=host.docker.internal:host-gateway "$IMAGE" sh -c "
  flow llm user use $ENDPOINT_ID --hub $HUB_IN_CONTAINER &&
  python ${SCRIPT:-agentic_process_snippet.py}"
