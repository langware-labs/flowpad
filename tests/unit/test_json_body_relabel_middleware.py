"""``JsonBodyRelabelMiddleware`` — `curl -d '{...}'` JSON arrives labelled ``application/json``.

Driven through a real ASGI app (Starlette + httpx ``ASGITransport``) for the header cases, and
through raw ``receive`` messages where chunking matters (sniff stops early, the cap, replay).
"""

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from flow_sdk.server.middleware import json_body_relabel_middleware as mod
from flow_sdk.server.middleware.json_body_relabel_middleware import JsonBodyRelabelMiddleware

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _echo(request: Request):
    body = await request.body()
    return JSONResponse({"content_type": request.headers.get("content-type"), "body": body.decode("latin-1")})


_app = JsonBodyRelabelMiddleware(Starlette(routes=[Route("/echo", _echo, methods=["GET", "POST", "PUT"])]))
_FORM = "application/x-www-form-urlencoded"


async def _send(method: str, body: bytes = b"", content_type: str | None = None) -> dict:
    headers = {"content-type": content_type} if content_type is not None else {}
    async with AsyncClient(transport=ASGITransport(app=_app), base_url="http://test") as c:
        resp = await c.request(method, "/echo", content=body, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b'{"path":"/Users/me/notes"}', _FORM),  # what `curl -d` sends
        (b'  \n[1, 2]', _FORM),
        (b'{"path":"/x"}', f"{_FORM}; charset=utf-8"),
        (b'{"path":"/x"}', None),
    ],
    ids=["form-object", "form-array-leading-ws", "form-with-params", "no-header"],
)
async def test_json_body_is_relabelled_and_replayed_unchanged(body, content_type):
    echoed = await _send("POST", body, content_type)
    assert echoed == {"content_type": "application/json", "body": body.decode()}


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b"path=%2Ftmp%2Fx&tag=a", _FORM),  # a real form
        (b'{"path": ', _FORM),  # starts like JSON, does not parse
        (b'"just a string"', _FORM),  # JSON, but a bare scalar
        (b"", _FORM),
        (b'{"a":1}', "text/plain"),  # any explicit non-form type is not ours to judge
        (b'--B\r\nContent-Disposition: form-data; name="a"\r\n\r\n{"x":1}\r\n--B--\r\n', "multipart/form-data; boundary=B"),
    ],
    ids=["real-form", "invalid-json", "scalar", "empty", "text-plain", "multipart"],
)
async def test_everything_else_is_untouched(body, content_type):
    echoed = await _send("POST", body, content_type)
    assert echoed == {"content_type": content_type, "body": body.decode()}


async def test_get_is_untouched():
    assert (await _send("GET", content_type=_FORM))["content_type"] == _FORM


# -- chunked delivery: raw ASGI ---------------------------------------------------


async def _run_raw(chunks: list[bytes], content_type: str = _FORM):
    """Run the middleware over ``chunks``.

    Returns (Content-Type the app saw, body the app read, receives pulled before the app ran).
    """
    pulled = 0
    queue = [{"type": "http.request", "body": c, "more_body": i < len(chunks) - 1} for i, c in enumerate(chunks)]

    async def receive():
        nonlocal pulled
        pulled += 1
        return queue.pop(0)

    seen = {}

    async def inner(scope, receive, send):
        seen["pulled"] = pulled
        seen["ctype"] = dict(scope["headers"])[b"content-type"]
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        seen["body"] = body

    scope = {"type": "http", "method": "POST", "path": "/", "headers": [(b"content-type", content_type.encode())]}
    await JsonBodyRelabelMiddleware(inner)(scope, receive, None)
    return seen["ctype"], seen["body"], seen["pulled"]


async def test_json_split_across_chunks_is_relabelled():
    assert await _run_raw([b"  ", b'{"a":', b"1}"]) == (b"application/json", b'  {"a":1}', 3)


async def test_a_form_stops_the_sniff_at_its_first_chunk():
    """The sniff reads one chunk of a form; the rest streams to the app, never buffered ahead."""
    assert await _run_raw([b"a=1&", b"b=2&", b"c=3"]) == (_FORM.encode(), b"a=1&b=2&c=3", 1)


async def test_a_body_past_the_sniff_cap_keeps_its_label(monkeypatch):
    monkeypatch.setattr(mod, "MAX_SNIFF_BYTES", 8)
    ctype, body, _ = await _run_raw([b'{"a":"', b"0123456789", b'"}'])
    assert (ctype, body) == (_FORM.encode(), b'{"a":"0123456789"}')
