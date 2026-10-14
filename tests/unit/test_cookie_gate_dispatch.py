"""cookie-gate dispatch — the local token on this machine's hosts, the hub gate from outside.

What gets past the local gate without the token, the desktop cookie the
direct-open grant sets, and which gate a request reaches. Bare Starlette app;
``local_gate`` (tests/pytest_plugin.py) turns the local token on under tmp_path.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import flow_sdk.server.middleware.cookie_gate_middleware as gate
from flow_sdk.instance_settings import cookie_gate

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SECRET = "s3cret"
HEADER = cookie_gate._HEADER_NAME

DIRECT_OPEN = {"sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}


def _gated_app() -> Starlette:
    async def ok(_request):
        return PlainTextResponse("ok")

    async def ws(websocket):
        await websocket.accept()
        await websocket.send_text("hi")
        await websocket.close()

    app = Starlette(
        routes=[Route("/", ok), Route("/api/v1/graph/shell", ok, methods=["POST"]), WebSocketRoute("/ws", ws)]
    )
    app.add_middleware(gate.CookieGateMiddleware)
    return app


@pytest.fixture
def token(local_gate):
    """A created local token, plus a client for the gated app."""
    client = TestClient(_gated_app(), base_url="http://localhost:9007")
    client.get("/")  # first request creates the file
    return client, local_gate.read_text(encoding="utf-8")


def test_poc_null_origin_shell_create_is_refused(token):
    """The ticket's PoC: a sandboxed iframe (Origin: null) POSTs to create a shell."""
    client, _ = token

    response = client.post(
        "/api/v1/graph/shell",
        content='{"name":"poc","workdir":null}',
        headers={"Origin": "null", "Content-Type": "text/plain"},
    )

    assert response.status_code == 403
    assert "type this address into your browser" in response.text


@pytest.mark.parametrize("transport", ["header", "port_cookie", "query"])
def test_each_transport_passes(token, transport):
    client, value = token
    if transport == "header":
        response = client.get("/", headers={HEADER: value})
    elif transport == "port_cookie":
        client.cookies.set("cookie-gate-9007", value)
        response = client.get("/")
    else:
        response = client.get(f"/?cookie-gate={value}")

    assert response.status_code == 200


def test_a_cookie_for_another_port_does_not_pass(token):
    client, value = token
    client.cookies.set("cookie-gate-9008", value)

    assert client.get("/").status_code == 403


@pytest.mark.parametrize("host", ["localhost:9007", "127.0.0.1:9007"])
def test_direct_open_passes_and_sets_the_desktop_cookie(token, host):
    client, value = token

    response = client.get("/", headers={**DIRECT_OPEN, "host": host})

    assert response.status_code == 200
    assert response.headers["set-cookie"].startswith(f"cookie-gate-9007={value};")


@pytest.mark.parametrize(
    "headers",
    [
        {**DIRECT_OPEN, "sec-fetch-site": "cross-site"},
        {**DIRECT_OPEN, "sec-fetch-dest": "iframe"},
        {"sec-fetch-mode": "navigate", "sec-fetch-dest": "document"},  # no Sec-Fetch-Site
        {**DIRECT_OPEN, "host": "evil.example:9007"},  # DNS-rebinding shape
    ],
)
def test_direct_open_grant_is_refused(token, headers):
    client, _ = token

    response = client.get("/", headers=headers)

    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_no_direct_open_grant_through_a_public_url(local_gate):
    """From outside (the box's public URL) the hub gate decides; the grant is local-only."""
    with patch.object(cookie_gate, "get_cookie_gate", return_value=SECRET):
        response = TestClient(_gated_app(), base_url="https://9007-box.e2b.dev").get("/", headers=DIRECT_OPEN)

    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_outside_requests_need_the_hub_secret_not_the_local_token(local_gate):
    with patch.object(cookie_gate, "get_cookie_gate", return_value=SECRET):
        client = TestClient(_gated_app(), base_url="https://9007-box.e2b.dev")
        client.get("/")  # nothing created: the local gate is not involved
        assert not local_gate.exists()

        assert client.post("/api/v1/graph/shell", headers={HEADER: SECRET}).status_code == 200
        assert client.post("/api/v1/graph/shell", headers={HEADER: "guess"}).status_code == 403


def test_a_rebound_host_without_a_hub_secret_gets_the_local_gate(token):
    """DNS rebinding: a non-loopback Host on a desktop is still this machine's browser."""
    client, value = token
    rebound = {"host": "evil.example:9007"}

    assert client.post("/api/v1/graph/shell", headers=rebound).status_code == 403
    assert client.post("/api/v1/graph/shell", headers={**rebound, HEADER: value}).status_code == 200


def test_cors_preflight_passes_but_a_bare_options_does_not(token):
    client, _ = token
    preflight = client.options(
        "/api/v1/graph/shell",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
    )
    bare = client.options("/api/v1/graph/shell")

    assert preflight.status_code != 403
    assert bare.status_code == 403


def test_websocket_needs_the_token(token):
    client, value = token

    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/ws"):
            pass
    assert refused.value.code == 1008

    # TestClient ignores base_url and its cookie jar on WS, so Host and Cookie go in explicitly.
    headers = {"host": "localhost:9007", "cookie": f"cookie-gate-9007={value}"}
    with client.websocket_connect("/ws", headers=headers) as ws:
        assert ws.receive_text() == "hi"
