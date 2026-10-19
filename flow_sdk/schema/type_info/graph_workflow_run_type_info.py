"""Type metadata for GRAPH_WORKFLOW_RUN — run bookkeeping row (trace on disk)."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

GRAPH_WORKFLOW_RUN = TypeInfo(type_name=EntityType.GRAPH_WORKFLOW_RUN, api_visible=True, icon="Play")
