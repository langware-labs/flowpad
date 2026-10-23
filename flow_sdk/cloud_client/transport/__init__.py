"""Cloud transport layer — how the local server reaches the hub.

  - HTTP: every request goes through ``flow_sdk.cloud_client.hub_proxy.HubProxy``
    (verbatim forwarding + typed graph calls); ``hub_http`` holds its client and URLs.
  - ``HubWebSocketManager``  : persistent WebSocket proxy (``ws_client``).

This is the canonical grouped import surface for new code. Everything is surfaced lazily so
``import flow_sdk.cloud_client`` stays light and cycle-free, and the canonical module identity stays at
``cloud_client.client`` / ``.ws_client`` / ``.transport.hub_http`` — so existing
call sites and test monkeypatches (e.g. ``patch("cloud_client.ws_client.hub_ws_manager")``)
keep working unchanged.
"""

__all__ = [
    "ApiConfig",
    "FlowpadClient",
    "hub_graph_url",
    "hub_base_url",
    "get_info",
    "HubWebSocketManager",
    "hub_ws_manager",
]

_LAZY = {
    "ApiConfig": ("flow_sdk.cloud_client.client", "ApiConfig"),
    "FlowpadClient": ("flow_sdk.cloud_client.client", "FlowpadClient"),
    "HubWebSocketManager": ("flow_sdk.cloud_client.ws_client", "HubWebSocketManager"),
    "hub_ws_manager": ("flow_sdk.cloud_client.ws_client", "hub_ws_manager"),
    "hub_graph_url": ("flow_sdk.cloud_client.transport.hub_http", "hub_graph_url"),
    "hub_base_url": ("flow_sdk.cloud_client.transport.hub_http", "hub_base_url"),
    "get_info": ("flow_sdk.cloud_client.transport.hub_http", "get_info"),
}


def __getattr__(name: str):
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    return getattr(importlib.import_module(target[0]), target[1])
