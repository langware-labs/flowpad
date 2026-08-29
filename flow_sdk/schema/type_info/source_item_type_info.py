"""Type metadata for SOURCE_ITEM — an ingested cloud record.

**Row-only, and searchable.** ``db_only``: ingestion never walks the filesystem,
never contends with the indexer's SQLite writer, and writes NO ``metadata.json``
shadow — the DB row is the record. ``fts_content=("body",)`` keeps ingested
content searchable: ``Entity.save`` feeds FTS from the row (``FtsEntry.from_entity``).
``tests/unit/test_source_item_body_is_searchable.py`` pins that a word present
only in ``body`` is found.
"""
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.digest import DIGESTED_FIELDS
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

SOURCE_ITEM = TypeMetadata(
    type=EntityType.SOURCE_ITEM,
    icon="Rss",
    api_visible=True,
    # Minted by the ingestor from a provider payload, never from a "new entity"
    # button — there is nothing meaningful to create by hand.
    creatable=False,
    index_fields=["name", "provider", "data_source_id", "segment_key", "occurred_at"],
    # Row-only: the DB IS the record — no metadata.json shadow per ingested item.
    # Searchable all the same: ``body`` is fed to FTS straight from the row.
    db_only=True,
    fts_content=("body",),
    asset_spec=SourceItemSpec,
    # The DB medium's identity and no-op policy: a re-poll resolves the row by
    # its natural key and is silent when the digested fields are unchanged.
    natural_key=("data_source_id", "segment_key", "external_id"),
    digest_fields=DIGESTED_FIELDS,
)
