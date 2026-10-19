"""A graph list call sorts on the server BEFORE its limit.

The SDK's QueryFilter.toJSON sends ``order_by`` at the top level, beside
``filter`` and ``limit``. The StreamInbox asks for the latest 100 conversations that
way; when the server drops the top-level order it cuts 100 rows in storage
order, and a conversation updated a moment ago is not among them.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from tests.unit._graph_client import call_local

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_top_level_order_by_sorts_before_the_limit():
    tag = uuid.uuid4().hex[:8]
    # Each save is newer than the last: storage order is the REVERSE of newest-first.
    convs = []
    for i in range(3):
        c = Conversation(id=str(uuid.uuid4()), title=f"order-{tag}-{i}")
        await c.save(notify=False)
        convs.append(c)

    # The query string exactly as the StreamInbox SDK call encodes it.
    res = await call_local(
        "GET",
        "conversation",
        params={
            "filter[match][op]": "$IN",
            "filter[match][operands][0]": "id",
            **{f"filter[match][operands][1][{i}]": c.id for i, c in enumerate(convs)},
            "limit": "2",
            "order_by[0][updated_date]": "desc",
            "order_by[1][id]": "asc",
        },
    )
    assert res.status_code == 200, res.text
    got = [c["title"] for c in res.json()["data"]]
    want = [f"order-{tag}-2", f"order-{tag}-1"]
    assert got == want, f"newest-first returned {got}: order_by was not applied before the limit"
