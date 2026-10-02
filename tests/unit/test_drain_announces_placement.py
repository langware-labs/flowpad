"""A deployment's drain announces the messages it places — and the app announces their rows.

A local agent deployment runs its loop in its own process (``builtin/agent_loop``). While it runs,
the app polls none of its channels: the drain (``StreamInbox.pages``) is the only thing that places
an arriving message in its conversation. It placed inbound mail SILENTLY, so the relayed
``projected`` tag (``tags/relay``) never fired for it, and the agent's stream inbox showed no row
for mail that landed after the deployment started — only its own reply's copy was announced.

And a tag is only half of it: the other process's writes made no entity op any client could hear,
so the app, on a relayed placement, sends the placed rows' ops to its own clients.
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import StreamInbox, workflow
from tests.utils.fake_source import scripted_provider

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _take(agen, n: int) -> list:
    out = []
    try:
        for _ in range(n):
            out.append(await agen.__anext__())
    finally:
        await agen.aclose()
    return out


def _messages(n: int) -> list[dict]:
    return [{"body": f"m{i:03d}", "author": "someone@example.com", "thread_key": f"t{i}"} for i in range(n)]


@pytest.fixture
def announced(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(
        "flow_sdk.stream_inbox.stream_inbox_on_tag.emit_projected_tag",
        lambda item: seen.append(str(item.id)),
    )
    return seen


async def test_the_drain_announces_an_inbound_message_it_places(announced):
    with scripted_provider("drain-announce", projected=True) as script:
        script.push(*_messages(2))
        box = StreamInbox(f"{mint_uuid()}@drain", provider="drain-announce")
        async with workflow(f"drain-{mint_uuid()}"):
            (page,) = await _take(box.pages(size=50, poll_every=0), 1)
    assert sorted(announced) == sorted(str(m._row.id) for m in page)


async def test_a_storm_page_is_placed_silently(announced):
    from flow_sdk.ingest.models import STORM_CAP_PER_MINUTE

    with scripted_provider("drain-storm", projected=True) as script:
        script.push(*_messages(STORM_CAP_PER_MINUTE + 1))
        box = StreamInbox(f"{mint_uuid()}@drain", provider="drain-storm")
        async with workflow(f"drain-{mint_uuid()}"):
            (page,) = await _take(box.pages(size=STORM_CAP_PER_MINUTE + 1, poll_every=0), 1)
    assert len(page) == STORM_CAP_PER_MINUTE + 1
    assert announced == []


async def test_a_relayed_placement_announces_its_rows_to_the_apps_clients(announced, monkeypatch):
    from flow_sdk.api.api_types.messages import OperationType
    from flow_sdk.tags.relay import announce_relayed_writes

    with scripted_provider("drain-relay", projected=True) as script:
        script.push(*_messages(1))
        box = StreamInbox(f"{mint_uuid()}@drain", provider="drain-relay")
        async with workflow(f"drain-{mint_uuid()}"):
            (page,) = await _take(box.pages(size=50, poll_every=0), 1)
    (item_id,) = announced

    ops: list[tuple[str, str]] = []

    async def _sent(op_message) -> None:
        ops.append((op_message.to_entity.type, OperationType(op_message.op).value))

    monkeypatch.setattr("flow_sdk.core.network.resource_tracker.handle_entity_op", _sent)
    envelope = {
        "tag": "stream_inbox.drain-relay.message.projected",
        "target": f"source_item:{item_id}",
        "data": {"entity_id": item_id, "source_id": page.source_id},
    }
    await announce_relayed_writes(envelope)

    assert ("flow_message", OperationType.CREATE.value) in ops
    assert ("conversation", OperationType.UPDATE.value) in ops

    # Any other relayed tag names no rows.
    ops.clear()
    await announce_relayed_writes({"tag": "deployment.timeline", "target": "deployment:d", "data": {}})
    assert ops == []
