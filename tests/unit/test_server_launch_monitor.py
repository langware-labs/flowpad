import os
import urllib.error
import urllib.request
from unittest.mock import patch

import pytest
from filelock import FileLock

from flow_sdk.server import launch
from flow_sdk.server.middleware.cookie_gate_middleware import HEADER_NAME


class StopMonitor(Exception):
    pass


class FakeChild:
    """Stand-in for the Popen the monitor retains for the backend it spawned."""

    def __init__(self, pid: int, rc: int | None = None):
        self.pid = pid
        self.rc = rc

    def poll(self):
        return self.rc


@pytest.fixture(autouse=True)
def set_infos(monkeypatch) -> list[dict]:
    """No test inherits another's retained child or lock, and none writes a real
    server.json: every merge the monitor attempts lands in the returned list."""
    written: list[dict] = []
    monkeypatch.setattr(launch, "_server_child", None)
    monkeypatch.setattr(launch, "_monitor_lock", None)
    monkeypatch.setattr(launch, "_set_info", lambda data: written.append(dict(data)))
    return written


# ---------------------------------------------------------------------------
# The health probe and the cookie gate
#
# The monitor probes the server it supervises. On a gated instance the gate has
# NO path exemptions -- `/health/status` included -- so a keyless probe is
# refused, a 403 is indistinguishable from a dead server, and the monitor kills
# a healthy app. The replacement is refused for the same reason: a restart loop
# with a doubling backoff that nothing recovers from.
# ---------------------------------------------------------------------------


class _Answer:
    """`urlopen` is used as a context manager and its body is never read."""

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _headers(req):
    """Case-folded, because ``Request.add_header`` capitalizes what it is given
    and the assertion is about the header, not urllib's spelling of it."""
    return {name.lower(): value for name, value in req.header_items()}


def _probe(secret, response=None):
    """Run ``check_server_health`` against a stubbed urlopen, and return the
    Request it built so the caller can assert on its headers."""
    sent = {}

    def fake_urlopen(req, timeout=None):
        sent["req"] = req
        if response is not None:
            raise response
        return _Answer()

    with (
        patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=secret),
        patch.object(urllib.request, "urlopen", fake_urlopen),
    ):
        healthy = launch.check_server_health(9007)
    return healthy, sent.get("req")


def test_health_probe_carries_the_gate_secret_when_gated():
    """Without this header the monitor is refused by the instance it supervises."""
    healthy, req = _probe("s3cret-gate")

    assert healthy is True
    assert _headers(req).get(HEADER_NAME) == "s3cret-gate"


def test_health_probe_sends_no_gate_header_when_ungated():
    """Every desktop install. The probe must be byte-identical to what it was."""
    healthy, req = _probe(None)

    assert healthy is True
    assert HEADER_NAME not in _headers(req)


def test_health_probe_reports_a_refusal_as_unhealthy_without_raising():
    """A gated instance answering 403 is still "not serving me" -- reported, not
    raised, so the monitor keeps supervising."""
    refused = urllib.error.HTTPError("http://127.0.0.1:9007/health/status", 403, "Forbidden", {}, None)

    healthy, _ = _probe(None, response=refused)

    assert healthy is False


def test_health_probe_survives_an_unreadable_gate():
    """Being unable to read the secret is a reason to probe without it, never a
    reason to stop supervising."""
    with (
        patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", side_effect=RuntimeError("sod is gone")),
        patch.object(urllib.request, "urlopen", lambda req, timeout=None: _Answer()),
    ):
        assert launch.check_server_health(9007) is True


def _stop_after(monkeypatch, n_sleeps: int) -> None:
    calls = 0

    def fake_sleep(_seconds: float) -> None:
        nonlocal calls
        calls += 1
        if calls > n_sleeps:
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)


def test_monitor_loop_does_not_restart_alive_server_before_failure_threshold(monkeypatch):
    _stop_after(monkeypatch, 2)
    killed_pids: list[int] = []

    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed_pids.append(pid))

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed_pids == []


def test_monitor_loop_restarts_alive_server_after_failure_threshold(monkeypatch, set_infos):
    _stop_after(monkeypatch, 4)
    killed_pids: list[int] = []
    started_ports: list[int] = []

    def fake_start_server_process(port: int) -> int:
        started_ports.append(port)
        return 456

    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed_pids.append(pid))
    monkeypatch.setattr(launch, "start_server_process", fake_start_server_process)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda *_args, **_kwargs: True)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed_pids == [123]
    assert started_ports == [9007]
    # The backend records its own pid; the monitor writes nothing on restart, so
    # it can never clobber what the backend's startup hook wrote.
    assert set_infos == []


# ---------------------------------------------------------------------------
# Reaping the spawned backend
# ---------------------------------------------------------------------------


def test_monitor_loop_reaps_a_child_that_exited(monkeypatch, caplog):
    """A backend that exited (crash, or lost the server lock) is collected on the
    next tick instead of lingering as a zombie the pid probe still sees as alive."""
    _stop_after(monkeypatch, 2)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: True)
    monkeypatch.setattr(launch, "_server_child", FakeChild(456, rc=1))

    with caplog.at_level("WARNING", logger="flow.monitor"), pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert launch._server_child is None
    assert "exited with code 1" in caplog.text


def test_monitor_loop_treats_a_booting_child_as_alive_until_threshold(monkeypatch):
    """server.json has no pid yet (the backend has not run its startup hook), but
    the retained child is running: that counts as alive, so the monitor waits for
    the failure threshold, then kills AND reaps it before restarting."""
    _stop_after(monkeypatch, 5)
    killed: list[int] = []
    started: list[int] = []
    booting = FakeChild(789)

    def fake_start(port: int) -> int:
        started.append(port)
        launch._server_child = FakeChild(456)
        return 456

    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: False)
    def fake_kill(pid: int) -> bool:
        killed.append(pid)
        booting.rc = -15  # dead now, so the next poll() reaps it
        return True

    monkeypatch.setattr(launch, "_server_child", booting)
    monkeypatch.setattr(launch, "kill_process", fake_kill)
    monkeypatch.setattr(launch, "start_server_process", fake_start)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda *_a, **_k: True)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed == [789]
    assert launch._server_child is not booting  # reaped, then replaced by the restart
    assert started == [9007]


def test_monitor_loop_restarts_at_once_when_nothing_is_alive(monkeypatch):
    """No threshold when nothing is alive: the first failed probe restarts."""
    _stop_after(monkeypatch, 1)
    killed: list[int] = []
    started: list[int] = []

    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: False)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed.append(pid) or True)
    monkeypatch.setattr(launch, "start_server_process", lambda port: started.append(port) or 456)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda *_a, **_k: True)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed == []
    assert started == [9007]


# ---------------------------------------------------------------------------
# launch_monitor: lock, adopt, stale kill
# ---------------------------------------------------------------------------


def _quiet_launch(monkeypatch) -> None:
    monkeypatch.setattr(launch, "_setup_logging", lambda: None)
    monkeypatch.setattr(launch, "ensure_monitor_singleton", lambda _port: None)


def test_launch_monitor_adopts_a_healthy_server_and_enters_the_loop(monkeypatch):
    """Finding the server already healthy is a reason to supervise it, not to
    exit and leave server.json naming a dead monitor."""
    _quiet_launch(monkeypatch)
    looped: list[int] = []

    def fake_loop(port: int, interval: float = 30.0) -> None:
        looped.append(port)
        raise StopMonitor

    def must_not_start(_port: int) -> int:
        raise AssertionError("a healthy server must not be restarted")

    monkeypatch.setattr(launch, "acquire_monitor_singleton", lambda: True)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: True)
    monkeypatch.setattr(launch, "start_server_process", must_not_start)
    monkeypatch.setattr(launch, "monitor_loop", fake_loop)

    with pytest.raises(StopMonitor):
        launch.launch_monitor(9007)

    assert looped == [9007]


def test_launch_monitor_exits_when_another_monitor_holds_the_lock(monkeypatch):
    _quiet_launch(monkeypatch)

    def must_not_loop(*_a, **_k):
        raise AssertionError("second monitor must not supervise")

    monkeypatch.setattr(launch, "acquire_monitor_singleton", lambda: False)
    monkeypatch.setattr(launch, "monitor_loop", must_not_loop)

    assert launch.launch_monitor(9007) is None


def test_launch_monitor_kills_the_stale_server_pid_read_fresh_from_disk(monkeypatch):
    _quiet_launch(monkeypatch)
    killed: list[int] = []
    started: list[int] = []

    def fake_loop(port: int, interval: float = 30.0) -> None:
        raise StopMonitor

    monkeypatch.setattr(launch, "acquire_monitor_singleton", lambda: True)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 321, "port": 9007})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed.append(pid) or True)
    monkeypatch.setattr(launch.time, "sleep", lambda _s: None)
    monkeypatch.setattr(launch, "start_server_process", lambda port: started.append(port) or 456)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda *_a, **_k: True)
    monkeypatch.setattr(launch, "monitor_loop", fake_loop)

    with pytest.raises(StopMonitor):
        launch.launch_monitor(9007)

    assert killed == [321]
    assert started == [9007]


def test_ensure_monitor_singleton_writes_only_its_own_keys(monkeypatch, set_infos):
    """The monitor merges port/monitor_pid/launch_iso_time and nothing else --
    in particular never server_pid, which belongs to the backend."""
    killed: list[int] = []
    written = set_infos

    monkeypatch.setattr(launch, "_load_info", lambda: {"monitor_pid": 111, "server_pid": 222, "port": 9007})
    monkeypatch.setattr(launch, "_is_ancestor", lambda _pid: False)
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed.append(pid) or True)

    launch.ensure_monitor_singleton(9007)

    assert killed == [111]
    assert len(written) == 1
    assert set(written[0]) == {"port", "monitor_pid", "launch_iso_time"}
    assert written[0]["monitor_pid"] == os.getpid()
    assert written[0]["port"] == 9007


# ---------------------------------------------------------------------------
# The monitor lock
# ---------------------------------------------------------------------------


@pytest.fixture
def lock_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("FLOWPAD_SKIP_LOCK", raising=False)
    monkeypatch.setattr(
        launch, "_monitor_lock_paths", lambda: (tmp_path / "server.monitor.lock", tmp_path / "server.monitor.pid")
    )
    yield tmp_path
    launch._release_monitor_lock()


def test_acquire_monitor_singleton_takes_the_lock_and_writes_the_sidecar(lock_dir):
    assert launch.acquire_monitor_singleton() is True

    assert (lock_dir / "server.monitor.pid").read_text() == str(os.getpid())
    assert (lock_dir / "server.monitor.lock").exists()


def test_acquire_monitor_singleton_refuses_while_a_live_monitor_holds_it(lock_dir, monkeypatch, caplog):
    holder = FileLock(str(lock_dir / "server.monitor.lock"), timeout=0)
    holder.acquire()
    (lock_dir / "server.monitor.pid").write_text("4242")
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: True)
    try:
        with caplog.at_level("WARNING", logger="flow.monitor"):
            assert launch.acquire_monitor_singleton() is False
    finally:
        holder.release()

    assert "already running (pid=4242)" in caplog.text


def test_acquire_monitor_singleton_reclaims_a_stale_lock(lock_dir, monkeypatch):
    """Lock file left behind by a monitor that died: nobody holds the flock, and
    the recorded pid is gone, so the newcomer takes over."""
    (lock_dir / "server.monitor.lock").touch()
    (lock_dir / "server.monitor.pid").write_text("4242")
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: False)

    assert launch.acquire_monitor_singleton() is True
    assert (lock_dir / "server.monitor.pid").read_text() == str(os.getpid())


# ---------------------------------------------------------------------------
# Finding monitors that server.json does not name
# ---------------------------------------------------------------------------


class _Proc:
    def __init__(self, pid: int, cmdline: list[str]):
        self.info = {"pid": pid, "cmdline": cmdline}


def test_scan_for_monitors_matches_only_this_ports_launch_cmdline(monkeypatch):
    procs = [
        _Proc(4242, ["python", "-m", "flow_sdk.server.launch", "9007"]),
        _Proc(4243, ["python", "-m", "flow_sdk.server.launch", "9008"]),
        _Proc(4244, ["python", "-m", "flow_sdk.server.run"]),
        _Proc(os.getpid(), ["python", "-m", "flow_sdk.server.launch", "9007"]),
    ]
    monkeypatch.setattr(launch.psutil, "process_iter", lambda _attrs: iter(procs))

    assert launch._scan_for_monitors(9007) == [4242]


def test_stop_all_kills_a_monitor_only_the_process_scan_can_see(monkeypatch):
    """The failure that produced a clobbered server.json: a monitor from another
    launcher, never recorded in the file, survived `flow stop`."""
    killed: list[int] = []

    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})
    monkeypatch.setattr(launch.singleton_lock, "read_pid", lambda _p: None)
    monkeypatch.setattr(launch, "_monitor_lock_paths", lambda: (None, None))
    monkeypatch.setattr(launch, "_scan_for_monitors", lambda _port: [4242])
    monkeypatch.setattr(
        launch, "is_process_alive", lambda _pid, expected_name=None: expected_name == launch._MONITOR_CMD_MARKER
    )
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed.append(pid) or True)
    monkeypatch.setattr("flow_sdk.config.clear_server_info", lambda: None)

    assert launch._stop_all_guarded() == (True, False)
    assert killed == [4242]


def test_get_status_falls_back_to_the_sidecar_pid(monkeypatch):
    monkeypatch.setattr(launch, "_load_info", lambda: {"port": 9007})
    monkeypatch.setattr(launch.singleton_lock, "read_pid", lambda _p: 555)
    monkeypatch.setattr(launch, "_monitor_lock_paths", lambda: (None, None))
    monkeypatch.setattr(launch, "_scan_for_monitors", lambda _port: [])
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: True)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)

    status = launch.get_status()

    assert status["monitor_pid"] == 555
    assert status["monitor_alive"] is True
    assert status["server_alive"] is False


def test_server_marker_never_matches_the_monitor_cmdline():
    """A bare "flow_sdk.server" is a prefix of "flow_sdk.server.launch": the
    monitor would pass the *server* liveness check and be killed as one."""
    assert launch._SERVER_CMD_MARKER not in launch._MONITOR_CMD_MARKER
