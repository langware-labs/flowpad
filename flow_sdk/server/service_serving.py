"""Serving a ``ServiceEndpoint`` that lives on THIS machine — the half every door shares.

Two doors hand requests here: the ``service`` path route on the box's own UI port
(``routes/service_endpoint.py``, reached by the hub's relay and by this machine's own
UI) and the audience listeners (``audience_listener.py``, reached by a browser holding a
grant). Both resolve the same ``routed`` backend to a route, and dispatch the same way:
a folder is served as documents, a loopback port is proxied (HTTP and WebSocket), a
channel is answered. What differs is only WHO the service is told about and WHERE the
browser is — the two parameters of :func:`serve_http` / :func:`serve_socket`.
"""

from __future__ import annotations

import asyncio
import time
from http.cookiejar import DefaultCookiePolicy
from pathlib import Path
from typing import Any, Optional

import httpx
import websockets
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.websockets import WebSocket
from websockets.exceptions import ConnectionClosed

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.core.dev_server import LOOPBACK_HOST
from flow_sdk.server.service_proxy import (
    CALLER_HEADER,
    inbound_headers,
    outbound_headers,
    public_base,
    upstream_path,
    verify_caller,
)

WS_POLICY = 1008
WS_UNAVAILABLE = 1013

_client: Optional[tuple[asyncio.AbstractEventLoop, httpx.AsyncClient]] = None


def http_client() -> httpx.AsyncClient:
    """One outbound client for every local service.

    No read/write timeout: a relayed stream is idle for as long as the service
    decides, and the caller's connection ends it. Redirects are relayed, never
    followed. The cookie jar stores nothing — the client is shared by every
    endpoint and every caller, so a kept ``Set-Cookie`` would be replayed to all
    of them (the policy goes on the client's OWN jar; httpx copies a passed one).
    """
    global _client
    loop = asyncio.get_running_loop()
    if _client is None or _client[0] is not loop:
        # Keyed by loop: a pooled connection belongs to the loop that opened it.
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=None, write=None, pool=10.0),
            limits=httpx.Limits(max_connections=256, max_keepalive_connections=32),
            follow_redirects=False,
        )
        client.cookies.jar.set_policy(DefaultCookiePolicy(allowed_domains=[]))
        _client = (loop, client)
    return _client[1]


def fail(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"status": "fail", "message": message, "data": None})


def verified_user(headers: Any) -> Optional[str]:
    """The caller the hub vouched for with this machine's gate secret, if any."""
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate  # noqa: PLC0415

    return verify_caller(headers.get(CALLER_HEADER), get_cookie_gate(), now=int(time.time()))


def served(endpoint: ServiceEndpoint, sub_path: str) -> Optional[tuple[Any, Optional[str], str]]:
    """``(backend, mount, path under it)`` that answers *sub_path* — the endpoint's own backend (no mount),
    or, on an audience proxy, the route the path lands on. None when the proxy routes nothing there."""
    backend = endpoint.backend
    if backend.type != "routed":
        return backend, None, sub_path
    mount, rest = backend.resolve(sub_path)
    return None if mount is None else (backend.routes[mount].backend, mount, rest)


async def serve_http(
    request: Request, endpoint: ServiceEndpoint, sub_path: str, *, user: Optional[str], base_root: Optional[str] = None
) -> Response:
    """Answer *request* for *sub_path* of *endpoint* from this machine.

    ``user`` is the caller the service is told about (``X-Flowpad-User``): one this tier
    verified, never one a client claimed. ``base_root`` is where the BROWSER is when it is a
    door of this box (an audience listener's origin); unsaid, it is read off the hub's
    gate-authenticated hop or defaults to this tier's own path.
    """
    found = served(endpoint, sub_path)
    if found is None:
        return fail(404, "no app is served at this path")
    backend, mount, sub_path = found
    try:
        # Validated once, after the mount is stripped: the dot-segment refusal and the re-quoting.
        path = upstream_path(sub_path, request.url.query)
    except ValueError as e:
        return fail(400, str(e))
    if backend.type == "static":
        return await serve_static(request, endpoint, backend.root, sub_path, mount, base_root=base_root)
    if backend.type == "channel":
        from flow_sdk.server.routes.service_channel import channel_http  # noqa: PLC0415

        return await channel_http(request, endpoint, sub_path, user)
    return await proxy_http(request, backend.port, path, user=user)


async def serve_socket(websocket: WebSocket, endpoint: ServiceEndpoint, sub_path: str, *, user: Optional[str]) -> None:
    """Relay a WebSocket for *sub_path* of *endpoint* to the loopback port that serves it."""
    found = served(endpoint, sub_path)
    if found is None or found[0].type != "proxy":
        await close(websocket, WS_POLICY, "a static endpoint has no socket")
        return
    try:
        url = f"ws://{LOOPBACK_HOST}:{found[0].port}{upstream_path(found[2], websocket.url.query)}"
    except ValueError:
        await close(websocket, WS_POLICY, "Invalid path")
        return
    headers = outbound_headers(websocket.headers.items(), user=user, websocket=True)
    await relay_websocket(websocket, url, headers, subprotocols=websocket.scope.get("subprotocols") or None)


async def serve_static(
    request: Request,
    endpoint: ServiceEndpoint,
    root: str,
    sub_path: str,
    mount: Optional[str] = None,
    *,
    base_root: Optional[str] = None,
) -> Response:
    """Serve a folder — the endpoint's own, or one route's — its documents based at where the BROWSER is.

    At a door of this box that is the door's origin (*base_root*). Behind the hub it is the
    hub's address for this endpoint (its own origin, or the hub's path), which only the hub's
    gate-authenticated hop may state; otherwise it is this tier's endpoint root. Never the
    request's own path. A route's documents are based one segment deeper, at its mount.
    """
    from flow_sdk.builtin.faas.serve_static import _browser_scheme, serve_app_bytes  # noqa: PLC0415
    from flow_sdk.config import default_service_config  # noqa: PLC0415
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate  # noqa: PLC0415

    if base_root is not None:
        base = base_root.rstrip("/") + "/"
    else:
        scheme_config = default_service_config.service_urls_config.api_url_scheme
        base = public_base(
            request.headers,
            gate_secret=get_cookie_gate(),
            scheme=_browser_scheme(request, scheme_config),
            host=request.headers.get("host") or request.url.netloc,
            endpoint_id=endpoint.id,
        )
    if mount:
        base = base.rstrip("/") + "/" + mount + "/"
    return await serve_app_bytes(
        Path(root),
        sub_path,
        request,
        base_url=base,
        # Revalidated, never trusted for an hour: a served folder may be under
        # edit (`app.js` keeps its name across edits), and the ETag makes an
        # unchanged file a cheap 304.
        cache_control="no-cache",
    )


async def proxy_http(request: Request, port: int, path: str, *, user: Optional[str]) -> Response:
    url = f"http://{LOOPBACK_HOST}:{port}{path}"
    headers = outbound_headers(request.headers.items(), user=user)
    has_body = request.headers.get("content-length", "0") != "0" or "chunked" in request.headers.get(
        "transfer-encoding", ""
    )
    client = http_client()
    outgoing = client.build_request(
        request.method, url, headers=headers, content=request.stream() if has_body else None
    )
    try:
        upstream = await client.send(outgoing, stream=True)
    except httpx.RequestError:
        return fail(502, "the service did not answer")
    response = StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, background=BackgroundTask(upstream.aclose)
    )
    response.raw_headers = [
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in inbound_headers(upstream.headers.multi_items())
    ]
    return response


async def close(websocket: WebSocket, code: int, reason: str) -> None:
    """Close the caller's socket; a caller that is already gone is not an error."""
    try:
        await websocket.close(code=code, reason=reason[:120])
    except Exception:  # noqa: BLE001 -- RuntimeError / anyio.ClosedResourceError: already closed
        pass


async def relay_websocket(
    websocket: WebSocket,
    url: str,
    headers: list[tuple[str, str]],
    *,
    subprotocols: Optional[list[str]] = None,
    ssl: Any = None,
) -> None:
    """Dial *url*, accept the caller with the upstream's subprotocol, and pump frames both ways.

    The upstream is dialled BEFORE the caller is accepted, so a service that is
    down refuses the handshake instead of accepting and dropping. Close codes are
    carried across in both directions. ``subprotocols`` are the caller's offer
    (Starlette already parsed them into the scope).
    """
    try:
        upstream = await websockets.connect(url, additional_headers=headers, subprotocols=subprotocols, ssl=ssl)
    except Exception:  # noqa: BLE001 -- any dial failure is "the service did not answer"
        await close(websocket, WS_UNAVAILABLE, "the service did not answer")
        return
    await websocket.accept(subprotocol=upstream.subprotocol)

    async def to_upstream():
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                await upstream.close(code=message.get("code") or 1000)
                return
            if message.get("bytes") is not None:
                await upstream.send(message["bytes"])
            elif message.get("text") is not None:
                await upstream.send(message["text"])

    async def to_caller():
        try:
            async for frame in upstream:
                if isinstance(frame, bytes):
                    await websocket.send_bytes(frame)
                else:
                    await websocket.send_text(frame)
        except ConnectionClosed:
            pass
        await close(websocket, upstream.close_code or 1000, upstream.close_reason or "")

    tasks = [asyncio.create_task(to_upstream()), asyncio.create_task(to_caller())]
    try:
        _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
    finally:
        # Collect both directions so an ending side's error is retrieved, not
        # logged as "never retrieved" — a peer hanging up is how a relay ends.
        await asyncio.gather(*tasks, return_exceptions=True)
        await upstream.close()


__all__ = [
    "WS_POLICY",
    "WS_UNAVAILABLE",
    "close",
    "fail",
    "http_client",
    "relay_websocket",
    "serve_http",
    "serve_socket",
    "verified_user",
]
