"""Bootstrap reconciles the sniffer install with what this instance owns.

"Disabled" has one meaning — no ``flowpad_sniffer`` commands in the harness
settings file — and both roads to it must agree. The explicit toggle off
(``DELETE`` on the hooks-sniffer action) already purged entity-free; boot did
not, so entries left by an uninstalled or otherwise-configured instance kept
Claude Code firing at a backend that had no hook for them. These tests pin
both halves of the contract: purge what nothing here backs, keep what the user
turned on.
"""

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.claude_settings_sync import (
    sniffer_installed_in_settings,
    sync_sniffer_hook_to_settings,
)


async def _install_orphan_sniffer() -> None:
    """Write sniffer commands into settings.json without saving any entity —
    exactly what another instance leaves behind."""
    hook = AgentHook(
        name="Hooks Sniffer",
        hook_name="flowpad_sniffer",
        provider=AgentProvider.CLAUDE_CODE,
        hook_scope=HookScope.USER,
        event="SessionStart",
    )
    assert await sync_sniffer_hook_to_settings(hook)
    assert sniffer_installed_in_settings(HookScope.USER)


async def test_bootstrap_purges_a_sniffer_no_entity_backs(client):
    """Gate off + no hook entity = disabled, so the stale commands must go."""
    # The API-test DB is session-shared, so an earlier test (e.g. the agent-hook
    # e2e) may have left an enabled sniffer entity — establish "no entity backs
    # it" ourselves rather than assume it.
    disable = await client.delete("/api/v1/graph/agent_hook/hooks-sniffer")
    assert disable.status_code == 200, disable.text

    await _install_orphan_sniffer()

    response = await client.get("/api/v1/graph/bootstrap")
    assert response.status_code == 200, response.text
    data = response.json()["data"]

    assert not sniffer_installed_in_settings(HookScope.USER)
    assert data["sniffer_installed"] is False
    assert data["sniffer_hook"] is None


async def test_bootstrap_keeps_a_sniffer_the_user_enabled(client):
    """The instance gate defaults off, but an explicit enable owns an entity —
    that survives every restart. Without this the purge would revoke the user's
    own choice on the next boot."""
    enable = await client.post("/api/v1/graph/agent_hook/hooks-sniffer")
    assert enable.status_code == 200, enable.text
    assert enable.json()["data"]["enabled"] is True
    assert sniffer_installed_in_settings(HookScope.USER)

    response = await client.get("/api/v1/graph/bootstrap")
    assert response.status_code == 200, response.text
    data = response.json()["data"]

    assert sniffer_installed_in_settings(HookScope.USER)
    assert data["sniffer_installed"] is True
    assert data["sniffer_hook"] is not None

    # Leave the shared session DB as we found the gate: no entity, no settings
    # entries — later tests assert on both.
    disable = await client.delete("/api/v1/graph/agent_hook/hooks-sniffer")
    assert disable.status_code == 200, disable.text
    assert not sniffer_installed_in_settings(HookScope.USER)
