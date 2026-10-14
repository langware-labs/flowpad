"""cookie-gate parity — Electron's ``electron/cookie-gate.js`` against the backend's gate.

The token's file and wire format live twice: in ``flow_sdk/instance_settings/cookie_gate.py``
and, in JavaScript, in the Electron main process. Nothing can import one from the other,
so this runs the real JS functions under node and checks what they produce against the
Python side: the same token file, a header and a cookie the gate accepts, and a cookie
with the attributes the backend's own ``Set-Cookie`` gives it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from http.cookies import SimpleCookie
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.requests import HTTPConnection
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

import flow_sdk.server.middleware.cookie_gate_middleware as gate
from flow_sdk.instance_settings import cookie_gate, reset_instance_settings

pytestmark = [
    pytest.mark.timeout(30),  # do not increase timeout without approval
    pytest.mark.skipif(shutil.which("node") is None, reason="needs node to run electron/cookie-gate.js"),
]

_JS_MODULE = Path(__file__).resolve().parents[2] / "electron" / "cookie-gate.js"
_RUNNER = """
const gate = require(process.argv[1]);
const [fn, args] = JSON.parse(process.argv[2]);
Promise.resolve(gate[fn](...args)).then((out) => process.stdout.write(JSON.stringify(out ?? null)));
"""

# Electron's BACKEND_URL is localhost; the CLI opens 127.0.0.1. Another port is another instance.
BACKEND_URLS = ["http://localhost:9007", "http://127.0.0.1:9007", "http://localhost:6011"]


def _electron(fn: str, *args):
    """Call ``fn(*args)`` in electron/cookie-gate.js and return its JSON result."""
    out = subprocess.run(
        ["node", "-e", _RUNNER, str(_JS_MODULE), json.dumps([fn, list(args)])],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    return json.loads(out.stdout)


@pytest.fixture
def instance(sod_env, tmp_path, monkeypatch):
    """A gated instance whose flow home is ``<home>/.flow``, where Electron looks. Yields (name, home)."""
    home = tmp_path / "home"
    name = "parity"
    monkeypatch.setenv("FLOW_HOME", str(home / ".flow"))
    monkeypatch.setenv("FLOW_INSTANCE", name)
    monkeypatch.delenv(gate.OFF_SWITCH_ENV, raising=False)
    reset_instance_settings()
    yield name, home
    reset_instance_settings()


def _app() -> Starlette:
    async def ok(_request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/", ok)])
    app.add_middleware(gate.CookieGateMiddleware)
    return app


def _backend_token() -> str:
    """The token, created by the backend the way its first request creates it."""
    header = cookie_gate.get_header()
    assert header is not None
    return header.value


def _conn(url: str) -> HTTPConnection:
    """A request to ``url`` as the backend sees it."""
    host, port = url.split("://")[1].split(":")
    return HTTPConnection(
        {
            "type": "http",
            "scheme": "http",
            "server": (host, int(port)),
            "path": "/",
            "query_string": b"",
            "headers": [(b"host", f"{host}:{port}".encode())],
        }
    )


def test_electron_reads_the_file_the_backend_writes(instance):
    name, home = instance
    token = _backend_token()

    js_path = _electron("tokenPath", name, str(home))

    assert Path(js_path) == cookie_gate._token_path()
    assert _electron("readToken", js_path) == token


def test_electron_has_no_token_before_the_backend_writes_one(instance):
    name, home = instance

    assert _electron("readToken", _electron("tokenPath", name, str(home))) is None
    assert _electron("gateHeaders", None) == {}


@pytest.mark.parametrize("url", BACKEND_URLS)
def test_electron_header_passes_the_gate(instance, url):
    token = _backend_token()
    client = TestClient(_app(), base_url=url)

    assert client.get("/", headers=_electron("gateHeaders", token)).status_code == 200
    assert client.get("/", headers=_electron("gateHeaders", None)).status_code == 403


@pytest.mark.parametrize("url", BACKEND_URLS)
def test_electron_cookie_passes_the_gate(instance, url):
    token = _backend_token()
    details = _electron("cookieDetails", url, token)
    client = TestClient(_app(), base_url=url)

    assert client.get("/", headers={"cookie": f"{details['name']}={details['value']}"}).status_code == 200
    assert client.get("/", headers={"cookie": f"{details['name']}=wrong"}).status_code == 403


@pytest.mark.parametrize("url", BACKEND_URLS)
def test_electron_cookie_matches_the_backends_cookie(instance, url):
    """Electron sets the cookie the backend's ``/auth/gate`` would hand a browser on that host."""
    token = _backend_token()
    now_ms = 1_800_000_000_000
    details = _electron("cookieDetails", url, token, now_ms)

    jar = SimpleCookie()
    jar.load(cookie_gate.set_cookie_header(_conn(url)))
    [(name, backend)] = jar.items()

    assert (details["name"], details["value"]) == (name, backend.value)
    assert details["path"] == backend["path"]
    assert details["httpOnly"] == bool(backend["httponly"])
    assert details["secure"] == bool(backend["secure"])
    assert details["sameSite"].lower() == backend["samesite"].lower()
    assert details["expirationDate"] - now_ms // 1000 == int(backend["max-age"])
