"""A desktop webhook's delivery, replayed on this app byte for byte, then acked to the hub.

A real HTTP server stands in for this instance's own route; only the hub call is captured.
"""
from __future__ import annotations

import base64
import http.server
import threading
from types import SimpleNamespace

import pytest

from flow_sdk.cloud_client import webhook_relay
from flow_sdk.cloud_client.hub_proxy import HubProxy

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


@pytest.fixture
def app(monkeypatch):
    seen: list = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            seen.append((self.path, dict(self.headers), body))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    import flow_sdk.instance_settings as settings

    monkeypatch.setattr(settings, "get_instance_settings", lambda: SimpleNamespace(port=server.server_port))
    webhook_relay._HANDLED.clear()
    yield seen
    server.shutdown()


@pytest.fixture
def acks(monkeypatch):

    sent: list = []

    async def hub_call(method, entity_type, entity_id=None, action=None, *a, payload=None, **kw):
        assert method == "POST"
        sent.append((entity_type, entity_id, action, payload))
        return {"acked": True}

    monkeypatch.setattr(HubProxy, "call", staticmethod(hub_call))
    return sent


def _message(delivery_id="d-1", body=b'{"entry":[]}'):
    return {
        "message_type": "webhook_delivery", "webhook_id": "w-1", "delivery_id": delivery_id, "method": "POST",
        "path": "/api/v1/data_source/webhook/whatsapp", "query": "x=1",
        "headers": [["x-hub-signature-256", "sha256=ab"], ["content-length", "999"], ["host", "hub.example"]],
        "body_b64": base64.b64encode(body).decode(),
    }


async def test_a_delivery_is_replayed_byte_for_byte_on_this_app_then_acked(app, acks):
    status = await webhook_relay.deliver(_message())

    (path, headers, body), = app
    assert status == 200 and path == "/api/v1/data_source/webhook/whatsapp?x=1"
    assert body == b'{"entry":[]}' and headers["x-hub-signature-256"] == "sha256=ab", "the provider signed these bytes"
    assert headers["Host"].startswith("127.0.0.1"), "hop-by-hop headers are this request's own"
    assert acks == [("webhook", "w-1", "ack", {"delivery_id": "d-1", "status": 200})]


async def test_a_delivery_pushed_again_is_acked_again_not_replayed_twice(app, acks):
    await webhook_relay.deliver(_message())
    await webhook_relay.deliver(_message())
    assert len(app) == 1 and len(acks) == 2


async def test_an_unreachable_app_is_a_502_the_hub_keeps(monkeypatch, acks):
    import flow_sdk.instance_settings as settings

    webhook_relay._HANDLED.clear()
    monkeypatch.setattr(settings, "get_instance_settings", lambda: SimpleNamespace(port=1))
    assert await webhook_relay.deliver(_message("d-2")) == 502
    assert acks[-1][3] == {"delivery_id": "d-2", "status": 502}


async def test_a_refused_catch_up_is_not_asked_again_by_the_same_principal(monkeypatch):
    """A box signed in as an agent is refused ``catch_up`` (403); its socket reconnects all day, so it must stop asking."""
    from flow_sdk.cli import app_config
    from flow_sdk.cloud_client.shared.errors import HubError

    asked: list = []

    async def hub_call(*_a, **_kw):
        asked.append(1)
        raise HubError(403, "Forbidden")

    monkeypatch.setattr(HubProxy, "call", staticmethod(hub_call))
    monkeypatch.setattr(webhook_relay, "_refused_for", None)
    user = {"id": "agent-1"}
    monkeypatch.setattr(app_config, "get_user", lambda: user)

    for _ in range(3):
        await webhook_relay.catch_up()
    assert len(asked) == 1

    user["id"] = "person-2"  # a different sign-in asks again
    await webhook_relay.catch_up()
    assert len(asked) == 2
