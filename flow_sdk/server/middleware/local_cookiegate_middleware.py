"""cookie-gate, local: the per-install token every non-sandbox backend enforces.

Dispatched by ``CookieGateMiddleware`` for every request that comes from this
machine (a loopback ``Host``) — on a desktop and on a cloud box alike, since a
browser on either machine can be pointed at localhost (FLOWPAD-2233: an
unauthenticated localhost API let any web page create a shell and run a command).

A random token in ``<instance_dir>/.cookie_gate``, created on the first request
this backend serves, and read from that file by the CLI and Electron.
``FLOWPAD_COOKIE_GATE=off`` turns this gate off for the process (dev runs,
tests, hub-launched boxes). With it on, failing to create or read the token
refuses the request: this gate fails CLOSED.

Two requests pass without the token, both header-shaped rather than path
exemptions: a CORS preflight (no cookie ever rides one, and no route runs), and a
direct open — a page load the user started themselves — which is handed the
cookie on its response.
"""

from __future__ import annotations

import os

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from flow_sdk.instance_settings import cookie_gate

from .cookie_gate_middleware import deny, presents

OFF_SWITCH_ENV = "FLOWPAD_COOKIE_GATE"
# Per port: cookies ignore the port, so one name would let two local instances
# in the same browser overwrite each other's cookie.
LOCAL_COOKIE_PREFIX = "cookie-gate-"
LOCAL_COOKIE_MAX_AGE = 365 * 24 * 3600


class LocalCookieGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        # The off switch is read once: it does not change while the process runs.
        self.should_enforce_gate = os.environ.get(OFF_SWITCH_ENV) != "off"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.should_enforce_gate:
            await self.app(scope, receive, send)
            return

        token = cookie_gate.get_cookie_gate() or cookie_gate.create_cookie_gate()

        conn = HTTPConnection(scope)
        if token is not None and presents(conn, token, local_cookie_name(_request_port(scope, conn))):
            await self.app(scope, receive, send)
            return

        if _is_cors_preflight(scope, conn):
            # Browsers never attach cookies to a preflight and no route runs for
            # one: CORSMiddleware answers it. The request it clears is gated.
            await self.app(scope, receive, send)
            return

        if token is not None and _is_direct_open(scope, conn):
            # The user opened this address themselves (typed, bookmark, OS
            # launch): no page can produce these browser-set headers.
            await self.app(scope, receive, _with_local_cookie(send, conn, token))
            return

        await deny(scope, receive, send, "Open Flowpad from its icon, or type this address into your browser.")


def _request_port(scope: Scope, conn: HTTPConnection) -> int | None:
    """The port as the browser addressed it (Host), else the socket's."""
    return conn.url.port or (scope.get("server") or (None, None))[1]


def local_cookie_name(port: int | None) -> str:
    return f"{LOCAL_COOKIE_PREFIX}{port}"


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
        and conn.url.hostname in ("localhost", "127.0.0.1")
    )


def local_cookie_header(port: int | None, token: str) -> str:
    """The desktop cookie. No ``Secure`` / ``__Host-``: on loopback they add no
    protection, and Safari drops ``Secure`` cookies on ``http://localhost``.
    ``SameSite=Lax`` keeps another site's fetch, form POST, iframe or subresource
    from riding it, and still sends it on a top-level GET navigation — the
    hub/provider redirects back to ``/auth/login_callback`` and ``/auth/oauth/*``
    are cross-site, and ``Strict`` refused them."""
    return (
        f"{local_cookie_name(port)}={token}; Max-Age={LOCAL_COOKIE_MAX_AGE}; "
        "Path=/; HttpOnly; SameSite=Lax"
    )


def _with_local_cookie(send: Send, conn: HTTPConnection, token: str) -> Send:
    cookie = local_cookie_header(_request_port(conn.scope, conn), token).encode("latin-1")

    async def wrapped(message):
        if message["type"] == "http.response.start":
            message = {**message, "headers": [*message.get("headers", []), (b"set-cookie", cookie)]}
        await send(message)

    return wrapped

