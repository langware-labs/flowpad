"""``SourceItemSpec`` is SOURCE_ITEM's ``asset_spec``: the one declaration of the
snapshot a driver emits and the medium persists."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.source_item import SourceItem, SourceItemSpec
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.db import DbSerializer
from flow_sdk.fs_store.serializer.fields import unwrap_annotation
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)

_HEADER = dict(data_source_id="ds", provider="rss", kind="content.feed.item", segment_key="k", external_id="x")


def test_every_spec_field_is_a_row_field_with_the_same_annotation():
    for name, field in SourceItemSpec.model_fields.items():
        assert name in SourceItem.model_fields, name
        # The row may widen a field to Optional (Entity declares `name` so); the core type is one.
        assert unwrap_annotation(SourceItem.model_fields[name].annotation) == unwrap_annotation(field.annotation), name


def test_the_spec_refuses_unknown_and_blank_header_fields():
    with pytest.raises(ValidationError, match="subject"):
        SourceItemSpec(**_HEADER, subject="nope")
    with pytest.raises(ValidationError, match="external_id"):
        SourceItemSpec(**{**_HEADER, "external_id": " "})
    spec = SourceItemSpec(**_HEADER, name="t")
    with pytest.raises(ValidationError):
        spec.name = "frozen"  # type: ignore[misc]


def test_the_spec_is_registered_under_its_kind():
    assert SchemaRegistry.kind_type("ingest.source_item") is SourceItemSpec


def test_derived_meta_model_is_header_plus_local_state():
    """The membership the old hand-written ``SourceItemMeta`` declared, derived:
    the header (incl. ``body`` — the FTS pin) ∪ ``content_digest/read/starred``."""
    info = SchemaRegistry.get(EntityType.SOURCE_ITEM)
    names = set(info.effective_meta_model.model_fields) - {"name", "id", "type"}
    expected = (set(SourceItemSpec.model_fields) - {"name", "raw"}) | {"content_digest", "read", "starred"}
    assert expected <= names, expected - names
    assert "raw" not in names, "raw is Persist.FALSE — never mirrored"


def test_raw_never_reaches_the_payload_but_every_header_field_reaches_the_row():
    full = dict(
        _HEADER, name="t", body="b", occurred_at="2026-01-01T00:00:00Z", author_external_id="a",
        author_display="A", permalink="https://x", thread_key="th", reply_to_external_id="r",
        segment_label="L", conversation_id="c", message_id="m", raw={"volatile": 1},
    )
    row = SourceItem(**full)
    assert "raw" not in row.metadata_payload()
    assert row.metadata_payload()["body"] == "b"
    data = DbSerializer().data(row)
    for name in SourceItemSpec.model_fields:
        assert name in data, name
