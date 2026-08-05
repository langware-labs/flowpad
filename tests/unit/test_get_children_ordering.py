"""``get_children`` honors ``child_filter``'s order_by / offset / limit.

The relationship rows carry no order, so before this the child list came back in
whatever order SQLite produced — fine while nobody asked, wrong the moment a caller
wants "this conversation's messages, oldest first". Ordering is a generic driver
capability here, not a conversation feature: the tests below use ``Comment`` children
so nothing about the guarantee is message-specific.

NULL handling is the sharp edge — a missing value must not be compared against a
real datetime. The shared ``_apply_sorting`` helper coerces missing values to
``""`` and raises exactly that TypeError, so ``get_children`` uses its own
NULL-bucketing key. (Folding the two sorters together is worth doing, but it
changes a helper shared with the main query path, so it is out of scope here.)
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


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.null_sort_order.rules: FAILING? read this tag's rules — missing
#       sorts FIRST; never coerce it to ""
# flowpad:endcapsule tag
def test_sort_key_buckets_missing_values_instead_of_coercing():
    """NULL ordering, tested where a NULL is actually reachable.

    Not through ``get_children``: the driver stamps ``created_date`` on every
    save, so a persisted entity can never have it NULL — a test that built one
    and asserted on its position would be asserting on ``datetime.now()``, not
    on NULL handling. The sort KEY is the thing with the NULL semantics, so it
    is tested directly.

    Two properties. It must never compare a missing value against a real one
    (the previous ``getattr(e, f, "") or ""`` coerced NULL to ``""`` and then
    raised ``str`` vs ``datetime``). And a missing value must sort FIRST on
    ascending — where SQLite's ``ORDER BY ... ASC`` puts it — so this Python
    fallback and the SQL path never disagree about the same rows.
    """
    from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver

    key = SQLiteDBDriver._sort_key
    now = datetime(2026, 7, 30, 12, 0, 0, tzinfo=timezone.utc)

    # The comparison that used to raise.
    assert key(None) < key(now)
    assert sorted([key(now), key(None)]) == [key(None), key(now)]
    # Mixed types stay in separate buckets rather than being compared.
    assert key(None) < key("a string")
    assert key(None) < key(0)


@pytest.mark.asyncio
async def test_without_order_by_all_children_still_returned(records_root, blob_storage):
    """The default path is untouched: no order_by, no ordering promise, same set."""
    conv, ids = await _parent_with_children([BASE, BASE + timedelta(minutes=1), BASE + timedelta(minutes=2)])

    kids = await conv.get_children()
    assert sorted(_ordered_ids(kids)) == sorted(ids)
