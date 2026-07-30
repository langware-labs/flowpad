"""GraphWorkflowNode — derived record-keeping row for a node inside an GraphWorkflow.

The SOURCE OF TRUTH for nodes is the flow's ``graph.json`` (see
``flow_sdk/graph_workflow_manager/graph_workflow_doc.py``); routing never reads these rows.
The indexer syncs one row per agent/function node, attached as a CHILD
of the GraphWorkflow — so ownership, cleanup, and "which flows use skill X"
queries work through the ordinary entity graph.

DB-only entity (no ``asset_ref``).
"""
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

# Model size → CLI model alias for spawned agent executions. Size names (not
# model ids) so the mapping can evolve without touching stored flows.
MODEL_SIZE_TO_CLI = {
    "sm": "haiku",
    "md": "sonnet",
    "lg": "opus",
}


class GraphWorkflowNode(Entity):
    type: str = APIField(default=EntityType.GRAPH_WORKFLOW_NODE.value)
    name: str = APIField(default="")
    flow_id: str = APIField(default="", description="The GraphWorkflow this node belongs to.")
    node_type: str = APIField(default="function", description="trigger | agent | function")
    program_ref: Optional[str] = APIField(None, description="Program summary for querying (e.g. skill name).")
    enabled: bool = APIField(default=True)

    _api_visible: ClassVar[bool] = True
