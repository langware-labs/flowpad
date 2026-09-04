"""Type metadata for DATA_SOURCE and DATA_SOURCE_CURSOR.

**DataSource is Tier B** — no placement fields, so the indexer can never reach
it, but not ``db_only`` either: a configured source should be findable in search,
and the metadata.json shadow is a forensic trail of a sync config.

**DataSourceCursor is Tier C (``db_only``)** — it is written on every poll of
every stream. Giving it a disk mirror would mean a filesystem write per stream
per minute forever, for state no human reads and no search should return.
"""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
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


DATA_SOURCE = TypeMetadata(
    type=EntityType.DATA_SOURCE,
    icon="Antenna",
    displayName="Data sources",
    api_visible=True,
    creatable=True,
    # Deliberately NOT browseable: the dedicated `/dock/data-sources` screen is
    # the surface now. This used to say the opposite — that the Assets browser
    # was enough, since the row already carries health/next_poll_at/error_detail
    # — but operating a source needs verbs (poll, replay, enable, delete) that a
    # generic type browser has nowhere to put. Leaving `browseable_by` set would
    # give the type two doors, which is the drift the old note was guarding
    # against, just in the other direction. `creatable` stays — it is the "offer
    # a New button" affordance hint, not an authorization flag (see
    # `_uncreatable_reason`), and the dialog creates through the ordinary
    # generic create route either way.
    index_fields=["name", "provider", "kind", "status", "health"],
    meta_model=DataSourceMeta,
)

DATA_SOURCE_CURSOR = TypeMetadata(
    type=EntityType.DATA_SOURCE_CURSOR,
    icon="Bookmark",
    api_visible=True,
    db_only=True,
)

# The consumer-side cursor: same shape, same reasons, one level up.
CONSUMER_POSITION = TypeMetadata(
    type=EntityType.CONSUMER_POSITION,
    icon="Bookmark",
    api_visible=True,
    db_only=True,
)

# The change log an object-shaped source leaves behind each reflected page.
SOURCE_CHANGE = TypeMetadata(
    type=EntityType.SOURCE_CHANGE,
    icon="FileDiff",
    api_visible=True,
    db_only=True,
)
