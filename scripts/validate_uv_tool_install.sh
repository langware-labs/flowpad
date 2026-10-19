#!/bin/bash
#
# Clean-room `uv tool install` — the exact command the desktop app runs on a
# user's machine on first launch (electron/uv-manager.js installLatest):
#
#     uv tool install <pkg> --python <requires-python floor> --force
#
# against a THROWAWAY uv home, so nothing already on this machine — a warm
# wheel cache, an existing flowpad tool venv, a managed CPython, the user-level
# uv config — can hide a failure a fresh user would hit. The interpreter pin is
# the `>=` floor of `requires-python` in pyproject.toml, read the same way the
# app reads it, and the install is forced onto a uv-managed CPython so the
# Python-download path is exercised as on a machine with no Python at all.
#
# Then validate_install.sh runs against the tool venv's interpreter (imports,
# `flow --help`, a real server boot), and the interpreter/version are checked
# against what was asked for. Works from macOS/Linux and from Git Bash on
# Windows (where the deploy script also runs).
#
# Usage:
#   scripts/validate_uv_tool_install.sh flowpad==X.Y.Z        # from PyPI (what users get)
#   scripts/validate_uv_tool_install.sh dist/flowpad-X.Y.Z-py3-none-any.whl
#
# The deploy script (scripts/deploy_to_github.sh) runs the PyPI form right
# after publishing; the wheel form is for a local rehearsal before that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SPEC="${1:-}"
if [[ -z "$SPEC" ]]; then
    echo -e "${RED}Usage: $0 <flowpad==X.Y.Z | path/to/flowpad-X.Y.Z.whl>${NC}" >&2
    exit 2
fi
if ! command -v uv >/dev/null 2>&1; then
    echo -e "${RED}Error: uv not found — the desktop app installs through uv, so the gate needs it too${NC}" >&2
    exit 2
fi

# Runs from macOS/Linux shells AND Git Bash on Windows (deploy_to_github.sh
# does) — so: no `python3` on the host (Git Bash has none), grep/sed only for
# the parse, the venv's own interpreter for every Python check, and both the
# POSIX `bin/` and the Windows `Scripts/` venv layouts.
IS_WIN=false
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=true ;; esac

# The pin, derived exactly as electron/uv-manager.js derives PYTHON_VERSION:
# the `>=` floor of requires-python, minor only ("3.11"). A missing floor is a
# hard error, never a silent default.
REQUIRES_PYTHON="$(grep -E '^[[:space:]]*requires-python[[:space:]]*=' "$PROJECT_DIR/pyproject.toml" \
    | head -1 | sed -E 's/^[^"]*"([^"]*)".*$/\1/')"
if [[ -z "$REQUIRES_PYTHON" ]]; then
    echo -e "${RED}Error: pyproject.toml has no \`requires-python\`${NC}" >&2
    exit 2
fi
PYTHON_VERSION="$(printf '%s' "$REQUIRES_PYTHON" | grep -oE '>=[[:space:]]*[0-9]+\.[0-9]+' | head -1 | sed -E 's/>=[[:space:]]*//')"
if [[ -z "$PYTHON_VERSION" ]]; then
    echo -e "${RED}Error: pyproject.toml requires-python \"$REQUIRES_PYTHON\" has no \">=\" floor to pin uv to${NC}" >&2
    exit 2
fi

# What version must come out the other end, when the spec says so.
EXPECTED_VERSION=""
case "$SPEC" in
    flowpad==*) EXPECTED_VERSION="${SPEC#flowpad==}" ;;
    *.whl)      EXPECTED_VERSION="$(basename "$SPEC" | sed -E 's/^flowpad-([^-]+)-.*$/\1/')" ;;
esac

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/flowpad-uv-gate.XXXXXX")"
cleanup() { cd / && rm -rf "$SANDBOX"; }
trap cleanup EXIT

# Run from INSIDE the sandbox, never from the repo: `python -m …` and
# `python -c …` put the current directory first on sys.path, so from the repo
# root every check below would import the checkout's flow_sdk instead of the
# package that was just installed — and pass for the wrong code.
cd "$SANDBOX"

# uv is a native Windows binary under Git Bash: hand it native paths, not the
# shell's /c/... spellings (a MSYS path in an env var is not reliably converted).
native_path() { if $IS_WIN && command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# Everything uv would normally share with the developer's machine, redirected.
UV_CACHE_DIR="$(native_path "$SANDBOX/cache")";          export UV_CACHE_DIR
UV_TOOL_DIR="$(native_path "$SANDBOX/tools")";           export UV_TOOL_DIR
UV_TOOL_BIN_DIR="$(native_path "$SANDBOX/bin")";         export UV_TOOL_BIN_DIR
UV_PYTHON_INSTALL_DIR="$(native_path "$SANDBOX/python")"; export UV_PYTHON_INSTALL_DIR
export UV_PYTHON_PREFERENCE="only-managed"   # never borrow a system Python
export UV_NO_CONFIG="1"                      # ignore ~/.config/uv/uv.toml etc.

# The server boot in validate_install.sh gets its own flow home too: the
# backend's singleton lock lives under <FLOW_HOME>/instances/<name>/, so
# without this a developer's running backend makes the boot exit silently
# ("[singleton] Server already running") and the gate fails for the wrong
# reason. It also leaves no DB/logs behind on the machine.
FLOW_HOME="$(native_path "$SANDBOX/flow-home")"; export FLOW_HOME

echo -e "${YELLOW}=== clean-room uv tool install (desktop first-launch path) ===${NC}"
echo -e "Spec:    $SPEC"
echo -e "Python:  $PYTHON_VERSION  (requires-python floor from pyproject.toml)"
echo -e "Sandbox: $SANDBOX"
echo ""

# The command the desktop runs, verbatim — no cache, no reuse, no cap.
uv tool install "$SPEC" --python "$PYTHON_VERSION" --force

# Shell-side (POSIX) paths for the checks below; the venv layout differs per OS.
if $IS_WIN; then
    FLOW="$SANDBOX/bin/flow.exe"
    VENV_PY="$SANDBOX/tools/flowpad/Scripts/python.exe"
else
    FLOW="$SANDBOX/bin/flow"
    VENV_PY="$SANDBOX/tools/flowpad/bin/python"
fi
if [[ ! -x "$FLOW" ]]; then
    echo -e "${RED}✗ flow shim not created at $FLOW${NC}" >&2
    exit 1
fi
if [[ ! -x "$VENV_PY" ]]; then
    echo -e "${RED}✗ tool venv interpreter not found at $VENV_PY${NC}" >&2
    exit 1
fi

# The venv must run on the pinned minor, not whatever uv felt like.
ACTUAL_PY="$("$VENV_PY" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
if [[ "$ACTUAL_PY" != "$PYTHON_VERSION" ]]; then
    echo -e "${RED}✗ tool venv runs Python $ACTUAL_PY, expected $PYTHON_VERSION${NC}" >&2
    exit 1
fi
echo -e "  ${GREEN}✓${NC} venv interpreter is Python $ACTUAL_PY"

# ...and carry the version we just published, not a stale resolution (uv
# silently picks an OLDER flowpad when the pin can't satisfy the newest one's
# requires-python — that is how v0.2.44's 3.10 pin went unnoticed).
if [[ -n "$EXPECTED_VERSION" ]]; then
    ACTUAL_VERSION="$("$VENV_PY" -c 'import flow_sdk; print(flow_sdk.__version__)')"
    if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
        echo -e "${RED}✗ installed flowpad $ACTUAL_VERSION, expected $EXPECTED_VERSION${NC}" >&2
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} installed flowpad $ACTUAL_VERSION"
fi

echo ""
"$SCRIPT_DIR/validate_install.sh" "$VENV_PY"
