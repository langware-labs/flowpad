"""Type metadata for DATA_SOURCE and DATA_SOURCE_CURSOR.

**DataSource is Tier B** — no placement fields, so the indexer can never reach
it, but not ``db_only`` either: a configured source should be findable in search,
and the metadata.json shadow is a forensic trail of a sync config.

**DataSourceCursor is Tier C (``db_only``)** — it is written on every poll of
every stream. Giving it a disk mirror would mean a filesystem write per stream
per minute forever, for state no human reads and no search should return.
"""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata, ViewMode
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class DataSourceMeta(BaseMeta):
    kind: Optional[str] = None
    provider: Optional[str] = None
    account_key: Optional[str] = None
    config: Optional[dict] = None
    enabled: Optional[bool] = None
    poll_interval_seconds: Optional[int] = None
    window_days: Optional[int] = None
    required_capabilities: Optional[list] = None
    health: Optional[str] = None


DATA_SOURCE = TypeMetadata(
    type=EntityType.DATA_SOURCE,
    icon="Antenna",
    displayName="Data sources",
    api_visible=True,
    creatable=True,
    # Surfaced through the existing Assets browser rather than a bespoke screen:
    # the row already carries everything a management view needs (health,
    # next_poll_at, error_detail) and reaches the UI through ordinary entity CRUD.
    browseable_by=ViewMode.ADVANCED,
    index_fields=["name", "provider", "kind", "health"],
    meta_model=DataSourceMeta,
)

DATA_SOURCE_CURSOR = TypeMetadata(
    type=EntityType.DATA_SOURCE_CURSOR,
    icon="Bookmark",
    api_visible=True,
    db_only=True,
)
