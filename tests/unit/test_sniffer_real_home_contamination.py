"""User-scope sniffer installs honor an explicitly isolated Claude home.

FLOW_HOME isolates Flowpad data; Claude configuration has its own selectors.
A temporary HOME/USERPROFILE stands in for the user's real home throughout.
"""

import json

import pytest

from flow_sdk.builtin.agent_hook import (
    DEFAULT_LISTENED_HOOKS,
    AgentHook,
    AgentProvider,
    HookScope,
)
from flow_sdk.builtin.claude_settings_sync import sync_sniffer_hook_to_settings
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


@pytest.fixture
def isolated_user_home(tmp_path, monkeypatch):
    real_home = tmp_path / "real_home"
    real_home.mkdir()
    # A non-test instance exercises the production provider-home resolvers.
    monkeypatch.setenv("FLOW_INSTANCE", "oss")
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "sandbox" / ".flow"))
    monkeypatch.setenv("HOME", str(real_home))
    monkeypatch.setenv("USERPROFILE", str(real_home))
    monkeypatch.delenv("FLOWPAD_CLAUDE_HOME", raising=False)
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    reset_instance_settings()
    try:
        yield real_home
    finally:
        reset_instance_settings()


@pytest.mark.parametrize("selector", ["FLOWPAD_CLAUDE_HOME", "CLAUDE_CONFIG_DIR"])
async def test_sniffer_install_does_not_contaminate_real_claude_settings(
    tmp_path, monkeypatch, isolated_user_home, selector
):
    real_claude_settings = isolated_user_home / ".claude" / "settings.json"
    real_claude_settings.parent.mkdir()
    sentinel = b'{"permissions":{"allow":["Read"]},"hooks":{}}\n'
    real_claude_settings.write_bytes(sentinel)
    sandbox_claude = tmp_path / "sandbox" / ".claude"
    monkeypatch.setenv(selector, str(sandbox_claude))
    reset_instance_settings()

    settings = get_instance_settings()
    assert settings.flow_home == tmp_path / "sandbox" / ".flow"
    assert settings.claude_settings_json_path == sandbox_claude / "settings.json"
    hook = AgentHook(
        name="flowpad_sniffer",
        hook_name="flowpad_sniffer",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="UserPromptSubmit",
    )
    assert hook.id, "AgentHook must have an id for the sniffer marker"
    assert await sync_sniffer_hook_to_settings(hook)

    installed = json.loads(settings.claude_settings_json_path.read_text())
    assert set(installed["hooks"]) == set(DEFAULT_LISTENED_HOOKS)
    for entries in installed["hooks"].values():
        assert len(entries) == 1
        assert len(entries[0]["hooks"]) == 1
        command_hook = entries[0]["hooks"][0]
        assert command_hook["type"] == "command"
        assert "--name=flowpad_sniffer" in command_hook["command"]
        assert f"--hook-entry-id={hook.id}" in command_hook["command"]
    assert real_claude_settings.read_bytes() == sentinel


def test_flow_home_alone_does_not_relocate_claude_settings(tmp_path, isolated_user_home):
    settings = get_instance_settings()
    assert settings.flow_home == tmp_path / "sandbox" / ".flow"
    assert settings.claude_settings_json_path == isolated_user_home / ".claude" / "settings.json"
