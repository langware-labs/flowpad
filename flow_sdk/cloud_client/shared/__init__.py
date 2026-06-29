"""Shared cloud plumbing used by both transports (HTTP proxy + WS proxy).

The protocol-neutral pieces: error types/reporting, auth/login state, expiry
constants. ``errors`` lives here physically; the rest are surfaced lazily from
their existing module homes so the canonical identity (and test monkeypatch
targets like ``cloud_client.auth_state``) stays put.
"""
from flow_sdk.cloud_client.shared.errors import HubError, _extract_reason

__all__ = [
    "HubError",
    "_extract_reason",
    "invalidate_hub_login",
    "set_login_status",
    "set_connection_status",
    "hub_error_reporter",
    "HubAuthExpiredError",
    "EXPIRY_LEEWAY_SECONDS",
]

_LAZY = {
    "invalidate_hub_login": ("flow_sdk.cloud_client.auth_state", "invalidate_hub_login"),
    "set_login_status": ("flow_sdk.cloud_client.auth_state", "set_login_status"),
    "set_connection_status": ("flow_sdk.cloud_client.auth_state", "set_connection_status"),
    "hub_error_reporter": ("flow_sdk.cloud_client.error_reporter", "hub_error_reporter"),
    "HubAuthExpiredError": ("flow_sdk.cloud_client.client_hooks", "HubAuthExpiredError"),
    "EXPIRY_LEEWAY_SECONDS": ("flow_sdk.cloud_client.constants", "EXPIRY_LEEWAY_SECONDS"),
}


def __getattr__(name: str):
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    return getattr(importlib.import_module(target[0]), target[1])
