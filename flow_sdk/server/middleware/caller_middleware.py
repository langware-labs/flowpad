"""Carries the UI's ``X-Flow-Caller`` header into the request's context (see ``cloud_client.caller``)."""

from starlette.types import ASGIApp, Receive, Scope, Send

from flow_sdk.cloud_client.caller import CALLER_HEADER, as_caller

_HEADER = CALLER_HEADER.encode()


class CallerMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw = next((v for k, v in scope.get("headers") or [] if k == _HEADER), b"")
        caller = raw.decode("utf-8", "replace") or f"api {scope.get('method')} {scope.get('path')}"
        with as_caller(caller):
            await self.app(scope, receive, send)
