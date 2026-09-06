"""`flow start` refuses while another process is mid-`flow stop`.

This is the contract that makes the desktop's quit handoff load-bearing.
``flow stop`` takes the instance lifecycle lock (``connection-service.lock``)
and holds it for the whole kill sequence -- up to 5s per process, because
``kill_process`` waits out SIGTERM before SIGKILL. ``flow start`` takes the SAME
lock with ``timeout=0``, so a start issued inside that window dies with::

    service_busy: Instance '<name>' is temporarily owned

That is correct mutual exclusion, not a defect: two concurrent lifecycle
mutations on one instance must not interleave. It is a defect for the DESKTOP to
walk into it, which it did by exiting on a fixed timer while its own ``flow
stop`` child was still running -- a non-detached execFile child is reparented,
not killed, so the lock outlived the app and the next launch collided with it.
``electron/shutdown.js`` now keeps the app alive until its stop has finished;
this test pins the CLI behaviour that fix exists to respect.

Nothing is mocked: a real server is started, a real signal makes it slow to exit
(which is what stretches a real stop across a relaunch), and both CLI
invocations are real subprocesses against a disposable instance.
"""

import os
import signal
import subprocess
import sys
import time
import uuid
from unittest.mock import patch

import pytest

from flow_sdk.instances import registry

# The desktop force-exited 1s after issuing the stop, so a relaunch landed at
# roughly +1s. That is the gap this test reproduces.
QUIT_TO_RELAUNCH_GAP_SECONDS = 1.0


def _flow(args: list[str], env: dict, **kwargs) -> subprocess.CompletedProcess:
    """Invoke the real CLI entry point the desktop invokes (`flow <args>`)."""
    return subprocess.run(
        [sys.executable, "-m", "flow_sdk.cli.flow_cli", *args],
        env=env,
        capture_output=True,
        text=True,
        **kwargs,
    )


def _spawn_flow(args: list[str], env: dict) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-m", "flow_sdk.cli.flow_cli", *args],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


@pytest.fixture()
def desktop_instance(allocate_ports, tmp_path, monkeypatch) -> dict:
    """A disposable instance with its own FLOW_HOME, as the desktop owns one."""
    (port,) = allocate_ports()
    name = f"quit-relaunch-{uuid.uuid4().hex[:8]}"
    flow_home = tmp_path / "flow-home"
    env = {
        **os.environ,
        "FLOW_INSTANCE": name,
        "FLOW_HOME": str(flow_home),
        "LOCAL_SERVER_PORT": str(port),
        "MINIHUB_HOST": "127.0.0.1",
        "MINIHUB_RELOAD": "False",
        "FLOWPAD_SKIP_DOTENV": "true",
    }
    monkeypatch.setenv("FLOW_INSTANCE", name)
    monkeypatch.setenv("FLOW_HOME", str(flow_home))
    try:
        yield env
    finally:
        _flow(["stop"], env, timeout=30)


def _server_pid(env: dict) -> int:
    """The backend's own record of its PID, read through the registry."""
    with patch.dict(os.environ, {"FLOW_HOME": env["FLOW_HOME"]}):
        return int(registry.read_server_info(env["FLOW_INSTANCE"])["server_pid"])


@pytest.mark.skipif(sys.platform == "win32", reason="SIGSTOP/SIGCONT are POSIX-only")
@pytest.mark.timeout(60)  # 10.4s measured; do not increase without approval
def test_start_refuses_while_a_stop_still_holds_the_lifecycle_lock(desktop_instance):
    """An abandoned stop makes the next start fail; once it finishes, start works."""
    env = desktop_instance

    booted = _flow(["start"], env, timeout=30)
    assert booted.returncode == 0, f"baseline start failed: {booted.stdout}{booted.stderr}"

    # Make the running server slow to exit, for real: SIGSTOP defers its SIGTERM
    # handling, so `stop_all` falls through kill_process's full SIGTERM wait
    # before SIGKILL. This is the ordinary "server did not die instantly" case
    # the desktop hits, produced by a real signal rather than a stub.
    server_pid = _server_pid(env)
    os.kill(server_pid, signal.SIGSTOP)

    quit_stop = _spawn_flow(["stop"], env)
    try:
        # Where the desktop used to force-exit, orphaning this child.
        time.sleep(QUIT_TO_RELAUNCH_GAP_SECONDS)
        assert quit_stop.poll() is None, "stop finished too early to reproduce the overlap"

        overlapped = _flow(["start"], env, timeout=30)
    finally:
        try:
            os.kill(server_pid, signal.SIGCONT)
        except ProcessLookupError:
            pass
        quit_stop.wait(timeout=30)

    combined = f"{overlapped.stdout}{overlapped.stderr}"
    assert overlapped.returncode != 0, f"start should refuse mid-stop, got: {combined.strip()}"
    assert "service_busy" in combined, combined.strip()
    assert "is temporarily owned" in combined, combined.strip()

    # The lock is the whole story: with the stop finished, the identical command
    # on the identical instance succeeds.
    relaunch = _flow(["start"], env, timeout=30)
    assert relaunch.returncode == 0, f"start after the stop finished: {relaunch.stdout}{relaunch.stderr}"
