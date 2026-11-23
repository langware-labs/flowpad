"""state-key — the local server answers no API call a page makes without a key this machine minted.

Runs right after the cookie gate (which already admitted the request as coming from this machine).
Machine callers — the CLI, workers, Electron's main process — present the gate token as a header and
pass; everything else that reaches ``/api/*`` or a WebSocket, including the app's own windows and
every page they show, must carry a state key (``flow_sdk/server/page_state.py``).

What is guarded is what a page can USE the API for: requests it makes from script (`fetch`, XHR, a
WebSocket — `Sec-Fetch-Mode: cors|websocket`) and anything that is not a plain read. A browser's own
GET navigation (a login redirect, a download, a page in a frame) and its passive resource loads (`<img>`,
`<video>`, classic `<script>`/`<link>`: `no-cors`; a served app's own ES-module imports: `script`) carry no key —
they cannot send a header, and an import's Referer is the importing module, not the page — and pass: a
page can act through them only by triggering a route that already acts on a GET, and cannot read what
they return. A navigation that POSTs (a form a page submits) is NOT passed.

A refusal is a 403 with ``X-Flowpad-Gate: state=<reason>`` — ``missing`` (no key sent) or ``unknown``
(a key this server never minted: expired, or from another machine) — which the SDK turns into a clear
message inside the page. Static files (``/sdk``, the app's own assets, the sandbox proxy) are not
guarded: the SDK has to load for a page to be told why it cannot proceed.
"""

from __future__ import annotations

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from flow_sdk.instance_settings import cookie_gate
from flow_sdk.server import page_state
from flow_sdk.utils.networking import is_loopback

from .cookie_gate_middleware import deny
from .local_cookiegate_middleware import _is_cors_preflight

_MESSAGE = "This page was not opened by Flowpad on this computer, so it may not use it."
#: A read the browser makes on its own: it cannot carry a header, and a page cannot read the answer.
_PLAIN_MODES = ("navigate", "no-cors")


def _is_plain_read(scope: Scope, conn: HTTPConnection) -> bool:
    headers = conn.headers
    return scope["type"] == "http" and scope["method"] in ("GET", "HEAD") and (
        headers.get("sec-fetch-mode") in _PLAIN_MODES
        or (headers.get("sec-fetch-dest") == "script" and headers.get("sec-fetch-site") == "same-origin")  # module import
    )


class StateKeyMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not scope["path"].startswith("/api/") or not page_state.enforced():
            await self.app(scope, receive, send)
            return

        conn = HTTPConnection(scope)
        if not is_loopback(conn.url.hostname) or cookie_gate.verify_machine(conn) or _is_cors_preflight(scope, conn):
            await self.app(scope, receive, send)
            return

        # A key that is there is noted either way: a page's own relative link (a plain navigation) still
        # tells `serve_app_bytes` which key to hand the next page.
        key = page_state.presented_key(conn)
        state = page_state.lookup(key)
        if state is not None:
            scope.setdefault("state", {}).update(page_state=state, page_state_key=key)
        if state is None and not _is_plain_read(scope, conn):
            await deny(scope, receive, send, _MESSAGE, details={"state": "missing" if not key else "unknown"})
            return
        await self.app(scope, receive, send)
