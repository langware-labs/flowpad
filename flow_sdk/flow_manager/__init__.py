"""FlowManager — runs AgenticFlow folder documents (graph.json).

Local events, explicit edges, per-run journals. See ``manager.py`` for the
runtime, ``flow_doc.py`` for the document model, ``pysdk_runner.py`` for the
python-node contract.
"""
from flow_sdk.flow_manager.envelope import EXTERNAL_SOURCE, FlowEvent
from flow_sdk.flow_manager.flow_doc import (
    AGENT_DONE_EVENT,
    CATCH_ALL_EVENT,
    TRIGGER_FIRED_EVENT,
    FlowDoc,
    FlowEdgeDef,
    FlowNodeDef,
    empty_flow_doc,
    parse_flow_doc,
)
from flow_sdk.flow_manager.manager import FlowManager, get_flow_manager
from flow_sdk.flow_manager import demo_callbacks  # noqa: F401  registers flow_echo/flow_relay

__all__ = [
    "AGENT_DONE_EVENT",
    "CATCH_ALL_EVENT",
    "EXTERNAL_SOURCE",
    "TRIGGER_FIRED_EVENT",
    "FlowDoc",
    "FlowEdgeDef",
    "FlowEvent",
    "FlowManager",
    "FlowNodeDef",
    "empty_flow_doc",
    "get_flow_manager",
    "parse_flow_doc",
]
