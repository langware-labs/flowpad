"""A graph list call sorts on the server BEFORE its limit, and pages without shuffling.

The order lives inside ``filter`` (the hub's contract). Equal sort keys are settled by ``id`` so page 2
neither repeats nor skips a row of page 1, and a paged list with no order is newest first.
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from tests.unit._graph_client import call_local

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _convs(n: int, title) -> list[Conversation]:
    convs = []
    for i in range(n):
        c = Conversation(id=str(uuid.uuid4()), title=title(i))
        await c.save(notify=False)
        convs.append(c)
    return convs


async def _page(convs, **page) -> dict:
    flt = {"match": {"op": "$IN", "operands": ["id", [c.id for c in convs]]}, **page}
    res = await call_local("GET", "conversation", params={"filter": json.dumps(flt)})
    assert res.status_code == 200, res.text
    return res.json()


async def test_order_by_inside_filter_sorts_before_the_limit():
    tag = uuid.uuid4().hex[:8]
    convs = await _convs(3, lambda i: f"order-{tag}-{i}")
    body = await _page(convs, limit=2, order_by=[{"updated_date": "desc"}])
    got = [c["title"] for c in body["data"]]
    assert got == [f"order-{tag}-2", f"order-{tag}-1"], f"newest-first returned {got}"


async def test_offset_page_two_continues_page_one():
    tag = uuid.uuid4().hex[:8]
    convs = await _convs(5, lambda i: f"order-{tag}-{i}")
    first = await _page(convs, limit=2, order_by=[{"title": "asc"}])
    second = await _page(convs, limit=2, offset=first["next_offset"], order_by=[{"title": "asc"}])
    last = await _page(convs, limit=2, offset=second["next_offset"], order_by=[{"title": "asc"}])
    titles = [c["title"] for body in (first, second, last) for c in body["data"]]
    assert titles == [f"order-{tag}-{i}" for i in range(5)]
    assert (first["has_more"], second["has_more"], last["has_more"]) == (True, True, False)
    assert last["next_offset"] == 5


async def test_equal_sort_keys_are_settled_by_id():
    title = f"same-{uuid.uuid4().hex[:8]}"
    convs = await _convs(5, lambda i: title)
    pages = []
    offset = 0
    while True:
        body = await _page(convs, limit=2, offset=offset, order_by=[{"title": "asc"}])
        pages.extend(c["id"] for c in body["data"])
        if not body["has_more"]:
            break
        offset = body["next_offset"]
    assert pages == sorted(c.id for c in convs), "equal keys shuffled between pages"


async def test_paged_without_order_is_newest_first():
    tag = uuid.uuid4().hex[:8]
    convs = await _convs(3, lambda i: f"new-{tag}-{i}")
    body = await _page(convs, limit=3)
    assert [c["id"] for c in body["data"]] == [c.id for c in reversed(convs)]
