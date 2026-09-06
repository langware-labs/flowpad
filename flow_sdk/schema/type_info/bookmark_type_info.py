"""Type metadata for BOOKMARK."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

BOOKMARK = TypeInfo(
    type_name=EntityType.BOOKMARK,
    icon="Bookmark",
    api_visible=True,
)
