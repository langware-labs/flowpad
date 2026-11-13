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
from typing import Optional

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.server import gate_trace, grants
from flow_sdk.server.service_proxy import SYSTEM_AUDIENCE
from flow_sdk.utils.serialization import epoch_to_iso_utc

from .cookie_gate_middleware import HEADER_NAME, deny


class SandboxCookieGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        refusal = _refusal(HTTPConnection(scope), cookie_gate.get_cookie_gate())
        if refusal is not None:
            reasons, context = refusal
            await deny(scope, receive, send, details=reasons, context=context)
            return

        await self.app(scope, receive, send)


def _refusal(conn: HTTPConnection, secret: Optional[str]) -> Optional[tuple[dict[str, str], dict[str, str]]]:
    """None when this caller holds a credential for the system door, by any of the three transports;
    otherwise ``(reasons, context)``: why each transport failed, and what happened just before — words, never values.

    Each transport is checked on its own rather than collapsed into ``a or b or c``: a stale
    cookie must not veto a valid header, and a grant from before a restart must not
    veto the fresh ticket that is there to replace it. The same check decides and explains,
    so the page can never name a reason other than the one that refused.
    """
    if secret is None:
        return {"box": "not armed by the hub yet"}, _context(conn)
    presented = conn.headers.get(HEADER_NAME)
    if presented and secrets.compare_digest(presented, secret):
        return None
    cookie, _ = grants.check_cookie(conn.cookies.get(grants.COOKIE_NAME), audience=SYSTEM_AUDIENCE, secret=secret)
    if cookie == "ok":
        return None
    ticket, _ = grants.check_ticket(conn.query_params.get(grants.TICKET_PARAM), audience=SYSTEM_AUDIENCE, secret=secret)
    if ticket == "ok":
        return None
    count = gate_trace.cookie_count(conn, grants.COOKIE_NAME)
    reasons = {"cookie": f"{cookie} (x{count})" if count > 1 else cookie, "ticket": ticket}
    if presented:
        reasons["machine header"] = "wrong"
    return reasons, _context(conn)


def _context(conn: HTTPConnection) -> dict[str, str]:
    """What only this gate knows: its last admits (``gate_trace``) and when this process started."""
    return {**gate_trace.refusal_facts(conn), "box up since": _BOOT}


_BOOT = epoch_to_iso_utc(grants.BOOT_TIME)
