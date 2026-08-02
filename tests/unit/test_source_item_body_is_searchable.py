"""SourceItem's body must reach FTS — the one-line omission that fails silently.

A ``Persist.DEFAULT`` field is mirrored to metadata.json only if its name is
declared in the type's ``meta_model``. That is not merely a disk concern: the
FTS row is written inside ``Entity._store()`` from ``FSRecord.search_content``,
which reads ``content``/``body`` off the record ``__dict__`` — and ``__dict__``
is populated by ``save_metadata`` from exactly that payload.

So dropping ``body`` from ``SourceItemMeta`` does not raise, does not warn, and
does not stop rows appearing. It just makes every ingested record invisible to a
full-text search while remaining findable by title — which is the kind of defect
that gets discovered months later by a user who assumes search is broken.

These tests pin both halves: the payload mechanism directly, and the
search-by-a-body-only-word behaviour it exists to produce.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.source_item import SourceItem


def _item(**kw) -> SourceItem:
    """A SourceItem whose id is derived, exactly as the ingestor mints it."""
    data_source_id = kw.pop("data_source_id", "ds-test")
    stream_key = kw.pop("stream_key", "stream-test")
    external_id = kw.pop("external_id", uuid.uuid4().hex)
    return SourceItem(
        id=SourceItem.allocate_deterministic_id(data_source_id, stream_key, external_id),
        data_source_id=data_source_id,
        stream_key=stream_key,
        external_id=external_id,
        kind="content.feed.item",
        provider="rss",
        **kw,
    )


def test_body_is_in_the_metadata_payload():
    """The mechanism, asserted directly — this is what carries body into FTS."""
    item = _item(name="a title", body="the searchable prose")
    payload = item.metadata_payload()

    assert payload.get("body") == "the searchable prose", (
        "body dropped out of metadata_payload — it is missing from SourceItemMeta, "
        "so the FTS row will be written with an empty content column"
    )
    # raw is Persist.FALSE: a DB column only, never on disk, never in FTS.
    item_with_raw = _item(name="t", body="b", raw={"secret": "provider payload"})
    assert "raw" not in item_with_raw.metadata_payload()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_word_only_in_the_body_is_searchable():
    # Unique per run so a leaked row from another test cannot satisfy the assert.
    needle = f"zqxbody{uuid.uuid4().hex[:10]}"

    item = _item(
        name="Quarterly update",          # deliberately does NOT contain the needle
        body=f"prelude {needle} postlude",
    )
    await item.save()

    hits = await SourceItem.search(needle, limit=10)
    assert any(getattr(h, "id", None) == item.id for h in hits), (
        f"{needle!r} appears only in body and was not found — the FTS content "
        "column is empty (check SourceItemMeta declares `body`)"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reingest_converges_on_one_row():
    """The derived id is the whole idempotency story — prove it survives a save."""
    external_id = f"ext-{uuid.uuid4().hex[:8]}"
    first = _item(external_id=external_id, name="v1", body="first body")
    await first.save()

    second = _item(external_id=external_id, name="v2", body="second body")
    assert second.id == first.id, "same (source, stream, external id) must derive the same id"
    await second.save()

    rows = await SourceItem.get_all({"external_id": external_id})
    assert len(rows) == 1, f"re-ingest created {len(rows)} rows; expected an in-place upsert"
    assert rows[0].name == "v2"
