"""cookie-gate on the WebSocket handshake.

Its own file because WS needs the sync starlette TestClient — httpx/ASGITransport
cannot do WebSockets.

This is the half of the gate that has to be wired deliberately.
``RequestTransactionMiddleware`` bails on non-HTTP scopes
(request_transaction_middleware.py:135), which is why nothing authenticates a WS
handshake today. Cookies do ride the same-origin WS handshake — there was just
never anything there to check them.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.server import grants
from tests.utils.gate import SECRET
from tests.utils.gate import armed as _stored
from tests.utils.gate import grant_cookie as _grant

COOKIE = grants.COOKIE_NAME

pytestmark = [
    pytest.mark.usefixtures("reset_db_for_testclient"),
    pytest.mark.timeout(30),  # do not increase timeout without approval
]


def _armed(secret: str | None = SECRET):
    return _stored(secret)


def _consume_confirmation(ws):
    """Read and discard the initial connection-confirmation message."""
    data = ws.receive_json()
    assert data["message_type"] == "response_msg"
    assert data["status"] == "ok"


def test_unarmed_ws_connects_as_today():
    from starlette.testclient import TestClient

    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    with _armed(None), TestClient(app) as tc:
        with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)


def test_armed_ws_without_cookie_is_rejected():
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    with _armed(), TestClient(app) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
                ws.receive_json()

    assert exc.value.code == 1008  # policy violation, closed before accept


def test_armed_ws_with_a_system_grant_connects():
    """Cookies ride the same-origin WS handshake; the grant cookie is what a browser holds."""
    from starlette.testclient import TestClient

    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    with _armed(), _stored(), TestClient(app, cookies={COOKIE: _grant()}) as tc:
        with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)


def test_armed_ws_with_an_audience_grant_is_rejected():
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    with _armed(), _stored(), TestClient(app, cookies={COOKIE: _grant("app")}) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
                ws.receive_json()

    assert exc.value.code == 1008


def test_armed_ws_with_wrong_cookie_is_rejected():
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    with _armed(), TestClient(app, cookies={COOKIE: "wrong"}) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
                ws.receive_json()

    assert exc.value.code == 1008


def test_armed_transcript_watch_without_cookie_is_rejected():
    """watch.py:26 accepts a caller-supplied project_dir, mkdirs it, and streams
    the JSONL inside — today with no auth at all, on a public sandbox URL."""
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from flow_sdk.server.app import app

    with _armed(), TestClient(app) as tc:
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect("/api/watch/transcript?project_dir=x") as ws:
                ws.receive_json()

    assert exc.value.code == 1008


def test_armed_ws_with_header_connects():
    """Machine callers present the secret as a header on the handshake."""
    from starlette.testclient import TestClient

    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    with _armed(), TestClient(app, headers={"X-Cookie-Gate": SECRET}) as tc:
        with tc.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
