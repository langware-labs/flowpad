"""The webhook relay and the cookie gate (FLOWPAD-2233).

The relay replays a delivery from the hub on this app's own route, so it must
carry this app's gate token, and never a credential that came with the delivery.
"""
from __future__ import annotations

import base64
import http.server
import threading
from types import SimpleNamespace

import pytest

from flow_sdk.cloud_client import webhook_relay

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

TOKEN = "local-gate-token"


@pytest.fixture
def app(monkeypatch):
    seen: list = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            self.rfile.read(int(self.headers.get("content-length") or 0))
            seen.append((self.path, dict(self.headers)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    import flow_sdk.instance_settings as settings
    import flow_sdk.instance_settings.cookie_gate as cookie_gate

    monkeypatch.setattr(settings, "get_instance_settings", lambda: SimpleNamespace(port=server.server_port))
    monkeypatch.setattr(cookie_gate, "get_cookie_gate", lambda: TOKEN)
    webhook_relay._HANDLED.clear()
    yield seen
    server.shutdown()


@pytest.fixture(autouse=True)
def acks(monkeypatch):
    from flow_sdk.cloud_client.transport import hub_http

    async def hub_post(*_a, **_kw):
        return {"acked": True}

    monkeypatch.setattr(hub_http, "hub_post", hub_post)


def _message(path, delivery_id="d-1"):
    return {
        "webhook_id": "w-1", "delivery_id": delivery_id, "method": "POST", "path": path,
        "headers": [["x-cookie-gate", "sender-supplied"], ["cookie", "cookie-gate-9007=sender"]],
        "body_b64": base64.b64encode(b"{}").decode(),
    }


async def test_a_webhook_delivery_carries_this_apps_token_not_the_senders(app):
    status = await webhook_relay.deliver(_message("/api/v1/data_source/webhook/whatsapp"))

    (path, headers), = app
    assert status == 200 and path == "/api/v1/data_source/webhook/whatsapp"
    assert headers["x-cookie-gate"] == TOKEN
    assert "Cookie" not in headers and "cookie" not in headers
