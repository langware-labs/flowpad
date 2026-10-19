"""Type metadata for TEAM."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

TEAM = TypeInfo(type_name=EntityType.TEAM, icon="Users", api_visible=True)
