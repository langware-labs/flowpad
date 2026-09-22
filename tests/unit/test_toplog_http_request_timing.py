"""The ``http`` toplog tag writes one line per HTTP request.

Every stall investigated on prod in 2026-09 was a request holding the event
loop (pty-stream replay, get-history, transcript/prompts), and the backend had
no per-request timing at all — only bootstrap was timed — so each one had to be
found from the outside. This line is the missing inside view: method, path,
status, time until the headers went out (the handler's work), total time
(including writing the body) and body size.

No mocks: a real request through the real middleware, read from the real
``toplog`` logger.
"""

from __future__ import annotations

import re

import httpx
import pytest
from fastapi import FastAPI
from starlette.middleware import Middleware
from starlette.responses import PlainTextResponse

from flow_sdk import toplog
from flow_sdk.server.middleware.request_transaction_middleware import RequestTransactionMiddleware

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_BODY = "x" * 4096
_LINE = re.compile(
    r"\[http\] request method=(\w+) path=(\S+) status=(\d+) ttfb_ms=(\d+) ms=(\d+) bytes=(\d+)"
)


def _app() -> FastAPI:
    app = FastAPI(middleware=[Middleware(RequestTransactionMiddleware)])

    @app.get("/api/v1/probe/timed")
    async def timed() -> PlainTextResponse:
        return PlainTextResponse(_BODY)

    return app


async def _get(path: str) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://t") as c:
        return await c.get(path)


def _http_lines(caplog) -> list[tuple[str, ...]]:
    return [m.groups() for r in caplog.records if (m := _LINE.search(r.getMessage()))]


@pytest.mark.asyncio
async def test_each_request_logs_one_timed_line_when_the_tag_is_on(initialize_test_db, caplog) -> None:
    toplog.enable()
    toplog.on("http")
    try:
        with caplog.at_level("INFO", logger="toplog"):
            resp = await _get("/api/v1/probe/timed")
    finally:
        toplog.disable()

    assert resp.status_code == 200
    lines = _http_lines(caplog)
    assert len(lines) == 1, f"expected exactly one http line, got {lines}"
    method, path, status, ttfb_ms, ms, body_bytes = lines[0]
    assert (method, path, status) == ("GET", "/api/v1/probe/timed", "200")
    assert int(body_bytes) == len(_BODY)
    assert int(ms) >= int(ttfb_ms)


@pytest.mark.asyncio
async def test_nothing_is_logged_when_the_tag_is_off(initialize_test_db, caplog) -> None:
    toplog.disable()
    with caplog.at_level("INFO", logger="toplog"):
        resp = await _get("/api/v1/probe/timed")

    assert resp.status_code == 200
    assert _http_lines(caplog) == []
