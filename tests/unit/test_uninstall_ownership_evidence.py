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
import re
import time
from pathlib import Path

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


def test_a_person_typing_flow_in_the_in_app_terminal_is_independent_use():
    """The in-app terminal inherits FLOWPAD_DESKTOP; a person at its prompt still uses the engine by
    hand. An agent's tool calls in that terminal run without an interactive stdin."""
    env = {"FLOWPAD_DESKTOP": "1", cli_use.ENV_PTY_SESSION_ID: "s1"}

    assert cli_use.is_independent_use("status", env, interactive=True)
    assert not cli_use.is_independent_use("record", env, interactive=False)
    assert not cli_use.is_independent_use("hooks", env, interactive=True)
    assert not cli_use.is_independent_use("status", {"FLOWPAD_DESKTOP": "1"}, interactive=True)


def test_a_stamp_with_a_bad_shape_is_replaced(instance):
    (instance.instance_dir / cli_use.CLI_USE_STAMP).write_text('{"first": "yesterday"}')

    cli_use.stamp_instance_use(instance.instance_dir, now=7.0)

    assert _stamp(instance)["first"] == 7.0


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

    monkeypatch.setattr(cli_use, "write_json_atomic", boom)

    cli_use.record_cli_use("status")  # must not raise

    assert _stamp(instance) is None


# ---------------------------------------------------------------------------
# cli-stamp-since
# ---------------------------------------------------------------------------


def test_stamping_marker_is_written_once(instance):
    marker = instance.global_dir / cli_use.STAMP_SINCE_FILENAME

    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root)
    first = marker.read_text()
    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root)

    assert marker.read_text() == first
    assert json.loads(first)["version"]


def test_stamping_marker_names_instances_an_older_engine_ran_against(instance):
    """An instance an older engine used may have been driven from the command line unrecorded."""
    root = instance.global_dir.parent / "instances"
    (root / "old").mkdir(parents=True, exist_ok=True)
    (root / "old" / "flowpad.db").write_bytes(b"db")
    started = time.time() + 60  # the database predates this "process"

    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root, started=started)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert "old" in marker["preexisting"]


def test_a_clean_install_has_no_preexisting_instance(instance):
    """The desktop creates the empty instances/prod at launch (main.js armAccountWatch), before any
    engine runs; the first engine then fills it. Nothing there predates stamping."""
    root = instance.global_dir.parent / "instances"
    (root / "prod").mkdir(parents=True, exist_ok=True)  # the desktop, at launch
    started = time.time() + 60  # the folder predates the server process...

    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root, started=started)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert "prod" not in marker["preexisting"], "...but no engine had run against it"


def test_anything_an_older_engine_left_counts(instance):
    """Data, settings, logs, locks — any file an engine left (only the OS's own do not count). A
    file nobody listed counts too: the error keeps an engine, never removes one."""
    root = instance.global_dir.parent / "instances"
    (root / "cli-only" / "tasks").mkdir(parents=True, exist_ok=True)
    (root / "cli-only" / "config.json").write_text("{}")
    (root / "logs-only" / "logs" / "cli").mkdir(parents=True, exist_ok=True)
    (root / "unlisted" / "worker_history_cache.sqlite").parent.mkdir(parents=True, exist_ok=True)
    (root / "unlisted" / "worker_history_cache.sqlite").write_bytes(b"")
    (root / "os-only").mkdir(parents=True, exist_ok=True)
    (root / "os-only" / ".DS_Store").write_bytes(b"")

    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root, started=time.time() + 60)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert {"cli-only", "logs-only", "unlisted"} <= set(marker["preexisting"])
    assert "os-only" not in marker["preexisting"]


def test_an_overridden_database_counts_for_its_instance(instance, tmp_path, monkeypatch):
    root = instance.global_dir.parent / "instances"
    (root / "moved").mkdir(parents=True, exist_ok=True)  # nothing in the folder itself
    db = tmp_path / "elsewhere.db"
    db.write_bytes(b"db")
    monkeypatch.setenv("SQLITE_DATABASE_PATH", str(db))

    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root, started=time.time() + 60, current="moved")

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert "moved" in marker["preexisting"]


def test_only_the_flow_entry_point_writes_the_marker():
    """No other module of the engine refers to the marker writer — not the server, its startup,
    the monitor, `python -m`, the MCP server — by name, alias or attribute: started without `flow`,
    any of them would date the marker after its own launch files (record_cli_use explains)."""
    import ast

    import flow_sdk

    package = Path(flow_sdk.__file__).parent
    writers = []
    for path in package.rglob("*.py"):
        if path.name == "cli_use.py" or "rust" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        if "ensure_stamping_marker" not in text:  # any reference (call, alias, getattr string) names it
            continue
        tree = ast.parse(text, filename=str(path))
        for node in ast.walk(tree):
            name = (
                node.id if isinstance(node, ast.Name)
                else node.attr if isinstance(node, ast.Attribute)
                else node.name if isinstance(node, ast.alias)
                else node.value if isinstance(node, ast.Constant) and isinstance(node.value, str)
                else None
            )
            if name == "ensure_stamping_marker":
                writers.append(f"{path.relative_to(package)}:{node.lineno if hasattr(node, 'lineno') else '?'}")
    assert writers == []


def test_an_unreadable_entry_counts_and_the_scan_goes_on(instance, monkeypatch):
    """One unreadable folder must not cut the list short: the marker is written only once."""
    root = instance.global_dir.parent / "instances"
    for name in ("a-locked", "b-old"):
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / "b-old" / "flowpad.db").write_bytes(b"db")
    real_is_dir = Path.is_dir

    def is_dir(self):
        if self.name == "a-locked":
            raise PermissionError("EACCES")
        return real_is_dir(self)

    monkeypatch.setattr(Path, "is_dir", is_dir)
    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root, started=time.time() + 60)

    marker = json.loads((instance.global_dir / cli_use.STAMP_SINCE_FILENAME).read_text())
    assert {"a-locked", "b-old"} <= set(marker["preexisting"])


def test_a_database_this_process_created_is_not_preexisting(instance):
    root = instance.global_dir.parent / "instances"
    started = time.time() - 60  # the process started before the database below was made
    (root / "fresh").mkdir(parents=True, exist_ok=True)
    (root / "fresh" / "flowpad.db").write_bytes(b"db")

    cli_use.ensure_stamping_marker(instance.global_dir, instance.instances_root, started=started)

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


# ---------------------------------------------------------------------------
# The uninstaller deletes the keys the writers made: same service, same account suffix
# ---------------------------------------------------------------------------


def test_the_uninstaller_deletes_the_key_slots_the_writers_use():
    """flow-rs's release names (flow_sdk/rust/src/uninstall/ops.rs) must be the ones the engine
    (Python), the signed flow-rs binary's callers and the desktop write. Read with a pattern, not
    an exact line, so a formatting change does not break it; a renamed constant does."""
    from flow_sdk.flow_rs_binary import FLOW_RS_ACCOUNT_SUFFIX
    from flow_sdk.instance_settings.base_settings import SOD_KEY_KEYCHAIN_SERVICE

    repo = Path(__file__).resolve().parents[2]
    rust = (repo / "flow_sdk" / "rust" / "src" / "uninstall" / "ops.rs").read_text(encoding="utf-8")
    desktop = (repo / "electron" / "uv-manager.js").read_text(encoding="utf-8")
    desktop_rs = (repo / "electron" / "flow-rs-keychain.js").read_text(encoding="utf-8")

    def const(text, name):
        m = re.search(rf"{name}\s*(?::\s*&str)?\s*=\s*[\"']([^\"']+)[\"']", text)
        assert m, f"{name} not found"
        return m.group(1)

    assert const(rust, "RELEASE_INSTANCE_KEY_SERVICE") == SOD_KEY_KEYCHAIN_SERVICE
    assert const(desktop, "SOD_KEY_KEYCHAIN_SERVICE") == SOD_KEY_KEYCHAIN_SERVICE
    assert const(rust, "FLOW_RS_ACCOUNT_SUFFIX") == FLOW_RS_ACCOUNT_SUFFIX
    assert f"}}{FLOW_RS_ACCOUNT_SUFFIX}`" in desktop_rs, "the desktop's flow-rs account is <instance>.flow-rs"
