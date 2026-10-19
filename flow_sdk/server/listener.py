"""A second uvicorn server in this process, on a socket we bind ourselves.

Shared by every extra listener the app opens beside its own port — the signed-webhook
ingress (``webhook_listener``) and the audience doors (``audience_listener``). The uvicorn
internals this takes (``lifespan_class``, ``startup(sockets=…)``, ``main_loop``) are
version-sensitive; one copy breaks in one place on a uvicorn bump.
"""

from __future__ import annotations

import asyncio
import socket
from typing import NamedTuple

import uvicorn
from starlette.types import ASGIApp


class Listener(NamedTuple):
    server: uvicorn.Server
    task: asyncio.Task
    port: int


async def serve_on_socket(app: ASGIApp, host: str, port: int, *, name: str) -> Listener:
    """Bind ``host:port`` (0 = any free port), start *app* on it, run its loop as a task.

    Raises ``OSError`` when the port cannot be bound; nothing is left open then.
    """
    sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
    server = None
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen()
        sock.setblocking(False)
        bound = sock.getsockname()[1]
        config = uvicorn.Config(app, lifespan="off", log_config=None, access_log=False)
        config.load()
        server = uvicorn.Server(config)
        server.lifespan = config.lifespan_class(config)
        await server.startup(sockets=[sock])
    except BaseException:
        if server is not None and server.started:
            await server.shutdown()
        sock.close()
        raise
    return Listener(server, asyncio.create_task(server.main_loop(), name=name), bound)


async def stop_listener(listener: Listener) -> None:
    listener.server.should_exit = True
    listener.task.cancel()
    try:
        await listener.task
    except asyncio.CancelledError:
        pass
    await listener.server.shutdown()


__all__ = ["Listener", "serve_on_socket", "stop_listener"]
