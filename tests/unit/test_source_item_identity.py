"""A stored item's identity is ``(data_source_id, item_scope, item_key)`` and its digest is over
the payload — and rows written before either moved still resolve and stay silent.

``item_scope`` is the account-free scope a source narrows its ids by (``scope_of``): the escaped
join of its ``within`` parts, so a feed url keeps its slashes inside one part and the account
never joins identity.
"""
from __future__ import annotations

import uuid
from typing import ClassVar, Optional

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.envelope_lift import envelope_of
from flow_sdk.ingest.ingestor import ingest_item, ingest_items
from flow_sdk.server.routes.ingest import _is_typed, _typed_item
from flow_sdk.sources.base import Scope, scope_in, scope_of, scope_parts
from flow_sdk.sources.values.items import MessageData, RecordData, SourceItemSpec as Item
from flow_sdk.sources.values.origin import CloudOrigin


# ── the scope ─────────────────────────────────────────────────────────────────


def test_scope_escapes_slash_and_percent_inside_a_part():
    assert scope_of("https://x.io/feed?a=1%2") == "https:%2F%2Fx.io%2Ffeed?a=1%252"
    assert scope_of("tasks", "t-1") == "tasks/t-1"
    assert scope_of("team/chan") == "team%2Fchan"
    assert scope_of() == "" and scope_of("", "c") == "c"
    for parts in (("https://x.io/feed",), ("tasks", "t-1"), ("a%2Fb", "c/d")):
        assert scope_parts(scope_of(*parts)) == list(parts)


def test_a_scope_minted_origin_carries_its_scope_and_the_account_is_not_in_it():
    origin = Scope("rss", "me@x.io").origin("k1", "https://x.io/feed")
    assert origin.namespace == "me@x.io/https://x.io/feed", "the origin itself is unchanged"
    assert scope_in(origin) == "https:%2F%2Fx.io%2Ffeed"
    assert scope_in(origin.model_copy(update={"url": "https://x.io/1"})) == "https:%2F%2Fx.io%2Ffeed"
    assert "_scope" not in origin.model_dump() and origin == CloudOrigin(kind="rss", namespace=origin.namespace, key="k1")
    other_account = Scope("rss", "you@x.io").origin("k1", "https://x.io/feed")
    assert scope_in(other_account) == scope_in(origin), "an account change keeps the item's scope"


def test_a_scope_is_recovered_from_a_namespace_that_lost_it():
    lost = CloudOrigin(kind="rss", namespace="me@x.io/https://x.io/feed", key="k1")
    assert scope_in(lost, "me@x.io") == "https:%2F%2Fx.io%2Ffeed"
    assert scope_in(CloudOrigin(kind="rss", namespace="me@x.io", key="k"), "me@x.io") == ""
    assert scope_in(CloudOrigin(kind="rss", namespace="rss", key="k")) == "", "an account-less flat lift"


# ── identity + digest ─────────────────────────────────────────────────────────


class _Deal(RecordData):
    spec_kind: ClassVar[str] = "unittest.identity.deal"
    digest_exclude: ClassVar[frozenset[str]] = frozenset({"raw", "views"})

    stage: Optional[str] = None
    views: int = 0
    raw: Optional[dict] = None


def _envelope(ds: str, key: str, data, *, account: str = "me@x.io", within=("pipeline/1",)):
    origin = Scope("crm", account).origin(key, *within)
    return envelope_of(Item(origin=origin, data=data), data_source_id=ds, provider="crm")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_same_item_twice_is_one_row_and_the_second_write_is_a_no_op():
    ds = f"ds-{uuid.uuid4().hex[:8]}"
    first = await ingest_item(_envelope(ds, "d1", _Deal(title="Acme", stage="open")))
    again = await ingest_item(_envelope(ds, "d1", _Deal(title="Acme", stage="open")))
    assert (first.status, again.status) == ("created", "unchanged")
    rows = await SourceItem.get_all({"data_source_id": ds})
    assert len(rows) == 1
    row = rows[0]
    assert (row.item_scope, row.item_key) == ("pipeline%2F1", "d1")
    assert isinstance(row.payload, _Deal) and row.data is row.payload
    assert row.name == "Acme", "the flat header is still written for the readers that have not moved"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_account_change_converges_on_the_same_row():
    ds = f"ds-{uuid.uuid4().hex[:8]}"
    await ingest_item(_envelope(ds, "d1", _Deal(title="Acme"), account="old@x.io"))
    moved = await ingest_item(_envelope(ds, "d1", _Deal(title="Acme"), account="new@x.io"))
    assert moved.status == "unchanged"
    assert len(await SourceItem.get_all({"data_source_id": ds})) == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_digest_is_over_the_payload_minus_digest_exclude():
    ds = f"ds-{uuid.uuid4().hex[:8]}"
    await ingest_item(_envelope(ds, "d1", _Deal(title="Acme", stage="open", views=1, raw={"a": 1})))
    quiet = await ingest_item(_envelope(ds, "d1", _Deal(title="Acme", stage="open", views=99, raw={"a": 2})))
    assert quiet.status == "unchanged", "an excluded field moved the digest"
    moved = await ingest_item(_envelope(ds, "d1", _Deal(title="Acme", stage="won")))
    assert moved.status == "updated"
    # A message field the old header digest never saw (its refs) is content now.
    m1 = await ingest_item(_envelope(ds, "m1", MessageData(text="hi")))
    m2 = await ingest_item(_envelope(ds, "m1", MessageData(text="hi", refs=("task-1",))))
    assert (m1.status, m2.status) == ("created", "updated")


# ── rows written before the move ──────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_old_row_resolves_by_the_legacy_key_and_stays_silent():
    """A row from before: no item_scope/item_key/payload, the header digest. Re-delivered
    unchanged it is found (one row) and NOT rewritten; changed, it is upgraded in place."""
    from flow_sdk.fs_store.serializer.db import hash_view

    ds = f"ds-{uuid.uuid4().hex[:8]}"
    spec = _envelope(ds, "d1", _Deal(title="Acme", stage="open"))
    old = SourceItem(
        data_source_id=ds, provider="crm", kind=spec.kind, external_id="d1", name="Acme",
        origin=spec.origin, content_digest=hash_view(spec.legacy_digest_view()), read=True,
    )
    await old.save()
    assert (old.item_scope, old.item_key, old.payload) == ("", "", None)

    assert (await SourceItem.find_existing(ds, spec.origin)).id == old.id
    same = await ingest_item(spec)
    assert (same.status, same.entity_id) == ("unchanged", old.id)
    assert (await SourceItem.get_one({"id": old.id})).item_key == "", "an unchanged old row is not rewritten"
    assert (await ingest_items([spec])).outcomes[0].status == "unchanged", "the batched read falls back too"

    changed = await ingest_item(_envelope(ds, "d1", _Deal(title="Acme", stage="won")))
    assert (changed.status, changed.entity_id) == ("updated", old.id)
    row = await SourceItem.get_one({"id": old.id})
    assert (row.item_scope, row.item_key, row.payload.stage, row.read) == ("pipeline%2F1", "d1", "won", True)
    assert len(await SourceItem.get_all({"data_source_id": ds})) == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_payload_reads_the_stored_value():
    row = SourceItem.model_validate({"data": {"spec_kind": "ingest.message", "text": "a"}})
    assert row.payload.text == "a" and row.data is row.payload
    assert "data" in row.model_dump(mode="json"), "user-authored paths (data.stage) keep resolving"


# ── the typed write route ─────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_typed_ingest_shape_converges_with_the_driver_path():
    src = DataSource(provider="rss", account_key=f"acct-{uuid.uuid4().hex[:8]}", name=f"Feed {uuid.uuid4().hex[:8]}",
                     config={"feed_url": "http://127.0.0.1:1/feed"})
    await src.save()
    wire = {"data_source_id": src.id, "scope": scope_of("https://x.io/feed"), "key": "e1",
            "payload": {"spec_kind": "ingest.feed.item", "title": "Hello", "text": "body"}}
    assert _is_typed(wire) and not _is_typed({"external_id": "x", "key": "k", "payload": {}})
    envelope = await _typed_item(wire, {})
    assert (envelope.item_scope, envelope.item_key, envelope.name, envelope.provider) == (
        "https:%2F%2Fx.io%2Ffeed", "e1", "Hello", "rss")
    assert envelope.origin.namespace == f"{src.account_key}/https://x.io/feed", "the origin a driver would mint"
    assert (await ingest_item(envelope)).status == "created"
    driver = envelope_of(Item(origin=Scope(envelope.origin.kind, src.account_key).origin("e1", "https://x.io/feed"),
                              data=envelope.payload), data_source_id=src.id, provider="rss")
    assert (await ingest_item(driver)).status == "unchanged"
    with pytest.raises(ValueError, match="unknown keys"):
        await _typed_item({**wire, "name": "x"}, {})
    with pytest.raises(ValueError):
        await _typed_item({**wire, "payload": {"spec_kind": "ingest.feed.item", "nope": 1}}, {})
