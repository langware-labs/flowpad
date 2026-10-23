"""Real servers for the HubProxy stress suite: an echo hub and the desktop graph server.

Both run under uvicorn on free ports, in their own threads and event loops — real sockets,
real HTTP, nothing patched. The echo hub answers every request with what it RECEIVED
(method, raw path, raw query, headers, body digest), and is steered per request by
``x-echo-*`` headers, which the proxy forwards like any other end-to-end header.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import json
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import uvicorn

from flow_sdk.db.drivers.query import encode_cursor, page_order


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Received:
    method: str
    raw_path: str
    query: str
    headers: list[tuple[str, str]]
    body: bytes

    @property
    def tag(self) -> str | None:
        return next((v for k, v in self.headers if k == "x-echo-tag"), None)

    def header(self, name: str) -> list[str]:
        return [v for k, v in self.headers if k == name.lower()]


@dataclass
class EchoHub:
    """An ASGI app that records each request and answers per its ``x-echo-*`` headers.

    Modes (``x-echo-mode``): ``json`` (default, an envelope echoing the request), ``detail``
    (FastAPI ``{"detail"}`` refusal), ``binary`` (``x-echo-size`` bytes), ``sse``
    (``x-echo-events`` events, ``x-echo-gap`` seconds apart), ``redirect`` (302), ``cookies``
    (two Set-Cookie), ``gzip`` (gzip-encoded envelope), ``empty`` (204), ``slow`` (sleep
    ``x-echo-delay``), ``answer`` (``x-echo-answer`` JSON returned as the envelope's data),
    ``text`` (a non-JSON 200). ``x-echo-status`` sets the status.
    """

    # Everything that reached the hub — including stray requests other tests' background tasks
    # send to whatever hub is configured. ``received`` is only the current test's (``tag``).
    all_received: list[Received] = field(default_factory=list)
    tag: str | None = None
    sse_closed: list[int] = field(default_factory=list)
    # (METHOD, raw path) → the envelope ``data`` to answer with, for requests the test does not
    # send itself (a follow-up the desktop makes on its own).
    scripted: dict[tuple[str, str], Any] = field(default_factory=dict)
    # raw path → the rows of a hub LIST, answered the way the hub pages one: ``filter`` holds
    # ``limit``/``offset`` (a plain ``?limit`` is refused 400), a paged answer carries ``has_more`` and
    # ``next_offset``. ``paged_fail_at`` (raw path → offset) answers 503 from that offset on;
    # ``paged_delay`` (seconds) slows every page. ``paged_seconds`` is what each page took.
    paged: dict[str, list[dict]] = field(default_factory=dict)
    paged_fail_at: dict[str, int] = field(default_factory=dict)
    paged_delay: float = 0.0
    paged_seconds: list[float] = field(default_factory=list)

    async def _answer_page(self, rec: Received, respond) -> None:
        await _page_answer(self, rec, respond)

    @property
    def received(self) -> list[Received]:
        return [r for r in self.all_received if self.tag is None or r.tag == self.tag]

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                msg = await receive()
                if msg["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif msg["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        headers = [(k.decode("latin-1").lower(), v.decode("latin-1")) for k, v in scope["headers"]]
        rec = Received(
            scope["method"],
            (scope.get("raw_path") or scope["path"].encode()).decode("latin-1"),
            scope.get("query_string", b"").decode("latin-1"),
            headers,
            body,
        )
        self.all_received.append(rec)
        h = dict(headers)
        mode = h.get("x-echo-mode", "json")
        status = int(h.get("x-echo-status", "200"))

        async def respond(content: bytes, ctype: str, extra: list[tuple[bytes, bytes]] | None = None, st: int = status):
            hdrs = [(b"content-type", ctype.encode()), (b"content-length", str(len(content)).encode())]
            await send({"type": "http.response.start", "status": st, "headers": hdrs + (extra or [])})
            await send({"type": "http.response.body", "body": content})

        echo = {
            "method": rec.method,
            "raw_path": rec.raw_path,
            "query": rec.query,
            "headers": headers,
            "body_len": len(body),
            "body_sha256": hashlib.sha256(body).hexdigest(),
            "body_text": body.decode("utf-8", "replace") if len(body) <= 4096 else None,
        }
        envelope = {"status": "SUCCESS" if status < 400 else "FAIL", "message": "echo", "data": echo}
        if rec.method == "GET" and rec.raw_path in self.paged and "x-echo-mode" not in h:
            await self._answer_page(rec, respond)
        elif (rec.method, rec.raw_path) in self.scripted and "x-echo-mode" not in h:
            data = self.scripted[(rec.method, rec.raw_path)]
            await respond(json.dumps({"status": "SUCCESS", "message": "success", "data": data}).encode(), "application/json")
        elif mode == "json":
            await respond(json.dumps(envelope).encode(), "application/json")
        elif mode == "answer":
            data = json.loads(h.get("x-echo-answer", "null"))
            await respond(json.dumps({"status": "SUCCESS", "message": "success", "data": data}).encode(), "application/json")
        elif mode == "detail":
            await respond(json.dumps({"detail": f"refused {status}"}).encode(), "application/json")
        elif mode == "text":
            await respond(b"plain text, not json", "text/plain")
        elif mode == "binary":
            size = int(h.get("x-echo-size", "1024"))
            content = bytes((i * 31) % 256 for i in range(size))
            await respond(content, "application/octet-stream", [(b"content-disposition", b'attachment; filename="b.bin"')])
        elif mode == "gzip":
            await respond(gzip.compress(json.dumps(envelope).encode()), "application/json", [(b"content-encoding", b"gzip")])
        elif mode == "cookies":
            await respond(b"{}", "application/json", [(b"set-cookie", b"a=1; Path=/"), (b"set-cookie", b"b=2; Path=/")])
        elif mode == "redirect":
            await respond(b"", "text/plain", [(b"location", b"https://example.invalid/next")], st=302)
        elif mode == "empty":
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})
        elif mode == "slow":
            await asyncio.sleep(float(h.get("x-echo-delay", "1")))
            await respond(json.dumps(envelope).encode(), "application/json")
        elif mode == "sse":
            n = int(h.get("x-echo-events", "5"))
            gap = float(h.get("x-echo-gap", "0.05"))
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            gone = asyncio.Event()

            async def watch():  # uvicorn drops writes to a closed peer silently: ask receive()
                while (await receive())["type"] != "http.disconnect":
                    pass
                gone.set()

            watcher = asyncio.create_task(watch())
            sent = 0
            try:
                for i in range(n):
                    if gone.is_set():
                        break
                    await send({"type": "http.response.body", "body": f"data: {i}\n\n".encode(), "more_body": True})
                    sent += 1
                    await asyncio.sleep(gap)
                if not gone.is_set():
                    await send({"type": "http.response.body", "body": b""})
            finally:
                watcher.cancel()
                if sent < n:
                    self.sse_closed.append(sent)
        else:
            await respond(b"unknown mode", "text/plain", st=500)


async def _page_answer(hub: "EchoHub", rec: Received, respond) -> None:
    from urllib.parse import parse_qs  # noqa: PLC0415

    started = time.monotonic()
    query = parse_qs(rec.query)
    plain = [k for k in ("limit", "offset", "order_by") if k in query]
    if plain:
        detail = {"detail": f"paging goes inside filter, not as {', '.join(plain)}"}
        await respond(json.dumps(detail).encode(), "application/json", st=400)
        return
    flt = json.loads(query.get("filter", ["{}"])[0])
    limit, offset = flt.get("limit"), int(flt.get("offset") or 0)
    rows = hub.paged[rec.raw_path]
    # The rows are kept in the order asked for; a page's order is total (``page_order``), and ``after`` (a
    # page's ``next_cursor``) starts right after the row it names — as on the hub, never with an offset.
    order = page_order(flt.get("order_by"))
    if flt.get("after") is not None:
        start = _cursor_start(rows, order, flt["after"]) if "offset" not in flt else None
        if start is None:
            detail = {"detail": "after: not a cursor for this list"}
            await respond(json.dumps(detail).encode(), "application/json", st=400)
            return
        rows, base = rows[start:], start
    else:
        base = 0
    fail_at = hub.paged_fail_at.get(rec.raw_path)
    if hub.paged_delay:
        await asyncio.sleep(hub.paged_delay)
    if fail_at is not None and base + offset >= fail_at:
        await respond(json.dumps({"detail": "unavailable"}).encode(), "application/json", st=503)
        return
    envelope: dict[str, Any] = {"status": "SUCCESS", "message": "success"}
    if limit is None:
        envelope["data"] = rows
    else:
        page = rows[offset : offset + int(limit)]
        has_more = offset + len(page) < len(rows)
        cursor = encode_cursor(order, page[-1]) if has_more and page else None
        envelope.update(data=page, has_more=has_more, next_offset=offset + len(page), next_cursor=cursor)
    await respond(json.dumps(envelope).encode(), "application/json")
    hub.paged_seconds.append(time.monotonic() - started)


def _cursor_start(rows: list[dict], order: list[tuple[str, str]], cursor: str) -> int | None:
    """Where the page after ``cursor`` starts in ``rows``: right after the row whose sort values it carries."""
    try:
        decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except Exception:  # noqa: BLE001 -- a malformed cursor is the caller's error
        return None
    if [tuple(term) for term in decoded.get("order", [])] != order:
        return None
    for i, row in enumerate(rows):
        if [row.get(field) for field, _ in order] == decoded.get("values"):
            return i + 1
    return None


def build_desktop_app():
    """The desktop's own graph surface: real middleware, graph router and WS router."""
    import importlib
    import pkgutil

    from fastapi import FastAPI

    import flow_sdk.app.actions  # noqa: F401 — side-effect registration
    import flow_sdk.builtin as builtin_pkg
    from flow_sdk.schema.type_info import register_all

    # Every entity type the real server knows, hub-only ones included.
    for mod in pkgutil.walk_packages(builtin_pkg.__path__, "flow_sdk.builtin."):
        try:
            importlib.import_module(mod.name)
        except Exception:  # noqa: BLE001 — an optional module the server would skip too
            pass
    register_all()
    from flow_sdk.server.middleware.request_transaction_middleware import RequestTransactionMiddleware
    from flow_sdk.server.routes import graph_router
    from flow_sdk.server.routes.websocket import websocket_router

    app = FastAPI()
    app.add_middleware(RequestTransactionMiddleware)
    app.include_router(graph_router, prefix="/api/v1/graph")
    app.include_router(websocket_router)
    return app


class ThreadedServer:
    """uvicorn in a daemon thread with its own loop; ``url`` once it accepts connections."""

    def __init__(self, app: Any, port: int | None = None):
        self.port = port or free_port()
        self.config = uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="off")
        self.server = uvicorn.Server(self.config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> "ThreadedServer":
        self.thread.start()
        deadline = time.time() + 15
        while not self.server.started:
            if time.time() > deadline:
                raise RuntimeError("server did not start")
            time.sleep(0.02)
        return self

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)
