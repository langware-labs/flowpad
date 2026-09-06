"""Type metadata for ANNOTATION."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

ANNOTATION = TypeInfo(type_name=EntityType.ANNOTATION, api_visible=True)
