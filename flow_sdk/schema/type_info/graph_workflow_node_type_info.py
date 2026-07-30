"""Type metadata for GRAPH_WORKFLOW_NODE — flow-graph station (DB-only, no disk record)."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

GRAPH_WORKFLOW_NODE = TypeMetadata(type=EntityType.GRAPH_WORKFLOW_NODE, api_visible=True, icon="Workflow")
