"""cookie-gate — admission control. Locks this instance to callers who can
present a credential the hub stands behind.

Two gates, one per way in, chosen per request:

* **local** (``local_cookiegate_middleware``) — requests from this machine
  (``Host`` is ``localhost``/``127.0.0.1``): its browser, the CLI, workers,
  Electron. Enforces the token in ``<instance_dir>/.cookie_gate`` (FLOWPAD-2233).
  Applies on a desktop and on a cloud box alike.
* **hub** (``sandbox_cookiegate_middleware``) — requests from outside, through a
  hub-armed box's public URL (any other ``Host``). Admits the secret the hub armed
  (``get_cookie_gate()``) as the machine header, or a grant / ticket for the system
  door signed with it (``server/grants.py``).

A non-loopback ``Host`` with no hub secret armed has no legitimate sender — on a
desktop it is what DNS rebinding produces — so it gets the local gate.

Per request, not once at construction: a box boots from its template unarmed and
the hub arms it later. ``get_cookie_gate()`` answers from a ``stat()``, so asking
per request is cheap.

Registered LAST in ``FlowServer.create`` so it runs FIRST — ``add_middleware`` is
LIFO. Rejecting here happens before ``RequestTransactionMiddleware`` opens a
transaction or attaches the ``@local`` user.

Pure ASGI, not ``BaseHTTPMiddleware``, because it must see WebSocket scopes.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from flow_sdk.utils.networking import is_loopback

OFF_SWITCH_ENV = "FLOWPAD_COOKIE_GATE"

#: The SECRET itself, from a machine that holds it. Browsers carry ``grants.COOKIE_NAME`` / ``grants.TICKET_PARAM``.
HEADER_NAME = "x-cookie-gate"

logger = logging.getLogger(__name__)


class CookieGateMiddleware:
    """Gate every HTTP request and WebSocket handshake: the hub gate for requests
    from outside a hub-armed box, the local gate for everything else."""

    def __init__(self, app: ASGIApp) -> None:
        # Deferred: both gates import the shared helpers at the bottom of this module.
        from .local_cookiegate_middleware import LocalCookieGateMiddleware
        from .sandbox_cookiegate_middleware import SandboxCookieGateMiddleware

        self.app = app
        self.sandbox = SandboxCookieGateMiddleware(app)
        self.local = LocalCookieGateMiddleware(app)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if os.environ.get(OFF_SWITCH_ENV) == "off" or scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        is_local_request = is_loopback(HTTPConnection(scope).url.hostname)
        if is_local_request:
            await self.local(scope, receive, send)
        else:
            await self.sandbox(scope, receive, send)


# ---------------------------------------------------------------------------
# Shared by both gates.
# ---------------------------------------------------------------------------


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
