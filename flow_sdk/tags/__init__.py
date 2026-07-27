"""Tags — the unified event bus (backend half).

``FlowEvent`` is the consolidating envelope name for a standard event anywhere
in the system; the bus carries it, adapters emit it, subscribers consume it.
See docs/flow-events.md (delivery worklog) and docs/tags.md (language).

Naming rule: anything with ``tag`` in its name is the unified system;
``event``/``message``/``op`` elsewhere is legacy.
"""
from flow_sdk.tags.bus import (
    FixedWindowStormGuard,
    TagEventBus,
    emit_tag,
    event_bus,
    on_tag,
    validate_bus_pattern,
)
from flow_sdk.tags.envelope import FlowEvent, FlowEventCtx, target_of

__all__ = [
    "FlowEvent",
    "FlowEventCtx",
    "FixedWindowStormGuard",
    "TagEventBus",
    "validate_bus_pattern",
    "target_of",
    "emit_tag",
    "event_bus",
    "on_tag",
]
