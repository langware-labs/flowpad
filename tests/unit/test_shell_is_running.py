"""Temp unit tests for Shell.is_running() — psutil-based foreground process detection."""

import subprocess
import sys
import uuid
from unittest import mock

import psutil
import pytest

from flow_sdk.builtin.shell import Shell


@pytest.fixture
def shell(tmp_path):
    """A minimal Shell entity with no DB needed."""
    from flow_sdk.fs_store.record import set_default_records_root
    set_default_records_root(tmp_path)
    s = Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))
    return s


# ---------------------------------------------------------------------------
# Tests for the standalone helper
# ---------------------------------------------------------------------------

def test_no_children_returns_false(shell):
    """Shell with no child processes → is_running() = False."""
    with mock.patch("flow_sdk.builtin.shell.psutil") as mock_psutil:
        mock_process = mock.MagicMock()
        mock_process.children.return_value = []
        mock_psutil.Process.return_value = mock_process
        mock_psutil.NoSuchProcess = psutil.NoSuchProcess
        mock_psutil.AccessDenied = psutil.AccessDenied

        result = shell.is_running(pid=12345)
        assert result is False


def test_with_children_returns_true(shell):
    """Shell with child processes → is_running() = True."""
    with mock.patch("flow_sdk.builtin.shell.psutil") as mock_psutil:
        mock_process = mock.MagicMock()
        mock_process.children.return_value = [mock.MagicMock()]  # one child
        mock_psutil.Process.return_value = mock_process
        mock_psutil.NoSuchProcess = psutil.NoSuchProcess
        mock_psutil.AccessDenied = psutil.AccessDenied

        result = shell.is_running(pid=12345)
        assert result is True


def test_no_such_process_returns_false(shell):
    """Process gone (NoSuchProcess) → is_running() = False, no exception."""
    with mock.patch("flow_sdk.builtin.shell.psutil") as mock_psutil:
        mock_psutil.NoSuchProcess = psutil.NoSuchProcess
        mock_psutil.AccessDenied = psutil.AccessDenied
        mock_psutil.Process.side_effect = psutil.NoSuchProcess(pid=12345)

        result = shell.is_running(pid=12345)
        assert result is False


def test_access_denied_returns_false(shell):
    """No permission to inspect process → is_running() = False, no exception."""
    with mock.patch("flow_sdk.builtin.shell.psutil") as mock_psutil:
        mock_psutil.NoSuchProcess = psutil.NoSuchProcess
        mock_psutil.AccessDenied = psutil.AccessDenied
        mock_psutil.Process.side_effect = psutil.AccessDenied(pid=12345)

        result = shell.is_running(pid=12345)
        assert result is False


def test_no_pid_returns_false(shell):
    """No pid argument and no pid available → is_running() = False."""
    result = shell.is_running(pid=None)
    assert result is False


# ---------------------------------------------------------------------------
# Integration: real child process
# ---------------------------------------------------------------------------

def test_real_child_process():
    """Spawn a real sleep subprocess and check children of its parent."""
    # Use current process as "shell" — spawn a child and verify detection
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])
    try:
        me = psutil.Process()
        children = me.children(recursive=False)
        pids = [c.pid for c in children]
        assert child.pid in pids, f"child pid {child.pid} not found in children {pids}"
    finally:
        child.terminate()
        child.wait()

