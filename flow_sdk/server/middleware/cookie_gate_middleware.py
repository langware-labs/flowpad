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

import html
import logging
import os
import re
import secrets
from datetime import datetime, timezone
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


async def deny(
    scope: Scope,
    receive: Receive,
    send: Send,
    message: Optional[str] = None,
    *,
    details: Optional[dict[str, str]] = None,
) -> None:
    # Denials used to be silent, and that silence was expensive. Uvicorn's
    # access logger sets ``propagate=False``, so its 403 lines never reach
    # the root handler ``init_dev_file_logging`` installs -- meaning a gated
    # instance refused every request with NO on-disk trace anywhere.
    #
    # What the caller presented is a secret (or a guess at one) and never appears here or on the
    # page: only WHY it failed (``details``, built by the gate) and what the browser said about
    # the request (``Sec-Fetch-*``), so one log line or one screenshot names the cause.
    from flow_sdk.server import gate_trace  # noqa: PLC0415 -- grants imports back into this package

    conn = HTTPConnection(scope)
    facts = _request_facts(scope, conn, details or {})
    facts.update(gate_trace.refusal_facts(conn))
    # One refused page brings its scripts, styles and favicon: log the first in full, point the rest at it.
    cause = "|".join(facts.get(k, "") for k in ("cookie", "ticket", "box", "cookies sent"))
    head = gate_trace.burst_of(facts["client"], cause, facts["request"])
    if head is None:
        logger.warning(
            "cookie-gate: refused %s %s (%s)",
            scope["type"],
            scope.get("path", "?"),
            " ".join(
                f"{k.replace(' ', '_')}={v.replace(' ', '_')}" for k, v in facts.items() if k not in ("path", "time")
            ),
        )
    else:
        logger.warning("cookie-gate: refused %s %s (same as request=%s)", scope["type"], scope.get("path", "?"), head)
    if scope["type"] == "websocket":
        # Closing before accept: the server turns this into an HTTP 403 on
        # the handshake, which is the correct rejection for a WS upgrade.
        await WebSocketClose(code=1008, reason="cookie-gate")(scope, receive, send)
        return
    headers = {"Cache-Control": "no-store", "X-Flowpad-Gate": _header_value(facts)}
    await HTMLResponse(forbidden_html(message, facts), status_code=403, headers=headers)(scope, receive, send)


def _request_facts(scope: Scope, conn: HTTPConnection, details: dict[str, str]) -> dict[str, str]:
    """The lines under "Details": when, which request, how the browser sent it, why it failed, which box."""
    from flow_sdk import __version__  # noqa: PLC0415 -- the package imports this module
    from flow_sdk.server import grants  # noqa: PLC0415 -- grants imports back into this package

    fetch = " / ".join(conn.headers.get(f"sec-fetch-{h}") or "-" for h in ("dest", "site", "mode"))
    facts = {
        "time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "request": secrets.token_hex(3),
        "path": str(scope.get("path", "?"))[:200],
        "fetch": fetch,
        **details,
        "host": (conn.url.hostname or "?")[:120],
        "box up since": datetime.fromtimestamp(grants.BOOT_TIME, timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "version": str(__version__),
        "browser": short_browser(conn.headers.get("user-agent") or ""),
    }
    return facts


def _header_value(facts: dict[str, str]) -> str:
    """The reason, for callers that never render the page (scripts, styles, API calls)."""
    keep = ("request", "cookie", "ticket", "box")
    return "; ".join(f"{k}={facts[k]}" for k in keep if k in facts).encode("ascii", "replace").decode()


_BROWSERS = (
    (r"CriOS/(\d+)", "Chrome iOS"),
    (r"FxiOS/(\d+)", "Firefox iOS"),
    (r"EdgiOS/(\d+)", "Edge iOS"),
    (r"Edg/(\d+)", "Edge"),
    (r"SamsungBrowser/(\d+)", "Samsung Internet"),
    (r"Firefox/(\d+)", "Firefox"),
    (r"Chrome/(\d+)", "Chrome"),
    (r"Version/(\d+)[\d.]* .*Safari/", "Safari"),
)
_SYSTEMS = (
    (r"(?:iPhone|iPad); CPU (?:iPhone )?OS (\d+)_(\d+)", "iOS"),
    (r"Android (\d+)", "Android"),
    (r"Mac OS X (\d+)_(\d+)", "macOS"),
    (r"Windows NT (\d+\.\d+)", "Windows"),
    (r"Linux", "Linux"),
)


def short_browser(user_agent: str) -> str:
    """``Chrome iOS 157 / iOS 27.2`` from a user agent; an in-app WebView says so. Unknown parts are dropped."""
    ua = user_agent[:512]
    name = next(
        (f"{label} {m.group(1)}" for pattern, label in _BROWSERS if (m := re.search(pattern, ua))),
        "WebView" if "AppleWebKit" in ua and "Mobile/" in ua else "",
    )
    system = next(
        (f"{label} {'.'.join(m.groups())}".strip() for pattern, label in _SYSTEMS if (m := re.search(pattern, ua))),
        "",
    )
    for app in ("WhatsApp", "Instagram", "FBAN", "Line/"):
        if app in ua:
            name = f"{name} in {app.rstrip('/')}".strip()
    return " / ".join(p for p in (name, system) if p) or "unknown"


# Fully inline — static is gated too, so an external stylesheet here would itself
# be Forbidden. The audience is a human who clicked a link, not a script parsing an
# envelope, so this is a page and not a JSON error. No script: the details are plain,
# selectable text, readable in a screenshot.
_FORBIDDEN_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forbidden</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:1.5rem 1rem;
         background:radial-gradient(ellipse at top, #16161b 0%, #0b0b0d 60%); color:#ececf1;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
         -webkit-font-smoothing:antialiased; }
  .card { width:100%; max-width:27rem; background:#121216; border:1px solid #23232a; border-radius:14px;
          padding:2rem 1.75rem 1.5rem; box-shadow:0 20px 50px -20px rgba(0,0,0,.6); }
  .badge { width:52px; height:52px; border-radius:14px; display:grid; place-items:center; margin-bottom:1.25rem;
           background:rgba(239,107,107,.1); border:1px solid rgba(239,107,107,.25); color:#ef6b6b; }
  .code { font-size:.6875rem; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:#ef6b6b;
          margin:0 0 .375rem; }
  h1 { font-size:1.3125rem; font-weight:600; letter-spacing:-.01em; margin:0 0 .625rem; line-height:1.3; }
  p  { color:#a1a1aa; margin:0; }
  .rule { height:1px; background:#23232a; margin:1.5rem 0 1rem; }
  .label { font-size:.6875rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:#71717a;
           margin:0 0 .5rem; }
  dl { margin:0; padding:.75rem .875rem; border:1px solid #23232a; border-radius:8px; background:#0d0d10;
       font:.71875rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
       display:grid; grid-template-columns:auto 1fr; gap:.0625rem 1rem; }
  dt { color:#71717a; white-space:nowrap; }
  dd { margin:0; word-break:break-all; color:#d4d4d8; }
  .foot { display:flex; justify-content:space-between; gap:1rem; font-size:.75rem; color:#5f5f68; margin-top:1rem; }
</style>
</head>
<body>
  <main class="card" role="alert">
    <div class="badge" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l7.5 3v5.25c0 4.35-3.05 8.3-7.5 9.75-4.45-1.45-7.5-5.4-7.5-9.75V6L12 3z"/>
        <path d="M9.75 12.25V10.5a2.25 2.25 0 0 1 4.5 0v1.75"/>
        <rect x="8.75" y="12.25" width="6.5" height="4.5" rx="1"/>
      </svg>
    </div>
    <div class="code">403 · Forbidden</div>
    <h1>Access to this workspace was denied</h1>
    <p>{message}</p>
    {details}
  </main>
</body>
</html>
"""

_DEFAULT_MESSAGE = (
    "Your access is missing or has expired. Open the invite link you were given again. "
    "If this keeps happening, send a screenshot of this page to whoever gave you the link."
)


def forbidden_html(message: Optional[str] = None, facts: Optional[dict[str, str]] = None) -> str:
    """The Forbidden page: what to do, then the facts that say why — escaped, never a credential."""
    rows = "".join(f"<dt>{html.escape(k)}</dt><dd>{html.escape(v)}</dd>" for k, v in (facts or {}).items())
    details = (
        '<div class="rule"></div><div class="label">Diagnostic details</div>'
        f'<dl aria-label="Diagnostic details">{rows}</dl>'
        '<div class="foot"><span>Flowpad</span><span>Contains no passwords or keys</span></div>'
        if rows
        else ""
    )
    return _FORBIDDEN_HTML.replace("{message}", html.escape(message or _DEFAULT_MESSAGE)).replace("{details}", details)


def from_flowpad_ui(request) -> bool:
    """Whether a request comes from Flowpad's own UI — a person's click. Not from a worker or the CLI (they present the
    gate secret as the ``HEADER_NAME`` header; the UI carries the cookie) and not from a web app Flowpad serves (its
    page lives under a service endpoint, and a page cannot forge the browser's ``Referer``). For actions that must take
    a person, such as handing a credential's values to someone else."""
    if request.headers.get(HEADER_NAME):
        return False
    referer = str(request.headers.get("referer") or "")
    return "/service_endpoint/" not in referer and "/service/" not in referer
