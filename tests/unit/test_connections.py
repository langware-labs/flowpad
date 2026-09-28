"""Public connection surface: canonical rows, immutable connect and cheap gate."""

from __future__ import annotations

import pytest

from flow_sdk import connections
from flow_sdk.connections import NotConnected, TokenUnavailable, get_connection, get_connections, require
from flow_sdk.schema.data_spec.connection_spec import (
    BrowserAuthorization,
    ConnectionResult,
    ConnectionSpec,
    ConnectionTestResult,
    ConnectionTokenResult,
    ConnectionTokenStatus,
)
from tests.utils.connection_rows import fake_connections

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


async def test_rows_preserve_canonical_order_and_metadata(monkeypatch):
    fake_connections(monkeypatch, [_spec("slack"), _spec("googledrive", connected=True)])

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
    fake_connections(monkeypatch, [original_spec])
    monkeypatch.setattr(connections, "open_authorization_in_system_browser", lambda _authorization: False)

    async def connect(_provider, presenter, *, reauthorize=False):
        await presenter.present(BrowserAuthorization(oauth_request_id="opaque-state", provider="slack", url="https://auth.example/connect"))
        return ConnectionResult(spec=verified_spec, test=ConnectionTestResult(ok=True, identity="me"))

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
    fake_connections(monkeypatch, [spec])
    monkeypatch.setattr(connections, "_test", lambda _provider: _async_value(ConnectionTestResult(ok=True)))
    monkeypatch.setattr(
        connections,
        "token_for_spec",
        lambda _spec: _async_value(ConnectionTokenResult(status=ConnectionTokenStatus.AVAILABLE, token="xoxb-secret")),
    )
    row = await get_connection("slack")

    assert row is not None and (await row.test()).ok is True
    assert await row.token() == "xoxb-secret"


async def test_nonexportable_held_token_is_not_not_connected(monkeypatch):
    spec = _spec("opaque", connected=True)
    fake_connections(monkeypatch, [spec])
    monkeypatch.setattr(
        connections,
        "token_for_spec",
        lambda _spec: _async_value(ConnectionTokenResult(status=ConnectionTokenStatus.UNAVAILABLE)),
    )
    row = await get_connection("opaque")

    with pytest.raises(TokenUnavailable):
        await row.token()  # type: ignore[union-attr]


async def test_token_uses_fresh_core_state_not_the_row_snapshot(monkeypatch):
    spec = _spec("slack", connected=True)
    fake_connections(monkeypatch, [spec])
    monkeypatch.setattr(
        connections,
        "token_for_spec",
        lambda _spec: _async_value(ConnectionTokenResult(status=ConnectionTokenStatus.NOT_CONNECTED)),
    )
    row = await get_connection("slack")

    with pytest.raises(NotConnected):
        await row.token()  # type: ignore[union-attr]


async def test_require_remains_the_cheap_credential_gate(monkeypatch):
    fake_connections(monkeypatch, [_spec("slack", connected=True), _spec("google")])

    assert (await require("slack")).connected
    with pytest.raises(NotConnected):
        await require("google")
    with pytest.raises(NotConnected):
        await require("nonesuch")


async def test_no_local_user_reads_every_provider_as_a_status_row(monkeypatch):
    """Without a user the table is still ``EnvVarStatus`` rows (MISSING), so the
    projection reads ``var_status`` directly and lists each provider disconnected."""
    from flow_sdk.core import oauth
    from flow_sdk.core.connections import specs
    from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvStatusEnum, EnvVarStatus
    from flow_sdk.core.oauth import hub_providers, provider_env_var

    async def no_user():
        return None

    async def no_hub():
        return EntityEnvVars(values=[])

    monkeypatch.setattr(
        oauth,
        "oauth_provider_rows",
        lambda: EntityEnvVars(values=[provider_env_var("slack", "Slack", "SLACK_OAUTH_USER_TOKEN", "Slack")]),
    )
    monkeypatch.setattr(hub_providers, "hub_provider_rows", no_hub)
    monkeypatch.setattr(specs, "_connection_user", no_user)

    table = await oauth.get_oauth_providers_as_env_table(None)
    assert [(type(r), r.var_status) for r in table.values] == [(EnvVarStatus, EnvStatusEnum.MISSING)]

    rows = await specs._list_connection_specs_local()

    assert [(r.provider, r.connected, str(r.state)) for r in rows] == [("slack", False, "disconnected")]


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


async def test_the_documented_use_runs_as_written_when_held(monkeypatch):
    """``docs/snippets/connections.md`` "Require and use a held connection", verbatim: held → its token."""
    from tests.utils.snippets import doc, fence_under, run_fence

    fake_connections(monkeypatch, [_spec("slack", connected=True)])
    monkeypatch.setattr(connections, "token_for_spec",
                        lambda _spec: _async_value(ConnectionTokenResult(status=ConnectionTokenStatus.AVAILABLE, token="xoxb-1")))
    ns = await run_fence(fence_under(doc("connections.md"), "Require and use a held connection"), {}, filename="connections.md")
    assert ns["token"] == "xoxb-1"


async def test_the_documented_use_runs_as_written_when_not_yet_connected(monkeypatch):
    """The same fence on a machine without the connection: it connects, and a Hub-held token reads as None."""
    from tests.utils.snippets import doc, fence_under, run_fence

    fake_connections(monkeypatch, [_spec("slack")])
    monkeypatch.setattr(connections, "open_authorization_in_system_browser", lambda _authorization: False)

    async def connect(_provider, presenter, *, reauthorize=False):
        await presenter.present(BrowserAuthorization(oauth_request_id="s", provider="slack", url="https://auth.example/connect"))
        return ConnectionResult(spec=_spec("slack", connected=True), test=ConnectionTestResult(ok=True, identity="me"))

    monkeypatch.setattr(connections, "_connect", connect)
    monkeypatch.setattr(connections, "token_for_spec",
                        lambda _spec: _async_value(ConnectionTokenResult(status=ConnectionTokenStatus.UNAVAILABLE)))
    ns = await run_fence(fence_under(doc("connections.md"), "Require and use a held connection"), {}, filename="connections.md")
    assert ns["slack"].connected and ns["token"] is None
