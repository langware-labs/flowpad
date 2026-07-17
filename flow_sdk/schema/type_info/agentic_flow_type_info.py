"""Type metadata for AGENTIC_FLOW — flow boundary + policy (DB-only, no disk record)."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

AGENTIC_FLOW = TypeMetadata(type=EntityType.AGENTIC_FLOW, api_visible=True, icon="Network")
