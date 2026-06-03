"""Unit tests for the shared FLOW_INSTANCE-aware CLI port resolver."""
from __future__ import annotations

import pytest

from flow_sdk.discovery import flowpad_discovery as disc
from flow_sdk.discovery.flowpad_discovery import (
    FlowpadServerInfo,
    InstanceNotRunningError,
    resolve_cli_port,
)
from flow_sdk.instance_settings import reset_instance_settings


def test_resolve_cli_port_returns_server_json_port(monkeypatch):
    monkeypatch.setattr(
        disc,
        "read_server_info",
        lambda: FlowpadServerInfo(
            port=9008, webhook_path="/w", health_path="/h", url="http://localhost:9008/w"
        ),
    )
    assert resolve_cli_port() == 9008


def test_resolve_cli_port_raises_named_error_when_not_running(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "no-such-instance-xyz")
    reset_instance_settings()
    monkeypatch.setattr(disc, "read_server_info", lambda: None)
    with pytest.raises(InstanceNotRunningError) as ei:
        resolve_cli_port()
    assert "no-such-instance-xyz" in str(ei.value)
    assert ei.value.instance_name == "no-such-instance-xyz"
