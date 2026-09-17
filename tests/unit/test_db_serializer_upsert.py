"""The DB medium's identity (natural key) and no-op (digest) live on the
serializer, declared once on the type."""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.db import DbSerializer
from flow_sdk.ingest import ingest_items
from flow_sdk.ingest.digest import DIGESTED_FIELDS, content_digest
from flow_sdk.ingest.legacy_lift import lift
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.sources import CloudOrigin


def _spec(namespace="feed", **kw) -> SourceItemSpec:
    base = dict(data_source_id="ds", provider="rss", kind="content.feed.item",
                external_id="x1", name="t", body="b")
    base.update(kw)
    base.setdefault("origin", CloudOrigin(kind="rss", namespace=namespace, key=base["external_id"]))
    return lift(None, SourceItemSpec(**base))


def test_source_item_declares_its_db_identity_and_gate():
    info = SchemaRegistry.get(EntityType.SOURCE_ITEM)
    assert info.natural_key == ("data_source_id", "origin_kind", "origin_namespace", "origin_key")
    assert info.digest_fields == DIGESTED_FIELDS
    assert info.db_only and info.default_origin_kind == "db" and info.fts_content == ("body",), "row-only: no shadow, FTS from the row"
    assert isinstance(info.serializer(), DbSerializer)


def test_upsert_is_pure_and_keeps_local_state():
    ser = DbSerializer()
    row, status = ser.upsert(SourceItem, _spec())
    assert status == "created" and row.content_digest == content_digest(_spec())
    row.read = True
    same, status = ser.upsert(SourceItem, _spec(raw={"volatile": 1}), existing=row)
    assert (same, status) == (None, "unchanged"), "raw is outside the digest"
    moved, status = ser.upsert(SourceItem, _spec(body="b2"), existing=row)
    assert status == "updated" and moved is row and moved.body == "b2" and moved.read is True


def test_natural_key_reads_the_same_on_spec_and_row():
    ser = DbSerializer()
    assert ser.natural_key_of(SourceItem, _spec()) == ("ds", "rss", "feed", "x1")
    assert ser.natural_key_of(SourceItem, SourceItem(**_spec().model_dump())) == ("ds", "rss", "feed", "x1")


def test_upsert_writes_the_key_it_resolves_by():
    """The triple is a property on the spec and a column on the row: upsert must copy it,
    or a created row could never be found again."""
    row, _ = DbSerializer().upsert(SourceItem, _spec())
    assert (row.origin_kind, row.origin_namespace, row.origin_key) == ("rss", "feed", "x1")
    assert row.origin == _spec().origin and row.data is not None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_resolve_many_keys_by_the_full_tuple():
    """An external id is only unique within its origin namespace (a Slack ts repeats
    across channels): two namespaces, one id, two rows — never one."""
    ds = f"ds-{uuid.uuid4().hex[:8]}"
    a = _spec(namespace="C1", data_source_id=ds, external_id="17")
    b = _spec(namespace="C2", data_source_id=ds, external_id="17")
    await ingest_items([a, b])
    known = await DbSerializer().resolve_many(SourceItem, [a, b])
    assert set(known) == {(ds, "rss", "C1", "17"), (ds, "rss", "C2", "17")}
    assert known[(ds, "rss", "C1", "17")].id != known[(ds, "rss", "C2", "17")].id
    assert await SourceItem.find_existing(ds, b.origin) is not None
    assert await SourceItem.find_existing(ds, b.origin.model_copy(update={"namespace": "C3"})) is None
