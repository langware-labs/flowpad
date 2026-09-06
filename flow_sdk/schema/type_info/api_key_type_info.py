"""Type metadata for API_KEY."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

API_KEY = TypeInfo(type_name=EntityType.API_KEY, api_visible=True)
