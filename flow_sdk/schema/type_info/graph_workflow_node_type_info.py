"""Type metadata for GRAPH_WORKFLOW_NODE — flow-graph station (DB-only, no disk record)."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

GRAPH_WORKFLOW_NODE = TypeInfo(type_name=EntityType.GRAPH_WORKFLOW_NODE, api_visible=True, icon="Workflow")
