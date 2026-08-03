"""Type metadata for SOURCE_ITEM — an ingested cloud record.

**Tier B, deliberately.** No placement fields, so the type is unreachable from
the indexer's roots by construction: ingestion never walks the filesystem and
never contends with the indexer's SQLite writer. But it is not ``db_only``
either — a Tier C type gets no FTS row at all, and ingested content being
searchable is the entire point.

**Why ``body`` is in the metadata model.** A ``Persist.DEFAULT`` field reaches
metadata.json only if its name appears here. That matters beyond disk: the FTS
row is written inside ``Entity._store()`` from ``FSRecord.search_content``,
which reads ``content``/``body`` off the record ``__dict__`` — and ``__dict__``
is populated by ``save_metadata`` from exactly this payload. Drop ``body`` from
this model and every ingested record still indexes, silently, with an empty
body: matchable by title, invisible to a full-text search. ``tests/unit/
test_source_item_body_is_searchable.py`` exists to catch that regression.
"""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class SourceItemMeta(BaseMeta):
    # Envelope. Mirrored to metadata.json for inspection and for the FTS chain
    # below — NOT a recovery path: like every Tier B type, this one has no
    # `from_disk_fn`, so nothing reads these files back into the DB.
    kind: Optional[str] = None
    provider: Optional[str] = None
    data_source_id: Optional[str] = None
    stream_key: Optional[str] = None
    stream_label: Optional[str] = None
    external_id: Optional[str] = None
    thread_key: Optional[str] = None
    reply_to_external_id: Optional[str] = None
    permalink: Optional[str] = None
    occurred_at: Optional[str] = None
    author_external_id: Optional[str] = None
    author_display: Optional[str] = None
    # The searchable payload — see the module docstring before removing.
    body: Optional[str] = None
    content_digest: Optional[str] = None
    # Local state. On disk because it is OURS, not the provider's: a re-ingest
    # must not be able to mark a read item unread.
    read: Optional[bool] = None
    starred: Optional[bool] = None


SOURCE_ITEM = TypeMetadata(
    type=EntityType.SOURCE_ITEM,
    icon="Rss",
    api_visible=True,
    # Minted by the ingestor from a provider payload, never from a "new entity"
    # button — there is nothing meaningful to create by hand.
    creatable=False,
    index_fields=["name", "provider", "data_source_id", "stream_key", "occurred_at"],
    meta_model=SourceItemMeta,
)
