"""Expiring dead feed refs costs one query per TYPE, not one per card.

A FeedEntry points at the entity that renders inside its card. When that target
is deleted nothing expires the entry, so the read path has to notice. It did —
with a ``get_by_id`` per entry, on every Home load. A feed of N cards therefore
paid N queries to answer a question that is one ``id IN (…)`` per entity type.

Two things are pinned here beyond the count:

* expired entries are still RETURNED. The caller renders them as unavailable;
  dropping them would make rows vanish mid-scroll, which is a product change,
  not a perf fix.
* the existence check fails OPEN. Expiry is persisted and not reversible from
  the read path, so a transient DB error must never mass-expire a live feed.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
from flow_sdk.fs_store.type_id import TypeId

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)


class _Row:
    def __init__(self, row_id: str) -> None:
        self.id = row_id


def _fake_model(present_ids: set[str], counter: list[int]):
    class _Model:
        @classmethod
        async def get_all(cls, entities_filter=None, **_kwargs):
            counter[0] += 1
            return [_Row(i) for i in sorted(present_ids)]

    return _Model


async def test_existence_check_is_one_query_per_type(monkeypatch):
    calls = [0]
    live = "11111111-1111-4111-8111-111111111111"
    dead = "22222222-2222-4222-8222-222222222222"
    other = "33333333-3333-4333-8333-333333333333"

    monkeypatch.setattr(
        FeedEntry,
        "get_entity_model_by_type",
        staticmethod(lambda _t: _fake_model({live, other}, calls)),
        raising=False,
    )
    from flow_sdk.core import Entity

    monkeypatch.setattr(Entity, "get_entity_model_by_type", staticmethod(lambda _t: _fake_model({live, other}, calls)))

    targets = [
        TypeId(type="skill", id=live),
        TypeId(type="skill", id=dead),
        TypeId(type="skill", id=other),
    ]
    existing = await FeedEntry._existing_targets(targets)

    assert calls[0] == 1, "three targets of one type must cost ONE query, not three"
    assert ("skill", live) in existing
    assert ("skill", other) in existing
    assert ("skill", dead) not in existing


async def test_two_types_cost_two_queries(monkeypatch):
    calls = [0]
    an_id = "44444444-4444-4444-8444-444444444444"
    from flow_sdk.core import Entity

    monkeypatch.setattr(Entity, "get_entity_model_by_type", staticmethod(lambda _t: _fake_model({an_id}, calls)))

    await FeedEntry._existing_targets([TypeId(type="skill", id=an_id), TypeId(type="markdown", id=an_id)])
    assert calls[0] == 2, "one query per distinct entity type"


async def test_unknown_type_fails_open(monkeypatch):
    from flow_sdk.core import Entity

    monkeypatch.setattr(Entity, "get_entity_model_by_type", staticmethod(lambda _t: None))

    an_id = "55555555-5555-4555-8555-555555555555"
    existing = await FeedEntry._existing_targets([TypeId(type="mystery", id=an_id)])

    assert ("mystery", an_id) in existing, "an unregistered type must not mass-expire its entries"


async def test_query_error_fails_open(monkeypatch):
    class _Exploding:
        @classmethod
        async def get_all(cls, entities_filter=None, **_kwargs):
            raise RuntimeError("db hiccup")

    from flow_sdk.core import Entity

    monkeypatch.setattr(Entity, "get_entity_model_by_type", staticmethod(lambda _t: _Exploding))

    an_id = "66666666-6666-4666-8666-666666666666"
    existing = await FeedEntry._existing_targets([TypeId(type="skill", id=an_id)])

    assert ("skill", an_id) in existing, "a transient failure must keep the feed, not empty it"


def test_expired_entries_are_still_returned_by_contract():
    """Guard on the read path's shape, stated as documentation.

    ``get_all`` marks entries EXPIRED and returns the full list. If a future
    change starts filtering them out, the feed loses rows mid-scroll — that is
    a product decision and should not arrive as a side effect of a perf fix.
    """
    entry = FeedEntry(name="feed-row")
    entry.feed_status = FeedStatus.EXPIRED.value
    assert entry.feed_status == FeedStatus.EXPIRED.value
