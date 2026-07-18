"""Type metadata for FLOW_NODE — flow-graph station (DB-only, no disk record)."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

FLOW_NODE = TypeMetadata(type=EntityType.FLOW_NODE, api_visible=True, icon="Workflow")
