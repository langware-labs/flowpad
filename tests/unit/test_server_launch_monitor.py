import pytest

from flow_sdk.server import launch


class StopMonitor(Exception):
    pass


def test_monitor_loop_does_not_restart_alive_server_before_failure_threshold(monkeypatch):
    sleep_calls = 0
    killed_pids: list[int] = []

    def fake_sleep(_seconds: float) -> None:
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 2:
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed_pids.append(pid))

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed_pids == []


def test_monitor_loop_restarts_alive_server_after_failure_threshold(monkeypatch):
    sleep_calls = 0
    killed_pids: list[int] = []
    saved_infos: list[dict] = []
    started_ports: list[int] = []

    def fake_sleep(_seconds: float) -> None:
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 4:
            raise StopMonitor

    def fake_start_server_process(port: int) -> int:
        started_ports.append(port)
        return 456

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "_save_info", lambda info: saved_infos.append(info.copy()))
    monkeypatch.setattr(launch, "is_process_alive", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed_pids.append(pid))
    monkeypatch.setattr(launch, "start_server_process", fake_start_server_process)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda *_args, **_kwargs: True)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed_pids == [123]
    assert started_ports == [9007]
    assert saved_infos == [{"server_pid": 456}]
