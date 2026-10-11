"""Narrow, signed-provider ingress, separate from the node's authenticated API.

Enabled by the direct-delivery setup step. Its port is retained per instance and
reopened at startup, so providers keep a stable callback across server restarts.
Only the public provider GET/POST routes are mounted: hub-trusted source-ID
routes and the rest of the node API are deliberately absent.
"""
from __future__ import annotations

import asyncio
import os
import socket
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI

from flow_sdk.schema.data_spec.spec import DataSpec


class ListenerState(DataSpec):
    port: int


_server: uvicorn.Server | None = None
_task: asyncio.Task | None = None
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
    global _server, _task, _url
    async with _lock:
        if _server is not None and _server.started and _task is not None and not _task.done():
            return _url
        if not start:
            return None
        host = os.environ.get("FLOWPAD_WEBHOOK_HOST", "127.0.0.1")
        external = os.environ.get("FLOWPAD_WEBHOOK_BASE_URL", "").rstrip("/")
        if external:
            parsed = urlsplit(external)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
                raise ValueError("FLOWPAD_WEBHOOK_BASE_URL must be an HTTP(S) origin")
        elif host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("a non-loopback webhook listener requires FLOWPAD_WEBHOOK_BASE_URL")
        path = _state_path()
        state = ListenerState.model_validate_json(path.read_text()) if path.exists() else None
        port = int(os.environ.get("FLOWPAD_WEBHOOK_PORT") or (state.port if state else 0))
        sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
        server = None
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
            sock.listen()
            sock.setblocking(False)
            port = sock.getsockname()[1]
            config = uvicorn.Config(listener_app(), lifespan="off", log_config=None, access_log=False)
            config.load()
            server = uvicorn.Server(config)
            server.lifespan = config.lifespan_class(config)
            await server.startup(sockets=[sock])
            path.parent.mkdir(parents=True, exist_ok=True)
            pending = path.with_suffix(".tmp")
            pending.write_text(ListenerState(port=port).model_dump_json())
            pending.replace(path)
        except BaseException:
            if server is not None and server.started:
                await server.shutdown()
            sock.close()
            raise
        _server = server
        _task = asyncio.create_task(server.main_loop(), name="signed-webhook-listener")
        _url = external or f"http://{'[' + host + ']' if ':' in host else host}:{port}"
        return _url


async def restore() -> None:
    if _state_path().exists():
        await callback_base_url(start=True)


async def stop() -> None:
    global _server, _task, _url
    if _server is not None:
        _server.should_exit = True
        if _task is not None:
            _task.cancel()
            try:
                await _task
            except asyncio.CancelledError:
                pass
        await _server.shutdown()
    _server, _task, _url = None, None, None
