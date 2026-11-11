"""A graph list request's top-level ``order_by`` is refused, as on the hub.

The hub is the standard: paging (``limit``/``offset``/``order_by``) lives inside ``filter`` next to a
``match``. A top-level ``order_by`` used to be copied in silently; now it answers 400 "paging goes
inside filter", so a caller that thinks it sorted cannot get an unsorted page back.

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import uuid

import pytest

from ._graph_client import call_local

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_top_level_order_by_is_refused() -> None:
    resp = await call_local(
        "GET",
        "conversation",
        params={
            "filter[match][op]": "$EQ",
            "filter[match][operands][0]": "title",
            "filter[match][operands][1]": f"order-by-{uuid.uuid4()}",
            "order_by[0][updated_date]": "desc",
        },
    )
    assert resp.status_code == 400, resp.text
    assert "paging goes inside filter" in resp.text


@pytest.mark.asyncio
async def test_order_by_inside_filter_pages_the_newest_first() -> None:
    title = f"order-by-{uuid.uuid4()}"
    created = []
    for _ in range(3):
        resp = await call_local("POST", "conversation", json={"title": title, "kind": "direct"})
        assert resp.status_code == 200, resp.text
        created.append(resp.json()["data"]["id"])

    resp = await call_local(
        "GET",
        "conversation",
        params={
            "filter[match][op]": "$EQ",
            "filter[match][operands][0]": "title",
            "filter[match][operands][1]": title,
            "filter[limit]": "2",
            "filter[order_by][0][updated_date]": "desc",
        },
    )
    assert resp.status_code == 200, resp.text
    assert [row["id"] for row in resp.json()["data"]] == [created[2], created[1]]
