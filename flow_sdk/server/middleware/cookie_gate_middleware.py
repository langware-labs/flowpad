"""cookie-gate — admission control. Locks this instance to callers who can
present its secret.

Two secrets, checked in order:

* **hub-armed** — what ``get_cookie_gate()`` returns: a sandbox the hub armed
  over loopback. When set, everything below this paragraph applies unchanged.
* **local token** — otherwise. A random token in ``<instance_dir>/.cookie_gate``,
  created on the first request this backend serves, and read from that file by
  the CLI and Electron (FLOWPAD-2233: an unauthenticated localhost API let any web
  page create a shell and run a command). ``FLOWPAD_COOKIE_GATE=off`` stops the
  file being created — it never disarms one that exists. Failing to create or
  read it refuses the request: the local gate fails CLOSED.

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
import os
import secrets
from pathlib import Path

from starlette.requests import HTTPConnection
from starlette.responses import HTMLResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.instance_settings.cookie_gate import get_cookie_gate

COOKIE_NAME = "__Host-cookie-gate"
HEADER_NAME = "x-cookie-gate"
QUERY_NAME = "cookie-gate"

LOCAL_TOKEN_FILENAME = ".cookie_gate"
OFF_SWITCH_ENV = "FLOWPAD_COOKIE_GATE"
# Per port: cookies ignore the port, so one name would let two local instances
# in the same browser overwrite each other's cookie.
LOCAL_COOKIE_PREFIX = "cookie-gate-"
LOCAL_COOKIE_MAX_AGE = 365 * 24 * 3600
_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1"})

#: This instance's token file — the one the CLI and Electron read.
LOCAL_TOKEN_PATH = get_instance_settings().instance_dir / LOCAL_TOKEN_FILENAME

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

# Same page for a local backend; the way back in differs from a sandbox's.
_LOCAL_FORBIDDEN_HTML = _FORBIDDEN_HTML.replace(
    "This link is not valid for this workspace. Open it again from Flowpad.",
    "Open Flowpad from its icon, or type this address into your browser.",
)


class CookieGateMiddleware:
    """Gate every HTTP request and WebSocket handshake on the cookie-gate secret."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        secret = get_cookie_gate()
        if secret is not None:
            # Hub-armed (a sandbox): exactly the pre-FLOWPAD-2233 behavior.
            if _presents(HTTPConnection(scope), secret):
                await self.app(scope, receive, send)
                return
            await self._deny(scope, receive, send)
            return

        enforce, token = _local_token()
        if not enforce:
            # Off switch, and no token file was ever written.
            await self.app(scope, receive, send)
            return

        conn = HTTPConnection(scope)
        if token is not None and (_presents(conn, token) or _presents_local_cookie(conn, token)):
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

        await self._deny(scope, receive, send, html=_LOCAL_FORBIDDEN_HTML)

    async def _deny(self, scope: Scope, receive: Receive, send: Send, html: str = "") -> None:
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
        await HTMLResponse(html or _FORBIDDEN_HTML, status_code=403)(scope, receive, send)


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


def _request_port(scope: Scope, conn: HTTPConnection) -> int | None:
    """The port as the browser addressed it (Host), else the socket's."""
    return conn.url.port or (scope.get("server") or (None, None))[1]


def local_cookie_name(port: int | None) -> str:
    return f"{LOCAL_COOKIE_PREFIX}{port}"


def _presents_local_cookie(conn: HTTPConnection, token: str) -> bool:
    presented = conn.cookies.get(local_cookie_name(_request_port(conn.scope, conn)))
    return bool(presented) and secrets.compare_digest(presented, token)


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
        and conn.url.hostname in _LOOPBACK_HOSTNAMES
    )


def local_cookie_header(port: int | None, token: str) -> str:
    """The desktop cookie. No ``Secure`` / ``__Host-``: on loopback they add no
    protection, and Safari drops ``Secure`` cookies on ``http://localhost``.
    ``SameSite=Strict`` is what keeps another site's page from riding it."""
    return (
        f"{local_cookie_name(port)}={token}; Max-Age={LOCAL_COOKIE_MAX_AGE}; "
        "Path=/; HttpOnly; SameSite=Strict"
    )


def _with_local_cookie(send: Send, conn: HTTPConnection, token: str) -> Send:
    cookie = local_cookie_header(_request_port(conn.scope, conn), token).encode("latin-1")

    async def wrapped(message):
        if message["type"] == "http.response.start":
            message = {**message, "headers": [*message.get("headers", []), (b"set-cookie", cookie)]}
        await send(message)

    return wrapped


# ---------------------------------------------------------------------------
# Local token — the file the CLI and Electron read to get past this gate.
# ---------------------------------------------------------------------------


def read_local_token(path: Path) -> str | None:
    """The local token in ``path``, or ``None`` when there is none. The one
    reader: the middleware (this instance's ``LOCAL_TOKEN_PATH``) and the CLI's
    ``gate_headers`` (the target instance's file) both come through here. A
    plain-file read, so nothing is cached. Never raises."""
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def _create_local_token(path: Path) -> str | None:
    """Write a fresh token unless one already exists, then return whatever is there.

    The token is written to a private temp file first and hard-linked into place:
    ``os.link`` refuses to replace an existing file, so when two processes race on
    first boot exactly one token survives and both read the same value back. 0600
    applies on posix; on Windows the file inherits the profile directory's ACL.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(secrets.token_urlsafe(32))
    try:
        os.link(tmp, path)
    except FileExistsError:
        pass  # a racing creator won; read its token below
    finally:
        tmp.unlink(missing_ok=True)
    return read_local_token(path)


def _local_token() -> tuple[bool, str | None]:
    """``(enforce, token)`` for this request.

    ``enforce`` is False only with the off switch set and no file on disk. Once
    the gate is expected, a token that cannot be created or read comes back as
    ``(True, None)`` — the caller refuses rather than passing everything.
    """
    token = read_local_token(LOCAL_TOKEN_PATH)
    if token is not None:
        return True, token
    # The off switch: dev runs, tests and hub-launched boxes never create a token.
    if os.environ.get(OFF_SWITCH_ENV) == "off":
        return False, None
    try:
        token = _create_local_token(LOCAL_TOKEN_PATH)
    except OSError as e:
        logger.warning("cookie-gate: could not create local token at %s: %s", LOCAL_TOKEN_PATH, e)
        return True, None
    if token is not None:
        logger.info("cookie-gate: created local token at %s", LOCAL_TOKEN_PATH)
    return True, token
