"""cookie-gate, local: the per-install token every non-sandbox backend enforces.

Dispatched by ``CookieGateMiddleware`` for every request that comes from this
machine (a loopback ``Host``) — on a desktop and on a cloud box alike, since a
browser on either machine can be pointed at localhost (FLOWPAD-2233: an
unauthenticated localhost API let any web page create a shell and run a command).

A random token in ``<instance_dir>/.cookie_gate``, created on the first request
this backend serves, and read from that file by the CLI and Electron.
``FLOWPAD_COOKIE_GATE=off`` turns the whole cookie gate off for the process
(dev runs, tests); ``CookieGateMiddleware`` reads it. With it on, failing to
create or read the token refuses the request: the gate fails CLOSED.

Two requests pass without the token, both header-shaped: a CORS preflight (no cookie ever rides one, and no route runs), and a
direct open — a page load the user started themselves — which is handed the
cookie on its response.

Two more pass because the cookie cannot reach them: a page that is not served by
this backend (a nano-app opened as a ``file://`` in a browser) is cross-site to
it, so the browser withholds the ``SameSite=Lax`` cookie from everything it asks
for. Such a page presents the state key its opener minted
(``flow_sdk/server/page_state.py``) -- a key this backend knows is admitted, on
HTTP and WebSocket alike -- and it loads the browser SDK from ``/sdk/``, the one
path exemption: public code, read by anyone (its own chunks and stylesheet carry
no key).
"""

from __future__ import annotations

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.server import page_state
from flow_sdk.utils.networking import is_loopback

from .cookie_gate_middleware import deny


class LocalCookieGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        conn = HTTPConnection(scope)
        if _reads_the_sdk(scope) or cookie_gate.verify_cookie(conn) or page_state.lookup(page_state.presented_key(conn)):
            await self.app(scope, receive, send)
            return

        if _is_cors_preflight(scope, conn):
            # Browsers never attach cookies to a preflight and no route runs for
            # one: CORSMiddleware answers it. The request it clears is gated.
            await self.app(scope, receive, send)
            return

        set_cookie = cookie_gate.set_cookie_header(conn) if _is_direct_open(scope, conn) else None
        if set_cookie:
            # The user opened this address themselves (typed, bookmark, OS
            # launch): no page can produce these browser-set headers.
            await self.app(scope, receive, _with_set_cookie(send, set_cookie))
            return

        await deny(scope, receive, send, "Open Flowpad from its icon, or type this address into your browser.")


def _reads_the_sdk(scope: Scope) -> bool:
    return scope["type"] == "http" and scope.get("method") in ("GET", "HEAD") and scope["path"].startswith("/sdk/")


def _is_cors_preflight(scope: Scope, conn: HTTPConnection) -> bool:
    return (
        scope["type"] == "http"
        and scope.get("method") == "OPTIONS"
        and "origin" in conn.headers
        and "access-control-request-method" in conn.headers
    )


def _is_direct_open(scope: Scope, conn: HTTPConnection) -> bool:
    """A top-level page load the user started themselves, on a loopback host.

    ``Sec-Fetch-*`` are set by the browser and cannot be set by a page, and
    ``Sec-Fetch-Site: none`` is what a typed URL, a bookmark or an OS launch
    sends — never a page's own navigation or fetch. Missing headers (curl, old
    browsers) never qualify. The Host check keeps a DNS-rebound name such as
    ``evil.example`` (resolving to 127.0.0.1) from being handed the cookie.
    """
    headers = conn.headers
    return (
        scope["type"] == "http"
        and scope.get("method") in ("GET", "HEAD")
        and headers.get("sec-fetch-site") == "none"
        and headers.get("sec-fetch-mode") == "navigate"
        and headers.get("sec-fetch-dest") == "document"
        and is_loopback(conn.url.hostname)
    )


def _with_set_cookie(send: Send, set_cookie: str) -> Send:
    cookie = set_cookie.encode("latin-1")

    async def wrapped(message):
        if message["type"] == "http.response.start":
            message = {**message, "headers": [*message.get("headers", []), (b"set-cookie", cookie)]}
        await send(message)

    return wrapped
