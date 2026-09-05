"""Type metadata for USER."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

USER = TypeInfo(type_name=EntityType.USER, icon="User", api_visible=True)
