"""Cloud client package — all cloud HTTP + WebSocket communication lives here.

Two transports talk to the hub, sharing one credential/expiry/error path. The
package is organized into three groups (import from these in new code):

  transport/  — how bytes move to the hub
      CloudProxy            transparent HTTP reverse proxy (method-faithful)
      hub_get/post/...      outbound HTTP from semantic args
      HubWebSocketManager   persistent WebSocket proxy (ws_client)
  shared/     — protocol-neutral plumbing
      HubError, invalidate_hub_login, hub_error_reporter, EXPIRY_LEEWAY_SECONDS
  events      — inbound WS bridge + entity events
      HubWsBridge (hub_ws_bridge), EntityEvent

Top-level re-exports below keep the common names one import away; the original
module paths (``cloud_client.client``, ``.ws_client``, ``.hub_bridge`` …) remain
canonical so existing call sites and monkeypatches are unaffected.
"""

from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.transport import CloudProxy

__all__ = [
    # transport
    "ApiConfig",
    "FlowpadClient",
    "CloudProxy",
    # shared
    "HubError",
    # events
    "HubWsBridge",
    "hub_ws_bridge",
    "EntityEvent",
]

_LAZY = {
    "HubError": ("flow_sdk.cloud_client.shared.errors", "HubError"),
    "HubWsBridge": ("flow_sdk.cloud_client.hub_bridge", "HubWsBridge"),
    "hub_ws_bridge": ("flow_sdk.cloud_client.hub_bridge", "hub_ws_bridge"),
    "EntityEvent": ("flow_sdk.cloud_client.events", "EntityEvent"),
}


def __getattr__(name: str):
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    return getattr(importlib.import_module(target[0]), target[1])
