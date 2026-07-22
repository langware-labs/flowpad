"""Type metadata for TOPIC — a blessed dot-taxonomy topic name. DB-first,
row-only entity (the taxonomy graph is derived from dot-paths, never stored);
the record persists name + description so blessings survive an index rebuild.
Anonymous (un-blessed) topics need no row at all — see flow_sdk/builtin/topic.py."""

from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class TopicMeta(BaseMeta):
    title: Optional[str] = None
    description: Optional[str] = None
    alias_of: Optional[str] = None
    deprecated: Optional[bool] = None
    system: Optional[bool] = None


TOPIC = TypeMetadata(
    type=EntityType.TOPIC,
    icon="Hash",
    displayName="Topics",
    # Dev-gated browse surface: blessed topics ride the generic Assets browser
    # (max reuse); the observed/anonymous gardening merge is a later slice.
    browseable_by=ViewMode.DEV,
    api_visible=True,
    indexed_by_default=False,
    creatable=False,
    index_fields=["name"],
    meta_model=TopicMeta,
)
