"""Type metadata for TOPIC — flow-graph channel (DB-only, no disk record)."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

TOPIC = TypeMetadata(type=EntityType.TOPIC, api_visible=True, icon="Radio")
