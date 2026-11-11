"""`flow start` declares its boot phases to the desktop app's startup gate.

The launcher stage — migrations, then the monitor spawn — imports nothing for
as long as it runs, so without a phase line per step the gate would read a slow
migration as a hung boot. The order of the declarations IS the contract.
"""

import os

import pytest
import typer

from flow_sdk import boot_progress
from flow_sdk.cli import flow_cli
from flow_sdk.migrations import runner as migration_runner
from flow_sdk.server import launch


@pytest.fixture
def phases(monkeypatch) -> list[str]:
    seen: list[str] = []
    monkeypatch.setattr(boot_progress, "set_phase", seen.append)
    monkeypatch.setattr(boot_progress, "stop", lambda: seen.append("<stop>"))
    monkeypatch.setattr(migration_runner, "run_if_needed", lambda: 0)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "start_monitor_detached", lambda _port: seen.append("<spawned>") or 1)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda _port, timeout: True)
    return seen


def test_a_cold_start_declares_migration_then_spawn_then_the_health_wait(phases):
    flow_cli._start_service_guarded(9007)
    assert phases == ["migration", "spawn", "<spawned>", "wait_health", "<stop>"]


def test_an_already_running_server_still_ends_the_report(phases, monkeypatch):
    monkeypatch.setattr(launch, "check_server_health", lambda _port: True)
    flow_cli._start_service_guarded(9007)
    assert phases == ["migration", "<stop>"]


def test_a_failed_migration_ends_the_report_before_refusing_to_start(phases, monkeypatch):
    monkeypatch.setattr(migration_runner, "run_if_needed", lambda: 3)
    with pytest.raises(typer.Exit):
        flow_cli._start_service_guarded(9007)
    assert phases == ["migration", "<stop>"]


def test_a_server_not_ready_in_time_prints_where_its_log_is_and_its_tail(phases, monkeypatch, tmp_path, capsys):
    """On a cloud box the CLI's own output is the only log that leaves the machine (journal → serial
    console, and the hub's restart command output). The server writes only to its own file, so a
    server that never answered left nothing to diagnose from. The CLI names that file and its tail."""
    server_dir = tmp_path / "server"
    server_dir.mkdir()
    (server_dir / "old.log").write_text("stale boot\n")
    newest = server_dir / "new.log"
    newest.write_text("".join(f"line {i}\n" for i in range(100)) + "Traceback: boom\n")
    os.utime(server_dir / "old.log", (1, 1))
    monkeypatch.setattr(launch, "_logs_base", lambda: tmp_path)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda _port, timeout: False)

    flow_cli._start_service_guarded(9007)

    err = capsys.readouterr().err
    assert str(newest) in err
    assert "Traceback: boom" in err
    assert "line 99" in err and "line 10\n" not in err  # a bounded tail, not the whole file
    assert "stale boot" not in err
