"""A graph list request's top-level ``order_by`` is honored, like ``limit``/``offset``.

``QueryFilter.toJSON`` (ts_sdk) sends ``order_by`` beside ``filter``, not inside it.
The stream inbox pages "the 100 newest conversations" that way; when the backend
dropped the top-level ``order_by`` it returned the first 100 in insertion order,
and today's conversations fell off the page.

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import uuid

import pytest

from ._graph_client import call_local

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_top_level_order_by_pages_the_newest_first() -> None:
    title = f"order-by-{uuid.uuid4()}"
    created = []
    for _ in range(3):
        resp = await call_local("POST", "conversation", json={"title": title, "kind": "direct"})
        assert resp.status_code == 200, resp.text
        created.append(resp.json()["data"]["id"])

    # The exact parameter shape the stream inbox page query sends.
    resp = await call_local(
        "GET",
        "conversation",
        params={
            "filter[match][op]": "$EQ",
            "filter[match][operands][0]": "title",
            "filter[match][operands][1]": title,
            "limit": "2",
            "order_by[0][updated_date]": "desc",
            "order_by[1][id]": "asc",
        },
    )
    assert resp.status_code == 200, resp.text

    assert [row["id"] for row in resp.json()["data"]] == [created[2], created[1]]
