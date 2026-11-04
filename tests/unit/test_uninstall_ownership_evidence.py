"""Evidence the Windows uninstaller reads (FLOWPAD-2250): CLI-use stamps, server identity, desktop env.

Missing evidence makes the uninstaller preserve things, so each piece must be written exactly when
it is true and never otherwise:

* ``.cli_used`` marks independent CLI use of an instance, never the desktop's own calls.
* ``cli-stamp-since`` says this engine stamps, so a missing ``.cli_used`` means "not used".
* ``server.json`` names who launched the server and identifies the monitor beyond its pid.
* every child the backend spawns inherits ``FLOWPAD_DESKTOP=1``, so desktop-run workers calling
  ``flow`` are not mistaken for independent CLI use.
"""

from __future__ import annotations

import json
import os
import time

import pytest
from typer.testing import CliRunner

from flow_sdk.cli import cli_use

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def instance(sod_env):
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    return settings


def _stamp(settings) -> dict | None:
    path = settings.instance_dir / cli_use.CLI_USE_STAMP
    return json.loads(path.read_text()) if path.exists() else None


# ---------------------------------------------------------------------------
# .cli_used
# ---------------------------------------------------------------------------


def test_independent_use_is_stamped(instance, monkeypatch):
    monkeypatch.delenv("FLOWPAD_DESKTOP", raising=False)

    cli_use.record_cli_use("status")

    stamp = _stamp(instance)
    assert stamp is not None
    assert stamp["first"] == stamp["last"]
    assert stamp["version"]


def test_desktop_calls_are_not_stamped(instance, monkeypatch):
    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")

    cli_use.record_cli_use("stop")

    assert _stamp(instance) is None


def test_hooks_are_the_desktop_integration_not_independent_use(instance, monkeypatch):
    monkeypatch.delenv("FLOWPAD_DESKTOP", raising=False)

    cli_use.record_cli_use("hooks")

    assert _stamp(instance) is None


def test_last_is_refreshed_at_most_hourly_and_first_is_kept(instance):
    cli_use.stamp_instance_use(instance.instance_dir, now=1000.0)
    cli_use.stamp_instance_use(instance.instance_dir, now=1000.0 + cli_use.REFRESH_SECONDS - 1)
    assert _stamp(instance)["last"] == 1000.0

    cli_use.stamp_instance_use(instance.instance_dir, now=1000.0 + cli_use.REFRESH_SECONDS + 1)
    stamp = _stamp(instance)
    assert stamp["first"] == 1000.0
    assert stamp["last"] == 1000.0 + cli_use.REFRESH_SECONDS + 1


def test_a_missing_instance_dir_is_not_created(tmp_path):
    missing = tmp_path / "instances" / "nope"

    cli_use.stamp_instance_use(missing)

    assert not missing.exists()


def test_a_corrupt_stamp_is_replaced(instance):
    (instance.instance_dir / cli_use.CLI_USE_STAMP).write_text("{ not json")

    cli_use.stamp_instance_use(instance.instance_dir, now=5.0)

    assert _stamp(instance) == {"first": 5.0, "last": 5.0, "version": _stamp(instance)["version"]}


def test_stamping_never_raises(instance, monkeypatch):
    def boom(*_a, **_k):
        raise OSError("read-only disk")

    monkeypatch.setattr(cli_use, "_write_json_atomic", boom)

    cli_use.record_cli_use("status")  # must not raise

    assert _stamp(instance) is None


# ---------------------------------------------------------------------------
# cli-stamp-since
# ---------------------------------------------------------------------------


def test_stamping_marker_is_written_once(instance):
    marker = instance.global_dir / cli_use.STAMP_SINCE_FILENAME

    cli_use.ensure_stamping_marker(instance.global_dir)
    first = marker.read_text()
    cli_use.ensure_stamping_marker(instance.global_dir)

    assert marker.read_text() == first
    assert json.loads(first)["version"]


def test_stamping_marker_names_instances_an_older_engine_ran_against(instance):
    """An instance an older engine used may have been driven from the command line unrecorded."""
    root = instance.global_dir.parent / "instances"
    (root / "old").mkdir(parents=True, exist_ok=True)
    (root / "old" / "flowpad.db").write_bytes(b"db")
    started = time.time() + 60  # the database predates this "process"

    cli_use.ensure_stamping_marker(instance.global_dir, started=started)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert "old" in marker["preexisting"]


def test_a_clean_install_has_no_preexisting_instance(instance):
    """The desktop creates instances/prod (and its logs) at launch, before any engine runs; the
    first server then creates the database. Nothing there predates stamping."""
    root = instance.global_dir.parent / "instances"
    (root / "prod" / "logs" / "server").mkdir(parents=True, exist_ok=True)  # the desktop, at launch
    started = time.time() + 60  # the folder predates the server process...

    cli_use.ensure_stamping_marker(instance.global_dir, started=started)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert "prod" not in marker["preexisting"], "...but no engine had run against it"


def test_a_database_this_process_created_is_not_preexisting(instance):
    root = instance.global_dir.parent / "instances"
    started = time.time() - 60  # the process started before the database below was made
    (root / "fresh").mkdir(parents=True, exist_ok=True)
    (root / "fresh" / "flowpad.db").write_bytes(b"db")

    cli_use.ensure_stamping_marker(instance.global_dir, started=started)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert "fresh" not in marker["preexisting"]


def test_the_desktop_marks_stamping_active_without_stamping_use(instance, monkeypatch):
    """A desktop-only user still gets the marker, so the absence of .cli_used is meaningful."""
    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")

    cli_use.record_cli_use("stop")

    assert (instance.global_dir / cli_use.STAMP_SINCE_FILENAME).exists()
    assert _stamp(instance) is None


def test_the_flow_entry_point_stamps(instance, monkeypatch):
    from flow_sdk.cli.flow_cli import app

    monkeypatch.delenv("FLOWPAD_DESKTOP", raising=False)
    result = CliRunner().invoke(app, [])

    assert result.exit_code == 0, result.output
    assert _stamp(instance) is not None


def test_the_flow_entry_point_does_not_stamp_for_the_desktop(instance, monkeypatch):
    from flow_sdk.cli.flow_cli import app

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    result = CliRunner().invoke(app, [])

    assert result.exit_code == 0, result.output
    assert _stamp(instance) is None


# ---------------------------------------------------------------------------
# server.json identity
# ---------------------------------------------------------------------------


def test_launched_by_names_the_desktop(monkeypatch):
    from flow_sdk.server.startup import server_launched_by

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    assert server_launched_by() == "desktop"

    monkeypatch.delenv("FLOWPAD_DESKTOP")
    assert server_launched_by() is None


# ---------------------------------------------------------------------------
# FLOWPAD_DESKTOP reaches what the backend spawns
# ---------------------------------------------------------------------------


def test_compute_ops_inherit_the_desktop_flag(sod_env, monkeypatch):
    from flow_sdk.core.compute.exec import command_env

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")

    assert command_env()["FLOWPAD_DESKTOP"] == "1"


def test_agent_workers_inherit_the_desktop_flag(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver as driver
    from flow_sdk.claude_env import without_inherited_claude_session

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    monkeypatch.setattr(driver, "worker_bin_folder", lambda _worker: str(tmp_path))

    assert driver.build_worker_spawn_env("claude", {})["FLOWPAD_DESKTOP"] == "1"
    assert (
        driver.build_worker_spawn_env("claude", {}, base_env=without_inherited_claude_session(os.environ))[
            "FLOWPAD_DESKTOP"
        ]
        == "1"
    )


def test_terminals_inherit_the_desktop_flag(monkeypatch):
    from flow_sdk.compute.providers.desktop.provider import _build_interactive_pty_env

    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")

    assert _build_interactive_pty_env("session-1")["FLOWPAD_DESKTOP"] == "1"
