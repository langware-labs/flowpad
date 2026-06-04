"""Type metadata for BOOKMARK."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

BOOKMARK = TypeMetadata(
    type=EntityType.BOOKMARK,
    icon="Bookmark",
    api_visible=True,
)
