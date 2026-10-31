"""The page-error reporter: a loopback relay in front of a desktop dev server that tells Flowpad what its page threw.

A desktop app display loads a dev server at its own loopback origin (HMR and absolute ``/src/...`` paths
need a root origin), so the page is cross-origin to Flowpad and its errors are invisible to the viewer.
This relay is that origin, one port per dev server: it relays HTTP and WebSockets to the server
unchanged, and adds one ``<script>`` to every HTML page. The script reports ``error``,
``unhandledrejection`` and ``console.error`` to the parent window (``postMessage``) and says when the page
has settled; the viewer hands the report to ``service_endpoint/<id>/page-report``.

Loopback only, and only for a desktop's own dev servers: the page is the person's own app, served to the
person's own browser — the relay passes what the server sends (cookies included), as a direct load did.
An app turns it off with ``report_errors: false`` in ``webapp.json``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

import httpx
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.types import Receive, Scope, Send
from starlette.websockets import WebSocket

from flow_sdk.server.listener import Listener, serve_on_socket
from flow_sdk.server.service_proxy import _HOP
from flow_sdk.server.service_serving import http_client, relay_websocket

logger = logging.getLogger(__name__)

LOOPBACK = "127.0.0.1"
REPORTER_PATH = "/__flowpad/reporter.js"
#: The message the reporter posts to the parent window. The viewer listens for this type.
MESSAGE_TYPE = "flowpad:page-report"
#: What the viewer posts to the frame to have the report sent again.
REQUEST_TYPE = "flowpad:page-report-request"

#: Settles 1.5s after load with no new error; reports again on every later error.
REPORTER_JS = """(() => {
  if (window.__flowpadReporter || window.parent === window) return;
  window.__flowpadReporter = true;
  // The document this page is: minted by the relay per HTML response, so a report says which load it is about.
  const me = document.currentScript && document.currentScript.src || '';
  const loadId = (me.match(/[?&]load=([\\w-]+)/) || [])[1] || '';
  const errors = [];
  let settled = false, timer = null;
  const post = () => { try { window.parent.postMessage({ type: '%(type)s', errors: errors.slice(-50), settled,
    url: location.href, load_id: loadId }, '*'); } catch (_) {} };
  const settle = () => { clearTimeout(timer); timer = setTimeout(() => { settled = true; post(); }, 1500); };
  const add = (source, text) => { errors.push({ source, text: String(text).slice(0, 2000) });
    if (settled) post(); else settle(); };
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) {
      add('network', 'failed to load ' + (e.target.src || e.target.href)); return; }
    add('page', (e.error && e.error.name ? e.error.name + ': ' : '') + (e.message || e.error));
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason; add('page', (r && r.name ? r.name + ': ' : 'Unhandled rejection: ') + (r && r.message || r)); });
  const original = console.error;
  console.error = function (...args) { add('console', args.map((a) => a && a.stack ? a.stack : String(a)).join(' '));
    return original.apply(this, args); };
  // A viewer that mounts over a frame it did not load (a cached frame) asks again.
  window.addEventListener('message', (e) => { if (e.source === window.parent && e.data &&
    e.data.type === '%(request)s' && settled) post(); });
  if (document.querySelector('meta[name="flowpad-upstream"][content="down"]')) add('relay', 'not_answering');
  if (document.readyState === 'complete') settle(); else window.addEventListener('load', settle);
})();
""" % {"type": MESSAGE_TYPE, "request": REQUEST_TYPE}

#: The document id each relay last served, by upstream port: a report for any other is about an older page.
_LATEST_LOAD: dict[int, str] = {}


def latest_load(upstream_port: int | None) -> str:
    """The id of the last HTML document the relay of ``upstream_port`` served; ``""`` when none."""
    return _LATEST_LOAD.get(int(upstream_port), "") if upstream_port else ""


def _script_tag(load_id: str) -> bytes:
    return f'<script src="{REPORTER_PATH}?load={load_id}"></script>'.encode()
_HEAD = re.compile(rb"<head[^>]*>", re.I)

#: Request headers the relay does not pass: hop-by-hop and ``host`` (httpx sets the upstream's). A request
#: that accepts HTML also drops its encoding offer, so the page arrives as text the script can be added to.
_DROP_OUT = _HOP | {"host"}
_DROP_IN = _HOP | {"content-length", "content-encoding"}


def inject(html: bytes, load_id: str = "") -> bytes:
    """``html`` with the reporter as the first thing in its head (or at its top when it has none), naming the
    document ``load_id``."""
    match = _HEAD.search(html)
    at = match.end() if match else 0
    return html[:at] + _script_tag(load_id) + html[at:]


def _not_answering(request: Request) -> Response:
    """The server is down: a page that says so AND reports it, so the viewer recovers instead of showing it."""
    if "text/html" not in request.headers.get("accept", ""):
        return Response("the app's server did not answer", status_code=502)
    # Marked, not worded: the reporter sends a structured ``relay``/``not_answering`` error (a built-in rule).
    page = (b'<!doctype html><html><head><meta name="flowpad-upstream" content="down"></head>'
            b"<body><p>The app's server did not answer.</p></body></html>")
    return Response(inject(page), status_code=502, media_type="text/html")


class _Relay:
    """The ASGI app of one relay: everything to ``upstream_port``, HTML with the reporter added."""

    def __init__(self, upstream_port: int):
        self.port = upstream_port

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            websocket = WebSocket(scope, receive, send)
            path = scope.get("raw_path", b"").decode() or scope["path"]
            query = scope.get("query_string", b"").decode()
            url = f"ws://{LOOPBACK}:{self.port}{path}{'?' + query if query else ''}"
            headers = [(k, v) for k, v in websocket.headers.items()
                       if k.lower() not in _DROP_OUT and not k.lower().startswith("sec-websocket") and k.lower() != "origin"]
            await relay_websocket(websocket, url, headers, subprotocols=scope.get("subprotocols") or None)
            return
        if scope["type"] != "http":
            return
        request = Request(scope, receive)
        if request.url.path == REPORTER_PATH:
            response = Response(REPORTER_JS, media_type="text/javascript", headers={"cache-control": "no-store"})
        else:
            response = await self._http(request)
        await response(scope, receive, send)

    async def _http(self, request: Request) -> Response:
        path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        drop = _DROP_OUT | ({"accept-encoding"} if "text/html" in request.headers.get("accept", "") else set())
        headers = [(k, v) for k, v in request.headers.items() if k.lower() not in drop]
        has_body = request.headers.get("content-length", "0") != "0" or "chunked" in request.headers.get(
            "transfer-encoding", "")
        client = http_client()
        outgoing = client.build_request(request.method, f"http://{LOOPBACK}:{self.port}{path}", headers=headers,
                                        content=request.stream() if has_body else None)
        try:
            upstream = await client.send(outgoing, stream=True)
        except httpx.RequestError:
            return _not_answering(request)
        out_headers = [(k, v) for k, v in upstream.headers.multi_items() if k.lower() not in _DROP_IN]
        if "text/html" in upstream.headers.get("content-type", "") and request.method == "GET":
            body = await upstream.aread()
            await upstream.aclose()
            from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

            load_id = str(mint_uuid())  # the document's id: a correlation token, never an entity
            if request.headers.get("sec-fetch-dest", "document") in ("document", "iframe", ""):
                _LATEST_LOAD[self.port] = load_id
            response = Response(inject(body, load_id), status_code=upstream.status_code)
        else:
            response = StreamingResponse(upstream.aiter_bytes(), status_code=upstream.status_code,
                                         background=BackgroundTask(upstream.aclose))
        response.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in out_headers] + [
            (k, v) for k, v in response.raw_headers if k == b"content-length"]
        return response


_RELAYS: dict[int, Listener] = {}
_LOCK = asyncio.Lock()


async def relay_port(upstream_port: int) -> Optional[int]:
    """The relay port for a dev server on ``upstream_port``, started on first use; None when it cannot bind."""
    async with _LOCK:
        relay = _RELAYS.get(upstream_port)
        if relay is not None and not relay.task.done():
            return relay.port
        try:
            relay = await serve_on_socket(_Relay(upstream_port), LOOPBACK, 0, name=f"reporter-relay-{upstream_port}")
        except OSError as exc:
            logger.warning("reporter relay for port %s did not start: %s", upstream_port, exc)
            return None
        _RELAYS[upstream_port] = relay
        logger.info("reporter relay: localhost:%s -> %s", relay.port, upstream_port)
        return relay.port


__all__ = ["MESSAGE_TYPE", "REPORTER_PATH", "inject", "latest_load", "relay_port"]
