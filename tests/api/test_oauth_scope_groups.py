"""A connection's scope groups, through the desktop's real auth + completion: one token per group.

The hub is a WIRE-level double (``HubProxy.call`` / ``try_call``) that speaks the scope-group contract:
its catalogue lists the provider's groups, ``auth?group=`` opens that group's consent, and its token rows
record what the provider GRANTED. Everything on the desktop side is real — ``_handle_auth`` (what the
Connect button calls), ``_handle_wait_callback`` (the completion), the SOD store and the connection rows —
so every assertion is about a value that was stored, never a status flag.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from flow_sdk.app.actions.oauth_action import _handle_auth, _handle_wait_callback
from flow_sdk.builtin.user import User
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.transport.hub_http import HubError
from flow_sdk.connections import MissingScopes, _from_spec
from flow_sdk.core.connections.specs import _list_connection_specs_local
from flow_sdk.core.entity.entity_env.env_types import EnvStatusEnum, EnvVarType
from flow_sdk.core.oauth.provider_registry import granted_scopes, token_for
from flow_sdk.request_context.methods import stored_user_credentials
from flow_sdk.responses.response import ApiSuccessResponse
from tests.api._oauth_sync_helpers import (  # noqa: F401 — pytest fixtures, registered by import
    CLOUD_USER,
    LOCAL_CREDENTIALS_NAME,
    PROVIDER,
    _isolate_oauth_module_state,
    local_dummy_provider,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DEFAULT_HUB = "DUMMYAUTH_OAUTH_USER_TOKEN"
MAIL_HUB = "DUMMYAUTH_MAIL_OAUTH_USER_TOKEN"
MAIL_LOCAL = "dummyauth_mail_credentials"


@dataclass
class GroupHub:
    """The hub as a desktop sees it: a catalogue with groups, sessions, token rows with granted scopes."""

    legacy: bool = False  # a hub from before scope groups: no groups in the catalogue
    held: dict[str, str] = field(default_factory=dict)  # credentials name -> token
    granted: dict[str, list[str]] = field(default_factory=dict)  # credentials name -> granted scopes
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)  # request id -> what auth was asked
    auth_calls: list[dict[str, Any]] = field(default_factory=list)

    def name_of(self, group: str) -> str:
        return MAIL_HUB if group == "mail" else DEFAULT_HUB

    def catalogue(self) -> dict[str, Any]:
        row = {
            "name": PROVIDER, "var_type": EnvVarType.OAUTH_PROVIDER_ID.value, "ref_type": "user",
            "ref_name": DEFAULT_HUB, "oauth_display_name": "Dummy Auth", "oauth_kind": "code",
            "oauth_scopes": ["files.read"], "oauth_verifiable": True, "oauth_protocol": 1,
            "var_status": (EnvStatusEnum.AVAILABLE if DEFAULT_HUB in self.held else EnvStatusEnum.MISSING).value,
        }
        if not self.legacy:
            row["oauth_groups"] = [
                {"name": "files", "title": "Files", "scopes": ["files.read"], "optional_scopes": ["files.write"],
                 "credentials_name": DEFAULT_HUB},
                {"name": "mail", "title": "Mail", "scopes": ["mail.read"], "optional_scopes": [],
                 "credentials_name": MAIL_HUB},
            ]
        return {"values": [row]}

    def complete(self, request_id: str, token: str, granted: list[str]) -> None:
        """The browser came back: the hub exchanged the code and stored the grant under its group's name."""
        name = self.name_of(self.sessions[request_id]["group"])
        self.held[name], self.granted[name] = token, granted
        self.sessions[request_id]["done"] = True

    async def answer(self, entity_type, entity_id=None, action=None, sub_path=None, params=None, **_kw):
        params = dict(params or {})
        group = "" if self.legacy else str(params.get("group") or "")
        if action == "env-var" and sub_path == "table":
            return self.catalogue()
        if action == "env-var" and sub_path.endswith("/value"):
            name = sub_path.removesuffix("/value")
            return {"name": name, "value": self.held[name]} if name in self.held else None
        if action == "oauth" and sub_path == f"{PROVIDER}/auth":
            request_id = f"req-{len(self.sessions) + 1}"
            self.sessions[request_id] = {"group": group, "done": False}
            self.auth_calls.append(params)
            return {"oauth_request_id": request_id, "provider": PROVIDER, "auth_url": "http://127.0.0.1:9/authorize"}
        if action == "oauth" and sub_path == f"{PROVIDER}/wait-callback":
            done = any(s["done"] for s in self.sessions.values())
            return {"status": "success" if done else "pending"}
        if action == "oauth" and sub_path == f"{PROVIDER}/status":
            name = self.name_of(group)
            return None if self.legacy else {"has_token": name in self.held, "granted_scopes": self.granted.get(name, [])}
        if action == "oauth" and sub_path == f"{PROVIDER}/test":
            return {"ok": False}  # never adopt a held grant: these tests run the consent
        return None

    async def try_call(self, method, entity_type, *args, **kwargs):
        return await self.answer(entity_type, *args, **kwargs)

    async def call(self, method, entity_type, *args, **kwargs):
        payload = await self.answer(entity_type, *args, **kwargs)
        if payload is None:
            raise HubError(404, "no double route")
        return payload


@pytest.fixture
def hub(monkeypatch, local_dummy_provider):  # noqa: F811 — the fixture, by name
    double = GroupHub()
    monkeypatch.setattr(HubProxy, "try_call", staticmethod(double.try_call))
    monkeypatch.setattr(HubProxy, "call", staticmethod(double.call))
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: True)
    monkeypatch.setattr("flow_sdk.cli.app_config.get_user", lambda: CLOUD_USER)
    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._hub_reachable", lambda: True)
    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._cloud_user_id", lambda: CLOUD_USER["id"])

    async def reachable(_url):
        return None

    monkeypatch.setattr("flow_sdk.app.actions.oauth_action.redirect_unreachable_reason", reachable)
    return double


@pytest.fixture
async def user(monkeypatch):
    person = User(name="scope-group-user")
    await person.save()

    async def current(*_a, **_kw):
        return person

    monkeypatch.setattr("flow_sdk.request_context.methods.get_current_request_user_fresh", current)
    monkeypatch.setattr("flow_sdk.core.connections.specs._connection_user", current)
    return person


async def _stored(user, name: str) -> Optional[Any]:
    try:
        return await stored_user_credentials(user, name, user.id)
    except KeyError:
        return None


async def _connect(hub: GroupHub, *, token: str, granted: list[str], **params) -> dict[str, Any]:
    """The Connect button, the browser round trip, and the desktop's completion. Returns what auth asked."""
    started = await _handle_auth(PROVIDER, SimpleNamespace(request_parameters=params, initiator_connection_id=""))
    assert isinstance(started, ApiSuccessResponse), started.message
    request_id = started.data["oauth_request_id"]
    hub.complete(request_id, token, granted)
    done = await _handle_wait_callback(PROVIDER, request_id)
    assert done.data["status"] == "success", done.data
    return hub.auth_calls[-1]


async def test_a_group_connect_keeps_its_own_token_with_the_scopes_granted(hub, user):
    asked = await _connect(hub, token="mail-token-1", granted=["mail.read"], group="mail")
    assert asked.get("group") == "mail", "the hub opens the Mail consent, not the provider's own"

    mail = await _stored(user, MAIL_LOCAL)
    assert mail["access_token"] == "mail-token-1" and mail["scopes"] == ["mail.read"]
    assert await _stored(user, LOCAL_CREDENTIALS_NAME) is None, "a Mail connect never touches the default token"


async def test_the_default_group_is_todays_connection_and_the_groups_never_overwrite_each_other(hub, user):
    asked = await _connect(hub, token="files-token-1", granted=["files.read"], group="files")
    assert "group" not in asked, "the default group is the provider's own consent — sent as no group at all"
    await _connect(hub, token="mail-token-1", granted=["mail.read"], group="mail")

    assert (await _stored(user, LOCAL_CREDENTIALS_NAME))["access_token"] == "files-token-1"
    assert (await _stored(user, MAIL_LOCAL))["access_token"] == "mail-token-1"
    assert await granted_scopes(PROVIDER, user) == ("files.read",)
    assert await granted_scopes(PROVIDER, user, name=MAIL_LOCAL) == ("mail.read",)
    assert await token_for(PROVIDER, name=MAIL_LOCAL) == "mail-token-1"


async def test_the_connection_row_checks_scopes_against_what_was_granted(hub, user):
    # The person unticked the write box: asked for files.write, the provider granted only files.read.
    await _connect(hub, token="files-token-1", granted=["files.read"], scopes="files.write")
    (spec,) = [s for s in await _list_connection_specs_local() if s.provider == PROVIDER]
    assert spec.granted_scopes == ("files.read",)

    row = _from_spec(spec)
    await row.validate_scopes(["files.read"])
    with pytest.raises(MissingScopes) as missing:
        await row.validate_scopes(["files.write"])
    assert missing.value.missing == ["files.write"]


async def test_a_use_points_extra_scopes_go_to_its_own_consent(hub, user):
    asked = await _connect(hub, token="files-token-1", granted=["files.read", "files.write"], scopes="files.write")
    assert asked.get("scopes") == "files.write"


async def test_a_group_the_hub_does_not_list_is_refused_before_any_consent(hub, user):
    refused = await _handle_auth(PROVIDER, SimpleNamespace(request_parameters={"group": "calendar"}, initiator_connection_id=""))
    assert not isinstance(refused, ApiSuccessResponse) and "calendar" in refused.message
    assert hub.auth_calls == []


async def test_a_hub_from_before_groups_connects_exactly_as_before(hub, user):
    hub.legacy = True
    asked = await _connect(hub, token="files-token-1", granted=["files.read"], group="mail")
    assert "group" not in asked, "an old hub knows no groups: the desktop does not invent one"
    stored = await _stored(user, LOCAL_CREDENTIALS_NAME)
    assert stored["access_token"] == "files-token-1" and "scopes" not in stored, "an old hub records no grant"
    assert await _stored(user, MAIL_LOCAL) is None
