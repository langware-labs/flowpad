"""Flowpad discovery — detect whether the Flowpad desktop app is running."""

from typing import Any

from .flowpad_discovery import (
    FlowpadDiscoveryResult,
    FlowpadServerInfo,
    FlowpadStatus,
    HOUR_IN_SECONDS,
    MAX_FAILURES_PER_HOUR,
    check_server_health,
    discover_flowpad,
    get_port_file_path,
    is_flowpad_installed,
    is_webhook_rate_limited,
    read_server_info,
    record_webhook_failure,
)

#: Loaded on first use (PEP 562): ``notify`` pulls the record store in, and ``flowpad_discovery`` -- what every
#: CLI command imports to find its server -- must not pay for that.
_NOTIFY = {
    "get_flowpad_status",
    "send_resource_sync",
    "send_entity_sync",
    "send_log_event",
    "send_flow_tag",
    "xml_str_to_flow_data_dict",
}


def __getattr__(name: str) -> Any:
    if name in _NOTIFY:
        from . import notify

        return getattr(notify, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "FlowpadDiscoveryResult",
    "FlowpadServerInfo",
    "FlowpadStatus",
    "HOUR_IN_SECONDS",
    "MAX_FAILURES_PER_HOUR",
    "check_server_health",
    "discover_flowpad",
    "get_port_file_path",
    "is_flowpad_installed",
    "is_webhook_rate_limited",
    "read_server_info",
    "record_webhook_failure",
    # Notify
    "get_flowpad_status",
    "send_resource_sync",
    "send_entity_sync",
    "send_log_event",
    "send_flow_tag",
    "xml_str_to_flow_data_dict",
]
