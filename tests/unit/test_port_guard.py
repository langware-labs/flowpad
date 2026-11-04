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

    killed, survivors, refused = terminate_tree([psutil.Process(tree["root"])])
    assert killed == [] and survivors == []
    # The refusal is reported explicitly (finding 6), not read as a successful stop.
    assert refused == [tree["root"]]
    # The ancestor is spared WHOLE: backend AND its worker child survive, not just the ancestor.
    assert psutil.Process(tree["backend"]).is_running()
    assert psutil.Process(tree["worker"]).is_running()


def test_terminate_tree_allow_protected_reaps(tree):
    from flow_sdk.instances.procs import terminate_tree

    killed, _, refused = terminate_tree([psutil.Process(tree["root"])], allow_protected=True)
    assert tree["root"] in killed and refused == []


def test_terminate_tree_kills_unrelated(monkeypatch):
    from flow_sdk.instances.procs import terminate_tree

    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: None)
    other = subprocess.Popen([sys.executable, "-c", _WORKER_SRC])
    try:
        killed, survivors, refused = terminate_tree([psutil.Process(other.pid)])
        assert other.pid in killed and survivors == [] and refused == []
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


def test_proc_kill_image_base_normalizes_versioned_python():
    from flow_sdk.cli.commands import proc_cmd

    # Finding 9: "--name python" must match the real names macOS/Linux/Windows report,
    # so the version suffix, case, and ".exe" are all normalized away — but a substring
    # like "python-lsp" is left alone.
    assert proc_cmd._image_base("python3.11") == "python"
    assert proc_cmd._image_base("python3") == "python"
    assert proc_cmd._image_base("Python") == "python"
    assert proc_cmd._image_base("python.exe") == "python"
    assert proc_cmd._image_base("node") == "node"
    assert proc_cmd._image_base("python-lsp") == "python-lsp"
    # Finding 4: a trailing version is stripped ONLY for known interpreters, so an unrelated
    # name that merely ends in digits keeps them (not x264 -> x, not foo2 -> foo).
    assert proc_cmd._image_base("x264") == "x264"
    assert proc_cmd._image_base("foo2") == "foo2"


def test_proc_kill_name_excludes_caller_and_ancestors():
    from flow_sdk.cli.commands import proc_cmd

    # Search for THIS process's own image base (it may be "pytest", "python", …) and assert the
    # caller and its whole ancestor chain are excluded — so a worker's --name request can never
    # resolve to the backend/launcher that spawned it.
    me = psutil.Process(os.getpid())
    matches = proc_cmd._pids_for_name(me.name())
    assert os.getpid() not in matches
    for parent in me.parents():
        assert parent.pid not in matches


def test_proc_kill_no_targets_exits_nonzero(monkeypatch):
    from flow_sdk.cli.commands import proc_cmd

    monkeypatch.setattr(proc_cmd.typer, "echo", lambda *a, **k: None)
    with pytest.raises(proc_cmd.typer.Exit) as exc:
        proc_cmd.kill(pids=None, name="definitely-no-such-image-xyz")
    assert exc.value.exit_code == 1


# ---- worker-only lifecycle gate (finding 2 of the re-review) --------------------------------

def test_caller_is_worker_reads_worker_env_only(monkeypatch):
    # The signal is FLOWPAD_WORKER (worker-spawn only), NOT FLOWPAD_EXECUTION_SCOPE (which the
    # desktop terminal carries too) — so a desktop terminal is NOT seen as a worker.
    monkeypatch.delenv("FLOWPAD_WORKER", raising=False)
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", '[{"type":"subagent","id":"x"}]')
    assert port_guard.caller_is_worker() is False
    monkeypatch.setenv("FLOWPAD_WORKER", "1")
    assert port_guard.caller_is_worker() is True


def test_apply_worker_env_stamps_worker_signal():
    # The one spawn chokepoint must stamp the signal, so every worker (and its children) carries it.
    # The stamp mutates env in place, before any driver/config work, so we assert on the passed
    # dict and don't care that the rest of the heavy spawn-env build needs a real driver/process.
    import contextlib
    from types import SimpleNamespace

    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import apply_worker_env
    from flow_sdk.utils.environment import WORKER_ENV

    process = SimpleNamespace(id="proc-1", get_type=lambda: "subagent", context_data={})
    env: dict[str, str] = {}
    with contextlib.suppress(Exception):
        apply_worker_env(env, process)
    assert env[WORKER_ENV] == "1"


def test_runs_under_identifies_self_and_ancestors(monkeypatch):
    # The ancestry signal: this process and its parents are "under" themselves; an unrelated pid
    # is not, and a falsey pid is never a match.
    me = psutil.Process(os.getpid())
    assert port_guard.runs_under(os.getpid()) is True
    assert port_guard.runs_under(me.parent().pid) is True
    assert port_guard.runs_under(None) is False
    assert port_guard.runs_under(999999) is False


def test_flow_stop_refused_for_worker_on_own_backend(monkeypatch):
    # Worker, and the instance's recorded backend is this process's ancestor → it is OUR FlowPad.
    from flow_sdk.core.connections.service import FlowServiceError
    from flow_sdk.server import launch

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007, "server_pid": 4242})
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: True)
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: True)
    with pytest.raises(FlowServiceError):
        launch._stop_all_guarded()


def test_flow_stop_allowed_for_worker_on_other_instance(monkeypatch):
    # Worker, but the target backend is NOT its ancestor (a different instance) → allowed. No
    # server_pid in info keeps it a pure unit (nothing is actually killed).
    from flow_sdk.server import launch

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: True)
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: False)
    monkeypatch.setattr(launch, "_monitor_pids", lambda info, port: [])
    monkeypatch.setattr(launch, "clear_server_info", lambda: None, raising=False)
    assert launch._stop_all_guarded() == (False, False)


def test_flow_stop_allowed_for_human(monkeypatch):
    # Not a worker → the gate never fires even on our own backend.
    from flow_sdk.server import launch

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: False)
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: True)
    monkeypatch.setattr(launch, "_monitor_pids", lambda info, port: [])
    monkeypatch.setattr(launch, "clear_server_info", lambda: None, raising=False)
    assert launch._stop_all_guarded() == (False, False)


def test_worker_reaping_own_backend_predicate(monkeypatch):
    from flow_sdk.cli.commands import instance_cmd

    # Refused only when BOTH worker AND the target backend is our ancestor.
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: True)
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: pid == 4242)
    assert instance_cmd._worker_reaping_own_backend({"server_pid": 4242}) is True   # own instance
    assert instance_cmd._worker_reaping_own_backend({"server_pid": 777}) is False   # other instance
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: False)
    assert instance_cmd._worker_reaping_own_backend({"server_pid": 4242}) is False  # human


def test_instance_reset_own_instance_refused_for_worker(monkeypatch):
    from flow_sdk.cli.commands import instance_cmd

    monkeypatch.setattr(instance_cmd, "_worker_reaping_own_backend", lambda server: True)
    monkeypatch.setattr(instance_cmd, "_read_json", lambda p: {})
    monkeypatch.setattr(instance_cmd, "_read_env_file", lambda n: {})
    with pytest.raises(RuntimeError, match="worker may not reset"):
        instance_cmd._kill_instance_processes("oss", backend_only=True)
