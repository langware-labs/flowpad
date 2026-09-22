"""One ``http`` toplog line per HTTP request, from the outermost middleware.

Every event-loop stall investigated on prod in 2026-09 was a request holding the
loop (pty-stream replay, get-history, transcript/prompts), and the backend had
no per-request timing — each one had to be found from outside. Registered
OUTERMOST so it times every request that reaches the app, including ones an
inner layer answers itself (a cookie-gate rejection, a CORS preflight).
"""

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from flow_sdk import toplog


class HttpTimingMiddleware:
    """``ttfb_ms`` is the time until the response headers went out (the handler's
    own work); ``ms`` also covers writing the body, so ``ms`` ≫ ``ttfb_ms`` means
    transfer, not compute. Off, it costs one ``toplog.is_on`` check."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not toplog.is_on("http"):
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        status = 0
        ttfb_ms = 0.0
        body_bytes = 0

        async def timed_send(message: Message) -> None:
            nonlocal status, ttfb_ms, body_bytes
            if message["type"] == "http.response.start":
                status = message.get("status", 0)
                ttfb_ms = (time.perf_counter() - started) * 1000
            elif message["type"] == "http.response.body":
                body_bytes += len(message.get("body", b""))
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                toplog.log(
                    "http", "request method=%s path=%s status=%s ttfb_ms=%.0f ms=%.0f bytes=%s",
                    scope.get("method"), scope.get("path"), status, ttfb_ms,
                    (time.perf_counter() - started) * 1000, body_bytes,
                )

        await self.app(scope, receive, timed_send)
