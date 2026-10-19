"""Narrow, signed-provider ingress, separate from the node's authenticated API.

Enabled by the direct-delivery setup step. Its port is retained per instance and
reopened at startup, so providers keep a stable callback across server restarts.
Only the public provider GET/POST routes are mounted: hub-trusted source-ID
routes and the rest of the node API are deliberately absent.
"""

from __future__ import annotations

import asyncio
import os
from urllib.parse import urlsplit

from fastapi import FastAPI

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.server.listener import Listener, serve_on_socket, stop_listener


class ListenerState(DataSpec):
    port: int


_listener: Listener | None = None
_url: str | None = None
_lock = asyncio.Lock()


def _state_path():
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().server_json_path.parent / "webhook-listener.json"


def listener_app() -> FastAPI:
    from flow_sdk.schema.data_spec.webhook_spec import WEBHOOK_ROUTE
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery, webhook_handshake

    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
    app.add_api_route(WEBHOOK_ROUTE, webhook_handshake, methods=["GET"])
    app.add_api_route(WEBHOOK_ROUTE, webhook_delivery, methods=["POST"])
    return app


async def callback_base_url(*, start: bool = False) -> str | None:
    """Return this runtime's direct callback origin; start it only when requested."""
    global _listener, _url
    async with _lock:
        if _listener is not None and _listener.server.started and not _listener.task.done():
            return _url
        if not start:
            return None
        host = os.environ.get("FLOWPAD_WEBHOOK_HOST", "127.0.0.1")
        external = os.environ.get("FLOWPAD_WEBHOOK_BASE_URL", "").rstrip("/")
        if external:
            parsed = urlsplit(external)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.query
                or parsed.fragment
                or parsed.path
            ):
                raise ValueError("FLOWPAD_WEBHOOK_BASE_URL must be an HTTP(S) origin")
        elif host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("a non-loopback webhook listener requires FLOWPAD_WEBHOOK_BASE_URL")
        path = _state_path()
        state = ListenerState.model_validate_json(path.read_text()) if path.exists() else None
        port = int(os.environ.get("FLOWPAD_WEBHOOK_PORT") or (state.port if state else 0))
        listener = await serve_on_socket(listener_app(), host, port, name="signed-webhook-listener")
        port = listener.port
        path.parent.mkdir(parents=True, exist_ok=True)
        pending = path.with_suffix(".tmp")
        pending.write_text(ListenerState(port=port).model_dump_json())
        pending.replace(path)
        _listener = listener
        _url = external or f"http://{'[' + host + ']' if ':' in host else host}:{port}"
        return _url


async def restore() -> None:
    if _state_path().exists():
        await callback_base_url(start=True)


async def stop() -> None:
    global _listener, _url
    if _listener is not None:
        await stop_listener(_listener)
    _listener, _url = None, None
