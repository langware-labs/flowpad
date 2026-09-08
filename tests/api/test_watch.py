"""Tests for watch/unwatch functionality and real-time entity notifications.

Tests the watch system which enables clients to register/unregister watches
and receive data_op_msg notifications when watched entities change via WebSocket.
"""

import json

import anyio
import pytest
import pytest_asyncio
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.testclient import TestClient

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.watch_registry import (
    cleanup_connection,
    get_watched_by,
    get_watched_entities,
)
from flow_sdk.builtin.project import Project
from flow_sdk.core.network.connections import get_all_connections
from flow_sdk.server.app import app


@pytest.fixture
def connection_id():
    connection = mint_uuid()
    assert connection not in get_watched_entities()
    try:
        yield connection
    finally:
        cleanup_connection(connection)
        assert connection not in get_watched_entities()


@pytest_asyncio.fixture
async def watched_project(bootstrapped_client, tmp_path):
    project = Project(
        id=mint_uuid(),
        name="Watch fixture",
        fs_storage_mount_path=str(tmp_path / "project"),
    )
    await project.save(notify=False)
    return project


@pytest.mark.asyncio
async def test_watch_action(bootstrapped_client, watched_project, connection_id):
    """Test that watch registers the connection and returns success."""
    entity_key = f"project:{watched_project.id}"
    assert get_watched_by(entity_key) == set()

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{watched_project.id}/watch",
        json={"connection_id": connection_id},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "SUCCESS"
    assert result["data"] is True
    assert get_watched_by(entity_key) == {connection_id}
    assert get_watched_entities()[connection_id] == {entity_key}


@pytest.mark.asyncio
async def test_unwatch_action(bootstrapped_client, watched_project, connection_id):
    """Test that unwatch removes the connection's membership."""
    entity_key = f"project:{watched_project.id}"
    project_path = f"/api/v1/graph/project/{watched_project.id}"

    # Watch the project
    response = await bootstrapped_client.post(
        f"{project_path}/watch",
        json={"connection_id": connection_id},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "SUCCESS"
    assert response.json()["data"] is True
    assert get_watched_by(entity_key) == {connection_id}

    # Unwatch the project
    response = await bootstrapped_client.post(
        f"{project_path}/unwatch",
        json={"connection_id": connection_id},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "SUCCESS"
    assert result["data"] is True
    assert get_watched_by(entity_key) == set()
    assert get_watched_entities()[connection_id] == set()


@pytest.mark.asyncio
async def test_watch_missing_target(bootstrapped_client, connection_id):
    """Test that a missing target fails before registering a watch."""
    missing_id = mint_uuid()
    entity_key = f"project:{missing_id}"
    assert await Project.get_by_id(missing_id) is None

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{missing_id}/watch",
        json={"connection_id": connection_id},
    )
    assert response.status_code == 404
    assert response.json()["status"] == "FAIL"
    assert get_watched_by(entity_key) == set()
    assert connection_id not in get_watched_entities()


def _receive_ws_messages(ws, *, target=None, count=1):
    """Receive a frame group within the original five-second deadline."""
    async def receive():
        # TestClient's public receive blocks on its portal without a timeout.
        # Await its stream on that portal so cancellation stops the receive.
        with anyio.fail_after(5):
            messages = []
            while len(messages) < count:
                frame = await ws._send_rx.receive()
                ws._raise_on_close(frame)
                assert frame["type"] == "websocket.send"
                message = json.loads(frame["text"])
                if target is not None and message.get("to_entity") != target:
                    # CREATE broadcasts can arrive for background entities.
                    # Never filter an unexpected operation on our own target.
                    assert message.get("message_type") in {"data_op_msg", "flow_data_msg"}, message
                    assert isinstance(message.get("to_entity"), str) and message["to_entity"], message
                    continue
                messages.append(message)
            return messages

    return ws.portal.call(receive)


@pytest.mark.asyncio
@pytest.mark.usefixtures("reset_db_for_testclient")
async def test_entity_update_notification(watched_project, connection_id):
    """Test that updating a watched entity delivers its changed data."""
    target = f"project-{watched_project.id}"
    project_path = f"/api/v1/graph/project/{watched_project.id}"
    with TestClient(app) as client:
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            confirmation, = _receive_ws_messages(ws)
            assert confirmation["message_type"] == "response_msg"
            assert confirmation["status"] == "ok"
            assert confirmation["data"]["connection_id"] == connection_id

            response = client.post(f"{project_path}/watch", json={"connection_id": connection_id})
            assert response.status_code == 200, response.text
            assert response.json()["status"] == "SUCCESS"
            assert response.json()["data"] is True
            assert get_watched_by(f"project:{watched_project.id}") == {connection_id}

            response = client.put(project_path, json={"name": "Updated Watch fixture"})
            assert response.status_code == 200, response.text
            assert response.json()["status"] == "SUCCESS"
            assert response.json()["data"]["name"] == "Updated Watch fixture"

            notification, = _receive_ws_messages(ws, target=target)
            assert notification["message_type"] == "data_op_msg"
            assert notification["op"] == "update"
            assert notification["to_entity"] == target
            assert notification["data"]["id"] == watched_project.id
            assert notification["data"]["name"] == "Updated Watch fixture"
        assert connection_id not in get_all_connections()
        assert connection_id not in get_watched_entities()


@pytest.mark.asyncio
@pytest.mark.usefixtures("reset_db_for_testclient")
async def test_entity_delete_notification(watched_project, connection_id):
    """Test that deletion delivers its notice followed by the delete operation."""
    target = f"project-{watched_project.id}"
    project_path = f"/api/v1/graph/project/{watched_project.id}"
    with TestClient(app) as client:
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            confirmation, = _receive_ws_messages(ws)
            assert confirmation["message_type"] == "response_msg"
            assert confirmation["status"] == "ok"
            assert confirmation["data"]["connection_id"] == connection_id

            response = client.post(f"{project_path}/watch", json={"connection_id": connection_id})
            assert response.status_code == 200, response.text
            assert response.json()["status"] == "SUCCESS"
            assert response.json()["data"] is True
            assert get_watched_by(f"project:{watched_project.id}") == {connection_id}

            response = client.delete(project_path)
            assert response.status_code == 200, response.text
            assert response.json()["status"] == "SUCCESS"

            prelude, notification = _receive_ws_messages(ws, target=target, count=2)
            assert prelude["message_type"] == "flow_data_msg"
            assert prelude["to_entity"] == target
            assert prelude["flow_data"]["attributes"]["event"] == "entity_deleted"
            assert prelude["flow_data"]["attributes"]["entity_id"] == watched_project.id
            assert notification["message_type"] == "data_op_msg"
            assert notification["op"] == "delete"
            assert notification["to_entity"] == target
            assert "data" not in notification
        assert connection_id not in get_all_connections()
        assert connection_id not in get_watched_entities()


@pytest.mark.asyncio
async def test_receive_ws_messages_preserves_operations_and_cancels():
    """Correlation preserves unexpected owned operations; timeout cancels the reader."""
    target = f"project-{mint_uuid()}"
    owned_frame = {"message_type": "data_op_msg", "to_entity": target, "op": "create"}

    async def quiet_socket(websocket):
        await websocket.accept()
        await websocket.send_json({
            "message_type": "data_op_msg",
            "to_entity": f"project-{mint_uuid()}",
            "op": "create",
        })
        await websocket.send_json(owned_frame)
        value = await websocket.receive_json()
        await websocket.send_json(value)

    quiet_app = Starlette(routes=[WebSocketRoute("/quiet", quiet_socket)])
    with TestClient(quiet_app) as client:
        with client.websocket_connect("/quiet") as ws:
            notification, = _receive_ws_messages(ws, target=target)
            assert notification == owned_frame
            with pytest.raises(TimeoutError):
                _receive_ws_messages(ws, target=target)
            assert ws._send_rx.statistics().tasks_waiting_receive == 0
            ws.send_json({"after_timeout": "same socket"})
            echoed, = _receive_ws_messages(ws)
            assert echoed == {"after_timeout": "same socket"}


@pytest.mark.asyncio
async def test_idempotent_watch(bootstrapped_client, watched_project, connection_id):
    """Test that calling watch twice retains exactly one membership."""
    entity_key = f"project:{watched_project.id}"
    watch_path = f"/api/v1/graph/project/{watched_project.id}/watch"

    # Watch twice
    response1 = await bootstrapped_client.post(
        watch_path,
        json={"connection_id": connection_id},
    )
    assert response1.status_code == 200
    assert response1.json()["status"] == "SUCCESS"
    assert response1.json()["data"] is True
    assert get_watched_by(entity_key) == {connection_id}

    response2 = await bootstrapped_client.post(
        watch_path,
        json={"connection_id": connection_id},
    )
    assert response2.status_code == 200
    assert response2.json()["status"] == "SUCCESS"
    assert response2.json()["data"] is True
    assert get_watched_by(entity_key) == {connection_id}
    assert get_watched_entities()[connection_id] == {entity_key}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
