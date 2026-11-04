"""FLOWPAD-2112 port guard: a FlowPad activity never kills the FlowPad it runs inside.

Identity is the live backend THE BACKEND RECORDED (server.json server_pid + create_time),
not whoever holds the port — so a stale/foreign port holder stays killable. Refusal is per
kill-root: a root that IS or CONTAINS the live backend (an ancestor: monitor/launcher/
Electron) is spared whole; a root at or below the backend (a worker's own children) is not.

Real process trees are built with subprocess; only ``live_backend_pid`` is faked, to a pid a
real helper owns — so the whole tree-walk path runs for real.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import psutil
import pytest

from flow_sdk.core import app_ports, port_guard

# root ──spawns──> backend ──spawns──> worker ; prints "<backend_pid> <worker_pid>" on root stdout.
_WORKER_SRC = "import time;time.sleep(300)"
_BACKEND_SRC = (
    "import subprocess,sys,time;"
    f"w=subprocess.Popen([sys.executable,'-c',{_WORKER_SRC!r}]);"
    "print(w.pid,flush=True);time.sleep(300)"
)
_ROOT_SRC = (
    "import subprocess,sys,time;"
    f"b=subprocess.Popen([sys.executable,'-c',{_BACKEND_SRC!r}],stdout=subprocess.PIPE,text=True);"
    "wpid=b.stdout.readline().strip();"
    "print(str(b.pid)+' '+wpid,flush=True);"
    "time.sleep(300)"
)


def _reap(*pids: int) -> None:
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            for child in proc.children(recursive=True):
                child.kill()
            proc.kill()
        except psutil.Error:
            pass


@pytest.fixture
def tree(monkeypatch):
    """A real root→backend→worker tree; the backend faked as this instance's live backend."""
    root = subprocess.Popen(
        [sys.executable, "-c", _ROOT_SRC],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True,
    )
    deadline = time.monotonic() + 10
    line = ""
    while time.monotonic() < deadline and not line:
        line = root.stdout.readline().strip()
        if not line and root.poll() is not None:
            break
    assert line, "helper tree did not report its pids"
    backend_pid, worker_pid = (int(x) for x in line.split())
    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: backend_pid)
    try:
        yield {"root": root.pid, "backend": backend_pid, "worker": worker_pid}
    finally:
        _reap(root.pid, backend_pid, worker_pid)


# ---- live_backend_pid identity (finding 1) --------------------------------------------------

def test_live_backend_pid_matches_recorded(monkeypatch):
    me = os.getpid()
    ct = psutil.Process(me).create_time()
    monkeypatch.setattr("flow_sdk.config.load_server_info",
                        lambda: {"server_pid": me, "server_create_time": ct})
    assert port_guard.live_backend_pid() == me


def test_live_backend_pid_none_on_create_time_mismatch(monkeypatch):
    # pid reused: recorded create_time does not match the live process → not the backend.
    monkeypatch.setattr("flow_sdk.config.load_server_info",
                        lambda: {"server_pid": os.getpid(), "server_create_time": 1.0})
    assert port_guard.live_backend_pid() is None


def test_live_backend_pid_none_when_dead_or_absent(monkeypatch):
    monkeypatch.setattr("flow_sdk.config.load_server_info", lambda: {"server_pid": 999999})
    assert port_guard.live_backend_pid() is None
    monkeypatch.setattr("flow_sdk.config.load_server_info", lambda: {})
    assert port_guard.live_backend_pid() is None


def test_stale_port_holder_is_killable(monkeypatch):
    # The crux of finding 1: backend dead (no live_backend_pid), a leftover process holds the
    # port. It must NOT be protected — otherwise the port never frees and FlowPad can't start.
    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: None)
    other = subprocess.Popen([sys.executable, "-c", _WORKER_SRC])
    try:
        assert port_guard.protected([other.pid]) == set()
    finally:
        _reap(other.pid)


# ---- protected() root semantics (findings 2, 3) ---------------------------------------------

def test_backend_itself_is_refused(tree):
    assert port_guard.protected([tree["backend"]]) == {tree["backend"]}


def test_ancestor_of_backend_is_refused(tree):
    assert port_guard.protected([tree["root"]]) == {tree["root"]}


def test_worker_child_of_backend_is_allowed(tree):
    # The backend is the worker's ANCESTOR, not a descendant — so the worker (and anything it
    # spawns) stays killable: "may clean up".
    assert port_guard.protected([tree["worker"]]) == set()


def test_partition_splits_allowed_and_refused(tree):
    allowed, refused = port_guard.partition([tree["root"], tree["worker"], 999999])
    assert refused == [tree["root"]]
    assert allowed == [tree["worker"], 999999]


# ---- terminate_tree (findings 3) ------------------------------------------------------------

def test_terminate_tree_spares_whole_backend_tree(tree):
    from flow_sdk.instances.procs import terminate_tree

    killed, survivors = terminate_tree([psutil.Process(tree["root"])])
    assert killed == [] and survivors == []
    # The ancestor is spared WHOLE: backend AND its worker child survive, not just the ancestor.
    assert psutil.Process(tree["backend"]).is_running()
    assert psutil.Process(tree["worker"]).is_running()


def test_terminate_tree_allow_protected_reaps(tree):
    from flow_sdk.instances.procs import terminate_tree

    killed, _ = terminate_tree([psutil.Process(tree["root"])], allow_protected=True)
    assert tree["root"] in killed


def test_terminate_tree_kills_unrelated(monkeypatch):
    from flow_sdk.instances.procs import terminate_tree

    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: None)
    other = subprocess.Popen([sys.executable, "-c", _WORKER_SRC])
    try:
        killed, survivors = terminate_tree([psutil.Process(other.pid)])
        assert other.pid in killed and survivors == []
    finally:
        _reap(other.pid)


# ---- kill_trees (findings 2, 3) -------------------------------------------------------------

@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
def test_kill_trees_spares_ancestor_tree_and_group(monkeypatch):
    # root and backend each lead their own session/group; kill_trees([root]) must neither kill
    # them directly nor killpg their groups.
    root = subprocess.Popen(
        [sys.executable, "-c", _ROOT_SRC], start_new_session=True,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True,
    )
    backend_pid, worker_pid = (int(x) for x in root.stdout.readline().strip().split())
    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: backend_pid)
    try:
        app_ports.kill_trees([root.pid])
        time.sleep(0.3)
        assert psutil.Process(root.pid).is_running()
        assert psutil.Process(backend_pid).is_running()
    finally:
        _reap(root.pid, backend_pid, worker_pid)


# ---- flow proc kill (findings 9) ------------------------------------------------------------

def test_proc_kill_spares_backend_kills_decoy(tree, monkeypatch):
    from flow_sdk.cli.commands import proc_cmd

    decoy = subprocess.Popen([sys.executable, "-c", _WORKER_SRC])
    captured: dict[str, str] = {}
    monkeypatch.setattr(proc_cmd.typer, "echo", lambda s, **k: captured.setdefault("out", s))
    try:
        proc_cmd.kill(pids=[tree["backend"], decoy.pid], name=None)
        out = json.loads(captured["out"])
        assert out["refused_protected"] == [tree["backend"]]
        assert decoy.pid in out["killed"]
    finally:
        _reap(decoy.pid)


def test_proc_kill_name_matches_versioned_python(monkeypatch):
    from flow_sdk.cli.commands import proc_cmd

    # The real interpreter name here is e.g. "python3.11"; --name python must still find it.
    me = psutil.Process(os.getpid())
    assert proc_cmd._image_base(me.name()) == "python"
    matches = proc_cmd._pids_for_name("python")
    assert os.getpid() not in matches  # caller excluded
    for parent in me.parents():
        assert parent.pid not in matches  # ancestor chain excluded


def test_proc_kill_no_targets_exits_nonzero(monkeypatch):
    from flow_sdk.cli.commands import proc_cmd

    monkeypatch.setattr(proc_cmd.typer, "echo", lambda *a, **k: None)
    with pytest.raises(proc_cmd.typer.Exit) as exc:
        proc_cmd.kill(pids=None, name="definitely-no-such-image-xyz")
    assert exc.value.exit_code == 1
