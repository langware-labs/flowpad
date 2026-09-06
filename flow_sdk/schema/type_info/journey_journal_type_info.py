"""Type metadata for JOURNEY_JOURNAL — per-user journey progress (DB-only)."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

JOURNEY_JOURNAL = TypeInfo(type_name=EntityType.JOURNEY_JOURNAL, api_visible=True)
