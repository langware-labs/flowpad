"""``service_endpoint/<id>/service/<path>`` on this tier — the last hop to the service.

A route of its own, mounted ahead of the graph catch-all, because a pure proxy
needs what the graph dispatcher does not offer: the request body unread and a
WebSocket route. What it does depends on where the endpoint lives:

* **here** (a local row) — served by ``server/service_serving.py``: files, a loopback
  process, a channel, or an audience proxy's route picked by the first path segment. On a
  cloud box this is where the HUB's hop lands: the hub addresses the box's own row at the
  same id, gate attached, and names the caller it vouches for (``X-Flowpad-Caller``). A
  browser does not come in here for a web app — each audience has a door of its own
  (``server/audience_listener.py``), and the gate middleware admits a browser only to the
  system door.
* **elsewhere** (``remote`` — a hub row this desktop adopted) — forwarded to the
  hub's ``service`` route, which reaches the machine it runs on.

Nothing here interprets a protocol; the endpoint may expose anything that rides
HTTP/1.1 or a WebSocket. Header policy and the caller contract are pure functions
in ``server/service_proxy.py``.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Request, WebSocket
from starlette.responses import Response

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.server.service_proxy import (
    SERVICE_ROUTE,
    SERVICE_ROUTE_PREFIX,
    outbound_headers,
    upstream_path,
)
from flow_sdk.server.service_serving import (
    WS_POLICY,
    WS_UNAVAILABLE,
    close,
    fail,
    relay_websocket,
    serve_http,
    serve_socket,
    verified_user,
)

router = APIRouter(prefix=SERVICE_ROUTE_PREFIX)

_PATH = SERVICE_ROUTE
_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


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
        return fail(404, "service endpoint not found")
    if endpoint.remote:
        try:
            path = upstream_path(sub_path, request.url.query)
        except ValueError as e:
            return fail(400, str(e))
        return await _via_hub(request, endpoint, path)
    return await serve_http(request, endpoint, sub_path, user=verified_user(request.headers))


async def _via_hub(request: Request, endpoint: ServiceEndpoint, path: str) -> Response:
    """A hub row: the hub reaches the machine; this desktop only forwards, with its hub login."""
    from flow_sdk.cloud_client.transport.hub_http import hub_graph_url  # noqa: PLC0415

    base = hub_graph_url(endpoint.get_type(), endpoint.id, "service")
    if base is None:
        return fail(409, "this endpoint runs on a cloud machine and no hub is configured")
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
        await close(websocket, WS_POLICY, "service endpoint not found")
        return
    if not endpoint.remote:
        await serve_socket(websocket, endpoint, sub_path, user=verified_user(websocket.headers))
        return
    try:
        path = upstream_path(sub_path, websocket.url.query)
    except ValueError:
        await close(websocket, WS_POLICY, "Invalid path")
        return
    target = _hub_socket_target(endpoint)
    if target is None:
        await close(websocket, WS_UNAVAILABLE, "no hub login for a cloud endpoint")
        return
    base, auth, ssl_context = target
    headers = outbound_headers(websocket.headers.items(), user=None, websocket=True) + auth
    offered = websocket.scope.get("subprotocols") or None
    await relay_websocket(websocket, base + path, headers, subprotocols=offered, ssl=ssl_context)


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


__all__ = ["router"]
