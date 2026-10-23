"""Pytest plugin for the HUB test suite: route every signed-in hub test client through a desktop.

Run from the hub repo (its venv, its test DB):

    PYTHONPATH=<oss>/tests/hub_passthrough \\
      uv run pytest -p hub_passthrough_plugin hub/tests/api/...

- The hub test app is served on a real port, inside the tests' own session event loop.
- ``get_async_test_client(service, headers, cookies)`` — the one seam every hub test client
  comes from — is replaced. A client carrying ``Authorization: Bearer <token>`` sends its
  requests to a desktop instance signed in as that token's user (started on first use, kept
  for the session), with ``Hub-Reflect: true``; the desktop forwards them through HubProxy to
  the hub. A client without a token stays direct: a signed-out desktop answers locally by
  design, so there is nothing to compare.
- ``PASSTHROUGH_LOG`` (a path) records every routed request and its status.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
from pathlib import Path

import httpx
import pytest

OSS_ROOT = Path(__file__).resolve().parents[2]

_state: dict = {"hub_url": None, "desktops": {}, "procs": [], "locks": {}, "original": None, "direct": set(), "tails": {}}


def _note(msg: str) -> None:
    log = os.environ.get("PASSTHROUGH_EVENTS")
    if log:
        with open(log, "a") as f:
            f.write(msg + "\n")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _alive(token: str) -> str | None:
    entry = _state["desktops"].get(token)
    if entry is None:
        return None
    url, proc = entry
    if proc.returncode is None:
        return url
    tail = "".join(_state["tails"].get(proc.pid, [])[-30:])
    _note(f"DIED token=...{token[-8:]} pid={proc.pid} rc={proc.returncode} url={url}\n{tail}")
    del _state["desktops"][token]
    return None


async def _desktop_for(token: str, extra: tuple[str, ...] = ()) -> str | None:
    """The base URL of the desktop signed in as ``token`` — started on first use, restarted if it
    died; ``None`` for a token no desktop can sign in with (not a user login)."""
    key = token if not extra else f"{token}|{'|'.join(extra)}"
    if key in _state["direct"]:
        return None
    if (url := _alive(key)) is not None:
        return url
    lock = _state["locks"].setdefault(key, asyncio.Lock())
    async with lock:
        if key in _state["direct"]:
            return None
        if (url := _alive(key)) is not None:
            return url
        port = _free_port()
        home = tempfile.mkdtemp(prefix="passthrough-desktop-")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("NEO4J_", "PYTEST_", "VIRTUAL_ENV"))}
        env.pop("PYTHONPATH", None)
        proc = await asyncio.create_subprocess_exec(
            "uv", "run", "--project", str(OSS_ROOT), "python", "-m", "tests.hub_passthrough.desktop_main",
            "--hub", _state["hub_url"], "--token", token, "--port", str(port), "--home", home, *extra,
            cwd=str(OSS_ROOT), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )  # fmt: skip
        _state["procs"].append(proc)
        tail: list[str] = []
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=120)
            if not line:
                _state["direct"].add(key)
                _note(f"NO-DESKTOP token=...{token[-8:]} (stays direct):\n" + "".join(tail[-6:]))
                return None
            text = line.decode("utf-8", "replace")
            tail.append(text)
            if text.startswith("READY "):
                break
        _state["tails"][proc.pid] = tail
        asyncio.get_running_loop().create_task(_drain(proc))
        url = f"http://127.0.0.1:{port}"
        _state["desktops"][key] = (url, proc)
        _note(f"STARTED token=...{token[-8:]} pid={proc.pid} url={url}")
        return url


async def _drain(proc) -> None:
    log = os.environ.get("PASSTHROUGH_DESKTOP_LOG")
    tail = _state["tails"].setdefault(proc.pid, [])
    while True:
        line = await proc.stdout.readline()
        if not line:
            return
        tail.append(line.decode("utf-8", "replace"))
        del tail[:-60]
        if log:
            with open(log, "ab") as f:
                f.write(line)


class _ViaDesktop(httpx.AsyncBaseTransport):
    """Per request: a bearer-carrying request goes to the desktop signed in as that token's user
    (with ``Hub-Reflect: true``); anything else keeps the client's original in-process transport."""

    def __init__(self, direct: httpx.AsyncBaseTransport):
        self.direct = direct
        self.inner = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        token = _bearer(request.headers)
        websocket = (request.headers.get("upgrade") or "").lower() == "websocket"
        graph = request.url.raw_path.startswith(b"/api/v1/graph/")
        if token is None or _state["hub_url"] is None or websocket or not graph:
            # A socket is the desktop's own protocol, not a forwarded hub socket; a route outside
            # the graph API is outside the proxy's scope (phase 1). Both stay direct — logged.
            if token is not None and not graph:
                _note(f"OUTSIDE-GRAPH {request.method} {request.url.raw_path.decode().split('?')[0]}")
            return await self.direct.handle_async_request(request)
        desktop = await _desktop_for(token)
        if desktop is None:
            return await self.direct.handle_async_request(request)
        base = httpx.URL(desktop)
        request.url = request.url.copy_with(scheme=base.scheme, host=base.host, port=base.port)
        request.headers["host"] = f"{base.host}:{base.port}"
        request.headers["hub-reflect"] = "true"
        # The in-process transport ignores timeouts; a real socket would apply the client's 5 s.
        request.extensions = {**request.extensions, "timeout": {"connect": 30, "read": 120, "write": 120, "pool": 30}}
        if request.headers.get("origin") == "http://testserver":
            # The hub's same-origin gate compares Origin with the host it is reached at.
            request.headers["origin"] = _state["hub_url"]
        response = await self.inner.handle_async_request(request)
        log = os.environ.get("PASSTHROUGH_LOG")
        if log:
            with open(log, "a") as f:
                f.write(json.dumps({"m": request.method, "p": request.url.raw_path.decode(), "s": response.status_code}) + "\n")
        return response

    async def aclose(self) -> None:
        await self.inner.aclose()
        await self.direct.aclose()


def _bearer(headers) -> str | None:
    for k, v in (headers or {}).items():
        if k.lower() == "authorization" and str(v).lower().startswith("bearer "):
            return str(v)[7:].strip()
    return None


def _passthrough_client(service, headers=None, cookies=None) -> httpx.AsyncClient:
    client = _state["original"](service, headers=headers, cookies=cookies)
    client._transport = _ViaDesktop(client._transport)
    return client


@pytest.fixture(scope="session", autouse=True)
async def _passthrough_hub(session_service):
    import uvicorn

    port = _free_port()
    config = uvicorn.Config(session_service.app, host="127.0.0.1", port=port, log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    task = asyncio.get_running_loop().create_task(server.serve())
    while not server.started:
        if task.done():
            raise RuntimeError(f"hub server failed: {task.exception()}")
        await asyncio.sleep(0.02)
    _state["hub_url"] = f"http://127.0.0.1:{port}"

    import flowpad.hub.tests.test_utils as tu

    _state["original"] = tu.get_async_test_client
    patched = []
    for mod in list(sys.modules.values()):
        if getattr(mod, "get_async_test_client", None) is _state["original"]:
            mod.get_async_test_client = _passthrough_client
            patched.append(mod.__name__)
    print(f"\n[passthrough] hub on {_state['hub_url']}; client seam patched in {len(patched)} modules", flush=True)
    yield
    for mod_name in patched:
        sys.modules[mod_name].get_async_test_client = _state["original"]
    for proc in _state["procs"]:
        if proc.returncode is None:
            proc.terminate()
    for proc in _state["procs"]:
        try:
            await asyncio.wait_for(proc.wait(), 10)
        except asyncio.TimeoutError:
            proc.kill()
    server.should_exit = True
    try:
        await task
    except asyncio.CancelledError:
        pass  # the session loop is closing; the server is already told to exit
