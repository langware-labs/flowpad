"""Built-in demo callback programs for flow prototyping.

Registered on import (flow_manager/__init__ pulls this in). A callback node's
dict return value becomes its ``done`` event payload, so these compose with
edges without any emit plumbing:

* ``flow_echo``  — log the delivered event; returns the data unchanged.
* ``flow_relay`` — returns the data with a hop counter (wire its ``done`` edge
  onward to build multi-hop demo chains).
"""
from __future__ import annotations

import logging

from flow_sdk import toplog
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.flow_manager.envelope import FlowEvent

logger = logging.getLogger(__name__)


@trigger_callbacks.register("flow_echo", meaning="flow demo: log the delivered event")
def flow_echo(event: FlowEvent) -> dict:
    logger.info("[flow_echo] %s data=%s run=%s", event.event, event.data, event.execution_id)
    toplog.log("flow", "flow_echo %s data=%s", event.event, event.data)
    return dict(event.data)


@trigger_callbacks.register("flow_relay", meaning="flow demo: pass data onward with a hop counter")
def flow_relay(event: FlowEvent) -> dict:
    hops = int(event.data.get("hops") or 0) + 1
    return {**event.data, "hops": hops}
