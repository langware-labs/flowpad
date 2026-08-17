"""Level A web-app probe, driven against real servers exhibiting real faults.

Every fault here is produced by an actual socket doing the wrong thing -- a
closed port, a 500, a raw TCP listener that never speaks HTTP -- rather than a
mocked httpx. That matters: the probe exists precisely because the *browser*
cannot tell these cases apart, so a test that stubbed the transport would only
confirm our model of the faults, not the probe's ability to find them.
"""

from __future__ import annotations

import asyncio
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from flow_sdk.builtin.agentic_process.webapp_probe import probe_webapp

# --- fault fixture server ---------------------------------------------------

# Bodies keyed by the path the test requests. One server serves every fault so a
# test only pays for one bind.
_ROUTES: dict[str, tuple[int, str]] = {
    "/ok": (200, "<html><body><h1>Todo</h1><p>hello</p></body></html>"),
    "/http-500": (500, "<html><body>server blew up</body></html>"),
    "/http-404": (404, "<html><body>nope</body></html>"),
    "/blank": (200, "<html><body></body></html>"),
    "/spa-shell": (200, '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'),
    "/visual-only": (200, '<html><body><canvas id="c"></canvas></body></html>'),
    "/commented-script": (200, "<html><body><!-- <script src=/a.js></script> --></body></html>"),
}


class _FaultHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's interface
        if self.path == "/redirect-loop":
            self.send_response(302)
            self.send_header("Location", "/redirect-loop")
            self.end_headers()
            return
        status, body = _ROUTES.get(self.path, (404, "unknown fixture route"))
        payload = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        """Silence the default stderr access log."""


@pytest.fixture(scope="module")
def fault_server() -> Iterator[int]:
    server = HTTPServer(("127.0.0.1", 0), _FaultHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def raw_tcp_port() -> Iterator[int]:
    """A listener that accepts connections and answers with non-HTTP bytes."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    port = sock.getsockname()[1]
    stop = threading.Event()

    def serve():
        sock.settimeout(0.25)
        while not stop.is_set():
            try:
                conn, _ = sock.accept()
            except (TimeoutError, OSError):
                continue
            with conn:
                try:
                    conn.sendall(b"\x00\x01\x02 NOT-HTTP\r\n\r\n")
                except OSError:
                    pass

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        stop.set()
        thread.join(timeout=2)
        sock.close()


def _closed_port() -> int:
    """A port number nothing is listening on (bound, read, then released)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


# --- tests ------------------------------------------------------------------


def _probe(port: int, path: str = "/") -> dict:
    return asyncio.run(probe_webapp(f"http://127.0.0.1:{port}{path}", port))


def test_no_server_is_unreachable():
    """The original bug: nothing listening. The browser reports `onload` here."""
    result = _probe(_closed_port())
    assert result["reachable"] is False
    assert result["nav_error"] == "connection_refused"
    assert result["http_status"] is None


def test_healthy_app_is_clean(fault_server):
    result = _probe(fault_server, "/ok")
    assert result["reachable"] is True
    assert result["is_http"] is True
    assert result["http_status"] == 200
    assert result["blank"] is False
    assert result["nav_error"] is None


@pytest.mark.parametrize(("path", "status"), [("/http-500", 500), ("/http-404", 404)])
def test_error_status_is_reported(fault_server, path, status):
    """A listening-but-erroring server -- invisible to a no-cors liveness ping."""
    result = _probe(fault_server, path)
    assert result["reachable"] is True
    assert result["http_status"] == status
    assert result["nav_error"] is None


def test_blank_page_is_flagged(fault_server):
    result = _probe(fault_server, "/blank")
    assert result["http_status"] == 200
    assert result["blank"] is True


def test_spa_shell_is_not_blank(fault_server):
    """A React shell is empty HTML by design; flagging it would break every SPA."""
    result = _probe(fault_server, "/spa-shell")
    assert result["blank"] is False


def test_commented_out_script_does_not_rescue_a_blank_page(fault_server):
    """A real parser sees `<!-- <script> -->` as a comment, not a script.

    Worth pinning: a regex looking for `<script` would call this an SPA shell and
    let a genuinely empty page through as healthy.
    """
    result = _probe(fault_server, "/commented-script")
    assert result["blank"] is True


def test_canvas_only_page_is_not_blank(fault_server):
    """A page that paints without text is not broken."""
    result = _probe(fault_server, "/visual-only")
    assert result["blank"] is False


def test_redirect_loop_is_reported(fault_server):
    result = _probe(fault_server, "/redirect-loop")
    assert result["nav_error"] == "redirect_loop"
    assert result["reachable"] is True


def test_non_http_listener_is_reported(raw_tcp_port):
    """Port open, but whatever is there is not a web server."""
    result = _probe(raw_tcp_port)
    assert result["nav_error"] == "not_http"
    assert result["http_status"] is None


def test_probe_never_raises_on_a_garbage_url():
    """Diagnostics must degrade to a result, never break the display."""
    result = asyncio.run(probe_webapp("http://", 4173))
    assert result["probe_error"] or result["nav_error"]
