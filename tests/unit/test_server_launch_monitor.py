import pytest

from flow_sdk.server import launch


class StopMonitor(Exception):
    pass


def _base_monkeypatch(monkeypatch, *, progressing, killed, started=None, saved=None):
    """Wire up monitor_loop's collaborators. Health always fails and the server
    PID is always alive, so the only thing that decides a restart is whether the
    server is making progress (the new liveness-based behaviour)."""
    monkeypatch.setattr(launch, "check_server_health", lambda *_a, **_k: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "_save_info", lambda info: (saved.append(info.copy()) if saved is not None else None))
    monkeypatch.setattr(launch, "is_process_alive", lambda *_a, **_k: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed.append(pid))
    monkeypatch.setattr(launch, "_server_making_progress", lambda _pid, _prev: (progressing, {}))
    if started is not None:
        monkeypatch.setattr(launch, "start_server_process", lambda port: (started.append(port) or 456))
        monkeypatch.setattr(launch, "wait_for_server_health", lambda *_a, **_k: True)


def test_monitor_loop_never_kills_a_server_that_is_making_progress(monkeypatch):
    """A slow-but-alive boot (e.g. cold AV-scan import) must never be executed,
    however many health checks fail, as long as it keeps making progress."""
    sleep_calls = 0
    killed: list[int] = []

    def fake_sleep(_seconds):
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 5:
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    _base_monkeypatch(monkeypatch, progressing=True, killed=killed)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed == []


def test_monitor_loop_does_not_kill_stalled_server_before_threshold(monkeypatch):
    """An alive-but-wedged server is given restart_failure_threshold strikes
    before it's killed."""
    sleep_calls = 0
    killed: list[int] = []

    def fake_sleep(_seconds):
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 2:  # only 2 stalls observed → still under the 3-strike threshold
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    _base_monkeypatch(monkeypatch, progressing=False, killed=killed)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed == []


def test_monitor_loop_restarts_active_but_stuck_server_past_boot_ceiling(monkeypatch):
    """A server that LOOKS active (progressing) but never becomes healthy within
    the boot ceiling is treated as stuck (busy/retry/spin loop) and restarted —
    activity alone must not let it be nursed forever."""
    sleep_calls = 0
    killed: list[int] = []
    started: list[int] = []

    def fake_sleep(_seconds):
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 2:
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    monkeypatch.setattr(launch, "_BOOT_CEILING_S", -1.0)  # any elapsed (>=0) exceeds it
    _base_monkeypatch(monkeypatch, progressing=True, killed=killed, started=started)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed == [123]
    assert started == [9007]


def test_monitor_loop_kills_and_restarts_wedged_server_after_threshold(monkeypatch):
    """An alive-but-wedged server (no CPU/RSS/IO progress) is killed and
    restarted once it crosses the stall threshold."""
    sleep_calls = 0
    killed: list[int] = []
    started: list[int] = []

    def fake_sleep(_seconds):
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 4:
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    _base_monkeypatch(monkeypatch, progressing=False, killed=killed, started=started)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed == [123]
    assert started == [9007]
