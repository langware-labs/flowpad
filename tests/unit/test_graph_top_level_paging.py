"""The graph list paging contract, as the hub (the standard) answers it.

Paging lives ONLY inside ``filter`` next to a ``match``. Plain ``?limit``/``?offset``/``?order_by`` are
refused (400) — they used to be honoured here and ignored on the hub, so the same call paged on one
backend and dumped every row on the other. A match-less filter that pages, and an invalid page
(``limit < 1``, ``offset < 0``, a non-integer, a bad direction, an order key that is not a field name),
are refused too.

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation

from ._graph_client import call_local

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _three(tag: str) -> list[Conversation]:
    convs = []
    for i in range(3):
        c = Conversation(id=str(uuid.uuid4()), title=f"page-{tag}-{i}")
        await c.save(notify=False)
        convs.append(c)
    return convs


def _match_ids(convs) -> dict:
    return {"op": "$IN", "operands": ["id", [c.id for c in convs]]}


@pytest.mark.parametrize("param", ["limit", "offset", "order_by"])
async def test_plain_paging_param_is_refused(param):
    res = await call_local("GET", "conversation", params={param: "2"})
    assert res.status_code == 400, res.text
    assert "paging goes inside filter" in res.text


async def test_filter_without_match_that_pages_is_refused():
    res = await call_local("GET", "conversation", params={"filter": json.dumps({"limit": 2})})
    assert res.status_code == 400, res.text
    assert "needs a" in res.text


@pytest.mark.parametrize(
    "page",
    [
        {"limit": 0},
        {"limit": -1},
        {"offset": -1},
        {"limit": "lots"},
        {"order_by": [{"title": "sideways"}]},
        {"order_by": [{"id) RETURN n //": "asc"}]},
    ],
)
async def test_invalid_page_is_refused(page):
    res = await call_local("GET", "conversation", params={"filter": json.dumps({"match": {}, **page})})
    assert res.status_code == 400, res.text


async def test_filter_paging_answers_a_page_with_has_more():
    convs = await _three(uuid.uuid4().hex[:8])
    flt = {"match": _match_ids(convs), "limit": 2, "order_by": [{"title": "asc"}]}
    res = await call_local("GET", "conversation", params={"filter": json.dumps(flt)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert [c["id"] for c in body["data"]] == [convs[0].id, convs[1].id]
    assert body["has_more"] is True
    assert body["next_offset"] == 2


async def test_bracket_form_paging_works():
    convs = await _three(uuid.uuid4().hex[:8])
    params = {
        "filter[match][op]": "$IN",
        "filter[match][operands][0]": "id",
        **{f"filter[match][operands][1][{i}]": c.id for i, c in enumerate(convs)},
        "filter[limit]": "1",
        "filter[offset]": "2",
        "filter[order_by][0][title]": "asc",
    }
    res = await call_local("GET", "conversation", params=params)
    assert res.status_code == 200, res.text
    body = res.json()
    assert [c["id"] for c in body["data"]] == [convs[2].id]
    assert body["has_more"] is False
    assert body["next_offset"] == 3


async def test_unpaged_answer_carries_no_paging_fields():
    convs = await _three(uuid.uuid4().hex[:8])
    res = await call_local("GET", "conversation", params={"filter": json.dumps({"match": _match_ids(convs)})})
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["data"]) == 3
    assert "has_more" not in body and "next_offset" not in body
