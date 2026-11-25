"""cookie-gate local token (FLOWPAD-2233) — created on first request, fail closed.

The middleware is exercised over a bare Starlette app so the gate decides alone:
no lifespan, no DB. ``get_cookie_gate`` (the hub-armed secret) is patched to
``None`` unless a test is about precedence, and the token file lives in tmp_path.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import patch

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

import flow_sdk.server.middleware.cookie_gate_middleware as gate
import flow_sdk.server.middleware.local_cookiegate_middleware as local
from flow_sdk.instance_settings import cookie_gate

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

HUB_SECRET = "hub-armed-secret"
#: The local gate answers this machine's hosts.
LOCAL = "http://localhost:9007"


def _app() -> Starlette:
    async def ok(_request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/", ok), Route("/api/v1/graph/shell", ok, methods=["GET", "POST"]),
                            Route("/sdk/flowpad-sdk.js", ok, methods=["GET", "POST"])])
    app.add_middleware(gate.CookieGateMiddleware)
    return app


def _header(token: str) -> dict[str, str]:
    return {cookie_gate.get_header().name: token}


def test_first_request_creates_a_token_and_is_refused(local_gate):
    client = TestClient(_app(), base_url=LOCAL)

    response = client.get("/")

    assert response.status_code == 403
    token = local_gate.read_text(encoding="utf-8")
    assert len(token) >= 43  # token_urlsafe(32): 32 bytes of entropy
    if sys.platform != "win32":
        assert local_gate.stat().st_mode & 0o777 == 0o600


def test_the_token_admits_and_survives_a_restart(local_gate):
    client = TestClient(_app(), base_url=LOCAL)
    client.get("/")
    token = local_gate.read_text(encoding="utf-8")

    assert client.get("/", headers=_header(token)).status_code == 200

    assert TestClient(_app(), base_url=LOCAL).get("/", headers=_header(token)).status_code == 200
    assert local_gate.read_text(encoding="utf-8") == token


def test_off_switch_without_a_file_passes_and_creates_nothing(local_gate, monkeypatch):
    monkeypatch.setenv(gate.OFF_SWITCH_ENV, "off")

    assert TestClient(_app(), base_url=LOCAL).get("/").status_code == 200
    assert not local_gate.exists()


def test_off_switch_turns_the_gate_off_even_with_a_token_file(local_gate, monkeypatch):
    local_gate.parent.mkdir(parents=True)
    local_gate.write_text("existing-token", encoding="utf-8")
    monkeypatch.setenv(gate.OFF_SWITCH_ENV, "off")

    assert TestClient(_app(), base_url=LOCAL).get("/").status_code == 200


def test_a_token_that_cannot_be_created_fails_closed(tmp_path, monkeypatch):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("", encoding="utf-8")  # the token's parent is a file: mkdir fails
    monkeypatch.delenv(gate.OFF_SWITCH_ENV, raising=False)
    monkeypatch.setattr(cookie_gate, "_token_path", lambda: blocker / ".cookie_gate")

    response = TestClient(_app(), base_url=LOCAL).post("/api/v1/graph/shell")

    assert response.status_code == 403


def test_a_deleted_token_is_replaced_and_the_old_one_stops_working(local_gate):
    client = TestClient(_app(), base_url=LOCAL)
    client.get("/")
    old = local_gate.read_text(encoding="utf-8")

    os.remove(local_gate)

    assert client.get("/", headers=_header(old)).status_code == 403
    new = local_gate.read_text(encoding="utf-8")
    assert new != old
    assert client.get("/", headers=_header(new)).status_code == 200


def test_a_hub_armed_secret_takes_precedence(local_gate):
    with patch.object(cookie_gate, "get_cookie_gate", return_value=HUB_SECRET):
        client = TestClient(_app(), base_url=LOCAL)

        assert client.get("/").status_code == 403
        assert client.get("/", headers=_header(HUB_SECRET)).status_code == 200

    assert not local_gate.exists()


def test_hub_arming_after_startup_is_enforced_on_the_next_request(local_gate):
    """The gate is chosen per request: a sandbox armed after the app was built
    gets the sandbox gate at once, not the local one it started with."""
    client = TestClient(_app(), base_url=LOCAL)
    client.get("/")  # local gate, token created
    token = local_gate.read_text(encoding="utf-8")

    with patch.object(cookie_gate, "get_cookie_gate", return_value=HUB_SECRET):
        assert client.get("/", headers=_header(token)).status_code == 403
        assert client.get("/", headers=_header(HUB_SECRET)).status_code == 200


def test_a_page_this_backend_does_not_serve_passes_on_its_state_key_and_reads_the_sdk(local_gate, tmp_path):
    """A nano-app opened as a ``file://`` is cross-site, so the browser sends it no cookie: the key its opener
    minted is what it presents, and the SDK it loads is public."""
    from flow_sdk.schema.data_spec.page_state_spec import PageState
    from flow_sdk.server import page_state

    page_state.reset_for_tests()
    with patch.object(page_state, "_path", return_value=tmp_path / "page_states.json"):
        key = page_state.mint(PageState(context={"message": "flow_message-1"}))
        client = TestClient(_app(), base_url=LOCAL)

        assert client.get("/sdk/flowpad-sdk.js").status_code == 200
        assert client.post("/sdk/flowpad-sdk.js").status_code == 403, "reading the SDK is all that is open"
        assert client.post("/api/v1/graph/shell", headers={page_state.HEADER: key}).status_code == 200
        assert client.get(f"/api/v1/graph/shell?state={key}").status_code == 200
        assert client.post("/api/v1/graph/shell", headers={page_state.HEADER: "k" * 32}).status_code == 403
        assert client.post("/api/v1/graph/shell").status_code == 403
    page_state.reset_for_tests()
