"""
WebSocket binary stream handling tests.

Migrated from FlowPad: flowpad/hub/tests/api/test_websocket_stream.py
Adapted for flow-cli:
- Uses flow-cli import paths (no flowpad.hub.*)
- No WSBinaryStreamApi action (ws_stream action not available in desktop mode)
- No TranscriptMessage / audio transcription tests
- Tests basic WebSocket connection, JSON messaging, and binary message handling
- Validates the WebSocket endpoint at /api/v1/connect/ws/{connection_id}
"""

import json
import uuid

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def ws_url():
    """Generate a unique WebSocket URL."""
    def _make_url():
        connection_id = str(uuid.uuid4())
        return f"/api/v1/connect/ws/{connection_id}", connection_id
    return _make_url


# Reset DB state before each test so TestClient gets a fresh event-loop-bound session.
pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


@pytest.mark.asyncio
async def test_websocket_connect_and_receive_confirmation():
    """
    Test: WebSocket connects successfully and receives connection confirmation.

    Validates:
    - WebSocket connection accepted at /api/v1/connect/ws/{connection_id}
    - Server sends confirmation message with connection_id
    """
    from flow_sdk.server.app import app

    connection_id = str(uuid.uuid4())

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        # Connect via WebSocket using the ASGI transport directly
        pass  # AsyncClient doesn't directly support WebSocket

    # Use httpx_ws or manual ASGI WebSocket for testing
    # For now, test via the WebSocket test client approach
    from starlette.testclient import TestClient

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Should receive connection confirmation
            data = ws.receive_json()
            assert data["message_type"] == "response_msg"
            assert data["status"] == "ok"
            assert data["data"]["connection_id"] == connection_id


@pytest.mark.asyncio
async def test_websocket_echo_message():
    """
    Test: WebSocket echo message type works correctly.

    Validates:
    - Sending an echo message returns the same content back
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            ws.receive_json()

            # Send echo message
            echo_msg = {
                "message_type": "echo",
                "message_id": "test-echo-1",
                "text": "Hello, world!",
            }
            ws.send_json(echo_msg)

            # Receive echo response
            response = ws.receive_json()
            assert response["message_type"] == "echo"
            assert response["text"] == "Hello, world!"


@pytest.mark.asyncio
async def test_websocket_ping_pong():
    """
    Test: WebSocket ping message returns pong.

    Validates:
    - Sending a ping returns a pong response
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            ws.receive_json()

            # Send ping
            ping_msg = {
                "message_type": "ping",
                "message_id": "test-ping-1",
                "text": "keepalive",
            }
            ws.send_json(ping_msg)

            # Receive pong
            response = ws.receive_json()
            assert response["message_type"] == "pong"
            assert response["text"] == "keepalive"


@pytest.mark.asyncio
async def test_websocket_binary_message_accepted():
    """
    Test: WebSocket accepts binary messages without error.

    In flow-cli desktop mode, binary messages (STREAM_MSG) are logged
    but not fully processed (no WSBinaryStream). This test verifies
    that binary messages don't crash the connection.

    Original FlowPad test used msgpack-encoded [stream_id, data] format.
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            ws.receive_json()

            # Send binary data (raw bytes)
            binary_data = b"\x00\x01\x02\x03\x04\x05"
            ws.send_bytes(binary_data)

            # Send a ping after binary to verify connection is still alive
            ws.send_json({"message_type": "ping", "message_id": "after-binary"})
            response = ws.receive_json()
            assert response["message_type"] == "pong", (
                "Connection should still be alive after binary message"
            )


@pytest.mark.asyncio
async def test_websocket_invalid_json():
    """
    Test: WebSocket handles invalid JSON gracefully.

    Validates:
    - Invalid JSON doesn't crash the connection
    - Error response is sent back
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            ws.receive_json()

            # Send invalid JSON
            ws.send_text("this is not valid json")

            # Should receive error response
            response = ws.receive_json()
            assert response["message_type"] == "response_msg"
            assert response["status"] == "error"
            assert "json" in response["error"].lower()


@pytest.mark.asyncio
async def test_websocket_unknown_message_type():
    """
    Test: WebSocket handles unknown message type gracefully.

    Validates:
    - Unknown message_type returns error response
    - Connection stays alive
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            ws.receive_json()

            # Send unknown message type
            ws.send_json({
                "message_type": "unknown_type",
                "message_id": "test-unknown-1",
            })

            # Should receive error response
            response = ws.receive_json()
            assert response["message_type"] == "response_msg"
            assert response["status"] == "error"
            assert "unknown" in response["error"].lower()

            # Connection should still work
            ws.send_json({"message_type": "ping", "message_id": "after-unknown"})
            pong = ws.receive_json()
            assert pong["message_type"] == "pong"


@pytest.mark.asyncio
async def test_websocket_hangup():
    """
    Test: WebSocket hangup message closes connection.
    """
    from flow_sdk.server.app import app
    from starlette.testclient import TestClient

    connection_id = str(uuid.uuid4())

    with TestClient(app) as test_client:
        with test_client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            # Consume connection confirmation
            ws.receive_json()

            # Send hangup
            ws.send_json({"message_type": "hangup"})

            # Connection should close - next receive should fail or return disconnect
            # The server closes the connection after hangup
