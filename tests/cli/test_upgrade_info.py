"""
Tests for `flow upgrade --info` CLI command.

Verifies that the command returns correct JSON with version, version_hash,
and all status fields — this is the payload Electron sends to the server.
"""

import json

from typer.testing import CliRunner

from flow_sdk._version import __version__
from flow_sdk.cli.flow_cli import app
from flow_sdk.utils.machine_id import get_machine_id

runner = CliRunner()


def test_upgrade_info_exits_zero():
    """Command should exit successfully."""
    result = runner.invoke(app, ["upgrade", "--info"])
    assert result.exit_code == 0, f"Exit code {result.exit_code}: {result.output}"


def test_upgrade_info_returns_valid_json():
    """Output must be valid JSON."""
    result = runner.invoke(app, ["upgrade", "--info"])
    data = json.loads(result.output.strip())
    assert isinstance(data, dict)


def test_upgrade_info_contains_version():
    """Output must include the current SDK version."""
    result = runner.invoke(app, ["upgrade", "--info"])
    data = json.loads(result.output.strip())
    assert data["version"] == __version__


def test_upgrade_info_contains_version_hash():
    """version_hash must match get_machine_id()."""
    result = runner.invoke(app, ["upgrade", "--info"])
    data = json.loads(result.output.strip())
    assert data["version_hash"] == get_machine_id()


def test_version_hash_stable_across_calls():
    """get_machine_id is cache-backed — two calls return the SAME value
    even after invoking the CLI between them (file-based cache)."""
    first = get_machine_id()
    runner.invoke(app, ["upgrade", "--info"])
    second = get_machine_id()
    assert first == second


def test_version_hash_persisted_to_global_system_json():
    """The value lives in <flow_home>/global/system.json keyed as
    "machine_id" — cross-instance shared state survives instance
    switches and package upgrades."""
    from flow_sdk.instance_settings import get_instance_settings

    val = get_machine_id()
    cache_path = get_instance_settings().flow_home / "global" / "system.json"
    assert cache_path.is_file(), f"cache not written at {cache_path}"
    data = json.loads(cache_path.read_text())
    assert data["machine_id"] == val


def test_upgrade_info_contains_status_fields():
    """Output must include all fields from get_status()."""
    result = runner.invoke(app, ["upgrade", "--info"])
    data = json.loads(result.output.strip())
    expected_keys = [
        "port",
        "monitor_pid",
        "monitor_alive",
        "server_pid",
        "server_alive",
        "server_healthy",
        "launch_iso_time",
    ]
    for key in expected_keys:
        assert key in data, f"Missing key: {key}"


def test_upgrade_without_info_flag_does_not_return_json():
    """Without --info, upgrade should NOT return JSON (it runs the upgrade flow)."""
    result = runner.invoke(app, ["upgrade"], input="n\n")
    # Should not be valid JSON — it's human-readable output
    try:
        json.loads(result.output.strip())
        # If it parsed as JSON, that's wrong
        assert False, "upgrade without --info should not return JSON"
    except json.JSONDecodeError:
        pass  # Expected
