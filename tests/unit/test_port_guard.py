"""FLOWPAD-2112 port guard: a FlowPad activity never kills the FlowPad it runs inside.

The one rule under test: a process whose tree (itself or a descendant) listens on a
protected FlowPad port is spared; everything else — a user's stuck python, a stale
holder, and crucially a worker's OWN child (the backend is its *ancestor*, not a
descendant) — is killable. ``allow_protected=True`` is the explicit user-requested
bypass, and ``flow proc kill`` never bypasses.

The protected port is faked to a real ephemeral port a helper process listens on, so the
whole live path (socket table scan → tree walk) runs; nothing is mocked out.
"""
from __future__ import annotations

import subprocess
import sys
import time

import psutil
import pytest

from flow_sdk.core import app_ports, port_guard

# A python process that binds 127.0.0.1:0, LISTENS, prints the real port, then idles.
_LISTENER_SRC = (
    "import socket,sys,time;"
    "s=socket.socket();s.bind(('127.0.0.1',0));s.listen();"
    "print(s.getsockname()[1],flush=True);"
    "time.sleep(300)"
)
# A listener that first spawns a plain (non-listening) child and prints BOTH pids:
# "<child_pid> <port>". The child stands in for a worker the backend spawned.
_LISTENER_WITH_CHILD_SRC = (
    "import socket,subprocess,sys,time;"
    "c=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)']);"
    "s=socket.socket();s.bind(('127.0.0.1',0));s.listen();"
    "print(str(c.pid)+' '+str(s.getsockname()[1]),flush=True);"
    "time.sleep(300)"
)


def _spawn(src: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-c", src],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True,
    )


def _first_line(proc: subprocess.Popen, timeout: float = 10.0) -> str:
    """The process's first stdout line, or fail — bounded so a stuck helper never hangs CI."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if line:
            return line.strip()
        if proc.poll() is not None:
            break
    raise AssertionError("helper process did not report within timeout")


def _reap(*procs: subprocess.Popen) -> None:
    for proc in procs:
        try:
            parent = psutil.Process(proc.pid)
            for child in parent.children(recursive=True):
                child.kill()
            parent.kill()
        except psutil.Error:
            pass
    for proc in procs:
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


@pytest.fixture
def listener(monkeypatch):
    """A live process listening on a port that is faked to be THIS instance's protected port."""
    proc = _spawn(_LISTENER_SRC)
    try:
        port = int(_first_line(proc))
        monkeypatch.setattr(port_guard, "protected_ports", lambda: {port})
        yield proc, port
    finally:
        _reap(proc)


def test_protected_ports_reads_server_and_settings(monkeypatch):
    # Both sources contribute; non-int / missing values are dropped.
    monkeypatch.setattr("flow_sdk.config.load_server_info", lambda: {"port": 9007})
    monkeypatch.setattr(
        "flow_sdk.instance_settings.get_instance_settings",
        lambda: type("S", (), {"port": 6001})(),
    )
    assert port_guard.protected_ports() == {9007, 6001}


def test_no_protected_port_spares_nothing(monkeypatch):
    monkeypatch.setattr(port_guard, "protected_ports", lambda: set())
    assert port_guard.protected([99999, 88888]) == set()
    assert port_guard.partition([1, 2, 3]) == ([1, 2, 3], [])


def test_listener_itself_is_refused(listener):
    proc, _ = listener
    assert port_guard.protected([proc.pid]) == {proc.pid}
    allowed, refused = port_guard.partition([proc.pid, 999999])
    assert refused == [proc.pid]
    assert allowed == [999999]


def test_ancestor_of_listener_is_refused(listener):
    # The listener's PARENT (this test process would be it) — simulate via a real ancestor:
    # the backend's monitor/launcher/Electron all have the backend as a descendant, so a tree
    # kill that reaches them must be refused. We assert the mechanism: a pid whose tree holds
    # the listener is refused.
    proc, _ = listener
    parent = psutil.Process(proc.pid).ppid()  # the pytest runner spawned the helper
    assert port_guard.protected([parent]) == {parent}


def test_worker_child_of_listener_is_allowed(monkeypatch):
    # A child of the listener (a worker the backend spawned) is NOT protected — the backend is
    # the child's ANCESTOR, not a descendant, so the worker can still clean up its own tree.
    proc = _spawn(_LISTENER_WITH_CHILD_SRC)
    try:
        child_pid_str, port_str = _first_line(proc).split()
        child_pid, port = int(child_pid_str), int(port_str)
        monkeypatch.setattr(port_guard, "protected_ports", lambda: {port})
        assert port_guard.protected([proc.pid]) == {proc.pid}  # the listener itself: refused
        assert port_guard.protected([child_pid]) == set()      # its child (a worker): allowed
    finally:
        _reap(proc)


def test_unrelated_process_is_allowed(listener):
    other = _spawn("import time;time.sleep(300)")
    try:
        assert port_guard.protected([other.pid]) == set()
    finally:
        _reap(other)


def test_terminate_tree_spares_the_listener(listener):
    from flow_sdk.instances.procs import terminate_tree

    proc, _ = listener
    killed, survivors = terminate_tree([psutil.Process(proc.pid)])
    assert killed == []
    assert survivors == []
    assert psutil.Process(proc.pid).is_running()


def test_terminate_tree_allow_protected_reaps_the_listener(listener):
    from flow_sdk.instances.procs import terminate_tree

    proc, _ = listener
    killed, survivors = terminate_tree([psutil.Process(proc.pid)], allow_protected=True)
    assert proc.pid in killed
    assert survivors == []


def test_terminate_tree_kills_an_unrelated_process(listener):
    from flow_sdk.instances.procs import terminate_tree

    other = _spawn("import time;time.sleep(300)")
    try:
        killed, survivors = terminate_tree([psutil.Process(other.pid)])
        assert other.pid in killed
        assert survivors == []
    finally:
        _reap(other)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
def test_kill_trees_spares_the_listener_and_its_group(monkeypatch):
    # The listener leads its own session/group (start_new_session); kill_trees must neither kill
    # it directly nor killpg its group.
    proc = subprocess.Popen(
        [sys.executable, "-c", _LISTENER_SRC],
        start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, text=True,
    )
    try:
        port = int(_first_line(proc))
        monkeypatch.setattr(port_guard, "protected_ports", lambda: {port})
        app_ports.kill_trees([proc.pid])
        time.sleep(0.3)
        assert psutil.Process(proc.pid).is_running()
    finally:
        _reap(proc)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
def test_kill_trees_allow_protected_reaps_the_listener(monkeypatch):
    proc = subprocess.Popen(
        [sys.executable, "-c", _LISTENER_SRC],
        start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, text=True,
    )
    try:
        port = int(_first_line(proc))
        monkeypatch.setattr(port_guard, "protected_ports", lambda: {port})
        app_ports.kill_trees([proc.pid], allow_protected=True)
        proc.wait(timeout=5)
        assert proc.poll() is not None
    finally:
        _reap(proc)


def test_caller_is_worker_reads_execution_scope(monkeypatch):
    monkeypatch.delenv("FLOWPAD_EXECUTION_SCOPE", raising=False)
    assert port_guard.caller_is_worker() is False
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", '[{"type":"agentic_process","id":"x"}]')
    assert port_guard.caller_is_worker() is True
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", "   ")
    assert port_guard.caller_is_worker() is False


def test_proc_kill_cli_spares_listener_kills_other(listener, monkeypatch):
    # flow proc kill: refuses the protected listener, kills an unrelated process, reports JSON.
    import json

    from flow_sdk.cli.commands import proc_cmd

    proc, _ = listener
    other = _spawn("import time;time.sleep(300)")
    captured = {}
    monkeypatch.setattr(proc_cmd.typer, "echo", lambda s: captured.setdefault("out", s))
    try:
        proc_cmd.kill(pids=[proc.pid, other.pid], name=None)
        out = json.loads(captured["out"])
        assert out["refused_protected"] == [proc.pid]
        assert other.pid in out["killed"]
    finally:
        _reap(other)


def test_proc_kill_name_is_exact_not_substring(monkeypatch):
    # _pids_for_name matches the image name exactly and never returns the caller's ancestors.
    import os

    from flow_sdk.cli.commands import proc_cmd

    me = psutil.Process(os.getpid())
    my_image = me.name().lower().removesuffix(".exe")
    matches = proc_cmd._pids_for_name(my_image)
    assert os.getpid() not in matches  # caller excluded
    for parent in me.parents():
        assert parent.pid not in matches  # whole ancestor chain excluded
    # A name no process has returns nothing (and in particular not a substring hit).
    assert proc_cmd._pids_for_name("definitely-no-such-image-xyz") == []
