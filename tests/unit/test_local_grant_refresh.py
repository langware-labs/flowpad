"""A grant this machine got itself (loopback) is refreshed where it is read: an expired one is handed out
with a fresh access token, and written back; one without a refresh token is handed out as it is."""
import time

import httpx
import pytest

from flow_sdk.core.oauth import provider_registry
from flow_sdk.core.oauth.provider_registry import refresh_local_grant

pytestmark = pytest.mark.asyncio


def _grant(**over):
    return {"provider": "google", "access_token": "old", "refresh_token": "r1",
            "expires_at": int(time.time() * 1000) - 1000, **over}


@pytest.fixture
def token_endpoint(monkeypatch):
    asked: list[dict] = []

    def handler(request):
        asked.append(dict(httpx.QueryParams(request.content.decode())))
        return httpx.Response(200, json={"access_token": "new", "expires_in": 3599, "scope": "https://mail.google.com/"})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *_a, **_kw: real(transport=httpx.MockTransport(handler)))
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
    return asked


async def test_an_expired_local_grant_is_handed_out_refreshed(token_endpoint):
    fresh = await refresh_local_grant("google", _grant())

    assert fresh["access_token"] == "new" and fresh["refresh_token"] == "r1"
    assert fresh["expires_at"] > time.time() * 1000 + 3000_000
    assert fresh["scopes"] == ["https://mail.google.com/"]
    (form,) = token_endpoint
    assert form == {"grant_type": "refresh_token", "refresh_token": "r1", "client_id": "cid"}, "no secret unless set"


async def test_the_client_secret_rides_only_when_set(token_endpoint, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "shh")
    await refresh_local_grant("google", _grant())
    assert token_endpoint[0]["client_secret"] == "shh"


async def test_a_grant_without_a_refresh_token_or_still_fresh_is_unchanged(token_endpoint):
    bare = _grant(refresh_token="")
    assert await refresh_local_grant("google", bare) is bare
    live = _grant(expires_at=int(time.time() * 1000) + 3600_000)
    assert await refresh_local_grant("google", live) is live
    assert token_endpoint == []


async def test_credential_for_writes_the_refreshed_grant_back(token_endpoint, monkeypatch):
    from flow_sdk.builtin.user import User
    from flow_sdk.request_context import methods

    stored = {"value": _grant()}
    local = User(id="u1")

    async def read(_u, _name, _fk=None):
        return stored["value"]

    async def write(_u, _name, value, _fk):
        stored["value"] = value

    async def get_local():
        return local

    async def nobody():
        return None

    monkeypatch.setattr(methods, "get_user_credentials", read)
    monkeypatch.setattr(methods, "set_user_credentials", write)
    monkeypatch.setattr(methods, "get_current_request_user_fresh", nobody)
    monkeypatch.setattr(User, "get_local", staticmethod(get_local))

    assert await provider_registry.token_for("google", hub=False) == "new"
    assert stored["value"]["access_token"] == "new"
