"""Flowpad runner wrapper for Claude Code settings.

Instead of writing bare `flow` commands into Claude Code settings.json,
we write a wrapper script that checks if `flow` exists before running it.
This prevents stale hook entries from breaking Claude after flowpad is uninstalled.

Wrapper location:
  - macOS/Linux: ~/.flow/flowpad_runner.sh
  - Windows:     ~/.flow/flowpad_runner.ps1
"""

import os
import stat
import sys
from pathlib import Path

_SH_WRAPPER = """\
#!/usr/bin/env sh
set -eu

FLOW_BIN=""

if command -v flow >/dev/null 2>&1; then
  FLOW_BIN="$(command -v flow)"
elif [ -x "$HOME/.local/bin/flow" ]; then
  FLOW_BIN="$HOME/.local/bin/flow"
elif [ -x "$HOME/.local/bin/flow.exe" ]; then
  FLOW_BIN="$HOME/.local/bin/flow.exe"
fi

if [ -z "$FLOW_BIN" ]; then
  exit 0
fi

exec "$FLOW_BIN" "$@"
"""

_PS1_WRAPPER = """\
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$flow = $null

try {
    $cmd = Get-Command flow -ErrorAction Stop
    $flow = $cmd.Source
} catch {
}

if (-not $flow) {
    $candidate = Join-Path $HOME ".local\\bin\\flow.exe"
    if (Test-Path $candidate) {
        $flow = $candidate
    }
}

if ($flow) {
    & $flow @Args
}

exit 0
"""


def get_wrapper_path() -> Path:
    """Return the OS-specific wrapper script path under the per-instance flow_home."""
    from flow_sdk.instance_settings import get_instance_settings
    flow_dir = get_instance_settings().flow_home
    if sys.platform == "win32":
        return flow_dir / "flowpad_runner.ps1"
    return flow_dir / "flowpad_runner.sh"


def ensure_wrapper() -> Path:
    """Create the wrapper script if it does not exist. Returns the path.

    Idempotent — safe to call on every hook sync.
    """
    wrapper_path = get_wrapper_path()

    if wrapper_path.exists():
        return wrapper_path

    wrapper_path.parent.mkdir(parents=True, exist_ok=True)

    if sys.platform == "win32":
        wrapper_path.write_text(_PS1_WRAPPER, encoding="utf-8")
    else:
        wrapper_path.write_text(_SH_WRAPPER, encoding="utf-8")
        # chmod +x
        wrapper_path.chmod(wrapper_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    return wrapper_path


def wrap_command(flow_args: str) -> str:
    """Build the full command string that Claude Code will execute.

    Instead of:
        flow hooks report --hook-entry-id=abc --name=flowpad_sniffer

    Returns:
        macOS/Linux: "/Users/me/.flow/flowpad_runner.sh" hooks report --hook-entry-id=abc --name=flowpad_sniffer
        Windows:     powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\me\\.flow\\flowpad_runner.ps1" hooks report ...

    Args:
        flow_args: The arguments that would follow `flow`, e.g. "hooks report --hook-entry-id=abc"
    """
    wrapper_path = ensure_wrapper()
    abs_path = str(wrapper_path.resolve())

    if sys.platform == "win32":
        return f'powershell -NoProfile -ExecutionPolicy Bypass -File "{abs_path}" {flow_args}'
    return f'"{abs_path}" {flow_args}'