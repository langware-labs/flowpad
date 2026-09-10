#!/usr/bin/env bash
# Host driver for the clean-container first-launch proof.
#
#   ./tests/first_launch_e2e/run.sh
#
# Builds the wheel from the working tree, builds an image with neither git nor a
# system python3, runs it once from nothing, and asserts the whole chain.
#
# Deliberately plain `docker run --rm` with NO volumes and NO bind mounts.
# docker-compose's `down -v` is the usual clean-first-launch lever precisely
# because those services have named volumes; here the absence of any volume
# gives the same guarantee unconditionally, and removes a whole class of "the
# previous run's ~/.flow leaked" failure. Every run is a virgin install.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${IMAGE:-flowpad-first-launch-e2e}"
CONTAINER="${CONTAINER:-flowpad-first-launch}"
HUB_URL="${FLOWPAD_HUB_URL:-http://host.docker.internal:8093}"
PORT="${HOST_PORT:-9712}"
KEEP="${KEEP:-0}"

step() { echo; echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

step "[1/5] preflight"
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the docker daemon is not running"
command -v uv >/dev/null || die "uv is not installed (needed to build the wheel)"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  [ -n "${FLOWPAD_CLOUD_USER_EMAIL:-}" ] || die \
  "The wizard's installer agent needs an LLM. Either set OPENROUTER_API_KEY to fund it
  directly, or set FLOWPAD_CLOUD_USER_EMAIL / FLOWPAD_CLOUD_USER_PASSWORD so the container
  cloud-logs-in and spends a hub LLMEndpoint (FLOWPAD_HUB_URL is ${HUB_URL}).
  Note the hub endpoint must actually SERVE the installer's tier model
  (sm -> anthropic/claude-haiku-4.5) or every install step fails with a 404."
  [ -n "${FLOWPAD_CLOUD_USER_PASSWORD:-}" ] || die "FLOWPAD_CLOUD_USER_PASSWORD is unset"
fi
# Which funding path this run takes. They are exclusive: cloud login pins
# ANTHROPIC_BASE_URL to the hub endpoint and the worker never sees OpenRouter,
# so the container skips the login when a key is present (see in_container.sh).
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  echo "    llm=OpenRouter key, direct (no cloud login)"
else
  echo "    hub=${HUB_URL}  user=${FLOWPAD_CLOUD_USER_EMAIL:-}"
  echo "    llm=hub LLMEndpoint — it must serve anthropic/claude-haiku-4.5 (the sm tier)"
fi

step "[2/5] build the wheel from the working tree"
rm -rf dist
python3 build_ui.py
uv build --wheel --out-dir dist/
ls -1 dist/flowpad-*.whl || die "no wheel was produced"
# The entrypoint rides in `dist/` with the wheel; see the Dockerfile's COPY.
cp tests/first_launch_e2e/in_container.sh dist/in_container.sh

step "[3/5] build the image (asserts python3 and git are absent, three times)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker build -t "$IMAGE" -f tests/first_launch_e2e/Dockerfile .

step "[4/5] run it clean — no volumes, no mounts"
set +e
docker run --rm --name "$CONTAINER" \
  --add-host=host.docker.internal:host-gateway \
  -e FLOWPAD_HUB_URL="$HUB_URL" \
  -e FLOWPAD_CLOUD_USER_EMAIL="${FLOWPAD_CLOUD_USER_EMAIL:-}" \
  -e FLOWPAD_CLOUD_USER_PASSWORD="${FLOWPAD_CLOUD_USER_PASSWORD:-}" \
  -e KEEP_ALIVE="$KEEP" \
  -e WIZARD_BUDGET_S="${WIZARD_BUDGET_S:-900}" \
  -e OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
  -p "${PORT}:9712" \
  "$IMAGE" 2>&1 | tee /tmp/first-launch-e2e.log
STATUS=${PIPESTATUS[0]}
set -e

step "[5/5] verdict"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if grep -q "^RESULT: PASS" /tmp/first-launch-e2e.log; then
  echo "PASS — the full chain ran on a machine that had neither python3 nor git."
  exit 0
fi
echo "FAIL — see /tmp/first-launch-e2e.log"
grep "^FAIL:" /tmp/first-launch-e2e.log || true
exit "${STATUS:-1}"
