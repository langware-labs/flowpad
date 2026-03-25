"""Multi-channel integration tests for the Bookmark entity.

Covers: hook_op webhook, REST graph API, compute-node records API,
and WebSocket data_op_msg notifications for create/update/delete.
"""

import json
import uuid

import pytest

# Import record class to trigger auto-registration in the type_registry.
from flow_sdk.fs_records.bookmark import BookmarkRecord  # noqa: F401
from flow_sdk.fs_store import get_default_records_root, set_default_records_root

LISTEN_URL = "/api/v1/webhook/listen"


def _envelope(payload: dict) -> dict:
    return {"webhook_type": "hook_op", "webhook_payload": payload}


def _reset_ws_state():
    """Clear stale WS connections from previous tests."""
    from flow_sdk.core.network.connections import _registry

    _registry.clear()


pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    """Redirect all record I/O to a temp directory for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    _reset_ws_state()
    yield tmp_path
    set_default_records_root(original)


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


# ---------------------------------------------------------------------------
# 1. hook_op create -> WS data_op_msg -> records read-back
#    + hook_op update/delete -> WS events
#    + graph PUT update -> WS event
#    (Single TestClient to avoid stale event-loop between sync tests)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(15)
def test_hook_op_ws_and_graph_update():
    """Create/update/delete via hook_op and graph PUT, verify all WS data_op_msg events."""
    from starlette.testclient import TestClient

    from flow_sdk.server.app import app

    with TestClient(app) as tc:
        resp = tc.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200
        cn_id = _compute_node_id(resp.json())

        conn_id = str(uuid.uuid4())
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"
            assert confirm["status"] == "ok"

            # --- hook_op CREATE -> WS create event ---
            resp = tc.post(
                LISTEN_URL,
                json=_envelope(
                    {
                        "type": "bookmark",
                        "id": "bookmark-ws-1",
                        "operation": "create",
                        "data": {
                            "title": "WS Test Bookmark",
                            "bookmark_type": "context",
                            "source": "test",
                            "session_id": "sess-1",
                            "work_dir": "/tmp/test",
                        },
                    }
                ),
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["action"] in ("created", "updated")
            bookmark_id = data["bookmark_id"]

            msg = ws.receive_json()
            assert msg["message_type"] == "data_op_msg", (
                f"Expected data_op_msg create, got: {json.dumps(msg, indent=2)}"
            )
            assert msg["op"] == "create"
            assert "bookmark" in msg["to_entity"]
            assert msg["data"]["title"] == "WS Test Bookmark"

            # --- Watch bookmark for targeted update/delete events ---
            resp = tc.post(
                f"/api/v1/graph/bookmark/{bookmark_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200, f"watch failed: {resp.text}"

            # --- Graph PUT update -> WS update event ---
            resp = tc.put(
                f"/api/v1/graph/bookmark/{bookmark_id}",
                json={"title": "Graph Updated", "bookmark_type": "summary"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["title"] == "Graph Updated"

            msg = ws.receive_json()
            assert msg["message_type"] == "data_op_msg", (
                f"Expected data_op_msg update, got: {json.dumps(msg, indent=2)}"
            )
            assert msg["op"] == "update"
            assert msg["data"]["title"] == "Graph Updated"

            # --- hook_op UPDATE -> WS update events ---
            # _reflect_entity UPDATE calls save() then notify_updated(),
            # producing two data_op_msg update notifications.
            resp = tc.post(
                LISTEN_URL,
                json=_envelope(
                    {
                        "type": "bookmark",
                        "id": "bookmark-ws-1",
                        "operation": "update",
                        "data": {"title": "Hook Updated", "source": "hook-update"},
                    }
                ),
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["action"] == "updated"

            msg1 = ws.receive_json()
            msg2 = ws.receive_json()
            for m in (msg1, msg2):
                assert m["message_type"] == "data_op_msg"
                assert m["op"] == "update"
                assert m["data"]["title"] == "Hook Updated"

            # --- hook_op DELETE -> WS delete event ---
            resp = tc.post(
                LISTEN_URL,
                json=_envelope(
                    {
                        "type": "bookmark",
                        "id": "bookmark-ws-1",
                        "operation": "delete",
                        "data": {},
                    }
                ),
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["action"] == "deleted"

            # Delete may be preceded by a flow_data_msg notification
            msg = ws.receive_json()
            if msg["message_type"] == "flow_data_msg":
                msg = ws.receive_json()
            assert msg["message_type"] == "data_op_msg", (
                f"Expected data_op_msg delete, got: {json.dumps(msg, indent=2)}"
            )
            assert msg["op"] == "delete"

        # --- Records API read-back (outside WS context) ---
        base = f"/api/v1/graph/compute_node/{cn_id}/fs-records/bookmark"
        resp = tc.post(
            base,
            json={
                "title": "Records Bookmark",
                "bookmark_type": "note",
                "source": "records-api",
            },
        )
        assert resp.status_code == 200, resp.text
        record_id = resp.json()["data"]["id"]

        resp = tc.get(f"{base}/{record_id}")
        assert resp.status_code == 200
        assert resp.json()["data"]["title"] == "Records Bookmark"


# ---------------------------------------------------------------------------
# 2. Graph REST CRUD (async, no WS)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_graph_crud(bootstrapped_client):
    """Full CRUD via REST graph API: create -> read -> update -> delete -> 404."""
    # CREATE via graph POST
    resp = await bootstrapped_client.post(
        "/api/v1/graph/bookmark",
        json={"title": "Graph Bookmark", "bookmark_type": "note", "source": "graph-test"},
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()["data"]
    bookmark_id = created["id"]
    assert created["title"] == "Graph Bookmark"
    assert created["type"] == "bookmark"

    # READ via graph GET
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{bookmark_id}")
    assert resp.status_code == 200
    assert resp.json()["data"]["title"] == "Graph Bookmark"

    # UPDATE via graph PUT
    resp = await bootstrapped_client.put(
        f"/api/v1/graph/bookmark/{bookmark_id}",
        json={"title": "Updated Graph Bookmark", "bookmark_type": "summary"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["title"] == "Updated Graph Bookmark"
    assert resp.json()["data"]["bookmark_type"] == "summary"

    # DELETE via graph DELETE
    resp = await bootstrapped_client.request("DELETE", f"/api/v1/graph/bookmark/{bookmark_id}")
    assert resp.status_code == 200

    # READ after delete -> entity not found (403 from graph route)
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{bookmark_id}")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# 3. Records CRUD lifecycle (compute node fs-records endpoint)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_records_crud_lifecycle(bootstrapped_client):
    """Full CRUD via compute-node records API: create -> read -> list -> update -> delete."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())
    base = f"/api/v1/graph/compute_node/{cn_id}/fs-records/bookmark"

    # CREATE
    resp = await bootstrapped_client.post(
        base,
        json={
            "title": "CRUD Bookmark",
            "bookmark_type": "note",
            "source": "test",
            "session_id": "sess-crud",
            "work_dir": "/tmp/crud",
        },
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()["data"]
    record_id = created["id"]
    assert created["title"] == "CRUD Bookmark"

    # READ
    resp = await bootstrapped_client.get(f"{base}/{record_id}")
    assert resp.status_code == 200
    assert resp.json()["data"]["title"] == "CRUD Bookmark"
    assert resp.json()["data"]["bookmark_type"] == "note"

    # LIST
    resp = await bootstrapped_client.get(base)
    assert resp.status_code == 200
    records = resp.json()["data"]
    assert any(r["id"] == record_id for r in records)

    # UPDATE
    resp = await bootstrapped_client.put(
        f"{base}/{record_id}",
        json={
            "title": "Updated CRUD Bookmark",
            "source": "updated-test",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["title"] == "Updated CRUD Bookmark"
    assert resp.json()["data"]["source"] == "updated-test"
    # Unchanged fields persist
    assert resp.json()["data"]["bookmark_type"] == "note"

    # DELETE
    resp = await bootstrapped_client.request("DELETE", f"{base}/{record_id}")
    assert resp.status_code == 200
    assert resp.json()["data"]["deleted"] == record_id

    # READ after delete -> 404
    resp = await bootstrapped_client.get(f"{base}/{record_id}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 4. SDK notify path: webhook listen -> DB create -> WS broadcast
#    Simulates what send_entity_sync / send_resource_sync does from a subprocess.
# ---------------------------------------------------------------------------


@pytest.mark.timeout(120)
def test_sdk_notify_creates_bookmark():
    """Simulate the SDK notify path: POST webhook envelope to /listen, verify DB + WS."""
    from starlette.testclient import TestClient

    from flow_sdk.server.app import app

    with TestClient(app) as tc:
        resp = tc.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200

        conn_id = str(uuid.uuid4())
        bookmark_uname = f"sdk-bookmark-{uuid.uuid4().hex[:8]}"
        with tc.websocket_connect(f"/api/v1/connect/ws/{conn_id}") as ws:
            confirm = ws.receive_json()
            assert confirm["message_type"] == "response_msg"

            # Simulate SDK send_entity_sync payload with content + data fields
            resp = tc.post(
                LISTEN_URL,
                json=_envelope(
                    {
                        "type": "bookmark",
                        "id": bookmark_uname,
                        "operation": "create",
                        "data": {
                            "title": "SDK Created Bookmark",
                            "bookmark_type": "context",
                            "source": "claude-cli",
                            "content": "This is the bookmark body from the SDK.",
                            "data": {"key": "value", "nested": {"a": 1}},
                            "session_id": "sess-sdk-1",
                            "work_dir": "/tmp/sdk-test",
                        },
                    }
                ),
            )
            assert resp.status_code == 200, resp.text
            result = resp.json()["data"]
            assert result["action"] in ("created", "updated")
            bookmark_id = result["bookmark_id"]

            # WS should broadcast a data_op_msg create
            msg = ws.receive_json()
            assert msg["message_type"] == "data_op_msg"
            assert msg["op"] == "create"
            assert msg["data"]["title"] == "SDK Created Bookmark"
            assert msg["data"]["content"] == "This is the bookmark body from the SDK."

        # Verify bookmark persisted in DB via graph GET
        resp = tc.get(f"/api/v1/graph/bookmark/{bookmark_id}")
        assert resp.status_code == 200
        bookmark_data = resp.json()["data"]
        assert bookmark_data["title"] == "SDK Created Bookmark"
        assert bookmark_data["content"] == "This is the bookmark body from the SDK."
        assert bookmark_data["bookmark_type"] == "context"
        assert bookmark_data["source"] == "claude-cli"
        assert bookmark_data["session_id"] == "sess-sdk-1"
        assert bookmark_data["work_dir"] == "/tmp/sdk-test"
