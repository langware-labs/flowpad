"""Type metadata for the DB-only WikiEntry binding."""

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

WIKI_ENTRY = TypeMetadata(
    type=EntityType.WIKI_ENTRY,
    icon="Link",
    displayName="Wiki Entries",
    api_visible=True,
)
