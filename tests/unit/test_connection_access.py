"""The access pattern for accounts: ``Connection.get`` → ``validate_scopes`` → bind; ``connect(reauthorize=True)``."""

from __future__ import annotations

import pytest

from flow_sdk import connections
from flow_sdk.connections import Connection, ConnectionRequirements, MissingScopes, NotConnected, require
from flow_sdk.schema.data_spec.connection_spec import ConnectionResult, ConnectionSpec, ConnectionTestResult
from tests.utils.connection_rows import fake_connections

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _spec(provider: str, *, connected: bool = False, scopes: tuple[str, ...] = ("read",)) -> ConnectionSpec:
    return ConnectionSpec(
        provider=provider,
        display_name=provider.title(),
        credential_ref=f"{provider}_credentials",
        connected=connected,
        scopes=scopes,
    )


async def test_get_returns_the_held_connection(monkeypatch):
    fake_connections(monkeypatch, [_spec("google", connected=True)])

    google = await Connection.get("google")

    assert google.provider == "google" and google.connected
    assert (await require("google")) == google


async def test_an_unconnected_provider_raises_carrying_its_row(monkeypatch):
    fake_connections(monkeypatch, [_spec("google")])

    with pytest.raises(NotConnected) as not_connected:
        await Connection.get("google")

    assert not_connected.value.connection is not None
    assert not_connected.value.connection.provider == "google" and not not_connected.value.connection.connected


async def test_an_unknown_provider_raises_with_no_row(monkeypatch):
    fake_connections(monkeypatch, [])

    with pytest.raises(NotConnected) as not_connected:
        await Connection.get("nowhere")

    assert not_connected.value.connection is None


async def test_get_connection_is_the_get_connections_row(monkeypatch):
    fake_connections(monkeypatch, [_spec("google", connected=True), _spec("slack")])

    rows = await connections.get_connections()
    slack = await connections.get_connection("slack")

    assert slack == next(c for c in rows if c.provider == "slack")
    assert slack is not None and slack.connected is False
    assert await connections.get_connection("nowhere") is None


async def test_validate_scopes_names_only_what_the_grant_lacks(monkeypatch):
    fake_connections(monkeypatch, [_spec("google", connected=True, scopes=("drive.readonly",))])
    google = await Connection.get("google")

    await google.validate_scopes(["drive.readonly"])
    with pytest.raises(MissingScopes) as missing:
        await google.validate_scopes(["drive.readonly", "cloud-platform", "cloud-platform"])

    assert missing.value.missing == ["cloud-platform"]
    assert missing.value.provider == "google"


async def test_connect_passes_reauthorize_to_the_orchestrator_only_when_asked(monkeypatch):
    held = _spec("google", connected=True)
    fake_connections(monkeypatch, [held])
    asked: list[bool] = []

    async def connect(provider, presenter, *, reauthorize=False):
        asked.append(reauthorize)
        return ConnectionResult(held, ConnectionTestResult(ok=True, identity="me@example.com"))

    monkeypatch.setattr(connections, "_connect", connect)
    google = await Connection.get("google")

    await google.connect()
    fresh = await google.connect(reauthorize=True)

    assert asked == [False, True]
    assert fresh.identity == "me@example.com"


def test_requirements_list_providers_and_their_scopes_once():
    needs = ConnectionRequirements({"google": ["drive.readonly", "drive.readonly", "cloud-platform"]})

    assert needs.names() == ["google"]
    assert needs.scopes("google") == ["drive.readonly", "cloud-platform"]
    assert needs.scopes("slack") == []
    assert ConnectionRequirements().names() == []
