"""Type metadata for JOURNEY_JOURNAL — per-user journey progress (DB-only)."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

JOURNEY_JOURNAL = TypeMetadata(type=EntityType.JOURNEY_JOURNAL, api_visible=True)
