"""Type metadata for the DB-only Wiki namespace."""

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

WIKI = TypeInfo(
    type_name=EntityType.WIKI,
    icon="BookOpen",
    display_name="Wikis",
    api_visible=True,
)
