#!/usr/bin/env bash
# install_flow_on_docker.sh — installs flow_sdk wheel into a Docker container.
#
# Runs INSIDE the container via:
#   docker cp <wheel> <container>:/tmp/
#   docker cp install_flow_on_docker.sh <container>:/tmp/
#   docker exec <container> bash /tmp/install_flow_on_docker.sh
#
# Requirements: python3 >= 3.10, pip.
set -euo pipefail

MIN_PYTHON_MAJOR=3
MIN_PYTHON_MINOR=10

# --- Verify Python -----------------------------------------------------------

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Use a container image that includes Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}."
    exit 1
fi

PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

if [ "$PYTHON_MAJOR" -lt "$MIN_PYTHON_MAJOR" ] || { [ "$PYTHON_MAJOR" -eq "$MIN_PYTHON_MAJOR" ] && [ "$PYTHON_MINOR" -lt "$MIN_PYTHON_MINOR" ]; }; then
    echo "ERROR: Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} required; found ${PYTHON_VERSION}."
    exit 1
fi

echo "  Python ${PYTHON_VERSION} OK"

# --- Create venv + install wheel ---------------------------------------------

VENV_DIR=/opt/flow

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
    echo "  Created venv at ${VENV_DIR}"
fi

WHEEL=$(ls /tmp/flowpad-*.whl 2>/dev/null | head -1)
if [ -z "$WHEEL" ]; then
    echo "ERROR: no flowpad-*.whl found in /tmp. docker cp the wheel first."
    exit 1
fi

PIP_INSTALL_ARGS=(--quiet --no-cache-dir)
if "$VENV_DIR/bin/pip" show flowpad >/dev/null 2>&1; then
    # `flow compute connect` deliberately reprovisions an existing container.
    # Development wheels commonly keep the same package version, so a normal
    # pip install would retain stale worker code even after copying a new wheel.
    # Dependencies are already present in this branch; replace only Flowpad.
    PIP_INSTALL_ARGS+=(--force-reinstall --no-deps)
fi
"$VENV_DIR/bin/pip" install "${PIP_INSTALL_ARGS[@]}" "$WHEEL" 2>&1 | tail -3
echo "  Installed $(basename "$WHEEL")"

# Also install websockets (required by the worker for dialling out)
"$VENV_DIR/bin/pip" install --quiet --no-cache-dir websockets 2>&1 | tail -1

# --- Prepare config dir -------------------------------------------------------

mkdir -p /etc/flowpad

# --- Symlink CLI into PATH ---------------------------------------------------

if ! ln -sf "$VENV_DIR/bin/flow" /usr/local/bin/flow 2>/dev/null; then
    echo "  Warning: could not symlink flow to /usr/local/bin/flow — call $VENV_DIR/bin/flow directly."
fi
echo "  flow_sdk installed. Run 'flow compute worker' to start the worker."
