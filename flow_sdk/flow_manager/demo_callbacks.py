"""Built-in demo FlowFunctions for flow prototyping.

Registered on import (flow_manager/__init__ pulls this in). A function's dict
return auto-emits its ``done`` event, so these compose with edges without any
emit plumbing:

* ``flow_echo``  — log the delivered event; returns the data unchanged.
* ``flow_relay`` — returns the data with a hop counter (wire its ``done`` edge
  onward to build multi-hop demo chains).
"""
from __future__ import annotations

import logging
from typing import Any

from flow_sdk import toplog
from flow_sdk.flow_manager import flow_functions

logger = logging.getLogger(__name__)


@flow_functions.register("flow_echo", meaning="flow demo: log the delivered event")
def flow_echo(event_name: str, data: dict, flow_ctx: Any) -> dict:
    logger.info("[flow_echo] %s data=%s run=%s", event_name, data, flow_ctx.execution_id)
    toplog.log("flow", "flow_echo %s data=%s", event_name, data)
    return dict(data)


@flow_functions.register("flow_relay", meaning="flow demo: pass data onward with a hop counter")
def flow_relay(event_name: str, data: dict, flow_ctx: Any) -> dict:
    hops = int(data.get("hops") or 0) + 1
    return {**data, "hops": hops}
