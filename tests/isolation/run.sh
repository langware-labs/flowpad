#!/usr/bin/env bash
# Host driver: prove a spawn on a machine with no harness fails fast and clearly.
#
#   bash tests/isolation/run.sh
#
# 1. builds a wheel (`uv build` — no build_ui.py, no UI assets needed)
# 2. builds an image with no node and no vendor CLI
# 3. runs the check; ISOLATION_PASS on stdout is the contract
#
# Exit 0 = passed. This is a LOCAL gate: like tests/migration_e2e, it is not
# wired into CI (.github/workflows/test.yml runs the unit and api tiers only).
# tests/unit/test_lazy_capability_resolution.py is what guards this continuously;
# this proves the same thing on a machine that genuinely has nothing installed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${REPO_ROOT}/tests/isolation"
IMAGE="flowpad-no-harness"

cd "$REPO_ROOT"

echo "## building wheel"
rm -rf "${DIR}/wheels"; mkdir -p "${DIR}/wheels"
uv build --wheel --out-dir "${DIR}/wheels" >/dev/null
ls "${DIR}/wheels"/*.whl >/dev/null || { echo "FAIL: no wheel built" >&2; exit 1; }

echo "## building image (python:3.10-slim — no node, no CLIs)"
docker build -q -t "$IMAGE" "$DIR" >/dev/null

echo "## running"
out="$(docker run --rm "$IMAGE" 2>&1)" || true
echo "$out"
rm -rf "${DIR}/wheels"

if grep -q "ISOLATION_PASS" <<<"$out"; then
  echo "PASS"
else
  echo "FAIL: the empty-machine check did not pass" >&2
  exit 1
fi
