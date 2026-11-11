"""The launcher signs a cloud-hub instance in with its hub API key, headless.

A cloud hub (staging, flowpad.ai) signs in only through Auth0 in a browser: its password login
answers "Use Auth0", and ``POST /cloud/login`` opens a browser nobody sees, so a launched
instance sat in ``logging_in`` forever. With ``FLOWPAD_CLOUD_API_KEY`` the launcher calls the
backend's ``/auth/login_callback`` instead — the route the hub signs a box in with.
"""

from __future__ import annotations

import http.server
import re
import subprocess
import threading
from urllib.parse import parse_qs, urlsplit

import pytest

from flow_sdk.instances import paths

SHIM = paths.REPO_ROOT / "scripts" / "instance_ctl.sh"
KEY = "fp_test+key/with=chars"


def _function_source() -> str:
    """The launcher's helpers and ``sign_in_with_api_key``, without running its ``main``."""
    text = SHIM.read_text()
    helpers = re.search(r"^log\(\).*?^die\(\).*?\n", text, re.S | re.M).group(0)
    fn = re.search(r"^sign_in_with_api_key\(\) \{.*?^\}\n", text, re.S | re.M).group(0)
    return helpers + fn


@pytest.fixture()
def backend():
    """A stub backend that records each request and answers with the status it is told to."""
    seen: list[str] = []
    answer = {"code": 302}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — http.server's name
            seen.append(self.path)
            self.send_response(answer["code"])
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield server.server_address[1], seen, answer
    finally:
        server.shutdown()


def _sign_in(port: int) -> subprocess.CompletedProcess[str]:
    script = _function_source() + f'sign_in_with_api_key {port} "$KEY_UNDER_TEST"\n'
    return subprocess.run(
        ["bash", "-c", script], env={"PATH": "/usr/bin:/bin", "KEY_UNDER_TEST": KEY},
        capture_output=True, text=True, timeout=30,
    )


def test_the_key_reaches_the_login_callback_and_a_redirect_is_success(backend):
    port, seen, _ = backend

    run = _sign_in(port)

    assert run.returncode == 0, run.stderr
    assert len(seen) == 1
    url = urlsplit(seen[0])
    assert url.path == "/auth/login_callback"
    assert parse_qs(url.query)["flowpad-api-key"] == [KEY]
    assert KEY not in run.stdout + run.stderr


def test_a_refused_key_fails_the_sign_in(backend):
    port, _, answer = backend
    answer["code"] = 401

    run = _sign_in(port)

    assert run.returncode == 1
    assert "HTTP 401" in run.stderr
