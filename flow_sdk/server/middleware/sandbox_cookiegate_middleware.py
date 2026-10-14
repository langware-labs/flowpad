"""cookie-gate, sandbox: the hub-armed secret and the grants signed with it.

Dispatched by ``CookieGateMiddleware`` for requests that reach a hub-armed box
from outside — through its public URL (a non-loopback ``Host``). Requests from the
box itself go through the local gate instead.

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

This gate only decides pass/deny. Trading a ticket for a cookie is
``GET /auth/gate`` (see ``flow_sdk/server/routes/auth.py``) — a route, because
the caller states its intent by choosing it.

With no secret to check against (none armed and no local token), it refuses: a
non-loopback ``Host`` with nothing to verify has no legitimate sender.
"""

from __future__ import annotations

import secrets

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.server import grants
from flow_sdk.server.service_proxy import SYSTEM_AUDIENCE

from .cookie_gate_middleware import HEADER_NAME, deny


class SandboxCookieGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        secret = cookie_gate.get_cookie_gate()
        if secret is None or not _presents(HTTPConnection(scope), secret):
            await deny(scope, receive, send)
            return

        await self.app(scope, receive, send)


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
