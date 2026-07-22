"""Topics — the unified event bus (backend half).

``FlowEvent`` is the consolidating envelope name for a standard event anywhere
in the system; the bus carries it, adapters emit it, subscribers consume it.
See docs/flow-events.md (delivery worklog) and docs/topics.md (language).

Naming rule: anything with ``topic`` in its name is the unified system;
``event``/``message``/``op`` elsewhere is legacy.
"""
from flow_sdk.topics.bus import (
    FixedWindowStormGuard,
    TopicEventBus,
    emit_topic,
    event_bus,
    on_topic,
    validate_bus_pattern,
)
from flow_sdk.topics.envelope import FlowEvent, FlowEventCtx, target_of

__all__ = [
    "FlowEvent",
    "FlowEventCtx",
    "FixedWindowStormGuard",
    "TopicEventBus",
    "validate_bus_pattern",
    "target_of",
    "emit_topic",
    "event_bus",
    "on_topic",
]
