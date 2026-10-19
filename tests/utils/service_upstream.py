"""A REAL service standing behind a ``ServiceEndpoint``, for the proxy tests on this tier.

Not a mock: a Starlette app served by uvicorn on a free loopback port, in a thread
with its own event loop. It speaks one traffic shape per protocol an endpoint can
expose, so each protocol is proven by a round trip rather than asserted about.

``prefix`` is where it answers: ``""`` when it IS the service (the loopback hop
lands on the service's own root), or the hub's graph path when it stands in for
the hub (a remote endpoint's forward lands there).

====================  =====================================================
sub-path              shape
====================  =====================================================
``echo``              any method: reports method, path, query, headers, body
``status/<n>``        answers status ``n``
``redirect``          302 to ``/elsewhere`` (relayed, not followed)
``v1/chat/completions``  OpenAI chat: JSON, or SSE deltas when ``stream``
``mcp``               MCP streamable HTTP: POST → session + SSE, GET, DELETE
``echo.Echo/Say``     gRPC-Web: length-prefixed frames + trailer frame
``gated``             SSE whose 2nd event waits for ``release`` — streaming proof
``ws/echo``           WebSocket: echo text/bytes, subprotocol, close codes
====================  =====================================================
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import socket
import struct
import threading
import time
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


def grpc_web_frame(payload: bytes, *, trailer: bool = False) -> bytes:
    """One gRPC-Web frame: flag byte, 4-byte big-endian length, payload."""
    return struct.pack(">BI", 0x80 if trailer else 0x00, len(payload)) + payload


class ServiceUpstream:
    def __init__(self, prefix: str = "") -> None:
        self.prefix = prefix.rstrip("/")
        self.seen: list[dict[str, Any]] = []
        self.release = threading.Event()
        self.port = _free_port()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "ServiceUpstream":
        config = uvicorn.Config(self._app(), host="127.0.0.1", port=self.port, log_level="warning", lifespan="off")
        server = self._server = uvicorn.Server(config)

        def serve() -> None:
            # `Server.run()` would install uvloop's policy process-wide and detach
            # the test runner's own loop; a private loop in this thread touches nothing.
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(server.serve())
            finally:
                loop.close()

        self._thread = threading.Thread(target=serve, daemon=True)
        self._thread.start()
        deadline = time.monotonic() + 5
        while not server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("service upstream did not start")
            time.sleep(0.01)
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join()

    def last(self) -> dict[str, Any]:
        return self.seen[-1]

    def _record(self, request, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        entry = {
            "method": getattr(request, "method", "WEBSOCKET"),
            "path": request.url.path,
            "query": request.url.query,
            "headers": [(k.decode("latin-1"), v.decode("latin-1")) for k, v in request.headers.raw],
            **(extra or {}),
        }
        self.seen.append(entry)
        return entry

    def _app(self) -> Starlette:
        upstream = self
        # A hub-shaped prefix (``…/service_endpoint/{eid}``) answers on the hub's route.
        p = self.prefix + "/service" if "{eid}" in self.prefix else self.prefix

        async def echo(request: Request) -> Response:
            body = await request.body()
            entry = upstream._record(
                request, {"body_b64": base64.b64encode(body).decode(), "body_sha": hashlib.sha256(body).hexdigest()}
            )
            response = JSONResponse(entry)
            response.headers.append("set-cookie", "flowpad_session=stolen; Path=/")
            response.headers["x-upstream"] = "yes"
            return response

        async def status(request: Request) -> Response:
            upstream._record(request)
            return Response(status_code=int(request.path_params["code"]), content=b"status body")

        async def redirect(request: Request) -> Response:
            upstream._record(request)
            return Response(status_code=302, headers={"location": "/elsewhere"})

        async def chat(request: Request) -> Response:
            body = json.loads(await request.body())
            upstream._record(request, {"json": body})
            words = ["Hello", " from", " the box"]
            if not body.get("stream"):
                return JSONResponse(
                    {
                        "object": "chat.completion",
                        "model": body.get("model"),
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(words)}}],
                    }
                )

            async def events():
                for word in words:
                    yield f"data: {json.dumps({'choices': [{'delta': {'content': word}}]})}\n\n".encode()
                yield b"data: [DONE]\n\n"

            return StreamingResponse(events(), media_type="text/event-stream")

        async def mcp(request: Request) -> Response:
            upstream._record(request)
            if request.method == "POST":
                message = json.loads(await request.body())
                result = {"jsonrpc": "2.0", "id": message.get("id"), "result": {"protocolVersion": "2025-06-18"}}

                async def one():
                    yield f"event: message\ndata: {json.dumps(result)}\n\n".encode()

                return StreamingResponse(one(), media_type="text/event-stream", headers={"mcp-session-id": "s-123"})
            if request.headers.get("mcp-session-id") != "s-123":
                return Response(status_code=404)
            if request.method == "DELETE":
                return Response(status_code=204)

            async def notification():
                note = {"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info"}}
                yield f"event: message\ndata: {json.dumps(note)}\n\n".encode()

            return StreamingResponse(notification(), media_type="text/event-stream")

        async def grpc_web(request: Request) -> Response:
            body = await request.body()
            upstream._record(request)
            _flag, length = struct.unpack(">BI", body[:5])
            reply = grpc_web_frame(b"echo:" + body[5 : 5 + length]) + grpc_web_frame(
                b"grpc-status:0\r\ngrpc-message:OK\r\n", trailer=True
            )
            return Response(reply, media_type="application/grpc-web+proto")

        async def gated(request: Request) -> Response:
            upstream._record(request)
            upstream.release.clear()

            async def events():
                yield b"data: first\n\n"
                await asyncio.to_thread(upstream.release.wait, 5)
                yield b"data: second\n\n"

            return StreamingResponse(events(), media_type="text/event-stream")

        async def ws_echo(websocket: WebSocket) -> None:
            upstream._record(websocket)
            offered = websocket.scope.get("subprotocols") or []
            await websocket.accept(subprotocol="graphql-ws" if "graphql-ws" in offered else None)
            try:
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if message.get("bytes") is not None:
                        await websocket.send_bytes(message["bytes"][::-1])
                    elif message.get("text") == "close-4001":
                        await websocket.close(code=4001, reason="bye")
                        return
                    elif message.get("text") is not None:
                        await websocket.send_text("echo:" + message["text"])
            except WebSocketDisconnect:
                return

        return Starlette(
            routes=[
                Route(p + "/echo", echo, methods=_METHODS),
                Route(p + "/status/{code:int}", status, methods=_METHODS),
                Route(p + "/redirect", redirect),
                Route(p + "/v1/chat/completions", chat, methods=["POST"]),
                Route(p + "/mcp", mcp, methods=["GET", "POST", "DELETE"]),
                Route(p + "/echo.Echo/Say", grpc_web, methods=["POST"]),
                Route(p + "/gated", gated),
                WebSocketRoute(p + "/ws/echo", ws_echo),
            ]
        )


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
