"""cookie-gate — admission control. Locks this instance to callers who can
present its secret.

Unarmed (no secret stored) every request passes. This is the default and every
desktop install; the gate must be provably inert there.

Armed, nothing is answered without the secret — not the UI, not static, not the
API, not a WebSocket. **No path is exempt**, including ``/health/status``,
``/auth/login_callback``, and ``/auth/gate``: the gate is not "block everything
except these URLs", it is "block anything that cannot present the secret", and
every legitimate caller can. A path exemption would be a permanent hole; this is
a single rule with none.

Three transports for one credential — not three special cases:

* cookie ``__Host-cookie-gate`` — the browser, on every request after its first
* header ``X-Cookie-Gate``      — machine callers (workers)
* query  ``?cookie-gate=``      — the hub's loopback curl, and the browser's
                                  *first* contact, which is necessarily
                                  cookie-less (the callback that armed the
                                  instance was made by curl inside the sandbox,
                                  so its Set-Cookie went to curl)

This middleware only decides pass/deny. Trading the secret for a cookie is
``GET /auth/gate`` (see ``flow_sdk/server/routes/auth.py``) — a route, because
the caller states its intent by choosing it. Doing the exchange here instead
would mean guessing that intent from request headers, and guessing wrong for the
hub's re-login curl would swallow the login while returning the 302 that
``_workspace_login`` reads as success.

Registered LAST in ``FlowServer.create`` so it runs FIRST — ``add_middleware`` is
LIFO. Rejecting here happens before ``RequestTransactionMiddleware`` opens a
transaction or attaches the ``@local`` user.

Pure ASGI, not ``BaseHTTPMiddleware``, because it must see WebSocket scopes.
``RequestTransactionMiddleware`` bails on non-HTTP scopes, which is exactly why
no WS handshake in this app is authenticated today — cookies do ride the
same-origin WS handshake, but nothing was there to check them.
"""

from __future__ import annotations

import logging
import secrets

from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from flow_sdk.instance_settings.cookie_gate import get_cookie_gate

COOKIE_NAME = "__Host-cookie-gate"
HEADER_NAME = "x-cookie-gate"
QUERY_NAME = "cookie-gate"

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
    """Gate every HTTP request and WebSocket handshake on the cookie-gate secret."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        secret = get_cookie_gate()
        if secret is None:
            # Unarmed: the default. No connection is built, nothing is parsed.
            await self.app(scope, receive, send)
            return

        if _presents(HTTPConnection(scope), secret):
            await self.app(scope, receive, send)
            return

        await self._deny(scope, receive, send)

    async def _deny(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Denials used to be silent, and that silence was expensive. Uvicorn's
        # access logger sets ``propagate=False``, so its 403 lines never reach
        # the root handler ``init_dev_file_logging`` installs -- meaning a gated
        # instance refused every request with NO on-disk trace anywhere, and the
        # only evidence of what was happening lived in the rejected caller. One
        # line here is the difference between reading a log and reverse-engineering
        # an HTML page out of a CLI error string.
        #
        # Type and path only. What the caller presented is a secret (or a guess
        # at one) and does not belong in a log.
        logger.warning(
            "cookie-gate: refused %s %s (no valid secret presented)",
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
    """Whether this caller carries the secret, by any of the three transports.

    Each is checked independently rather than collapsed into ``a or b or c``.
    ``or`` yields the first *present* value, so a stale cookie would short-circuit
    and a valid ``?cookie-gate=`` could never override it — rotating the secret
    would permanently lock out every browser holding an old cookie, with the one
    link that should rescue them being the thing that gets ignored.
    """
    for presented in (
        conn.cookies.get(COOKIE_NAME),
        conn.headers.get(HEADER_NAME),
        conn.query_params.get(QUERY_NAME),
    ):
        if presented and secrets.compare_digest(presented, secret):
            return True
    return False
