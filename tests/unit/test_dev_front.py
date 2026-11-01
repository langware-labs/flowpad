"""A web app's dev runtime answers Flowpad's ``/sdk`` and ``/api`` the way the served app does.

The bug this pins: a plain folder's dev server was a bare ``python -m http.server``, so the page's
``/sdk/flowpad-sdk.js`` and ``/sdk/flowpad.css`` were 404 and the app never started (GTM Studio, 2026-10-29).
A route stored with that command is upgraded when it is started, so an app set up before the fix recovers.
"""

from __future__ import annotations

import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from flow_sdk.cli.app_discovery import discover_webapps
from flow_sdk.core.app_ports import Listener, launched_by
from flow_sdk.core.dev_server import dev_command, start_process, stop_group, wait_for_port
from flow_sdk.server.dev_front import create_app

SDK_BODY = b"export const flowpad = 1;\n"
PAGE = '<!doctype html><html><head><link rel="stylesheet" href="/sdk/flowpad.css"></head><body><script type="module" src="app.js"></script></body></html>'


class _Backend(BaseHTTPRequestHandler):
    """A real HTTP server standing in for Flowpad's backend: its ``/sdk`` file and an ``/api`` echo."""

    def do_GET(self):  # noqa: N802
        if self.path == "/sdk/flowpad-sdk.js":
            self._send(200, SDK_BODY, "text/javascript")
        elif self.path.startswith("/api/"):
            self._send(200, (self.headers.get("cookie") or "").encode(), "text/plain", cookie="s=1; Path=/")
        else:
            self._send(404, b"no", "text/plain")

    def _send(self, status, body, kind, cookie=None):
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        if cookie:
            self.send_header("set-cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def backend(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Backend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv("FLOWPAD_BACKEND", origin)
    yield origin
    server.shutdown()


@pytest.fixture
def app_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "gtm-pipeline"
    folder.mkdir()
    (folder / "index.html").write_text(PAGE)
    (folder / "app.js").write_text("import '/sdk/flowpad-sdk.js';\n")
    return folder


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _client(root: Path) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(root)), base_url="http://127.0.0.1:8001")


async def test_page_gets_the_sdk_and_the_served_documents_handling(backend, app_dir):
    async with _client(app_dir) as client:
        page = await client.get("/")
        sdk = await client.get("/sdk/flowpad-sdk.js")
        js = await client.get("/app.js")
        deep = await client.get("/pipeline/42")
    assert page.status_code == 200 and "__FLOWPAD_API_URL__" in page.text  # same injection as the served app
    assert page.headers["cache-control"] == "no-cache"
    assert sdk.status_code == 200 and sdk.content == SDK_BODY
    assert js.status_code == 200
    assert deep.status_code == 200 and "__FLOWPAD_API_URL__" in deep.text  # client routes fall back to index


async def test_api_keeps_the_browser_session_both_ways(backend, app_dir):
    async with _client(app_dir) as client:
        reply = await client.get("/api/v1/graph/bootstrap", headers={"cookie": "flowpad_gate=abc"})
    assert reply.text == "flowpad_gate=abc"
    assert reply.headers["set-cookie"] == "s=1; Path=/"


async def test_backend_down_is_a_clear_502(monkeypatch, app_dir):
    monkeypatch.setenv("FLOWPAD_BACKEND", f"http://127.0.0.1:{_free_port()}")
    async with _client(app_dir) as client:
        reply = await client.get("/sdk/flowpad-sdk.js")
    assert reply.status_code == 502


def test_a_stored_bare_file_server_is_upgraded_and_still_recognised():
    stored = '"/opt/py/bin/python3" -m http.server 8001'
    run = dev_command(stored)
    assert "-m flow_sdk.server.dev_front --port 8001" in run
    assert dev_command("python3 -m http.server {port} --bind 127.0.0.1").endswith("--port {port}")
    assert dev_command("npm run dev") == "npm run dev"
    running = Listener(pid=1, port=8001, name="python", cwd="/app", commands=(run.replace('"', ""),))
    assert launched_by(running, '"/opt/py/bin/python3" -m http.server {port}')


@pytest.mark.parametrize("how", ["discovered", "stored-legacy"])
def test_the_started_dev_runtime_serves_the_sdk(backend, app_dir, how):
    """Through the real start path: the command ``flow app open`` runs, started by ``start_process``."""
    [candidate] = discover_webapps(app_dir.parent, "gtm-pipeline")
    command = candidate.start_cmd if how == "discovered" else '"python3" -m http.server {port}'
    port = _free_port()
    proc, log = start_process(command.replace("{port}", str(port)), cwd=app_dir, port=port, name="gtm-pipeline")
    try:
        assert wait_for_port(port, 15, exited=lambda: proc.poll() is not None), Path(log).read_text()
        sdk = httpx.get(f"http://127.0.0.1:{port}/sdk/flowpad-sdk.js")
        page = httpx.get(f"http://127.0.0.1:{port}/")
    finally:
        stop_group(proc.pid)
    assert sdk.status_code == 200 and sdk.content == SDK_BODY
    assert "__FLOWPAD_API_URL__" in page.text


ENDPOINT = "4c46354c-c3d5-4fb5-9ed9-3ac6772cf6c2"
SERVICE = f"/api/v1/graph/service_endpoint/{ENDPOINT}/service/gtm-pipeline-dev/"


async def test_the_page_at_its_service_path_resolves_its_app_like_the_served_one(backend, app_dir):
    """The SDK reads the app from ``location.pathname`` (``ts_sdk/src/apps/host.ts``): a dev page
    served at ``/`` names no app and the app's startup throws."""
    async with _client(app_dir) as client:
        page = await client.get(SERVICE + "?theme=dark")
        js = await client.get(SERVICE + "app.js")
        other_api = await client.get(f"/api/v1/graph/service_endpoint/{ENDPOINT}", headers={"cookie": "g=1"})
    assert page.status_code == 200
    assert f'<base href="http://127.0.0.1:8001{SERVICE}?theme=dark"' in page.text
    assert js.status_code == 200 and "flowpad-sdk" in js.text
    assert other_api.text == "g=1"  # the endpoint's own record is still the backend's


def test_flowpad_addresses_a_static_dev_route_at_its_service_path():
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint, static_dev_address

    def endpoint(start_cmd):
        return ServiceEndpoint(
            id=ENDPOINT,
            name="app",
            subkind="app",
            protocol={"spec_kind": "web.app", "entry": "index.html"},
            backend={
                "type": "routed",
                "routes": {"gtm-pipeline-dev": {"backend": {"type": "proxy", "port": 8001, "start_cmd": start_cmd}}},
            },
        )

    legacy = endpoint('"/py/bin/python3" -m http.server 8001')
    assert static_dev_address(legacy, "gtm-pipeline-dev", "http://localhost:8001") == f"http://localhost:8001{SERVICE}"
    vite = endpoint("npm run dev")
    assert static_dev_address(vite, "gtm-pipeline-dev", "http://localhost:8001") == "http://localhost:8001"
