"""A graph-workflow function subprocess calls its instance's API with the cookie-gate token (FLOWPAD-2233)."""
from __future__ import annotations

import http.server
import json
import threading

import pytest

from flow_sdk.graph_workflow_manager.function_runner import GraphWorkflowCtx

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

TOKEN = "local-gate-token"


@pytest.fixture
def api(monkeypatch):
    seen: list = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self):
            seen.append((self.command, self.path, TOKEN in (self.headers.get("cookie") or "")))
            body = json.dumps({"data": {"ok": True}}).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            self.rfile.read(int(self.headers.get("content-length") or 0))
            self._answer()

        def log_message(self, *_a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    import urllib.request

    import flow_sdk.instance_settings.cookie_gate as cookie_gate

    monkeypatch.setattr(cookie_gate, "get_cookie_gate", lambda: TOKEN)
    monkeypatch.setattr(urllib.request, "_opener", None)
    cookie_gate.install_gate_opener()  # what the function runner's __main__ does
    yield f"http://127.0.0.1:{server.server_port}", seen
    server.shutdown()


def test_ctx_post_carries_the_gate_token(api):
    base, seen = api
    ctx = GraphWorkflowCtx("f", "n", "e", base)

    result = ctx.post("/api/v1/x", {"a": 1})

    assert result == {"ok": True}
    assert seen == [("POST", "/api/v1/x", True)]
