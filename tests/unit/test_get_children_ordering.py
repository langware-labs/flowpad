"""``get_children`` honors ``child_filter``'s order_by / offset / limit.

The relationship rows carry no order, so before this the child list came back in
whatever order SQLite produced — fine while nobody asked, wrong the moment a caller
wants "this conversation's messages, oldest first". Ordering is a generic driver
capability here, not a conversation feature: the tests below use ``Comment`` children
so nothing about the guarantee is message-specific.

NULL handling is the sharp edge — a child with no ``created_date`` must not be
compared against one that has a real datetime (the shared ``_apply_sorting`` helper
coerces missing values to ``""`` and raises exactly that TypeError, which is why
``get_children`` sorts with its own NULL-bucketing key).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


@pytest.fixture()
def blob_storage(tmp_path):
    """Blob-storage fallback so Comment (blob field) saves outside a service context."""
    from flow_sdk.config import default_service_config
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev


BASE = datetime(2026, 7, 30, 12, 0, 0, tzinfo=timezone.utc)


async def _parent_with_children(stamps: list[datetime | None]) -> tuple[Conversation, list[str]]:
    """A conversation with one Comment child per stamp, attached in an order that
    deliberately does NOT match the stamps — so a passing assertion can only come
    from real sorting, never from insertion order."""
    conv = Conversation(id=str(uuid.uuid4()), title="ordering")
    await conv.save()
    ids: list[str] = []
    for i, ts in enumerate(stamps):
        child = Comment(id=str(uuid.uuid4()), raw_content=f"c{i}", data={"line": i})
        if ts is not None:
            child.created_date = ts
        await conv.add_child(child)
        ids.append(child.id)
    return conv, ids


def _ordered_ids(kids) -> list[str]:
    return [getattr(k, "value", k).id for k in kids if getattr(k, "value", k) is not None]


@pytest.mark.asyncio
async def test_order_by_created_date_asc(records_root, blob_storage):
    # attached newest-first; asking for asc must invert that
    conv, ids = await _parent_with_children([BASE + timedelta(minutes=2), BASE, BASE + timedelta(minutes=1)])
    newest, oldest, middle = ids

    kids = await conv.get_children(child_filter=QueryFilter(type=Comment.get_type(), order_by={"created_date": "asc"}))
    assert _ordered_ids(kids) == [oldest, middle, newest]


@pytest.mark.asyncio
async def test_order_by_created_date_desc(records_root, blob_storage):
    conv, ids = await _parent_with_children([BASE, BASE + timedelta(minutes=2), BASE + timedelta(minutes=1)])
    oldest, newest, middle = ids

    kids = await conv.get_children(child_filter=QueryFilter(type=Comment.get_type(), order_by={"created_date": "desc"}))
    assert _ordered_ids(kids) == [newest, middle, oldest]


@pytest.mark.asyncio
async def test_limit_and_offset_apply_after_ordering(records_root, blob_storage):
    conv, ids = await _parent_with_children([BASE + timedelta(minutes=2), BASE, BASE + timedelta(minutes=1)])
    newest, oldest, middle = ids

    page = await conv.get_children(
        child_filter=QueryFilter(type=Comment.get_type(), order_by={"created_date": "asc"}, limit=2)
    )
    assert _ordered_ids(page) == [oldest, middle]

    page2 = await conv.get_children(
        child_filter=QueryFilter(type=Comment.get_type(), order_by={"created_date": "asc"}, offset=1, limit=2)
    )
    assert _ordered_ids(page2) == [middle, newest]


@pytest.mark.asyncio
async def test_null_created_date_sorts_last_and_never_raises(records_root, blob_storage):
    """A NULL stamp must bucket to the end, not blow up comparing str to datetime."""
    conv, ids = await _parent_with_children([BASE + timedelta(minutes=1), None, BASE])
    later, missing, earlier = ids

    kids = await conv.get_children(child_filter=QueryFilter(type=Comment.get_type(), order_by={"created_date": "asc"}))
    ordered = _ordered_ids(kids)
    assert ordered[-1] == missing, f"NULL should sort last, got {ordered}"
    assert ordered[:2] == [earlier, later]


@pytest.mark.asyncio
async def test_without_order_by_all_children_still_returned(records_root, blob_storage):
    """The default path is untouched: no order_by, no ordering promise, same set."""
    conv, ids = await _parent_with_children([BASE, BASE + timedelta(minutes=1), BASE + timedelta(minutes=2)])

    kids = await conv.get_children()
    assert sorted(_ordered_ids(kids)) == sorted(ids)
