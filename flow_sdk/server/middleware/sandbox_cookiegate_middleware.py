"""cookie-gate, sandbox: the hub-armed secret.

Dispatched by ``CookieGateMiddleware`` when ``get_cookie_gate()`` returns a secret
— a sandbox the hub armed over loopback.

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

This gate only decides pass/deny. Trading the secret for a cookie is
``GET /auth/gate`` (see ``flow_sdk/server/routes/auth.py``) — a route, because
the caller states its intent by choosing it. Doing the exchange here instead
would mean guessing that intent from request headers, and guessing wrong for the
hub's re-login curl would swallow the login while returning the 302 that
``_workspace_login`` reads as success.
"""

from __future__ import annotations

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from .cookie_gate_middleware import deny, presents

COOKIE_NAME = "__Host-cookie-gate"


class SandboxCookieGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send, secret: str) -> None:
        if presents(HTTPConnection(scope), secret, COOKIE_NAME):
            await self.app(scope, receive, send)
            return
        await deny(scope, receive, send)
