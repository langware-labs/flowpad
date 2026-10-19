"""Type metadata for WORKSPACE."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

WORKSPACE = TypeInfo(type_name=EntityType.WORKSPACE, icon="Users", api_visible=True)
