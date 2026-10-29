"""The dev server for a plain web-app folder: the folder live, Flowpad's ``/sdk`` and ``/api`` beside it.

A served app (``flow app serve``) is on Flowpad's own origin, so ``<link href="/sdk/flowpad.css">``,
``import "/sdk/flowpad-sdk.js"`` and the SDK's ``/api`` calls all reach the backend. A dev server is a
different origin: a bare file server answers those paths 404 and the page never starts. This one
answers them the way the served app does:

* the folder through :func:`serve_app_bytes` — the SAME document handling as the served route (the
  API-origin injection, the index fallback, the content version), never cached so an edit shows on reload;
* ``/sdk/*`` and ``/api/*`` (HTTP and WebSocket) forwarded to this instance's backend, cookies included:
  the browser is on the same host, so the gate cookie the backend set is the one it sends here.

The backend is ``FLOWPAD_BACKEND`` (the same variable the Vite template's proxy reads) or the pinned
instance's ``server.json``, read per request so a backend restarted on another port is followed.

    python -m flow_sdk.server.dev_front --port 8001 [--root <folder>]
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Optional

import httpx
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket

from flow_sdk.core.dev_server import LOOPBACK_HOST
from flow_sdk.server.service_proxy import inbound_headers, upstream_path
from flow_sdk.server.service_serving import WS_UNAVAILABLE, close, fail, http_client, relay_websocket

#: The backend's own paths a page calls from its origin — what this server forwards.
FORWARDED = ("sdk", "api")

#: Dropped on the way to the backend: the hop-by-hop set and the address. The cookie STAYS — it is the
#: browser's own session with that same backend.
_TO_BACKEND_DROP = frozenset(
    {"host", "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"}
)
_WS_DROP = _TO_BACKEND_DROP | {
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-accept",
    "sec-websocket-protocol",
}


def backend_origin() -> Optional[str]:
    """``http://127.0.0.1:<port>`` of this instance's backend, or None when it is not running."""
    explicit = (os.environ.get("FLOWPAD_BACKEND") or "").strip().rstrip("/")
    if explicit:
        return explicit
    from flow_sdk.discovery.flowpad_discovery import _parse_server_json, _server_json_path  # noqa: PLC0415

    info = _parse_server_json(_server_json_path())
    return f"http://{LOOPBACK_HOST}:{info.port}" if info else None


def _target(path: str, query: str) -> Optional[str]:
    origin = backend_origin()
    return None if origin is None else origin + upstream_path(path, query)


async def _forward(request: Request) -> Response:
    try:
        url = _target(request.url.path, request.url.query)
    except ValueError as e:
        return fail(400, str(e))
    if url is None:
        return fail(502, "Flowpad is not running")
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in _TO_BACKEND_DROP]
    has_body = request.headers.get("content-length", "0") != "0" or "chunked" in request.headers.get(
        "transfer-encoding", ""
    )
    client = http_client()
    outgoing = client.build_request(request.method, url, headers=headers, content=request.stream() if has_body else None)
    try:
        upstream = await client.send(outgoing, stream=True)
    except httpx.RequestError:
        return fail(502, "Flowpad did not answer")
    response = StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, background=BackgroundTask(upstream.aclose)
    )
    # The backend's cookies are this host's own — unlike a proxied service's, they are kept.
    response.raw_headers = [
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in inbound_headers(upstream.headers.multi_items())
    ] + [
        (b"set-cookie", value.encode("latin-1")) for value in upstream.headers.get_list("set-cookie")
    ]
    return response


async def _forward_socket(websocket: WebSocket) -> None:
    try:
        url = _target(websocket.url.path, websocket.url.query)
    except ValueError:
        url = None
    if url is None:
        await close(websocket, WS_UNAVAILABLE, "Flowpad is not running")
        return
    headers = [(k, v) for k, v in websocket.headers.items() if k.lower() not in _WS_DROP]
    await relay_websocket(
        websocket,
        "ws" + url[len("http"):],
        headers,
        subprotocols=websocket.scope.get("subprotocols") or None,
    )


def create_app(root: Path) -> Starlette:
    from flow_sdk.builtin.faas.serve_static import serve_app_bytes  # noqa: PLC0415

    async def folder(request: Request) -> Response:
        return await serve_app_bytes(root, request.path_params.get("path", ""), request, cache_control="no-cache")

    routes: list = []
    for prefix in FORWARDED:
        routes += [
            Route(f"/{prefix}/{{rest:path}}", _forward, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
            WebSocketRoute(f"/{prefix}/{{rest:path}}", _forward_socket),
        ]
    routes += [Route("/", folder), Route("/{path:path}", folder)]
    return Starlette(routes=routes)


def main(argv: Optional[list[str]] = None) -> None:
    import uvicorn  # noqa: PLC0415

    parser = argparse.ArgumentParser(prog="python -m flow_sdk.server.dev_front")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 0) or None, required=False)
    parser.add_argument("--root", default=".")
    args = parser.parse_args(argv)
    if not args.port:
        parser.error("--port (or PORT) is required")
    uvicorn.run(create_app(Path(args.root).resolve()), host=LOOPBACK_HOST, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
