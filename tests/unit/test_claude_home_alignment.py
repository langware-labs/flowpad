"""Pure unit coverage for Flowpad/Claude transcript-root alignment."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers import apply_worker_env
from flow_sdk.instance_settings import reset_instance_settings
from flow_sdk.instance_settings.base_settings import BaseInstanceSettings


class _ClaudeProcess:
    id = "00000000-0000-4000-8000-000000000001"
    driver = SimpleNamespace(name="claude")

    @staticmethod
    def get_type() -> str:
        return "agentic_process"


@pytest.fixture(autouse=True)
def isolate_claude_home_env(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    monkeypatch.delenv("FLOWPAD_CLAUDE_HOME", raising=False)
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    reset_instance_settings()
    yield
    reset_instance_settings()


def test_claude_home_defaults_to_user_config_dir():
    assert BaseInstanceSettings._resolve_claude_home() == Path.home() / ".claude"


def test_claude_home_honors_flowpad_override(monkeypatch, tmp_path):
    configured = tmp_path / "flowpad-claude"
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(configured))

    assert BaseInstanceSettings._resolve_claude_home() == configured


def test_claude_home_falls_back_to_native_claude_config_dir(monkeypatch, tmp_path):
    configured = tmp_path / "native-claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(configured))

    assert BaseInstanceSettings._resolve_claude_home() == configured


def test_claude_home_accepts_lexically_equivalent_explicit_roots(monkeypatch, tmp_path):
    configured = tmp_path / "claude"
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(tmp_path / "unused" / ".." / "claude"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(configured))

    assert BaseInstanceSettings._resolve_claude_home() == configured


def test_claude_home_rejects_conflicting_explicit_roots(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(tmp_path / "flowpad"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-cli"))

    with pytest.raises(ValueError, match="FLOWPAD_CLAUDE_HOME and CLAUDE_CONFIG_DIR"):
        BaseInstanceSettings._resolve_claude_home()


def test_native_default_worker_leaves_claude_config_dir_unset():
    env: dict[str, str] = {}

    apply_worker_env(env, _ClaudeProcess())

    assert "CLAUDE_CONFIG_DIR" not in env


def test_explicit_flowpad_home_stamps_worker_claude_config_dir(monkeypatch, tmp_path):
    configured = tmp_path / "isolated-claude"
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(configured))
    env: dict[str, str] = {}

    apply_worker_env(env, _ClaudeProcess())

    assert env["CLAUDE_CONFIG_DIR"] == str(configured)


def test_native_claude_config_dir_is_preserved_for_worker(monkeypatch, tmp_path):
    configured = tmp_path / "native-config"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(configured))
    env: dict[str, str] = {}

    apply_worker_env(env, _ClaudeProcess())

    assert env["CLAUDE_CONFIG_DIR"] == str(configured)


def test_native_default_per_worker_override_is_dropped():
    # A per-worker CLAUDE_CONFIG_DIR that resolves to the native ~/.claude must be
    # dropped, not honored: pinning it there makes Claude read ~/.claude/.claude.json
    # instead of the real ~/.claude.json beside it, losing the OAuth account and
    # falling back to the login picker (breaking every real-Claude worker turn).
    configured = Path.home() / ".claude"
    env = {"CLAUDE_CONFIG_DIR": str(configured / "unused" / "..")}

    apply_worker_env(env, _ClaudeProcess())

    assert "CLAUDE_CONFIG_DIR" not in env


def test_conflicting_per_worker_override_is_rejected(tmp_path):
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path / "other-claude")}

    with pytest.raises(ValueError, match="Claude worker CLAUDE_CONFIG_DIR"):
        apply_worker_env(env, _ClaudeProcess())
