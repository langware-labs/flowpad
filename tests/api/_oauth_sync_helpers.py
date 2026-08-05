"""A hub double that holds a REAL token, plus the fixtures the sync tests share.

The double answers the three hub routes the desktop calls, but it does not
invent a token: when the test hands it a code, it performs an actual
``POST /token`` against the dummy provider. So "the hub's value" in these tests
is a value the provider issued, and the triple equality at the end is a claim
about one string that travelled the whole chain.

One seam is patched — ``hub_http.hub_get``. Both ``hub_oauth._hub_data`` and
``hub_providers.hub_provider_rows`` import it inside the function body, so
patching the module attribute covers both. That is deliberately a WIRE-level
double rather than several behavioural stubs: stubbing `hub_holds_credential`
and friends would let a routing change pass while the real thing broke.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import httpx
import pytest

from flow_sdk.core.entity.entity_env.env_types import EnvStatusEnum, EnvVarType

PROVIDER = "dummyauth"
LOCAL_CREDENTIALS_NAME = "dummyauth_credentials"
HUB_CREDENTIALS_NAME = "DUMMYAUTH_OAUTH_USER_TOKEN"
CLOUD_USER = {"id": "u-oauth-sync-1", "email": "sync@local.test"}


@dataclass
class HubDouble:
    """What the hub knows, and the routes the desktop asks it about."""

    dummy: Any
    #: The token the hub is holding, if the flow has completed there.
    held: Optional[str] = None
    #: state -> the desktop's pending authorization, as the hub would keep it.
    sessions: dict[str, dict[str, str]] = field(default_factory=dict)
    #: Set to refuse the value route while still reporting the row as present —
    #: the shape of the hub bug where a token row's value is not released.
    release_value: bool = True
    calls: list[tuple[str, str]] = field(default_factory=list)

    # ── the routes ────────────────────────────────────────────────────────
    def env_var_table(self) -> dict[str, Any]:
        """The provider catalogue, with connectedness derived from what is held."""
        return {
            "values": [
                {
                    "name": PROVIDER,
                    "description": "Dummy Auth",
                    "var_type": EnvVarType.OAUTH_PROVIDER_ID.value,
                    "ref_type": "user",
                    "ref_name": HUB_CREDENTIALS_NAME,
                    "var_status": (
                        EnvStatusEnum.AVAILABLE.value if self.held else EnvStatusEnum.MISSING.value
                    ),
                    "oauth_kind": "code",
                    "oauth_scopes": ["read", "write"],
                }
            ]
        }

    def start_auth(self) -> dict[str, Any]:
        """Open a session and hand back the provider's authorize URL."""
        state = f"hub-state-{len(self.sessions) + 1}"
        redirect = f"{self.dummy.base_url}/_hub_callback"
        self.sessions[state] = {"redirect_uri": redirect}
        query = {
            "client_id": "dummy-client",
            "redirect_uri": redirect,
            "state": state,
            "response_type": "code",
            "scope": "read write",
        }
        return {
            "oauth_request_id": f"req-{len(self.sessions)}",
            "provider": PROVIDER,
            "auth_url": str(httpx.URL(self.dummy.authorize_url).copy_merge_params(query)),
        }

    # ── what the browser + provider do to it ──────────────────────────────
    def complete_flow(self) -> str:
        """Drive a real authorization: browser → provider → hub's exchange.

        The test plays the browser (follow_redirects=False, read the Location);
        the double plays the hub's callback handler and does the token exchange
        itself. Returns the token the provider issued.
        """
        payload = self.start_auth()
        redirected = httpx.get(payload["auth_url"], follow_redirects=False)
        assert redirected.status_code == 302, redirected.text
        location = httpx.URL(redirected.headers["Location"])
        code = location.params.get("code")
        state = location.params.get("state")
        assert code, f"provider did not return a code: {location}"

        session = self.sessions.get(state)
        assert session is not None, f"hub has no session for state {state!r}"

        exchanged = httpx.post(
            self.dummy.token_url,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": session["redirect_uri"],
                "client_id": "dummy-client",
                "client_secret": "dummy-secret",
            },
        )
        assert exchanged.status_code == 200, exchanged.text
        self.held = exchanged.json()["access_token"]
        return self.held

    # ── the patched transport ─────────────────────────────────────────────
    async def hub_get(self, entity_type, entity_id=None, action=None, sub_path=None, **kwargs):
        self.calls.append((action or "", sub_path or ""))
        if action == "env-var" and sub_path == "table":
            return self.env_var_table()
        if action == "oauth" and sub_path == f"{PROVIDER}/auth":
            return self.start_auth()
        if action == "env-var" and sub_path == f"{HUB_CREDENTIALS_NAME}/value":
            if not self.held or not self.release_value:
                return None
            return {"name": HUB_CREDENTIALS_NAME, "value": self.held}
        return None


@pytest.fixture
def dummy_provider():
    """The fake provider, on a real socket, for one test."""
    from tests.utils.dummy_oauth_server import dummy_oauth_server

    with dummy_oauth_server() as server:
        yield server


@pytest.fixture
def hub(dummy_provider, monkeypatch):
    """A hub double wired into the transport, with the cloud login it gates on.

    `_hub_reachable()` is `is_logged_in() and not is_local_mode()`, and
    `_cloud_user_id()` reads the app-config user — so all three are needed
    before any hub OAuth path opens at all.
    """
    double = HubDouble(dummy=dummy_provider)

    from flow_sdk.cloud_client.transport import hub_http

    monkeypatch.setattr(hub_http, "hub_get", double.hub_get)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.is_logged_in", lambda: True)
    monkeypatch.setattr("flow_sdk.cli.app_config.get_user", lambda: CLOUD_USER)
    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._hub_reachable", lambda: True)
    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._cloud_user_id", lambda: CLOUD_USER["id"])
    # The hub's auth_url points at the dummy server on loopback; the preflight
    # short-circuits loopback without probing, but be explicit rather than
    # relying on that.
    monkeypatch.setattr(
        "flow_sdk.app.actions.oauth_action.redirect_unreachable_reason",
        lambda url: _none(),
    )
    yield double


async def _none():
    return None


@pytest.fixture
def local_dummy_provider(monkeypatch):
    """Register `dummyauth` locally for one test.

    `kind=DEVICE` on purpose, two consequences both wanted: `prefers_hub_flow`
    stays True so the hub route is the one exercised, and `get_local_provider`
    is non-None — which is the ONLY condition under which `_adopt_hub_credential`
    copies a value into local SOD.
    """
    from flow_sdk.core.oauth import provider_registry as registry
    from flow_sdk.core.oauth.provider_registry import LocalOAuthProvider, OAuthFlowKind

    monkeypatch.setitem(
        registry._PROVIDERS,
        PROVIDER,
        LocalOAuthProvider(
            name=PROVIDER,
            display_name="Dummy Auth",
            user_credentials_name=LOCAL_CREDENTIALS_NAME,
            kind=OAuthFlowKind.DEVICE,
        ),
    )
    return PROVIDER


@pytest.fixture(autouse=True)
def _isolate_oauth_module_state():
    """Drop the module globals that would otherwise leak between tests.

    The provider catalogue caches per cloud user for 10 minutes, so without this
    the second test reads the first test's answer.
    """
    from flow_sdk.app.actions import desktop_oauth
    from flow_sdk.core.oauth.hub_providers import invalidate_hub_providers

    invalidate_hub_providers()
    desktop_oauth._desktop_oauth_sessions.clear()
    yield
    invalidate_hub_providers()
    desktop_oauth._desktop_oauth_sessions.clear()


async def local_value(user) -> Optional[str]:
    """What this machine actually holds, or None when it holds nothing."""
    from flow_sdk.request_context.methods import get_user_credentials

    try:
        return await get_user_credentials(user, LOCAL_CREDENTIALS_NAME, user.id)
    except KeyError:
        return None


def assert_in_sync(dummy, hub: HubDouble, sod_value: Optional[str]) -> None:
    """The one definition of "in sync": all three hold the same issued string.

    Deliberately NOT a status check. `var_status == AVAILABLE` is reached purely
    from the presence of a name-matching row — `test_env_var_table.py` gets there
    with no token at all — so only the value proves anything.
    """
    issued = dummy.latest_token
    assert issued, "the provider issued nothing — the flow never completed"
    assert hub.held == issued, f"hub holds {hub.held!r}, provider issued {issued!r}"
    assert sod_value == issued, f"desktop holds {sod_value!r}, provider issued {issued!r}"
