"""An agent with a mailbox AND a channel answers each conversation on ITS channel.

``POST /conversation/<id>/send_external {agent_id}`` used to pin the reply to the agent's FIRST
source (``scope.source_id``) — so a Slack conversation of an agent that also had a mailbox was
refused with "this conversation did not come from a channel". The source is the conversation's
own; the scope check is what makes the agent's send legitimate.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.stream_inbox import outbound
from tests.unit._stream_inbox_matrix import deliver, double_for, make_cell, projected

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_the_reply_leaves_through_the_conversations_own_source(client, monkeypatch):
    # Two channels owned by one agent; the conversation comes from whichever source sorts SECOND
    # by id — exactly the one the old route never picked.
    with double_for("slack") as slack, double_for("telegram") as telegram:
        first = await make_cell("agent", "slack", slack, monkeypatch)
        second = await make_cell("agent", "telegram", telegram, monkeypatch)
        second.source.owner = first.owner  # one agent, both sources
        await second.source.save()
        second.agent = first.agent
        cells = sorted((first, second), key=lambda c: str(c.source.id))
        cell = cells[1]
        try:
            item = await deliver(cell)
            _, conversation = await projected(item)

            resp = await client.post(f"/api/v1/graph/conversation/{conversation.id}/send_external",
                                     json={"text": f"reply {cell.nonce}", "agent_id": first.owner.id})
            body = resp.json()
            assert resp.status_code == 200 and body.get("status") == "SUCCESS", body
            assert body["data"]["channel"] == cell.source.channel, "the reply was routed by the agent's first source"
            await asyncio.gather(*list(outbound._INFLIGHT))
            assert [m["text"] for m in cell.double.sent()] == [f"reply {cell.nonce}"]
            assert cells[0].double.sent() == [], "the other channel sent nothing"
        finally:
            for c in (first, second):
                await c.source.delete()
            await first.agent.delete()
