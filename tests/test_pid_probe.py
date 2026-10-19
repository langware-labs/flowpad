"""``pid_is_alive`` must answer the question, not shoot the asker.

The bug these guard: ``os.kill(pid, 0)`` is a liveness probe on POSIX and a
``GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)`` on Windows, because
``signal.CTRL_C_EVENT == 0``. A backend enumerating instances "checked" its own
recorded PID and Ctrl-C'd its own console group — uvicorn shut down seconds
after startup and the pending KeyboardInterrupt surfaced as
``SystemError: <built-in function kill> returned a result with an exception set``.
"""

import ctypes
import os
import subprocess
import sys
import textwrap

import pytest

from flow_sdk.pid_probe import pid_is_alive


@pytest.fixture
def dead_pid() -> int:
    """A PID that definitely named a process and definitely does not now."""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def test_live_process_is_alive():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert pid_is_alive(proc.pid) is True
    finally:
        proc.kill()
        proc.wait()


def test_reaped_process_is_not_alive(dead_pid: int):
    assert pid_is_alive(dead_pid) is False


def test_self_is_alive():
    assert pid_is_alive(os.getpid()) is True


@pytest.mark.parametrize("pid", [None, 0, -1, -5, 999_999_999])
def test_junk_pids_are_not_alive_and_do_not_raise(pid):
    assert pid_is_alive(pid) is False


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only privilege case")
def test_other_owners_process_counts_as_alive():
    """PID 4 is System: it exists, and OpenProcess on it is refused.

    ACCESS_DENIED must read as "alive", not "gone" — misreading it would let a
    stale-lock check evict a live backend it merely cannot open.
    """
    assert pid_is_alive(4) is True


@pytest.mark.skipif(sys.platform != "win32", reason="guards the Windows os.kill footgun")
def test_probing_self_does_not_deliver_a_console_ctrl_event():
    """The regression itself: probing must not Ctrl-C the calling process.

    Runs in a child that is its own console process-group leader with Ctrl-C
    re-enabled — the topology in which ``GenerateConsoleCtrlEvent`` is delivered
    back to the caller, and the one a server launched as the root of its own
    group actually has. The old ``os.kill(pid, 0)`` raised KeyboardInterrupt
    here roughly a second after the call; the child reports any that lands.
    """
    child = textwrap.dedent(
        f"""
        import ctypes, os, sys, time
        sys.path.insert(0, {os.path.dirname(os.path.dirname(os.path.abspath(__file__)))!r})
        ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False)  # undo group default
        from flow_sdk.pid_probe import pid_is_alive

        assert pid_is_alive(os.getpid()) is True
        for _ in range(8):          # the interrupt used to arrive ~1s later
            time.sleep(0.25)
        print("NO_CTRL_EVENT")
        """
    )
    CREATE_NEW_CONSOLE = 0x00000010
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    result = subprocess.run(
        [sys.executable, "-c", child],
        capture_output=True,
        text=True,
        timeout=60,
        creationflags=CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP,
    )
    assert "KeyboardInterrupt" not in result.stderr, result.stderr
    assert result.returncode == 0, result.stderr
    assert "NO_CTRL_EVENT" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="documents the Windows os.kill footgun")
def test_os_kill_signal_zero_is_a_console_ctrl_event_on_windows():
    """Pin the platform fact the fix rests on, so nobody "simplifies" it back.

    If a future CPython makes ``os.kill(pid, 0)`` a real probe on Windows, this
    fails and the workaround can be revisited on evidence.
    """
    import signal

    assert signal.CTRL_C_EVENT == 0
    # ctypes is what pid_probe uses instead; confirm the API it relies on exists.
    assert hasattr(ctypes.WinDLL("kernel32", use_last_error=True), "WaitForSingleObject")
