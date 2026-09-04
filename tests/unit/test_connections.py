"""Public connection surface: canonical rows, immutable connect and cheap gate."""

from __future__ import annotations

import pytest

from flow_sdk import connections
from flow_sdk.connections import NotConnected, TokenUnavailable, get_connection, get_connections, require
from flow_sdk.core.connections.types import (
    BrowserAuthorization,
    ConnectionResult,
    ConnectionSpec,
    ConnectionTestResult,
    ConnectionTokenResult,
    ConnectionTokenStatus,
)

pytestmark = pytest.mark.asyncio


def _spec(provider: str, *, connected: bool = False, identity: str = "") -> ConnectionSpec:
    return ConnectionSpec(
        provider=provider,
        display_name=provider.title(),
        credential_ref=f"{provider}_credentials",
        connected=connected,
        identity=identity,
        scopes=("read",),
        icon=provider.title(),
    )


def _catalogue(monkeypatch, rows: list[ConnectionSpec]) -> None:
    async def list_rows(project_id: str = ""):
        return rows

    async def resolve(provider: str):
        return next((row for row in rows if row.provider == provider), None)

    monkeypatch.setattr(connections, "list_connections", list_rows)
    monkeypatch.setattr(connections, "resolve_connection_spec", resolve)


async def test_rows_preserve_canonical_order_and_metadata(monkeypatch):
    _catalogue(monkeypatch, [_spec("slack"), _spec("googledrive", connected=True)])

    rows = await get_connections()

    assert [row.provider for row in rows] == ["slack", "googledrive"]
    assert rows[1].connected and rows[1].scopes == ("read",)
    # `kind` IS a field now, and deliberately: this list carries every kind of
    # connection — an API key, the FlowPad account, a harness CLI login — where
    # it once carried OAuth providers only and shared no rows with the screen.
    # `hub_only` stays absent; nothing needed it.
    assert rows[0].kind == "oauth"
    assert not hasattr(rows[0], "hub_only")


async def test_connect_returns_new_verified_row_and_manual_url(monkeypatch, capsys):
    original_spec = _spec("slack")
    verified_spec = _spec("slack", connected=True)
    _catalogue(monkeypatch, [original_spec])
    monkeypatch.setattr(connections, "open_authorization_in_system_browser", lambda _authorization: False)

    async def connect(_provider, presenter):
        await presenter.present(BrowserAuthorization("opaque-state", "slack", "https://auth.example/connect"))
        return ConnectionResult(verified_spec, ConnectionTestResult(ok=True, identity="me"))

    monkeypatch.setattr(connections, "_connect", connect)
    old = (await get_connections())[0]

    fresh = await old.connect()

    assert old.connected is False
    assert fresh.connected is True and fresh.identity == "me"
    stderr = capsys.readouterr().err
    assert "https://auth.example/connect" in stderr
    assert "opaque-state" not in stderr


async def test_test_and_token_delegate_to_core(monkeypatch):
    spec = _spec("slack", connected=True)
    _catalogue(monkeypatch, [spec])
    monkeypatch.setattr(connections, "_test", lambda _provider: _async_value(ConnectionTestResult(ok=True)))
    monkeypatch.setattr(
        connections,
        "token_for_spec",
        lambda _spec: _async_value(ConnectionTokenResult(ConnectionTokenStatus.AVAILABLE, "xoxb-secret")),
    )
    row = await get_connection("slack")

    assert row is not None and (await row.test()).ok is True
    assert await row.token() == "xoxb-secret"


async def test_nonexportable_held_token_is_not_not_connected(monkeypatch):
    spec = _spec("opaque", connected=True)
    _catalogue(monkeypatch, [spec])
    monkeypatch.setattr(
        connections,
        "token_for_spec",
        lambda _spec: _async_value(ConnectionTokenResult(ConnectionTokenStatus.UNAVAILABLE)),
    )
    row = await get_connection("opaque")

    with pytest.raises(TokenUnavailable):
        await row.token()  # type: ignore[union-attr]


async def test_token_uses_fresh_core_state_not_the_row_snapshot(monkeypatch):
    spec = _spec("slack", connected=True)
    _catalogue(monkeypatch, [spec])
    monkeypatch.setattr(
        connections,
        "token_for_spec",
        lambda _spec: _async_value(ConnectionTokenResult(ConnectionTokenStatus.NOT_CONNECTED)),
    )
    row = await get_connection("slack")

    with pytest.raises(NotConnected):
        await row.token()  # type: ignore[union-attr]


async def test_require_remains_the_cheap_credential_gate(monkeypatch):
    _catalogue(monkeypatch, [_spec("slack", connected=True), _spec("google")])

    assert (await require("slack")).connected
    with pytest.raises(NotConnected):
        await require("google")
    with pytest.raises(NotConnected):
        await require("nonesuch")


async def _async_value(value):
    return value


# ── the token exchange's encoding ────────────────────────────────────────────


def test_the_token_exchange_is_form_encoded_unless_a_provider_says_otherwise():
    """RFC 6749 §4.1.3: the token request is `application/x-www-form-urlencoded`.

    A spec-following endpoint does not merely prefer it — Entra answers
    `AADSTS900144: the request body must contain 'grant_type'` for a JSON body,
    because it never parsed it. JSON was hard-coded while Anthropic was the only
    local code grant, so one endpoint's tolerance read as the rule; the default
    is now the spec and the exception is named on the provider.
    """
    from flow_sdk.core.oauth.provider_registry import ANTHROPIC, MICROSOFT, local_providers

    by_name = {p.name: p for p in local_providers()}
    assert by_name[ANTHROPIC].token_request_json is True
    assert by_name[MICROSOFT].token_request_json is False
    assert [p.name for p in local_providers() if p.token_request_json] == [ANTHROPIC]
