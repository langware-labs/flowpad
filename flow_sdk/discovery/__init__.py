"""Flowpad discovery — detect whether the Flowpad desktop app is running."""

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
    write_server_info,
)
from .notify import (
    get_flowpad_status,
    send_resource_sync,
    send_entity_sync,
    send_log_event,
    send_flow_tag,
    xml_str_to_flow_data_dict,
)

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
    "write_server_info",
    # Notify
    "get_flowpad_status",
    "send_resource_sync",
    "send_entity_sync",
    "send_log_event",
    "send_flow_tag",
    "xml_str_to_flow_data_dict",
]
