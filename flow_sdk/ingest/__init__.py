"""Cloud-data ingestion — the indexer's analogue for records that live remotely.

Where the filesystem indexer walks roots and turns files into entities, this
subsystem polls remote systems of record and turns their items into entities:

    DataSource → cursor (since last pull) → driver → ingest_item
               → SourceItem written + indexed → FlowEvent → triggers/flows

``ingest_item`` is the single chokepoint; drivers only produce ``SourceItemSpec``s
(``flow_sdk/builtin/source_item.py`` — the row's ``header``).
"""
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.digest import content_digest
from flow_sdk.ingest.ingestor import ingest_item, ingest_items
from flow_sdk.ingest.models import (
    IngestMode,
    IngestOutcome,
    IngestReport,
)

__all__ = [
    "IngestMode",
    "IngestOutcome",
    "IngestReport",
    "SourceItemSpec",
    "content_digest",
    "ingest_item",
    "ingest_items",
]
