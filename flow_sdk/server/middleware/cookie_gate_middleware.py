"""cookie-gate — admission control. Locks this instance to callers who can
present its secret.

Two gates, chosen per request:

* **sandbox** (``sandbox_cookiegate_middleware``) — when ``get_cookie_gate()``
  returns a secret: a sandbox the hub armed over loopback.
* **local** (``local_cookiegate_middleware``) — otherwise: every other backend,
  desktop included, enforcing the token in ``<instance_dir>/.cookie_gate``
  (FLOWPAD-2233).

Per request, not once at construction: a sandbox boots from its template with
no secret and is armed by the hub later, so a choice made at startup would put
every sandbox behind the local gate for good. No env var or flag says "sandbox"
at boot (``E2B_SANDBOX_ID`` is empty in the server process; the runtime is only
assigned by ``login_callback``). ``get_cookie_gate()`` answers from a ``stat()``,
so asking per request is cheap.

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
from typing import Optional

from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from flow_sdk.instance_settings.cookie_gate import get_cookie_gate

HEADER_NAME = "x-cookie-gate"
QUERY_NAME = "cookie-gate"

logger = logging.getLogger(__name__)


class CookieGateMiddleware:
    """Gate every HTTP request and WebSocket handshake: the sandbox gate when the
    hub armed this instance, the local gate otherwise."""

    def __init__(self, app: ASGIApp) -> None:
        # Deferred: both gates import the shared helpers at the bottom of this module.
        from .local_cookiegate_middleware import LocalCookieGateMiddleware
        from .sandbox_cookiegate_middleware import SandboxCookieGateMiddleware

        self.app = app
        self.sandbox = SandboxCookieGateMiddleware(app)
        self.local = LocalCookieGateMiddleware(app)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        secret = get_cookie_gate()
        if secret is not None:
            await self.sandbox(scope, receive, send, secret)
        else:
            await self.local(scope, receive, send)


# ---------------------------------------------------------------------------
# Shared by both gates.
# ---------------------------------------------------------------------------


def presents(conn: HTTPConnection, secret: str, cookie_name: str) -> bool:
    """Whether this caller carries the secret, by any of the three transports:
    the gate's cookie, the ``X-Cookie-Gate`` header, the ``?cookie-gate=`` query.

    Each is checked independently rather than collapsed into ``a or b or c``.
    ``or`` yields the first *present* value, so a stale cookie would short-circuit
    and a valid ``?cookie-gate=`` could never override it — rotating the secret
    would permanently lock out every browser holding an old cookie, with the one
    link that should rescue them being the thing that gets ignored.
    """
    for presented in (
        conn.cookies.get(cookie_name),
        conn.headers.get(HEADER_NAME),
        conn.query_params.get(QUERY_NAME),
    ):
        if presented and secrets.compare_digest(presented, secret):
            return True
    return False


async def deny(scope: Scope, receive: Receive, send: Send, message: Optional[str] = None) -> None:
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
    await HTMLResponse(forbidden_html(message), status_code=403)(scope, receive, send)


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
    <p>{message}</p>
  </div>
</body>
</html>
"""


def forbidden_html(message: Optional[str] = None) -> str:
    """The Forbidden page, telling the reader how to get back in."""
    return _FORBIDDEN_HTML.replace(
        "{message}", message or "This link is not valid for this workspace. Open it again from Flowpad."
    )
