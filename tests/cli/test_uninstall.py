"""Tests for the `flow uninstall` CLI command."""

import json
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from flow_sdk.cli.flow_cli import app

runner = CliRunner()


def _write_settings(path: Path, settings: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2))


def _read_settings(path: Path) -> dict:
    return json.loads(path.read_text())


def _make_sniffer_settings() -> dict:
    """Settings with sniffer hooks across multiple events."""
    return {
        "hooks": {
            "SessionStart": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "flow hooks report --name=flowpad_sniffer",
                        }
                    ],
                }
            ],
            "PreToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "flow hooks report --name=flowpad_sniffer --hook-entry-id=abc",
                        }
                    ],
                }
            ],
        }
    }


def _make_mixed_settings() -> dict:
    """Settings with both sniffer and non-sniffer hooks."""
    return {
        "hooks": {
            "SessionStart": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "flow hooks report --name=flowpad_sniffer",
                        },
                        {
                            "type": "command",
                            "command": "echo 'my custom hook'",
                        },
                    ],
                }
            ],
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": "echo 'stop hook'",
                        }
                    ],
                }
            ],
        }
    }


def test_uninstall_removes_sniffer_from_user_settings(tmp_path):
    """Sniffer hooks are removed from user-level settings."""
    home = tmp_path / "home"
    settings_path = home / ".claude" / "settings.json"
    _write_settings(settings_path, _make_sniffer_settings())

    with patch("pathlib.Path.home", return_value=home), \
         patch("flow_sdk.cli.flow_cli.get_context") as mock_ctx:
        mock_ctx.return_value.is_in_repo.return_value = False
        result = runner.invoke(app, ["uninstall"])

    assert result.exit_code == 0
    assert "Removed" in result.output
    assert "sniffer hook(s)" in result.output

    settings = _read_settings(settings_path)
    # hooks dict should be gone (all events were sniffer-only)
    assert "hooks" not in settings


def test_uninstall_preserves_non_sniffer_hooks(tmp_path):
    """Non-sniffer hooks are preserved; only sniffer entries removed."""
    home = tmp_path / "home"
    settings_path = home / ".claude" / "settings.json"
    _write_settings(settings_path, _make_mixed_settings())

    with patch("pathlib.Path.home", return_value=home), \
         patch("flow_sdk.cli.flow_cli.get_context") as mock_ctx:
        mock_ctx.return_value.is_in_repo.return_value = False
        result = runner.invoke(app, ["uninstall"])

    assert result.exit_code == 0
    assert "Removed 1 sniffer hook(s)" in result.output

    settings = _read_settings(settings_path)
    # SessionStart should still exist with the custom hook
    assert "SessionStart" in settings["hooks"]
    hooks_list = settings["hooks"]["SessionStart"][0]["hooks"]
    assert len(hooks_list) == 1
    assert "my custom hook" in hooks_list[0]["command"]

    # Stop event should be untouched
    assert "Stop" in settings["hooks"]


def test_uninstall_no_sniffer_found(tmp_path):
    """No-op when there are no sniffer hooks."""
    home = tmp_path / "home"
    settings_path = home / ".claude" / "settings.json"
    _write_settings(settings_path, {
        "hooks": {
            "Stop": [{"hooks": [{"type": "command", "command": "echo bye"}]}]
        }
    })

    with patch("pathlib.Path.home", return_value=home), \
         patch("flow_sdk.cli.flow_cli.get_context") as mock_ctx:
        mock_ctx.return_value.is_in_repo.return_value = False
        result = runner.invoke(app, ["uninstall"])

    assert result.exit_code == 0
    assert "No sniffer hooks found" in result.output

    # File should be unchanged
    settings = _read_settings(settings_path)
    assert "Stop" in settings["hooks"]


def test_uninstall_no_settings_file(tmp_path):
    """Graceful when no settings file exists."""
    home = tmp_path / "home"

    with patch("pathlib.Path.home", return_value=home), \
         patch("flow_sdk.cli.flow_cli.get_context") as mock_ctx:
        mock_ctx.return_value.is_in_repo.return_value = False
        result = runner.invoke(app, ["uninstall"])

    assert result.exit_code == 0
    assert "No sniffer hooks found" in result.output


def test_uninstall_also_cleans_project_settings(tmp_path):
    """When in a repo, project and local settings are also cleaned."""
    home = tmp_path / "home"
    repo_root = tmp_path / "repo"

    user_settings = home / ".claude" / "settings.json"
    project_settings = repo_root / ".claude" / "settings.json"
    local_settings = repo_root / ".claude" / "settings.local.json"

    _write_settings(user_settings, _make_sniffer_settings())
    _write_settings(project_settings, _make_sniffer_settings())
    _write_settings(local_settings, _make_sniffer_settings())

    with patch("pathlib.Path.home", return_value=home), \
         patch("flow_sdk.cli.flow_cli.get_context") as mock_ctx:
        mock_ctx.return_value.is_in_repo.return_value = True
        mock_ctx.return_value.repo_root = repo_root
        result = runner.invoke(app, ["uninstall"])

    assert result.exit_code == 0
    # All three files should have been cleaned
    assert "sniffer hook(s) total" in result.output

    for path in (user_settings, project_settings, local_settings):
        settings = _read_settings(path)
        assert "hooks" not in settings


def test_uninstall_empty_hooks_dict(tmp_path):
    """Settings with an empty hooks dict are handled gracefully."""
    home = tmp_path / "home"
    settings_path = home / ".claude" / "settings.json"
    _write_settings(settings_path, {"hooks": {}})

    with patch("pathlib.Path.home", return_value=home), \
         patch("flow_sdk.cli.flow_cli.get_context") as mock_ctx:
        mock_ctx.return_value.is_in_repo.return_value = False
        result = runner.invoke(app, ["uninstall"])

    assert result.exit_code == 0
    assert "No sniffer hooks found" in result.output
