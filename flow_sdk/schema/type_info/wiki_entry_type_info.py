"""Type metadata for the DB-only WikiEntry binding."""

from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

WIKI_ENTRY = TypeInfo(
    type_name=EntityType.WIKI_ENTRY,
    icon="Link",
    display_name="Wiki Entries",
    api_visible=True,
)
