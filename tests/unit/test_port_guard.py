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


# A backend that is a session/group leader with TWO workers IN its group (plain Popen children,
# no new session): a target worker and an innocent sibling. prints "<wa> <wb>".
_TWO_WORKER_BACKEND_SRC = (
    "import subprocess,sys,time,signal;"
    "signal.signal(signal.SIGCHLD,signal.SIG_IGN);"  # auto-reap: a killed worker fully disappears
    f"a=subprocess.Popen([sys.executable,'-c',{_WORKER_SRC!r}]);"
    f"b=subprocess.Popen([sys.executable,'-c',{_WORKER_SRC!r}]);"
    "print(a.pid,b.pid,flush=True);time.sleep(300)"
)


def _alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
def test_kill_trees_spares_backend_group_when_target_shares_it(monkeypatch):
    # Item 4: the target worker shares the LIVE backend's process group (it did not get its own
    # session). kill_trees([worker]) must kill ONLY that worker's subtree — never the backend nor
    # the sibling worker in the same group (neither by killpg nor by direct kill via group
    # expansion). Before the fix, the group expansion swept the sibling into `doomed`.
    backend = subprocess.Popen(
        [sys.executable, "-c", _TWO_WORKER_BACKEND_SRC], start_new_session=True,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True,
    )
    target, sibling = (int(x) for x in backend.stdout.readline().strip().split())
    # All three share the backend's group (backend is the session/group leader).
    assert os.getpgid(backend.pid) == os.getpgid(target) == os.getpgid(sibling) == backend.pid
    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: backend.pid)
    try:
        refused = app_ports.kill_trees([target])
        time.sleep(0.3)
        assert refused == []                              # the worker itself is not protected
        assert psutil.Process(backend.pid).is_running()   # backend (group leader) spared
        assert _alive(sibling)                            # innocent sibling spared
        assert not _alive(target)                         # target actually killed
    finally:
        _reap(backend.pid, target, sibling)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
def test_kill_trees_reports_refused_backend(tree):
    # Item 5: a refusal must be visible to the caller. When a target IS the live backend, kill_trees
    # returns it in the refused list (so a caller cannot report "stopped" while it still runs).
    refused = app_ports.kill_trees([tree["backend"]])
    assert refused == [tree["backend"]]
    assert psutil.Process(tree["backend"]).is_running()


# A spawner that double-forks a "foreign" FlowPad backend: it setsid's, spawns two workers, writes
# "<backend> <wa> <wb>" to argv[1], then the spawner process exits so the backend REPARENTS TO INIT
# — i.e. it is genuinely NOT a descendant of the test (as another instance's backend would be).
_REPARENT_SPAWNER_SRC = (
    "import os,sys,time,signal,subprocess\n"
    "out=sys.argv[1]\n"
    "if os.fork()>0: os._exit(0)\n"            # spawner exits -> child reparents to init
    "os.setsid()\n"
    "signal.signal(signal.SIGCHLD, signal.SIG_IGN)\n"
    f"a=subprocess.Popen([sys.executable,'-c',{_WORKER_SRC!r}])\n"
    f"b=subprocess.Popen([sys.executable,'-c',{_WORKER_SRC!r}])\n"
    "open(out,'w').write(f'{os.getpid()} {a.pid} {b.pid}')\n"
    "time.sleep(300)\n"
)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX reparenting")
def test_foreign_flowpad_tree_refused_but_own_child_killable(monkeypatch, tmp_path):
    # Item 3: `flow proc kill` must spare EVERY live FlowPad process that is not the caller's own to
    # clean up — another instance's backend, its monitor-ward ancestors, and its workers — while the
    # caller's own child (a stuck python it spawned) stays killable.
    from flow_sdk.cli.commands import proc_cmd

    out = tmp_path / "pids.txt"
    spawner = subprocess.Popen([sys.executable, "-c", _REPARENT_SPAWNER_SRC, str(out)])
    spawner.wait()  # the spawner exits immediately; the backend lives on, reparented to init
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not out.exists():
        time.sleep(0.05)
    backend, wa, wb = (int(x) for x in out.read_text().split())
    # The foreign backend is NOT one of the test's descendants (it reparented away).
    own_kids = {c.pid for c in psutil.Process(os.getpid()).children(recursive=True)}
    assert backend not in own_kids

    monkeypatch.setattr(port_guard, "live_backend_pids", lambda: {backend})
    monkeypatch.setattr(port_guard, "live_backend_pid", lambda: None)  # this-instance partition sees nothing
    decoy = subprocess.Popen([sys.executable, "-c", _WORKER_SRC])  # the caller's OWN child
    captured: dict[str, str] = {}
    monkeypatch.setattr(proc_cmd.typer, "echo", lambda s, **k: None if k.get("err") else captured.__setitem__("out", s))
    try:
        foreign = port_guard.foreign_flowpad_pids()
        assert {backend, wa, wb} <= foreign      # the whole foreign FlowPad tree is protected
        assert decoy.pid not in foreign          # the caller's own child is not

        proc_cmd.kill(pids=[backend, wa, decoy.pid], name=None)
        res = json.loads(captured["out"])
        assert backend in res["refused_protected"]   # foreign backend spared
        assert wa in res["refused_protected"]        # foreign worker (sibling) spared
        assert decoy.pid in res["killed"]            # the caller's own python cleaned up
    finally:
        _reap(backend, wa, wb, decoy.pid)


# ---- flow proc kill (findings 9) ------------------------------------------------------------

def test_proc_kill_spares_backend_kills_decoy(tree, monkeypatch):
    from flow_sdk.cli.commands import proc_cmd

    monkeypatch.setattr(port_guard, "live_backend_pids", lambda: set())  # hermetic: only this instance
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


def test_without_worker_signal_strips_the_signal(monkeypatch):
    # Item 6: the shared helper every infra spawn routes through drops FLOWPAD_WORKER, from a
    # passed env and from os.environ, while leaving everything else intact.
    from flow_sdk.utils.environment import WORKER_ENV, without_worker_signal

    assert without_worker_signal({WORKER_ENV: "1", "KEEP": "x"}) == {"KEEP": "x"}
    monkeypatch.setenv(WORKER_ENV, "1")
    monkeypatch.setenv("FLOW_SENTINEL_KEEP", "yes")
    out = without_worker_signal()
    assert WORKER_ENV not in out and out["FLOW_SENTINEL_KEEP"] == "yes"


def test_build_named_instance_env_strips_worker_signal(monkeypatch):
    # Item 6: a backend a worker brings up must not inherit the worker signal (else terminals it
    # spawns are wrongly gated). build_named_instance_env is one of the env-copying spawn paths.
    from types import SimpleNamespace

    from flow_sdk.instances import env as envmod

    monkeypatch.setenv("FLOWPAD_WORKER", "1")
    settings = SimpleNamespace(instance_name="no_such_instance_xyz", flow_home="/tmp/fh", port=6001)
    out = envmod.build_named_instance_env(settings)
    assert "FLOWPAD_WORKER" not in out
    assert out["FLOW_INSTANCE"] == "no_such_instance_xyz"


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
    # Worker, but neither the target backend NOR its monitor is its ancestor (a different
    # instance) → allowed. No server_pid in info keeps it a pure unit (nothing is actually killed).
    from flow_sdk.server import launch

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: True)
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: False)
    monkeypatch.setattr(launch, "_recorded_monitor_pid", lambda info: None)
    monkeypatch.setattr(launch, "_monitor_pids", lambda info, port: [])
    monkeypatch.setattr(launch, "clear_server_info", lambda: None, raising=False)
    assert launch._stop_all_guarded() == (False, False)


def test_flow_stop_refused_for_worker_in_startup_window(monkeypatch):
    # The ~15s window after a restart: server_pid is not yet recorded, so the server check alone
    # fails open — but the monitor (our ancestor) is already recorded, so the gate still refuses.
    from flow_sdk.core.connections.service import FlowServiceError
    from flow_sdk.server import launch

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})  # no server_pid yet
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: True)
    monkeypatch.setattr(launch, "_recorded_monitor_pid", lambda info: 5151)
    # Ancestor iff it is the recorded monitor; server_pid (None here) is never our ancestor.
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: pid == 5151)
    with pytest.raises(FlowServiceError):
        launch._stop_all_guarded()


def test_flow_stop_allowed_for_human(monkeypatch):
    # Not a worker → the gate never fires even on our own backend.
    from flow_sdk.server import launch

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: False)
    monkeypatch.setattr(port_guard, "runs_under", lambda pid: True)
    monkeypatch.setattr(launch, "_recorded_monitor_pid", lambda info: None)
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
    # Server_pid not yet recorded, but the monitor (passed explicitly) is our ancestor → refused.
    assert instance_cmd._worker_reaping_own_backend({}, 4242) is True               # startup window
    monkeypatch.setattr(port_guard, "caller_is_worker", lambda: False)
    assert instance_cmd._worker_reaping_own_backend({"server_pid": 4242}) is False  # human


def test_instance_reset_own_instance_refused_for_worker(monkeypatch):
    from flow_sdk.cli.commands import instance_cmd

    monkeypatch.setattr(instance_cmd, "_worker_reaping_own_backend", lambda server, monitor_pid=None: True)
    monkeypatch.setattr(instance_cmd, "_read_json", lambda p: {})
    monkeypatch.setattr(instance_cmd, "_read_env_file", lambda n: {})
    with pytest.raises(RuntimeError, match="worker may not reset"):
        instance_cmd._kill_instance_processes("oss", backend_only=True)
