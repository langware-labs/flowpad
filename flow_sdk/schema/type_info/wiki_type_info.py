"""Type metadata for the DB-only Wiki namespace."""

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

WIKI = TypeMetadata(
    type=EntityType.WIKI,
    icon="BookOpen",
    displayName="Wikis",
    api_visible=True,
)
