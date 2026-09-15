"""json-body-relabel — a JSON body labelled as a form is delivered as ``application/json``.

``curl -d '{...}'`` without ``-H`` sends ``Content-Type: application/x-www-form-urlencoded``.
That is the spelling a person types, and every doc snippet uses it. Left alone, a declared
FastAPI ``Body(...)`` answers it with a 422 and the shared ``RequestInfo`` parser reads it as a
form and hands the action ``{}``. This fixes it once, at the transport, before any route or
parser reads the body.

Rule: a ``POST``/``PUT``/``PATCH``/``DELETE`` whose ``Content-Type`` is form-urlencoded or
absent, and whose body IS a JSON object or array, has its ``Content-Type`` header rewritten to
``application/json``. The body bytes are replayed unchanged (a webhook that verifies a
signature over the raw bytes still sees exactly what was sent). Nothing else is touched:

* ``multipart/form-data`` and every other explicit type pass straight through, unread.
* A real ``key=value&...`` form cannot start with ``{`` or ``[``, so sniffing stops at the first
  non-whitespace byte and the stream continues untouched — only the chunks already received are
  replayed, nothing more is buffered.
* A body whose first byte is ``{``/``[`` is buffered to its end to confirm it parses. Every
  downstream reader of such a body (``Body(...)``, ``request.json()``, ``request.body()``)
  buffers the whole thing anyway, so this adds no new unbounded buffering in practice; still,
  the sniff gives up at ``MAX_SNIFF_BYTES`` and replays what it holds unchanged, so a huge
  mislabelled upload keeps its pre-middleware behaviour instead of being held in memory twice.
* Bytes that start like JSON but don't parse (``{"path": ``) keep their original label.

Pure ASGI (not ``BaseHTTPMiddleware``) so the body is replayed through ``receive`` without the
response being wrapped.
"""

from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_SNIFF_BYTES = 10 * 1024 * 1024

_BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_FORM = "application/x-www-form-urlencoded"
_WHITESPACE = b" \t\r\n"


def _json_container_or_none(raw: bytes) -> dict | list | None:
    """``raw`` decoded as a JSON object or array, else ``None`` (not JSON, or a bare scalar)."""
    text = raw.strip()
    if text[:1] not in (b"{", b"["):
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, (dict, list)) else None


def _may_be_mislabelled(scope: Scope) -> bool:
    if scope["type"] != "http" or scope.get("method") not in _BODY_METHODS:
        return False
    for name, value in scope.get("headers") or ():
        if name == b"content-type":
            return value.split(b";", 1)[0].strip().lower().decode("latin-1") == _FORM
    return True  # no Content-Type at all


def _relabelled(scope: Scope) -> Scope:
    headers = [(k, v) for k, v in scope.get("headers") or () if k != b"content-type"]
    headers.append((b"content-type", b"application/json"))
    return {**scope, "headers": headers}


class JsonBodyRelabelMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not _may_be_mislabelled(scope):
            await self.app(scope, receive, send)
            return

        held: list[Message] = []  # messages already pulled from `receive`, replayed in order
        size = 0
        body = bytearray()
        looks_like_json = False
        ended = False  # the whole body is in `held`
        while True:
            message = await receive()
            held.append(message)
            if message["type"] != "http.request":  # disconnect mid-body: replay as-is
                break
            chunk = message.get("body", b"")
            size += len(chunk)
            if not looks_like_json:
                first = chunk.lstrip(_WHITESPACE)[:1] if not body.strip(_WHITESPACE) else b""
                if first and first not in (b"{", b"["):
                    break  # a form (or anything else): stop sniffing, stream the rest
                if first:
                    looks_like_json = True
            body.extend(chunk)
            if not message.get("more_body", False):
                ended = True
                break
            if size > MAX_SNIFF_BYTES:
                break  # too large to hold for a sniff: keep the original label

        if ended and looks_like_json and _json_container_or_none(bytes(body)) is not None:
            scope = _relabelled(scope)

        async def replay() -> Message:
            if held:
                return held.pop(0)
            return await receive()

        await self.app(scope, replay, send)
