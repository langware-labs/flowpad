"""FlowManager — the flow-graph orchestrator.

Ingests topic events at a single choke point (:func:`emit`), resolves listener
FlowNodes by prefix (ancestor walk over the topic name), enforces per-chain
loop budgets, dispatches each listener's program (callback / spawned agent /
injected prompt), stamps observed ``Emits`` edges, journals every event, and
broadcasts it over WS.

Deliberately NOT under the legacy ``flow_sdk/core/flow`` package — that is the
old request pipeline; this is the fresh flow-graph definition.
"""
from flow_sdk.flow_manager.envelope import TopicEvent
from flow_sdk.flow_manager.manager import FlowManager, get_flow_manager
from flow_sdk.flow_manager.matcher import topic_ancestors, topic_matches
from flow_sdk.flow_manager import demo_callbacks  # noqa: F401  registers flow_echo/flow_relay

__all__ = [
    "TopicEvent",
    "FlowManager",
    "get_flow_manager",
    "topic_ancestors",
    "topic_matches",
]
