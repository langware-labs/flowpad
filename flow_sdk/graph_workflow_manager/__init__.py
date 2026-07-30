"""GraphWorkflowManager — runs GraphWorkflow folder documents (graph.json).

Local events, explicit edges, per-run journals. See ``manager.py`` for the
runtime, ``graph_workflow_doc.py`` for the document model, ``graph_workflow_functions.py`` for the
GraphWorkflowFunction registry, ``function_runner.py`` for the subprocess runtime.
"""
from flow_sdk.graph_workflow_manager import graph_workflow_functions
from flow_sdk.graph_workflow_manager.envelope import EXTERNAL_SOURCE, RunEvent
from flow_sdk.graph_workflow_manager.graph_workflow_doc import (
    AGENT_DONE_EVENT,
    CATCH_ALL_EVENT,
    TRIGGER_FIRED_EVENT,
    GraphWorkflowConfig,
    GraphWorkflowDoc,
    GraphWorkflowEdgeDef,
    GraphWorkflowNodeDef,
    empty_graph_workflow_doc,
    parse_graph_workflow_doc,
)
from flow_sdk.graph_workflow_manager.manager import GraphWorkflowManager, get_graph_workflow_manager
from flow_sdk.graph_workflow_manager import demo_callbacks  # noqa: F401  registers flow_echo/flow_relay

__all__ = [
    "AGENT_DONE_EVENT",
    "CATCH_ALL_EVENT",
    "EXTERNAL_SOURCE",
    "TRIGGER_FIRED_EVENT",
    "GraphWorkflowConfig",
    "GraphWorkflowDoc",
    "GraphWorkflowEdgeDef",
    "RunEvent",
    "GraphWorkflowManager",
    "GraphWorkflowNodeDef",
    "empty_graph_workflow_doc",
    "graph_workflow_functions",
    "get_graph_workflow_manager",
    "parse_graph_workflow_doc",
]
