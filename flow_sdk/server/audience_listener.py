"""The two audience doors of this box — one listener each, on a fixed port beside the box's own UI.

A project placed on this machine serves up to two browser audiences, ``admin`` and ``app``,
each as ONE routed ``ServiceEndpoint`` (its audience proxy). Behind every route is a process on
a loopback port, or a folder. A browser never reaches the process: it enters the audience's
DOOR — this listener, on ``AUDIENCE_PORTS[audience]`` — and the door verifies the grant the
browser carries, then serves the route the grant's endpoint resolves (``service_serving``).

Why a listener per audience rather than paths on the box's own port: a cookie is per origin,
not per path. Serving the user's app under the box UI's origin would hand an XSS in that app the
box's own session. One origin per door, one cookie per door, the same shape as the hub's
``<audience>--<deployment>.<app_domain>`` hosts.

The door's three answers:

* ``GET /auth/gate?ticket=&next=`` — the hub admitted this browser and sent it here with a
  ticket for THIS door (``server/grants.py``): trade it for the ``__Host-grant`` cookie, land on ``next``.
* a valid grant for this door → serve the endpoint the grant names: a browser is told the
  caller the hub vouched for, and a static page is based at this door's origin.
* no grant → a browser navigation is sent to the hub's ``open`` for the row this door serves, which
  decides and issues a ticket; anything else is a 401. ``/__flowpad/*`` is reserved: 404.

Unarmed (every desktop), there are no grants and nothing points a browser here; the doors answer
a plain 404 and the app display loads a dev server at its own loopback address as before.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional
from urllib.parse import quote

from starlette.requests import Request
from starlette.responses import RedirectResponse, Response
from starlette.types import Receive, Scope, Send
from starlette.websockets import WebSocket

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.service_endpoint_spec import WEB_AUDIENCES
from flow_sdk.server import grants
from flow_sdk.server.listener import Listener, serve_on_socket, stop_listener
from flow_sdk.server.service_proxy import VISITOR, Grant
from flow_sdk.server.service_serving import WS_POLICY, close, fail, serve_http, serve_socket

logger = logging.getLogger(__name__)

#: How long a door trusts its reading of an endpoint row: every asset of a page asks, and the row
#: changes only when the placement is edited.
_ROW_TTL = 5.0

_doors: dict[str, Listener] = {}
_rows: dict[str, tuple[float, Optional[ServiceEndpoint]]] = {}


def _wants_html(request: Request) -> bool:
    return "text/html" in request.headers.get("accept", "").lower()


async def _row(endpoint_id: str) -> Optional[ServiceEndpoint]:
    now = time.monotonic()
    cached = _rows.get(endpoint_id)
    if cached is not None and cached[0] > now:
        return cached[1]
    row = await ServiceEndpoint.get_by_id(endpoint_id)
    _rows[endpoint_id] = (now + _ROW_TTL, row)
    return row


async def door_row(audience: str) -> Optional[ServiceEndpoint]:
    """The audience proxy this door serves when a browser arrives with nothing — the one routed row of
    that audience on this machine. A box hosts one placement; with several (a desktop), the one placed last."""
    rows = [
        row
        for row in await ServiceEndpoint.get_all({"match": {"subkind": audience}})
        if row.backend.type == "routed" and not row.remote
    ]
    return max(rows, key=lambda r: r.updated_date or "", default=None)


def hub_open_url(endpoint_id: str, next_path: str) -> Optional[str]:
    """The hub's ``open`` for *endpoint_id* — where a grant-less browser is sent — or None with no hub."""
    from flow_sdk.cloud_client.transport.hub_http import hub_graph_url  # noqa: PLC0415

    base = hub_graph_url(ServiceEndpoint.get_type(), endpoint_id, "open")
    return f"{base}?next={quote(next_path, safe='/')}" if base else None


class AudienceDoor:
    """The ASGI app of one door: HTTP and WebSocket, pure, no middleware in front."""

    def __init__(self, audience: str) -> None:
        if audience not in WEB_AUDIENCES:
            raise ValueError(f"{audience!r} is not a web audience")
        self.audience = audience

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            request = Request(scope, receive, send)
            response = await self.http(request)
            await response(scope, receive, send)
        elif scope["type"] == "websocket":
            await self.socket(WebSocket(scope, receive, send))

    async def _admitted(self, cookies, path: str) -> Optional[tuple[Grant, ServiceEndpoint]]:
        """The grant a browser holds for THIS door and the row it names, or None: no grant, another
        door's, or a row this door does not serve."""
        grant = grants.read_grant(cookies.get(grants.COOKIE_NAME))
        if grant is None or grant.audience != self.audience:
            return None
        endpoint = await _row(grant.endpoint)
        if endpoint is None or endpoint.subkind != self.audience or endpoint.remote:
            return None
        return grant, endpoint

    async def http(self, request: Request) -> Response:
        from flow_sdk.builtin.faas.serve_static import _browser_scheme  # noqa: PLC0415

        path = request.url.path
        if path.startswith(grants.RESERVED_PREFIX):
            return fail(404, "not found")
        if path == grants.GATE_PATH:
            landing = grants.safe_next(request.query_params.get("next"))
            traded = grants.exchange(
                request.query_params.get(grants.TICKET_PARAM), audience=self.audience, landing=landing
            )
            return traded if traded is not None else fail(403, "this link is not valid for this door")
        admitted = await self._admitted(request.cookies, path)
        if admitted is None:
            return await self._no_grant(request)
        grant, endpoint = admitted
        origin = f"{_browser_scheme(request, None)}://{request.headers.get('host') or request.url.netloc}"
        return await serve_http(request, endpoint, path.lstrip("/"), user=_user(grant), base_root=origin)

    async def _no_grant(self, request: Request) -> Response:
        if request.method != "GET" or not _wants_html(request):
            return fail(401, "open this app from Flowpad")
        row = await door_row(self.audience)
        if row is None:
            return fail(404, f"nothing is served to the {self.audience} audience here")
        landing = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        url = hub_open_url(row.id, landing)
        if url is None:
            return fail(401, "no hub to ask")
        return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})

    async def socket(self, websocket: WebSocket) -> None:
        admitted = await self._admitted(websocket.cookies, websocket.url.path)
        if admitted is None or websocket.url.path.startswith(grants.RESERVED_PREFIX):
            await close(websocket, WS_POLICY, "Forbidden")
            return
        grant, endpoint = admitted
        await serve_socket(websocket, endpoint, websocket.url.path.lstrip("/"), user=_user(grant))


def _user(grant: Grant) -> Optional[str]:
    """Who the app is told about: the caller the hub admitted, nobody for a visitor."""
    return None if grant.caller == VISITOR else grant.caller


async def start() -> None:
    """Open every audience door on its fixed port. A port already taken is logged, not fatal: the box
    still serves its own UI, and the hub's relay still reaches every app through the path route."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    from flow_sdk.instance_settings.base_settings import audience_ports  # noqa: PLC0415

    host = get_instance_settings().host
    for audience, port in audience_ports().items():
        if audience in _doors:
            continue
        try:
            _doors[audience] = await serve_on_socket(
                AudienceDoor(audience), host, port, name=f"audience-door-{audience}"
            )
        except OSError as e:
            logger.warning("audience door %s could not bind %s:%s (%s)", audience, host, port, e)


async def stop() -> None:
    doors = [_doors.pop(audience) for audience in list(_doors)]
    await asyncio.gather(*(stop_listener(door) for door in doors))


__all__ = ["AudienceDoor", "start", "stop"]
