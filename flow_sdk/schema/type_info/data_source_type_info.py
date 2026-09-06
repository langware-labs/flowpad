"""Type metadata for DATA_SOURCE and DATA_SOURCE_CURSOR.

**DataSource is Tier B** — no placement fields, so the indexer can never reach
it, but not ``db_only`` either: a configured source should be findable in search,
and the metadata.json shadow is a forensic trail of a sync config.

**DataSourceCursor is Tier C (``db_only``)** — it is written on every poll of
every stream. Giving it a disk mirror would mean a filesystem write per stream
per minute forever, for state no human reads and no search should return.
"""
from typing import Optional

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class DataSourceMeta(BaseMeta):
    kind: Optional[str] = None
    provider: Optional[str] = None
    channel: Optional[str] = None
    account_key: Optional[str] = None
    account_identities: Optional[list] = None
    config: Optional[dict] = None
    status: Optional[str] = None
    poll_interval_seconds: Optional[int] = None
    window_days: Optional[int] = None
    segment_count: Optional[int] = None
    required_capabilities: Optional[list] = None
    health: Optional[str] = None


DATA_SOURCE = TypeInfo(
    type_name=EntityType.DATA_SOURCE,
    icon="Antenna",
    display_name="Data sources",
    api_visible=True,
    creatable=True,
    # Deliberately NOT browseable: the dedicated `/dock/data-sources` screen is
    # the one surface — operating a source needs verbs (poll, replay, enable,
    # delete) a generic type browser has nowhere to put. `creatable` stays: it
    # is the "offer a New button" hint, not an authorization flag (see
    # `_uncreatable_reason`).
    index_fields=["name", "provider", "kind", "status", "health"],
    meta_model=DataSourceMeta,
)

DATA_SOURCE_CURSOR = TypeInfo(
    type_name=EntityType.DATA_SOURCE_CURSOR,
    icon="Bookmark",
    api_visible=True,
    db_only=True,
)

# The consumer-side cursor: same shape, same reasons, one level up.
CONSUMER_POSITION = TypeInfo(
    type_name=EntityType.CONSUMER_POSITION,
    icon="Bookmark",
    api_visible=True,
    db_only=True,
)

# The change log an object-shaped source leaves behind each reflected page.
SOURCE_CHANGE = TypeInfo(
    type_name=EntityType.SOURCE_CHANGE,
    icon="FileDiff",
    api_visible=True,
    db_only=True,
)
