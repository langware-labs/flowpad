"""Retired persisted ARTIFACT_RELATION compatibility metadata."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

ARTIFACT_RELATION = TypeInfo(type_name=EntityType.ARTIFACT_RELATION, api_visible=False)
