"""Cloud-data ingestion — the indexer's analogue for records that live remotely.

Where the filesystem indexer walks roots and turns files into entities, this
subsystem polls remote systems of record and turns their items into entities:

    DataSource → cursor (since last pull) → driver → ingest_item
               → SourceItem written + indexed → FlowEvent → triggers/flows

``ingest_item`` is the single chokepoint; drivers only produce ``IngestItem``s.
"""
from flow_sdk.ingest.digest import content_digest
from flow_sdk.ingest.ingestor import ingest_item, ingest_items
from flow_sdk.ingest.models import (
    IngestItem,
    IngestMode,
    IngestOutcome,
    IngestReport,
)

__all__ = [
    "IngestItem",
    "IngestMode",
    "IngestOutcome",
    "IngestReport",
    "content_digest",
    "ingest_item",
    "ingest_items",
]
