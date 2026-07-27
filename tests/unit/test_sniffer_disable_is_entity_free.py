"""Disabling the sniffer must clear settings.json even with no local entity.

The sniffer install is machine-global (``~/.claude/settings.json``) while the
AgentHook that describes it lives in one instance's DB. Any other instance —
or the same one after a DB reset — sees hooks it has no entity for, and the
old disable path (entity → ``unapply()``) silently no-op'd there while Claude
Code kept firing events. These tests pin the entity-free contract: what is
installed is read from, and purged from, the settings file itself.
"""

import json

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.claude_settings_sync import (
    sniffer_installed_in_settings,
    purge_sniffer_entries_from_settings,
    sync_sniffer_hook_to_settings,
)
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


def _sniffer_hook() -> AgentHook:
    return AgentHook(
        name="Hooks Sniffer",
        hook_name="flowpad_sniffer",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="SessionStart",
    )


async def _install(tmp_path, monkeypatch) -> tuple[AgentHook, "object"]:
    """Install a sniffer into an isolated claude home; return (hook, settings path)."""
    claude_home = tmp_path / "claude_home"
    claude_home.mkdir(parents=True)
    monkeypatch.setenv("FLOWPAD_CLAUDE_HOME", str(claude_home))
    reset_instance_settings()

    hook = _sniffer_hook()
    assert await sync_sniffer_hook_to_settings(hook)
    return hook, get_instance_settings().claude_settings_json_path


async def test_install_is_visible_without_the_entity(tmp_path, monkeypatch):
    try:
        _, settings_path = await _install(tmp_path, monkeypatch)
        assert sniffer_installed_in_settings(HookScope.USER)
        assert "flowpad_sniffer" in settings_path.read_text()
    finally:
        reset_instance_settings()


async def test_purge_clears_a_sniffer_this_instance_does_not_own(tmp_path, monkeypatch):
    """The disable path, with no AgentHook in hand — the cross-instance case."""
    try:
        _, settings_path = await _install(tmp_path, monkeypatch)

        assert purge_sniffer_entries_from_settings(HookScope.USER)

        assert not sniffer_installed_in_settings(HookScope.USER)
        assert "flowpad_sniffer" not in settings_path.read_text()
    finally:
        reset_instance_settings()


async def test_purge_keeps_unrelated_hooks(tmp_path, monkeypatch):
    try:
        _, settings_path = await _install(tmp_path, monkeypatch)
        settings = json.loads(settings_path.read_text())
        settings["hooks"].setdefault("SessionStart", []).append(
            {"matcher": "*", "hooks": [{"type": "command", "command": "echo mine"}]}
        )
        settings_path.write_text(json.dumps(settings))

        assert purge_sniffer_entries_from_settings(HookScope.USER)

        remaining = settings_path.read_text()
        assert "flowpad_sniffer" not in remaining
        assert "echo mine" in remaining
    finally:
        reset_instance_settings()
