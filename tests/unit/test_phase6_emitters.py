"""Phase 6 — remaining emitters: agent.status, hub relay, node liveness."""
import asyncio

from flow_sdk.topics import event_bus
from tests.conftest import async_context


@async_context
async def test_node_liveness_emits_on_connection_transition(tmp_path):
    from flow_sdk.builtin.compute_node import ComputeNode
    from flow_sdk.cloud_client.auth_state import set_connection_status
    from flow_sdk.cloud_client.auth_status import HubConnectionStatus

    local = await ComputeNode.get_local()
    got: list = []
    unsub = event_bus.on("node.*", got.append)
    try:
        await set_connection_status(HubConnectionStatus.CONNECTED)
        await set_connection_status(HubConnectionStatus.DISCONNECTED, error="link lost")
        await asyncio.sleep(0.02)
    finally:
        unsub()
    topics = [e.topic for e in got]
    assert topics == ["node.connected", "node.disconnected"]
    assert all(e.target == f"compute_node:{local.id}" for e in got)
    assert got[1].data == {"error": "link lost"}


@async_context
async def test_hub_relay_emits_own_family_with_hub_origin(tmp_path):
    from flow_sdk.cloud_client.hub_bridge import HubWsBridge

    bridge = HubWsBridge.__new__(HubWsBridge)  # dispatch only — no live link
    bridge._subscriptions = []
    got: list = []
    unsub = event_bus.on("hub.*", got.append)
    try:
        bridge._dispatch_event(op="update", entity_type="conversation",
                               entity_id="c-1", parent_type=None, parent_id=None,
                               data={"actor": "user:u-9"})
    finally:
        unsub()
    assert len(got) == 1
    e = got[0]
    assert e.topic == "hub.entity.update"          # own family — never entity.*
    assert e.target == "conversation:c-1"
    assert e.ctx.origin == "hub"
    assert e.ctx.actor == "user:u-9"
