"""cookie-gate — admission control. Locks this instance to callers who can
present a credential the hub stands behind.

Unarmed (no secret stored) every request passes. This is the default and every
desktop install; the gate must be provably inert there.

Armed, nothing is answered without a credential — not the UI, not static, not the
API, not a WebSocket. **No path is exempt**, including ``/health/status``,
``/auth/login_callback``, and ``/auth/gate``: the gate is not "block everything
except these URLs", it is "block anything that cannot present a credential", and
every legitimate caller can. A path exemption would be a permanent hole; this is
a single rule with none.

Two credentials, three transports — not three special cases:

* header ``X-Cookie-Gate``   — the SECRET itself, from a machine that holds it: a worker on this
                               box, the hub's relay, the hub's loopback curl. Never a browser.
* cookie ``__Host-grant``    — a GRANT (``server/grants.py``): who may enter the ``system`` door,
                               signed by this process. The browser, on every request after its first.
* query  ``?ticket=``        — the hub's TICKET for the system door, signed with the secret: the
                               browser's *first* contact, which is necessarily cookie-less. It is
                               what ``GET /auth/gate`` trades for the cookie, and it admits the one
                               request it rides on, for a minute.

The secret never rides a URL or a cookie: a copied link is a ticket that dies in a
minute and names one caller, not the box's one key for everyone forever.

This middleware only decides pass/deny. Trading a ticket for a cookie is
``GET /auth/gate`` (see ``flow_sdk/server/routes/auth.py``) — a route, because
the caller states its intent by choosing it.

Registered LAST in ``FlowServer.create`` so it runs FIRST — ``add_middleware`` is
LIFO. Rejecting here happens before ``RequestTransactionMiddleware`` opens a
transaction or attaches the ``@local`` user.

Pure ASGI, not ``BaseHTTPMiddleware``, because it must see WebSocket scopes.
"""

from __future__ import annotations

import logging
import secrets

from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.server import grants
from flow_sdk.server.service_proxy import SYSTEM_AUDIENCE

#: The SECRET itself, from a machine that holds it. Browsers carry ``grants.COOKIE_NAME`` / ``grants.TICKET_PARAM``.
HEADER_NAME = "x-cookie-gate"

logger = logging.getLogger(__name__)

# Fully inline — static is gated too, so an external stylesheet here would itself
# be Forbidden. The audience is a human who clicked a stale link, not a script
# parsing an envelope, so this is a page and not a JSON error.
_FORBIDDEN_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forbidden</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; background:#0b0b0d; color:#e5e5e7;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .box { text-align:center; padding:2rem; }
  h1 { font-size:1.25rem; font-weight:600; margin:0 0 .5rem; }
  p  { font-size:.875rem; color:#8e8e93; margin:0; }
</style>
</head>
<body>
  <div class="box">
    <h1>Forbidden</h1>
    <p>This link is not valid for this workspace. Open it again from Flowpad.</p>
  </div>
</body>
</html>
"""


class CookieGateMiddleware:
    """Gate every HTTP request and WebSocket handshake on a credential for the system door."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        secret = cookie_gate.get_cookie_gate()
        if secret is None:
            # Unarmed: the default. No connection is built, nothing is parsed.
            await self.app(scope, receive, send)
            return

        if _presents(HTTPConnection(scope), secret):
            await self.app(scope, receive, send)
            return

        await self._deny(scope, receive, send)

    async def _deny(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Type and path only. What the caller presented is a credential (or a guess
        # at one) and does not belong in a log.
        logger.warning(
            "cookie-gate: refused %s %s (no valid credential presented)",
            scope["type"],
            scope.get("path", "?"),
        )
        if scope["type"] == "websocket":
            # Closing before accept: the server turns this into an HTTP 403 on
            # the handshake, which is the correct rejection for a WS upgrade.
            await WebSocketClose(code=1008, reason="cookie-gate")(scope, receive, send)
            return
        await HTMLResponse(_FORBIDDEN_HTML, status_code=403)(scope, receive, send)


def _presents(conn: HTTPConnection, secret: str) -> bool:
    """Whether this caller holds a credential for the system door, by any of the three transports.

    Each is checked independently rather than collapsed into ``a or b or c``: a stale
    cookie must not veto a valid header, and a grant from before a restart must not
    veto the fresh ticket that is there to replace it.
    """
    presented = conn.headers.get(HEADER_NAME)
    if presented and secrets.compare_digest(presented, secret):
        return True
    grant = grants.read_grant(conn.cookies.get(grants.COOKIE_NAME), secret=secret)
    if grant is not None and grant.audience == SYSTEM_AUDIENCE:
        return True
    ticket = grants.read_ticket(conn.query_params.get(grants.TICKET_PARAM), secret=secret)
    return ticket is not None and ticket.audience == SYSTEM_AUDIENCE
