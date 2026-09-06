"""Type metadata for TAG — a blessed dot-taxonomy tag name. DB-first,
row-only entity (the taxonomy graph is derived from dot-paths, never stored);
the record persists name + description so blessings survive an index rebuild.
Anonymous (un-blessed) tags need no row at all — see flow_sdk/builtin/tag.py."""

from typing import Optional

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class TagMeta(BaseMeta):
    title: Optional[str] = None
    description: Optional[str] = None
    alias_of: Optional[str] = None
    deprecated: Optional[bool] = None
    system: Optional[bool] = None


TAG = TypeInfo(
    type_name=EntityType.TAG,
    icon="Hash",
    display_name="Tags",
    # Dev-gated browse surface: blessed tags ride the generic Assets browser
    # (max reuse); the observed/anonymous gardening merge is a later slice.
    browseable_by=ViewMode.DEV,
    api_visible=True,
    indexed_by_default=False,
    creatable=False,
    index_fields=["name"],
    meta_model=TagMeta,
)
