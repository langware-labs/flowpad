"""A graph list call sorts on the server BEFORE its limit, and pages without shuffling.

The order lives inside ``filter`` (the hub's contract). Equal sort keys are settled by ``id`` so page 2
neither repeats nor skips a row of page 1, and a paged list with no order is newest first.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

from flow_sdk.builtin.agent_trace import AgentTrace
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


async def _page(convs, resource: str = "conversation", **page) -> dict:
    flt = {"match": {"op": "$IN", "operands": ["id", [c.id for c in convs]]}, **page}
    res = await call_local("GET", resource, params={"filter": json.dumps(flt)})
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


async def _cursor_walk(convs, **page) -> list[dict]:
    """Every row, one page at a time, each page asked for by the previous page's ``next_cursor``."""
    rows, after = [], None
    for _ in range(20):
        body = await _page(convs, **page, **({"after": after} if after else {}))
        rows.extend(body["data"])
        assert "next_cursor" in body
        if not body["has_more"]:
            assert body["next_cursor"] is None
            return rows
        after = body["next_cursor"]
        assert after
    raise AssertionError("cursor walk never ended")


async def test_cursor_walk_with_tied_keys_neither_repeats_nor_skips():
    tag = uuid.uuid4().hex[:8]
    convs = await _convs(7, lambda i: f"cur-{tag}-{(i // 2)}")  # titles tie in pairs
    rows = await _cursor_walk(convs, limit=2, order_by=[{"title": "desc"}])
    by_offset = (await _page(convs, limit=7, order_by=[{"title": "desc"}]))["data"]
    assert [r["id"] for r in rows] == [r["id"] for r in by_offset]
    assert len({r["id"] for r in rows}) == 7


async def test_cursor_walk_on_a_number_compares_numbers():
    # 9 < 10 < 100 as numbers; compared as text the keyset after 9 would skip 10 and 100.
    traces = []
    for count in (9, 10, 10, 2, 100):
        t = AgentTrace(id=str(uuid.uuid4()), name=f"num-{uuid.uuid4().hex[:8]}", issue_count=count)
        await t.save(notify=False)
        traces.append(t)
    rows = await _cursor_walk(traces, limit=2, order_by=[{"issue_count": "asc"}], resource="agent_trace")
    assert [r["issue_count"] for r in rows] == [2, 9, 10, 10, 100]
    assert len({r["id"] for r in rows}) == 5


async def test_default_order_cursor_walk_matches_newest_first():
    tag = uuid.uuid4().hex[:8]
    convs = await _convs(5, lambda i: f"dflt-{tag}-{i}")
    rows = await _cursor_walk(convs, limit=2)  # created_date desc, id: keyset compares created_date with $EQ
    assert [r["id"] for r in rows] == [c.id for c in reversed(convs)]


async def test_default_order_cursor_walk_through_tied_created_dates():
    # The keyset's tie branch is ``created_date $EQ x AND id > y``: an ISO cursor value must equal the
    # stored DateTime, or every row sharing the page's last timestamp is skipped.
    same = datetime(2026, 10, 23, 11, 25, 7, 768473, tzinfo=timezone.utc)
    convs = []
    for i in range(5):
        c = Conversation(id=str(uuid.uuid4()), title=f"tie-{i}", created_date=same)
        await c.save(notify=False)
        convs.append(c)
    rows = await _cursor_walk(convs, limit=2)
    assert [r["id"] for r in rows] == sorted(c.id for c in convs)


async def test_pages_asked_for_at_offset_plus_limit_never_repeat_a_row():
    """A page counts only the rows the caller is shown: hidden system rows are excluded by the query, not
    after it. Counted after it, a page spanned more store rows than it answered, so the next page — asked
    for at ``offset + limit``, as a client walking a list does — started back inside it."""
    tag = uuid.uuid4().hex[:8]
    convs = []
    for i in range(24):
        c = Conversation(id=str(uuid.uuid4()), title=f"hid-{tag}-{i:02}", system=i % 3 == 0)
        await c.save(notify=False)
        convs.append(c)
    mine, rows = [c for c in convs if not c.system], []
    for offset in range(0, len(mine), 4):
        body = await _page(convs, limit=4, offset=offset, order_by=[{"title": "asc"}])
        rows.extend(c["id"] for c in body["data"])
    assert len(rows) == len(set(rows)), f"{len(rows) - len(set(rows))} row(s) came back twice"
    assert rows == [c.id for c in mine], "the walk is the visible rows, each once, in order"
