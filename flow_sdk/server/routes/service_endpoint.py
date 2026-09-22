"""``service_endpoint/<id>/service/<path>`` on this tier — the last hop to the service.

A route of its own, mounted ahead of the graph catch-all, because a pure proxy
needs what the graph dispatcher does not offer: the request body unread and a
WebSocket route. What it does depends on where the endpoint lives:

* **here** (a local row) — ``static`` serves files from ``backend.root``;
  ``proxy`` relays to ``127.0.0.1:<port>``. On a cloud box this is where the hub's
  hop lands: the hub addresses the box's own row at the same id, gate attached.
* **elsewhere** (``remote`` — a hub row this desktop adopted) — forwarded to the
  hub's ``service`` route, which reaches the machine it runs on.

Nothing here interprets a protocol; the endpoint may expose anything that rides
HTTP/1.1 or a WebSocket. Header policy and the caller contract are pure functions
in ``server/service_proxy.py``.
"""

from __future__ import annotations

import asyncio
import time
from http.cookiejar import DefaultCookiePolicy
from pathlib import Path
from typing import Any, Optional

import httpx
import websockets
from fastapi import APIRouter, Request, WebSocket
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, Response, StreamingResponse
from websockets.exceptions import ConnectionClosed

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.server.service_proxy import (
    CALLER_HEADER,
    SERVICE_ROUTE,
    SERVICE_ROUTE_PREFIX,
    inbound_headers,
    outbound_headers,
    public_base,
    upstream_path,
    verify_caller,
)

router = APIRouter(prefix=SERVICE_ROUTE_PREFIX)

_PATH = SERVICE_ROUTE
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

WS_POLICY = 1008
WS_UNAVAILABLE = 1013

_client: Optional[tuple[asyncio.AbstractEventLoop, httpx.AsyncClient]] = None


def _http() -> httpx.AsyncClient:
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


def _fail(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"status": "fail", "message": message, "data": None})


def _verified_user(headers: Any) -> Optional[str]:
    """The caller the hub vouched for with this machine's gate secret, if any."""
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate  # noqa: PLC0415

    return verify_caller(headers.get(CALLER_HEADER), get_cookie_gate(), now=int(time.time()))


async def _endpoint(endpoint_id: str) -> Optional[ServiceEndpoint]:
    try:
        return await ServiceEndpoint.get_by_id(endpoint_id)
    except Exception:  # noqa: BLE001 -- a malformed id is simply not an endpoint
        return None


# ── HTTP ─────────────────────────────────────────────────────────────────────


@router.api_route(_PATH, methods=_METHODS)
@router.api_route(_PATH + "/{sub_path:path}", methods=_METHODS)
async def service_http(request: Request, endpoint_id: str, sub_path: str = "") -> Response:
    endpoint = await _endpoint(endpoint_id)
    if endpoint is None:
        return _fail(404, "service endpoint not found")
    try:
        # Validated once, before any branch: the dot-segment refusal and the re-quoting.
        path = upstream_path(sub_path, request.url.query)
    except ValueError as e:
        return _fail(400, str(e))
    if endpoint.remote:
        return await _via_hub(request, endpoint, path)
    if endpoint.backend.type == "static":
        return await _serve_static(request, endpoint, sub_path)
    return await _proxy_http(request, endpoint, path)


async def _serve_static(request: Request, endpoint: ServiceEndpoint, sub_path: str) -> Response:
    """Serve the endpoint's folder, its documents based at where the BROWSER is.

    Behind the hub that is the hub's address for this endpoint (its own origin,
    or the hub's path), which only the hub's gate-authenticated hop may state;
    otherwise it is this tier's endpoint root. Never the request's own path.
    """
    from flow_sdk.builtin.faas.serve_static import _browser_scheme, serve_app_bytes  # noqa: PLC0415
    from flow_sdk.config import default_service_config  # noqa: PLC0415
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate  # noqa: PLC0415

    scheme_config = default_service_config.service_urls_config.api_url_scheme
    base = public_base(
        request.headers,
        gate_secret=get_cookie_gate(),
        scheme=_browser_scheme(request, scheme_config),
        host=request.headers.get("host") or request.url.netloc,
        endpoint_id=endpoint.id,
    )
    return await serve_app_bytes(
        Path(endpoint.backend.root),
        sub_path,
        request,
        base_url=base,
        # Revalidated, never trusted for an hour: a served folder may be under
        # edit (`app.js` keeps its name across edits), and the ETag makes an
        # unchanged file a cheap 304.
        cache_control="no-cache",
    )


async def _proxy_http(request: Request, endpoint: ServiceEndpoint, path: str) -> Response:
    url = f"http://127.0.0.1:{endpoint.backend.port}{path}"
    headers = outbound_headers(request.headers.items(), user=_verified_user(request.headers))
    has_body = request.headers.get("content-length", "0") != "0" or "chunked" in request.headers.get(
        "transfer-encoding", ""
    )
    client = _http()
    outgoing = client.build_request(
        request.method, url, headers=headers, content=request.stream() if has_body else None
    )
    try:
        upstream = await client.send(outgoing, stream=True)
    except httpx.RequestError:
        return _fail(502, "the service did not answer")
    response = StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, background=BackgroundTask(upstream.aclose)
    )
    response.raw_headers = [
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in inbound_headers(upstream.headers.multi_items())
    ]
    return response


async def _via_hub(request: Request, endpoint: ServiceEndpoint, path: str) -> Response:
    """A hub row: the hub reaches the machine; this desktop only forwards, with its hub login."""
    from flow_sdk.cloud_client.transport.hub_http import hub_graph_url  # noqa: PLC0415

    base = hub_graph_url(endpoint.get_type(), endpoint.id, "service")
    if base is None:
        return _fail(409, "this endpoint runs on a cloud machine and no hub is configured")
    # The sub-path arrives DECODED; `upstream_path` re-quoted it (hub_graph_url does not).
    return await _cloud_proxy()(request, base + path)


_proxy: Optional[tuple[asyncio.AbstractEventLoop, Any]] = None


def _cloud_proxy():
    """One ``CloudProxy`` per loop: a fresh one per request would open a new hub connection per asset."""
    from flow_sdk.cloud_client.transport import CloudProxy  # noqa: PLC0415

    global _proxy
    loop = asyncio.get_running_loop()
    if _proxy is None or _proxy[0] is not loop:
        _proxy = (loop, CloudProxy())
    return _proxy[1]


# ── WebSocket ────────────────────────────────────────────────────────────────


@router.websocket(_PATH)
@router.websocket(_PATH + "/{sub_path:path}")
async def service_socket(websocket: WebSocket, endpoint_id: str, sub_path: str = "") -> None:
    endpoint = await _endpoint(endpoint_id)
    if endpoint is None:
        await _close(websocket, WS_POLICY, "service endpoint not found")
        return
    try:
        path = upstream_path(sub_path, websocket.url.query)
    except ValueError:
        await _close(websocket, WS_POLICY, "Invalid path")
        return
    offered = websocket.scope.get("subprotocols") or None
    if endpoint.remote:
        target = _hub_socket_target(endpoint)
        if target is None:
            await _close(websocket, WS_UNAVAILABLE, "no hub login for a cloud endpoint")
            return
        base, auth, ssl_context = target
        headers = outbound_headers(websocket.headers.items(), user=None, websocket=True) + auth
        await relay_websocket(websocket, base + path, headers, subprotocols=offered, ssl=ssl_context)
    elif endpoint.backend.type == "proxy":
        url = f"ws://127.0.0.1:{endpoint.backend.port}{path}"
        headers = outbound_headers(websocket.headers.items(), user=_verified_user(websocket.headers), websocket=True)
        await relay_websocket(websocket, url, headers, subprotocols=offered)
    else:
        await _close(websocket, WS_POLICY, "a static endpoint has no socket")


def _hub_socket_target(endpoint: ServiceEndpoint) -> Optional[tuple[str, list, Any]]:
    """The hub's ``…/service`` socket base, the auth header, and the TLS context — or None with no login."""
    from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_base_url  # noqa: PLC0415
    from flow_sdk.cloud_client.ws_client import _hub_ssl_context, build_hub_ws_path_url  # noqa: PLC0415

    creds = load_credentials()
    if hub_base_url() is None or not creds or not creds.api_key:
        return None
    base = build_hub_ws_path_url(None, f"/graph/{endpoint.get_type()}/{endpoint.id}/service")
    # certifi-backed, as every other hub socket: `websockets` alone trusts only the OS store.
    ssl_context = _hub_ssl_context() if base.startswith("wss://") else None
    return base, [("authorization", f"Bearer {creds.api_key}")], ssl_context


async def _close(websocket: WebSocket, code: int, reason: str) -> None:
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
        await _close(websocket, WS_UNAVAILABLE, "the service did not answer")
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
        await _close(websocket, upstream.close_code or 1000, upstream.close_reason or "")

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


__all__ = ["relay_websocket", "router"]
