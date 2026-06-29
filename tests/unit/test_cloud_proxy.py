"""Unit tests for the transparent HTTP CloudProxy.

The full behavioral matrix (49 cases: CRUD, params, uploads, downloads,
streaming, framing, lifecycle) was validated with a standalone two-server
harness before the class landed. These fast tests lock the load-bearing
invariant in-repo: the proxy carries the HTTP method **verbatim** and strips
hop-by-hop + Host + stale Authorization on the forwarded request — i.e. it can
never turn a roster GET into a destructive DELETE.
"""
from __future__ import annotations

import httpx
import pytest

from flow_sdk.cloud_client.transport.proxy import CloudProxy
from starlette.requests import Request


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
    proxy = CloudProxy.__new__(CloudProxy)  # no network — we only exercise _build
    client = httpx.AsyncClient()
    target = httpx.URL("https://hub.example/api/v1/graph/conversation/c1/members")
    try:
        for method in ("GET", "DELETE", "POST", "PUT", "PATCH", "REPORT"):
            req = _make_request(method, {
                "host": "client.invalid",
                "connection": "keep-alive",
                "keep-alive": "timeout=5",
                "upgrade": "h2c",
                "authorization": "Bearer stale-client-token",
                "x-end-to-end": "keep-me",
            })
            built = proxy._build(client, req, target)
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
