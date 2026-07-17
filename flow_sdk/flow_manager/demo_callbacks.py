"""Built-in demo callback programs for flow-node prototyping (FlowStudio).

Registered on import (flow_manager/__init__ pulls this in), so a FlowNode with
``program_kind=callback`` can reference them immediately:

* ``flow_echo``  — log the event under the ``flow`` toplog topic. The no-op
  sink; wire it anywhere to see deliveries.
* ``flow_relay`` — emit a follow-on event, extending the chain. The topic is
  ``payload.relay_to`` (default ``flow.relayed``); the payload carries a hop
  counter. Wire a relay to listen on its own output to demo cycle refusal.
"""
from __future__ import annotations

import logging

from flow_sdk import toplog
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.flow_manager.envelope import TopicEvent

logger = logging.getLogger(__name__)


@trigger_callbacks.register("flow_echo", meaning="flow demo: log the delivered topic event")
def flow_echo(event: TopicEvent) -> None:
    logger.info("[flow_echo] %s payload=%s corr=%s depth=%s",
                event.topic, event.payload, event.correlation_id, event.depth)
    toplog.log("flow", "flow_echo %s depth=%s payload=%s", event.topic, event.depth, event.payload)


@trigger_callbacks.register("flow_relay", meaning="flow demo: re-emit payload.relay_to as a child event")
async def flow_relay(event: TopicEvent) -> None:
    from flow_sdk.flow_manager import get_flow_manager

    relay_to = str(event.payload.get("relay_to") or "flow.relayed")
    hops = int(event.payload.get("hops") or 0) + 1
    await get_flow_manager().emit(
        event.child(relay_to, {**event.payload, "hops": hops}, source="flow_relay")
    )
