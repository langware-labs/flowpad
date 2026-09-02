"""The connections CLI is a presenter over the shared connection core."""

from __future__ import annotations

import json

from typer.testing import CliRunner

from flow_sdk.cli.commands import connections_cmd
from flow_sdk.cli.flow_cli import app
from flow_sdk.core.connections.types import (
    BrowserAuthorization,
    ConnectionCancelled,
    ConnectionConnectError,
    ConnectionResult,
    ConnectionSpec,
    ConnectionStage,
    ConnectionTestResult,
)


def _spec(provider: str, connected: bool = False) -> ConnectionSpec:
    return ConnectionSpec(provider, provider.title(), f"{provider}_credentials", connected, None, (), None)


def test_connections_list_json_preserves_core_order(monkeypatch):
    async def rows():
        return [_spec("slack"), _spec("googledrive", True)]

    monkeypatch.setattr(connections_cmd, "list_connection_specs", rows)
    result = CliRunner().invoke(app, ["connections", "list", "--json"])

    assert result.exit_code == 0
    assert [row["provider"] for row in json.loads(result.stdout)["connections"]] == ["slack", "googledrive"]


def test_connections_connect_writes_one_success_json(monkeypatch):
    async def connect(_provider, _presenter):
        return ConnectionResult(_spec("slack", True), ConnectionTestResult(ok=True, identity="me"))

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)
    result = CliRunner().invoke(app, ["connections", "connect", "slack", "--json"])

    assert result.exit_code == 0
    assert json.loads(result.stdout) == {"ok": True, "provider": "slack", "connected": True, "identity": "me"}


def test_connections_list_renders_typed_service_failure(monkeypatch):
    async def rows():
        raise ConnectionConnectError("", ConnectionStage.SERVICE, "service_start_failed", "could not start")

    monkeypatch.setattr(connections_cmd, "list_connection_specs", rows)
    result = CliRunner().invoke(app, ["connections", "list", "--json"])

    assert result.exit_code == connections_cmd.EXIT_SERVICE
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "ok": False,
        "provider": "",
        "stage": "service",
        "code": "service_start_failed",
        "detail": "could not start",
    }


def test_connections_connect_maps_cancellation(monkeypatch):
    async def connect(_provider, _presenter):
        raise ConnectionCancelled("slack", "browser closed")

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)
    result = CliRunner().invoke(app, ["connections", "connect", "slack", "--json"])

    assert result.exit_code == connections_cmd.EXIT_CANCELLED
    assert json.loads(result.stderr)["code"] == "cancelled"


def test_connections_connect_maps_invalid_provider(monkeypatch):
    async def connect(_provider, _presenter):
        raise ConnectionConnectError("nope", ConnectionStage.CATALOG, "unknown_provider")

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)
    result = CliRunner().invoke(app, ["connections", "connect", "nope"])

    assert result.exit_code == connections_cmd.EXIT_INVALID_PROVIDER
    assert "catalog/unknown_provider" in result.stderr


def test_connections_connect_maps_authorization_failure(monkeypatch):
    async def connect(_provider, _presenter):
        raise ConnectionConnectError("slack", ConnectionStage.VERIFICATION, "verification_failed")

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)
    result = CliRunner().invoke(app, ["connections", "connect", "slack"])

    assert result.exit_code == connections_cmd.EXIT_AUTH


def test_connections_connect_falls_back_to_stderr_when_browser_opener_fails(monkeypatch):
    async def connect(_provider, presenter):
        await presenter.present(BrowserAuthorization("opaque", "slack", "https://auth.example/connect"))
        return ConnectionResult(_spec("slack", True), ConnectionTestResult(ok=True))

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)
    monkeypatch.setattr(
        connections_cmd,
        "open_authorization_in_system_browser",
        lambda _authorization: False,
    )
    result = CliRunner().invoke(app, ["connections", "connect", "slack"])

    assert result.exit_code == 0
    assert "https://auth.example/connect" in result.stderr
    assert "opaque" not in result.stderr
    assert json.loads(result.stdout)["ok"] is True


def test_connections_connect_falls_back_when_browser_opener_raises(monkeypatch):
    from flow_sdk.core.connections import presentation

    async def connect(_provider, presenter):
        await presenter.present(BrowserAuthorization("opaque", "slack", "https://auth.example/connect"))
        return ConnectionResult(_spec("slack", True), ConnectionTestResult(ok=True))

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)

    def fail_to_open(_url):
        raise RuntimeError("no opener")

    monkeypatch.setattr(presentation.webbrowser, "open", fail_to_open)
    result = CliRunner().invoke(app, ["connections", "connect", "slack"])

    assert result.exit_code == 0
    assert "https://auth.example/connect" in result.stderr


def test_connections_connect_maps_ctrl_c(monkeypatch):
    async def connect(_provider, _presenter):
        raise KeyboardInterrupt

    monkeypatch.setattr(connections_cmd, "connect_provider", connect)
    result = CliRunner().invoke(app, ["connections", "connect", "slack"])

    assert result.exit_code == connections_cmd.EXIT_INTERRUPTED
