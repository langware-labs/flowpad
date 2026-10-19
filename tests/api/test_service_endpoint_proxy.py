"""``service_endpoint/<id>/service`` and ``/direct-url`` on this tier, over the real app.

The service is ``ServiceUpstream`` — a real server on a loopback port — and the
requests go through the real FastAPI app in-process, so the middleware stack
(cookie gate, request transaction, JSON relabel) is the one production runs.

One round trip per protocol an endpoint can expose, pinning the traffic SHAPE the
protocol depends on (a streamed body, a session header, binary frames, a close
code) in both directions. WebSocket relaying is exercised on the relay function
itself (below) — the endpoint resolution in front of it is the same one the HTTP
tests drive.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
import time
import uuid

import pytest
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.service_endpoint_spec import (
    PROTOCOL_API_CHAT_OPENAI,
    PROTOCOL_API_MCP,
    PROTOCOL_API_REST,
    PROTOCOL_WEB_APP,
)
from flow_sdk.server.routes.service_endpoint import _hub_socket_target
from flow_sdk.server.service_proxy import CALLER_HEADER, GATE_HEADER, USER_HEADER, outbound_headers, sign_caller
from flow_sdk.server.service_serving import http_client as _http
from flow_sdk.server.service_serving import relay_websocket
from tests.utils.service_upstream import ServiceUpstream, grpc_web_frame

GATE = "gate-secret-for-tests"


@pytest.fixture(scope="module")
def upstream():
    server = ServiceUpstream().start()
    yield server
    server.stop()


async def _endpoint(upstream=None, **over) -> ServiceEndpoint:
    data = {
        "name": "api",
        "parent_type_id": f"deployment-{uuid.uuid4()}",
        "protocol": {"spec_kind": PROTOCOL_API_REST},
        "backend": {"type": "proxy", "port": upstream.port if upstream else 8765},
    }
    data.update(over)
    endpoint = ServiceEndpoint(**data)
    await endpoint.save()
    return endpoint


def _url(endpoint, sub: str = "") -> str:
    return f"/api/v1/graph/service_endpoint/{endpoint.id}/service/{sub}"


def _headers(entry) -> dict:
    return {k: v for k, v in entry["headers"]}


# =============================================================================
# api.rest
# =============================================================================


async def test_rest_round_trip_carries_method_path_query_and_raw_body(client, upstream):
    endpoint = await _endpoint(upstream)
    body = bytes(range(256)) * 4
    resp = await client.post(_url(endpoint, "echo") + "?a=1&b=%20x", content=body)
    assert resp.status_code == 200, resp.text
    seen = resp.json()
    assert (seen["method"], seen["path"], seen["query"]) == ("POST", "/echo", "a=1&b=%20x")
    assert seen["body_sha"] == hashlib.sha256(body).hexdigest()
    assert resp.headers["x-upstream"] == "yes"


@pytest.mark.parametrize("method", ["GET", "PUT", "PATCH", "DELETE"])
async def test_every_method_is_relayed_verbatim(client, upstream, method):
    endpoint = await _endpoint(upstream)
    resp = await client.request(method, _url(endpoint, "echo"), content=b"x" if method != "GET" else None)
    assert resp.status_code == 200, resp.text
    assert resp.json()["method"] == method


async def test_a_form_labelled_json_body_keeps_its_label(client, upstream):
    """The JSON-relabel middleware must not touch a body that belongs to the service."""
    endpoint = await _endpoint(upstream)
    resp = await client.post(
        _url(endpoint, "echo"), content=b'{"a": 1}', headers={"content-type": "application/x-www-form-urlencoded"}
    )
    assert resp.status_code == 200, resp.text
    assert _headers(resp.json())["content-type"] == "application/x-www-form-urlencoded"
    assert base64.b64decode(resp.json()["body_b64"]) == b'{"a": 1}'


async def test_status_and_redirects_are_relayed_not_interpreted(client, upstream):
    endpoint = await _endpoint(upstream)
    for code in (201, 404, 500):
        resp = await client.get(_url(endpoint, f"status/{code}"))
        assert (resp.status_code, resp.content) == (code, b"status body")
    resp = await client.get(_url(endpoint, "redirect"))
    assert (resp.status_code, resp.headers["location"]) == (302, "/elsewhere")


async def test_flowpad_credentials_never_reach_the_service(client, upstream):
    endpoint = await _endpoint(upstream)
    resp = await client.get(
        _url(endpoint, "echo"),
        headers={"authorization": "Bearer flowpad", "cookie": "s=1", GATE_HEADER: "g", USER_HEADER: "forged"},
    )
    seen = _headers(resp.json())
    for name in ("authorization", "cookie", GATE_HEADER, USER_HEADER):
        assert name not in seen, name
    assert "set-cookie" not in resp.headers, "a service must not set cookies on FlowPad's origin"


async def test_only_a_caller_signed_with_this_machines_gate_reaches_the_service(client, upstream, monkeypatch):
    import flow_sdk.instance_settings.cookie_gate as gate

    monkeypatch.setattr(gate, "get_cookie_gate", lambda: GATE)
    endpoint = await _endpoint(upstream)
    caller = f"user-{uuid.uuid4()}"

    hop = {GATE_HEADER: GATE}  # the hub's hop: through the armed door with the secret
    signed = await client.get(
        _url(endpoint, "echo"), headers={**hop, CALLER_HEADER: sign_caller(caller, GATE, now=int(time.time()))}
    )
    assert _headers(signed.json())[USER_HEADER] == caller

    forged = await client.get(
        _url(endpoint, "echo"), headers={**hop, CALLER_HEADER: sign_caller(caller, "wrong", now=int(time.time()))}
    )
    assert USER_HEADER not in _headers(forged.json())


async def test_a_dot_segment_cannot_leave_the_service(client, upstream):
    endpoint = await _endpoint(upstream)
    before = len(upstream.seen)
    resp = await client.get(_url(endpoint) + "%2E%2E/%2E%2E/etc")
    assert resp.status_code in (400, 404)
    assert len(upstream.seen) == before


async def test_an_unknown_endpoint_is_404(client):
    resp = await client.get(f"/api/v1/graph/service_endpoint/{uuid.uuid4()}/service/echo")
    assert resp.status_code == 404


async def test_a_service_that_is_down_is_502(client):
    endpoint = await _endpoint(backend={"type": "proxy", "port": 1})
    resp = await client.get(_url(endpoint, "echo"))
    assert resp.status_code == 502


# =============================================================================
# api.chat.openai — JSON and SSE
# =============================================================================


async def test_openai_chat_json(client, upstream):
    endpoint = await _endpoint(upstream, name="chat", protocol={"spec_kind": PROTOCOL_API_CHAT_OPENAI})
    resp = await client.post(
        _url(endpoint, "v1/chat/completions"), json={"model": "m", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["choices"][0]["message"]["content"] == "Hello from the box"


async def test_openai_chat_streams_server_sent_events(client, upstream):
    endpoint = await _endpoint(upstream, name="chat", protocol={"spec_kind": PROTOCOL_API_CHAT_OPENAI})
    resp = await client.post(_url(endpoint, "v1/chat/completions"), json={"model": "m", "stream": True, "messages": []})
    assert resp.headers["content-type"].startswith("text/event-stream")
    data = [line[6:] for line in resp.text.splitlines() if line.startswith("data: ")]
    assert data[-1] == "[DONE]"
    assert "".join(json.loads(d)["choices"][0]["delta"]["content"] for d in data[:-1]) == "Hello from the box"


async def test_the_relay_streams_rather_than_buffers(upstream):
    """The in-process test client buffers, so incremental delivery is proven on the
    relay's own client: the second event is held until the first has arrived."""
    response = await _http().send(_http().build_request("GET", f"http://127.0.0.1:{upstream.port}/gated"), stream=True)
    try:
        chunks = response.aiter_raw()
        first = await chunks.__anext__()
        assert b"first" in first and b"second" not in first
        upstream.release.set()
        assert b"second" in b"".join([c async for c in chunks])
    finally:
        await response.aclose()


# =============================================================================
# api.mcp — streamable HTTP
# =============================================================================


async def test_mcp_session_round_trip(client, upstream):
    endpoint = await _endpoint(upstream, name="mcp", protocol={"spec_kind": PROTOCOL_API_MCP})
    init = await client.post(_url(endpoint, "mcp"), json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    session = init.headers["mcp-session-id"]
    assert '"protocolVersion": "2025-06-18"' in init.text
    stream = await client.get(_url(endpoint, "mcp"), headers={"mcp-session-id": session})
    assert "notifications/message" in stream.text
    assert (await client.delete(_url(endpoint, "mcp"), headers={"mcp-session-id": session})).status_code == 204


# =============================================================================
# web.app — a static backend served from a folder
# =============================================================================


async def test_static_backend_serves_documents_with_conditional_get(client, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>app</title>")
    (tmp_path / "app.js").write_text("console.log('app')")
    endpoint = await _endpoint(
        name="app", protocol={"spec_kind": PROTOCOL_WEB_APP}, backend={"type": "static", "root": str(tmp_path)}
    )

    script = await client.get(_url(endpoint, "app.js"))
    assert script.status_code == 200 and script.text == "console.log('app')"
    cached = await client.get(_url(endpoint, "app.js"), headers={"if-none-match": script.headers["etag"]})
    assert cached.status_code == 304

    routed = await client.get(_url(endpoint, "some/client/route"))
    assert routed.status_code == 200 and "<title>app</title>" in routed.text, "an app route falls back to index.html"


# =============================================================================
# gRPC-Web
# =============================================================================


async def test_grpc_web_frames_round_trip(client, upstream):
    endpoint = await _endpoint(upstream, name="grpc", protocol={"spec_kind": "--acme--.api.grpc_web"})
    resp = await client.post(
        _url(endpoint, "echo.Echo/Say"),
        content=grpc_web_frame(b"\x0a\x05hello"),
        headers={"content-type": "application/grpc-web+proto", "x-grpc-web": "1"},
    )
    flag, length = struct.unpack(">BI", resp.content[:5])
    assert (flag, resp.content[5 : 5 + length]) == (0, b"echo:\x0a\x05hello")
    assert resp.content[5 + length] == 0x80


# =============================================================================
# WebSocket — the relay itself, against the real service
# =============================================================================


def _relay_app(target: str) -> Starlette:
    async def relay(websocket):
        headers = outbound_headers(websocket.headers.items(), user=None, websocket=True)
        await relay_websocket(websocket, target, headers, subprotocols=websocket.scope.get("subprotocols") or None)

    return Starlette(routes=[WebSocketRoute("/relay", relay)])


def test_websocket_relays_text_binary_and_the_subprotocol(upstream):
    with TestClient(_relay_app(f"ws://127.0.0.1:{upstream.port}/ws/echo")) as tc:
        with tc.websocket_connect("/relay", subprotocols=["graphql-ws"]) as ws:
            assert ws.accepted_subprotocol == "graphql-ws"
            ws.send_text("ping")
            assert ws.receive_text() == "echo:ping"
            ws.send_bytes(b"\x01\x02\x03")
            assert ws.receive_bytes() == b"\x03\x02\x01"


def test_websocket_close_code_is_carried_to_the_caller(upstream):
    with TestClient(_relay_app(f"ws://127.0.0.1:{upstream.port}/ws/echo")) as tc:
        with tc.websocket_connect("/relay") as ws:
            ws.send_text("close-4001")
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_text()
    assert closed.value.code == 4001


def test_a_dead_websocket_service_refuses_the_handshake():
    with TestClient(_relay_app("ws://127.0.0.1:1/ws/echo")) as tc:
        with pytest.raises(WebSocketDisconnect) as refused:
            with tc.websocket_connect("/relay"):
                pass
    assert refused.value.code == 1013


async def test_a_remote_endpoints_socket_goes_to_the_hubs_service_route_with_certifi_tls(monkeypatch):
    from types import SimpleNamespace

    import flow_sdk.cli.auth.credentials as credentials
    from flow_sdk.cloud_client.transport import hub_http

    monkeypatch.setattr(hub_http, "hub_base_url", lambda: "https://hub.example")
    monkeypatch.setattr(credentials, "load_credentials", lambda: SimpleNamespace(api_key="k"))
    monkeypatch.setenv("FLOWPAD_HUB_URL", "https://hub.example")
    endpoint = await _endpoint(remote=True)

    base, auth, ssl_context = _hub_socket_target(endpoint)

    assert base.startswith("wss://") and base.endswith(f"/graph/service_endpoint/{endpoint.id}/service")
    assert auth == [("authorization", "Bearer k")]
    assert ssl_context is not None, "a wss hub socket trusts certifi, as every other hub socket does"


# =============================================================================
# A cloud endpoint (a hub row) is forwarded to the hub's service route
# =============================================================================


async def test_a_remote_endpoint_is_forwarded_to_the_hub(client, monkeypatch):
    hub = ServiceUpstream(prefix="/api/v1/graph/service_endpoint/{eid}").start()
    try:
        from flow_sdk.cloud_client.transport import hub_http

        monkeypatch.setattr(hub_http, "hub_base_url", lambda: f"http://127.0.0.1:{hub.port}")
        endpoint = await _endpoint(remote=True)
        resp = await client.post(_url(endpoint, "echo") + "?q=1", content=b"payload")
        assert resp.status_code == 200, resp.text
        seen = resp.json()
        assert seen["path"] == f"/api/v1/graph/service_endpoint/{endpoint.id}/service/echo"
        assert seen["query"] == "q=1"
        assert base64.b64decode(seen["body_b64"]) == b"payload"
    finally:
        hub.stop()


async def test_a_remote_endpoint_with_no_hub_is_409(client, monkeypatch):
    from flow_sdk.cloud_client.transport import hub_http

    monkeypatch.setattr(hub_http, "hub_base_url", lambda: None)
    endpoint = await _endpoint(remote=True)
    assert (await client.get(_url(endpoint, "echo"))).status_code == 409


# =============================================================================
# direct-url
# =============================================================================


def _direct(endpoint, query: str = "") -> str:
    return f"/api/v1/graph/service_endpoint/{endpoint.id}/direct-url{query}"


def _app_proxy(**over):
    """A placement's ``app`` proxy: a routed row, one dev server at its root."""
    routes = {"": {"backend": {"type": "proxy", "port": 8765}}, "shop": {"backend": {"type": "static", "root": "/srv"}}}
    data = {
        "name": "app",
        "subkind": "app",
        "protocol": {"spec_kind": PROTOCOL_WEB_APP},
        "backend": {"type": "routed", "routes": routes},
        "supports_direct_access": True,
    }
    data.update(over)
    return _endpoint(**data)


async def test_direct_url_on_a_desktop_is_the_dev_servers_own_loopback_address(client):
    """The viewer sits at the machine and nothing is published: the process answers at localhost."""
    endpoint = await _app_proxy()
    resp = await client.get(_direct(endpoint))
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["url"] == "http://localhost:8765"
    redirected = await client.get(_direct(endpoint, "?redirect=1"))
    assert (redirected.status_code, redirected.headers["location"]) == (302, "http://localhost:8765")


async def test_direct_url_is_refused_when_unsupported_static_or_not_a_browser_door(client):
    assert (await client.get(_direct(await _app_proxy(supports_direct_access=False)))).status_code == 409
    static = await _app_proxy()
    assert (await client.get(_direct(static, "?route=shop"))).status_code == 409, (
        "a folder has no address of its own here"
    )
    assert (await client.get(_direct(static, "?route=nope"))).status_code == 404
    service = await _endpoint(supports_direct_access=True, backend={"type": "proxy", "port": 8765})
    assert (await client.get(_direct(service))).status_code == 409, "a machine service is reached through the hub"


async def test_direct_url_on_a_box_the_hub_placed_is_the_hubs_answer(client, monkeypatch):
    """A hub-placed box (E2B or GCP, sandbox or agent) does not build its own address: the hub holds the row at
    the same id and knows the provider's door for it now — a published door, or its relaying audience host."""
    import flow_sdk.instance_settings.runtime as runtime
    from flow_sdk.cloud_client.transport import hub_http

    asked = []

    async def hub_get(entity_type, entity_id=None, action=None, sub_path=None, **kwargs):
        asked.append((str(entity_type), entity_id, action, kwargs.get("params")))
        return {"url": "https://app--d.flowpad.app/shop/"}

    monkeypatch.setattr(
        runtime, "get_assigned_compute_node", lambda: "compute_node-00000000-0000-4000-8000-000000000001"
    )
    monkeypatch.setattr(hub_http, "hub_get", hub_get)
    users = await _app_proxy()
    resp = await client.get(_direct(users, "?route=shop"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["url"] == "https://app--d.flowpad.app/shop/"
    assert asked == [("service_endpoint", users.id, "direct-url", {"route": "shop"})]


async def test_direct_url_of_a_placement_the_hub_never_made_is_answered_on_the_box(client, monkeypatch):
    """A hub-placed box also has placements of its own (a project the hub never placed): the hub holds no row for
    them, so the box answers as it did before instead of failing the display."""
    import flow_sdk.instance_settings.runtime as runtime
    from flow_sdk.cloud_client.transport import hub_http

    async def hub_get(*args, **kwargs):
        return None

    monkeypatch.setattr(
        runtime, "get_assigned_compute_node", lambda: "compute_node-00000000-0000-4000-8000-000000000001"
    )
    monkeypatch.setattr(hub_http, "hub_get", hub_get)
    resp = await client.get(_direct(await _app_proxy()))
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["url"] == "http://localhost:8765"


async def test_direct_url_inside_a_sandbox_is_the_boxs_door_never_the_port(client, monkeypatch):
    """On a box whose ports are public, the process's port would be a door with no lock: the browser is sent to
    the audience door (``AUDIENCE_PORTS``), which admits it by its grant and reaches the process over loopback."""
    import functools

    import flow_sdk.instance_settings.runtime as runtime
    from flow_sdk.instance_settings.base_settings import AUDIENCE_PORTS

    # Keeps the memo's interface: the suite's teardown calls ``cache_clear`` on it.
    monkeypatch.setattr(runtime, "own_sandbox_id", functools.lru_cache(maxsize=1)(lambda: "sbx123"))
    users = await _app_proxy()
    operators = await _app_proxy(name="admin", subkind="admin")
    resp = await client.get(_direct(users))
    assert resp.json()["data"]["url"] == f"https://{AUDIENCE_PORTS['app']}-sbx123.e2b.dev/"
    assert "8765" not in resp.json()["data"]["url"]
    shop = await client.get(_direct(users, "?route=shop"))
    assert shop.json()["data"]["url"] == f"https://{AUDIENCE_PORTS['app']}-sbx123.e2b.dev/shop/"
    admin = await client.get(_direct(operators))
    assert admin.json()["data"]["url"] == f"https://{AUDIENCE_PORTS['admin']}-sbx123.e2b.dev/"


# =============================================================================
# A static app's <base>: where the BROWSER is, never the request's own path
# =============================================================================


async def _static_site(tmp_path):
    (tmp_path / "index.html").write_text(
        "<!doctype html><html><head></head><body><script src=app.js></script></body></html>"
    )
    (tmp_path / "app.js").write_text("console.log('served')")
    return await _endpoint(
        name="site", protocol={"spec_kind": PROTOCOL_WEB_APP}, backend={"type": "static", "root": str(tmp_path)}
    )


def _base_of(html: str) -> str:
    import re

    return re.search(r'<base href="([^"]+)"', html).group(1)


async def test_a_deep_link_is_based_at_the_endpoint_root_and_its_asset_resolves(client, tmp_path):
    endpoint = await _static_site(tmp_path)
    page = await client.get(_url(endpoint, "about/team"))
    base = _base_of(page.text)
    assert base == f"http://testserver/api/v1/graph/service_endpoint/{endpoint.id}/service/"
    from urllib.parse import urljoin, urlsplit

    asset = await client.get(urlsplit(urljoin(base, "app.js")).path)
    assert asset.status_code == 200 and asset.text == "console.log('served')"


async def test_behind_the_hub_the_page_is_based_where_the_hub_serves_it(client, tmp_path, monkeypatch):
    import flow_sdk.instance_settings.cookie_gate as gate

    monkeypatch.setattr(gate, "get_cookie_gate", lambda: GATE)
    endpoint = await _static_site(tmp_path)
    own_origin = {
        GATE_HEADER: GATE,
        "x-forwarded-host": f"{endpoint.id}.flowpad.app",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/",
    }
    page = await client.get(_url(endpoint), headers=own_origin)
    assert _base_of(page.text) == f"https://{endpoint.id}.flowpad.app/"


async def test_a_client_cannot_move_the_pages_assets(client, tmp_path, monkeypatch):
    import flow_sdk.instance_settings.cookie_gate as gate
    from flow_sdk.server import grants
    from flow_sdk.server.service_proxy import SYSTEM_AUDIENCE, SYSTEM_ENDPOINT, Grant

    monkeypatch.setattr(gate, "get_cookie_gate", lambda: GATE)
    endpoint = await _static_site(tmp_path)
    # A browser at the armed door (a grant), claiming to be the hub's hop (a wrong gate header).
    forged = {GATE_HEADER: "not-the-gate", "x-forwarded-host": "evil.example", "x-forwarded-prefix": "/"}
    cookies = {grants.COOKIE_NAME: grants.mint_grant(Grant("user-x", SYSTEM_AUDIENCE, SYSTEM_ENDPOINT), secret=GATE)}
    page = await client.get(_url(endpoint), headers=forged, cookies=cookies)
    assert "evil.example" not in _base_of(page.text)
