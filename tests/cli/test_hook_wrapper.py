"""Tests for the flowpad runner wrapper module."""

import sys
from pathlib import Path
from unittest.mock import patch

from flow_sdk.builtin.flowpad_runner_wrapper import ensure_wrapper, get_wrapper_path, wrap_command


def test_get_wrapper_path_unix():
    """Returns .sh path on unix."""
    with patch("sys.platform", "darwin"):
        p = get_wrapper_path()
    assert p.name == "flowpad_runner.sh"
    assert ".flow" in str(p)


def test_get_wrapper_path_windows():
    """Returns .ps1 path on windows."""
    with patch("sys.platform", "win32"):
        p = get_wrapper_path()
    assert p.name == "flowpad_runner.ps1"


def test_ensure_wrapper_creates_file(tmp_path):
    """Wrapper file is created if missing."""
    wrapper_path = tmp_path / ".flow" / "flowpad_runner.sh"

    with patch("flow_sdk.builtin.flowpad_runner_wrapper.get_wrapper_path", return_value=wrapper_path), \
         patch("sys.platform", "darwin"):
        result = ensure_wrapper()

    assert result == wrapper_path
    assert wrapper_path.exists()
    content = wrapper_path.read_text()
    assert "#!/usr/bin/env sh" in content
    assert 'exec "$FLOW_BIN" "$@"' in content


def test_ensure_wrapper_idempotent(tmp_path):
    """Calling ensure_wrapper twice does not overwrite."""
    wrapper_path = tmp_path / ".flow" / "flowpad_runner.sh"

    with patch("flow_sdk.builtin.flowpad_runner_wrapper.get_wrapper_path", return_value=wrapper_path), \
         patch("sys.platform", "darwin"):
        ensure_wrapper()
        mtime1 = wrapper_path.stat().st_mtime
        ensure_wrapper()
        mtime2 = wrapper_path.stat().st_mtime

    assert mtime1 == mtime2


def test_ensure_wrapper_windows(tmp_path):
    """Windows wrapper is PowerShell."""
    wrapper_path = tmp_path / ".flow" / "flowpad_runner.ps1"

    with patch("flow_sdk.builtin.flowpad_runner_wrapper.get_wrapper_path", return_value=wrapper_path), \
         patch("sys.platform", "win32"):
        ensure_wrapper()

    content = wrapper_path.read_text()
    assert "Get-Command flow" in content
    assert "& $flow @Args" in content


def test_wrap_command_unix(tmp_path):
    """Unix wrap_command uses quoted path."""
    wrapper_path = tmp_path / ".flow" / "flowpad_runner.sh"

    with patch("flow_sdk.builtin.flowpad_runner_wrapper.get_wrapper_path", return_value=wrapper_path), \
         patch("sys.platform", "darwin"):
        cmd = wrap_command("hooks report --hook-entry-id=abc --name=flowpad_sniffer")

    assert cmd.startswith('"')
    assert "flowpad_runner.sh" in cmd
    assert cmd.endswith('--name=flowpad_sniffer')


def test_wrap_command_windows(tmp_path):
    """Windows wrap_command uses powershell prefix."""
    wrapper_path = tmp_path / ".flow" / "flowpad_runner.ps1"

    with patch("flow_sdk.builtin.flowpad_runner_wrapper.get_wrapper_path", return_value=wrapper_path), \
         patch("sys.platform", "win32"):
        cmd = wrap_command("hooks report --hook-entry-id=abc")

    assert cmd.startswith("powershell -NoProfile -ExecutionPolicy Bypass -File")
    assert "flowpad_runner.ps1" in cmd
    assert "--hook-entry-id=abc" in cmd