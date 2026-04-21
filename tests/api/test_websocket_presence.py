"""WebSocket presence-tracking tests.

Exercises the per-connection visibility/focus state introduced alongside
the `presence` message type, and the `get_active_connection()` resolver
used to pick a single tab for agent-driven navigation.
"""

import uuid

import pytest


pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


def _consume_confirmation(ws):
    """Read and discard the initial connection-confirmation message."""
    data = ws.receive_json()
    assert data["message_type"] == "response_msg"
    assert data["status"] == "ok"


@pytest.mark.asyncio
async def test_presence_update_is_acked_and_recorded():
    """Sending `presence` returns an ack and mutates the ConnectionInfo."""
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.websocket import get_connection_infos
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)

            ws.send_json(
                {
                    "message_type": "presence",
                    "message_id": "p1",
                    "visible": False,
                    "focused": False,
                }
            )
            response = ws.receive_json()

            assert response["message_type"] == "response_msg"
            assert response["status"] == "ok"
            assert response["response_message_id"] == "p1"
            assert response["data"] == {"visible": False, "focused": False}

            infos = get_connection_infos()
            assert connection_id in infos
            assert infos[connection_id].visible is False
            assert infos[connection_id].focused is False


@pytest.mark.asyncio
async def test_presence_partial_update_preserves_missing_fields():
    """A presence message with only one field leaves the other unchanged."""
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.websocket import get_connection_infos
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)

            # Start by setting both to True explicitly, then flip only `visible`.
            ws.send_json(
                {
                    "message_type": "presence",
                    "message_id": "p-init",
                    "visible": True,
                    "focused": True,
                }
            )
            ws.receive_json()

            ws.send_json({"message_type": "presence", "message_id": "p-partial", "visible": False})
            response = ws.receive_json()
            assert response["data"] == {"visible": False, "focused": True}

            info = get_connection_infos()[connection_id]
            assert info.visible is False
            assert info.focused is True


@pytest.mark.asyncio
async def test_get_active_connection_prefers_visible_and_focused():
    """With two tabs, the one that is visible+focused wins regardless of age."""
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.websocket import get_active_connection
    from starlette.testclient import TestClient

    id_a = str(uuid.uuid4())
    id_b = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{id_a}") as ws_a:
            _consume_confirmation(ws_a)
            with test_client.websocket_connect(f"/api/v1/connect/ws/{id_b}") as ws_b:
                _consume_confirmation(ws_b)

                # B is only visible; A is visible AND focused (even though B
                # reports presence *after* A, priority wins over recency).
                ws_a.send_json(
                    {"message_type": "presence", "message_id": "pa", "visible": True, "focused": True}
                )
                ws_a.receive_json()

                ws_b.send_json(
                    {"message_type": "presence", "message_id": "pb", "visible": True, "focused": False}
                )
                ws_b.receive_json()

                active = get_active_connection()
                assert active is not None
                assert active[0] == id_a


@pytest.mark.asyncio
async def test_get_active_connection_tiebreaks_by_recency():
    """When priority is tied, newest `last_presence_at` wins."""
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.websocket import get_active_connection
    from starlette.testclient import TestClient

    id_a = str(uuid.uuid4())
    id_b = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{id_a}") as ws_a:
            _consume_confirmation(ws_a)
            with test_client.websocket_connect(f"/api/v1/connect/ws/{id_b}") as ws_b:
                _consume_confirmation(ws_b)

                ws_a.send_json(
                    {"message_type": "presence", "message_id": "pa", "visible": True, "focused": True}
                )
                ws_a.receive_json()

                # B matches A's priority but reports later → should win.
                ws_b.send_json(
                    {"message_type": "presence", "message_id": "pb", "visible": True, "focused": True}
                )
                ws_b.receive_json()

                active = get_active_connection()
                assert active is not None
                assert active[0] == id_b


@pytest.mark.asyncio
async def test_get_active_connection_falls_through_when_all_hidden():
    """With nothing visible, fall through to the newest overall record."""
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.websocket import get_active_connection
    from starlette.testclient import TestClient

    id_a = str(uuid.uuid4())
    id_b = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{id_a}") as ws_a:
            _consume_confirmation(ws_a)
            with test_client.websocket_connect(f"/api/v1/connect/ws/{id_b}") as ws_b:
                _consume_confirmation(ws_b)

                ws_a.send_json(
                    {"message_type": "presence", "message_id": "pa", "visible": False, "focused": False}
                )
                ws_a.receive_json()
                ws_b.send_json(
                    {"message_type": "presence", "message_id": "pb", "visible": False, "focused": False}
                )
                ws_b.receive_json()

                active = get_active_connection()
                assert active is not None
                # Last presence wins among hidden tabs.
                assert active[0] == id_b


@pytest.mark.asyncio
async def test_disconnect_clears_connection_info():
    """Closing the socket removes the ConnectionInfo record."""
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.websocket import get_connection_infos
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
            assert connection_id in get_connection_infos()

        # Exiting the context manager closes the socket; the server's
        # cleanup path should have popped the record.
        assert connection_id not in get_connection_infos()


@pytest.mark.asyncio
async def test_debug_connections_endpoint():
    """`GET /api/v1/debug/connections` reports state and active_id."""
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)

            ws.send_json(
                {
                    "message_type": "presence",
                    "message_id": "p-dbg",
                    "visible": True,
                    "focused": True,
                }
            )
            ws.receive_json()

            resp = test_client.get("/api/v1/debug/connections")
            assert resp.status_code == 200
            body = resp.json()

            assert body["count"] == 1
            assert body["active_id"] == connection_id
            assert len(body["connections"]) == 1
            entry = body["connections"][0]
            assert entry["id"] == connection_id
            assert entry["visible"] is True
            assert entry["focused"] is True
            assert isinstance(entry["last_presence_at_ms_ago"], int)
            assert entry["last_presence_at_ms_ago"] >= 0
