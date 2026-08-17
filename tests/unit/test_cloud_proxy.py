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
from starlette.requests import Request

from flow_sdk.cloud_client.transport.proxy import CloudProxy


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


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize("status", [200, 400, 500])
async def test_cloudproxy_delivers_the_hub_body_verbatim(monkeypatch, status):
    """The proxied body must reach the caller intact — at every status.

    The shared client's response hook reads the body to report hub 4xx/5xx (and
    to sniff auth-failure envelopes on 2xx JSON). On a proxied hop that read
    would consume the stream, so ``aiter_raw()`` raises ``StreamConsumed`` after
    the headers — including the hub's Content-Length — have already been sent,
    and the browser reports a bare "Network Error" instead of the hub's message.
    The passthrough marker on the forwarded request is what keeps the hook out.
    """
    import flow_sdk.cloud_client.client_hooks as hooks

    class Reporter:
        def __init__(self):
            self.reports = []

        async def report(self, **kwargs):
            self.reports.append(kwargs)

    reporter = Reporter()
    monkeypatch.setattr(hooks, "hub_error_reporter", reporter)

    body = b'{"status":"fail","message":"hub said no"}'

    async def handler(request: httpx.Request) -> httpx.Response:
        # An async-iterator body, like a real network response: unread until
        # someone streams it. (Passing `content=bytes` would hand back an
        # already-consumed stream and prove nothing about the hook.)
        async def stream():
            yield body

        return httpx.Response(
            status,
            content=stream(),
            headers={
                "content-type": "application/json",
                "content-length": str(len(body)),
            },
        )

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        event_hooks={"response": [hooks._on_response]},
    )
    proxy = CloudProxy.__new__(CloudProxy)
    proxy._client = lambda: _resolved(client)  # type: ignore[method-assign]

    try:
        out = await proxy(_make_request("GET", {}), url="https://hub.example/api/v1/x")
        streamed = b"".join([chunk async for chunk in out.body_iterator])
    finally:
        await client.aclose()

    assert out.status_code == status
    assert streamed == body
    assert out.headers["content-length"] == str(len(body))
    if status >= 400:
        # Status still reported; the message comes from the status alone because
        # the body belongs to the caller downstream.
        assert reporter.reports == [
            {
                "status_code": status,
                "method": "GET",
                "path": "/api/v1/x",
                "message": f"HTTP {status}",
            }
        ]


async def _resolved(value):
    return value
