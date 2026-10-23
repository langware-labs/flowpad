"""Unit tests for the transparent HTTP forwarding in HubProxy.

The full behavioral matrix (49 cases: CRUD, params, uploads, downloads,
streaming, framing, lifecycle) was validated with a standalone two-server
harness before the class landed. These fast tests lock the load-bearing
invariant in-repo: the proxy carries the HTTP method **verbatim** and strips
hop-by-hop + Host + stale Authorization on the forwarded request — i.e. it can
never turn a roster GET into a destructive DELETE.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from starlette.requests import Request

from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.transport import hub_http


def _make_request(method: str, headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": "/api/v1/graph/conversation/c1/members",
        "raw_path": b"/api/v1/graph/conversation/c1/members",
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "scheme": "http",
        "server": ("local", 80),
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(scope, receive)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_cloudproxy_carries_method_verbatim_and_strips_hop_by_hop():
    client = httpx.AsyncClient()
    target = httpx.URL("https://hub.example/api/v1/graph/conversation/c1/members")
    try:
        for method in ("GET", "DELETE", "POST", "PUT", "PATCH", "REPORT"):
            req = _make_request(
                method,
                {
                    "host": "client.invalid",
                    "connection": "keep-alive",
                    "keep-alive": "timeout=5",
                    "upgrade": "h2c",
                    "authorization": "Bearer stale-client-token",
                    "x-end-to-end": "keep-me",
                },
            )
            built = client.build_request(method, target, headers=HubProxy.outbound_headers(list(req.headers.raw)))
            seen = {k.lower() for k in built.headers}

            # The whole point: the verb is carried, never inferred.
            assert built.method == method
            # The client's hop-by-hop headers must not leak end-to-end. (httpx
            # adds its own `Connection` for the proxy↔hub link — that's the proxy
            # managing its own transport, not a forwarded client value.)
            assert "keep-alive" not in seen
            assert "upgrade" not in seen
            # Stale client Authorization dropped (the FlowpadClient request hook
            # injects the live bearer at send time, not from the inbound header).
            assert built.headers.get("authorization") != "Bearer stale-client-token"
            # Host is the hub's authority, never the client's.
            assert built.headers.get("host") != "client.invalid"
            assert built.url.host == "hub.example"
            # End-to-end headers pass through.
            assert built.headers.get("x-end-to-end") == "keep-me"
    finally:
        await client.aclose()


async def _resolved(value):
    return value


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_cloudproxy_reuses_one_hub_connection_across_requests(tmp_path, monkeypatch):
    """20 proxied requests through ``HubProxy.forward`` (the per-request call shape)
    open ONE hub connection — not one per call left for the GC to close. The
    hub is a real keep-alive HTTP/1.1 server on a unix socket in ``tmp_path``;
    the shared hub client is pointed at it through its transport."""
    accepted = 0

    async def _serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal accepted
        accepted += 1
        body = b'{"status":"success","data":{"ok":true}}'
        try:
            while True:
                await reader.readuntil(b"\r\n\r\n")
                writer.write(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
                    b"content-length: %d\r\n\r\n" % len(body) + body
                )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    monkeypatch.chdir(tmp_path)  # sun_path is 104 bytes on macOS; dial a relative path
    server = await asyncio.start_unix_server(_serve, path="hub.sock")
    shared = FlowpadClient(ApiConfig.from_env(), transport=httpx.AsyncHTTPTransport(uds="hub.sock"))
    monkeypatch.setattr(hub_http, "_shared_client", shared)
    monkeypatch.setattr(hub_http, "_shared_client_loop", asyncio.get_running_loop())
    try:
        for _ in range(20):
            resp = await HubProxy.forward(_make_request("GET", {}), "http://hub.example/api/v1/graph/x")
            assert resp.status_code == 200
            async for _ in resp.body_iterator:  # what Starlette does: stream, then run .background
                pass
            await resp.background()
        assert accepted == 1
    finally:
        await hub_http.close_hub_client()
        server.close()
        await server.wait_closed()
