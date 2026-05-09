"""Long tests for Bookmark entity — TestClient + WebSocket path (slow)."""

import json
import uuid

import pytest

from flow_sdk.fs_records.bookmark import BookmarkRecord  # noqa: F401
from flow_sdk.fs_store import get_default_records_root, set_default_records_root
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.usefixtures("reset_db_for_testclient"),
]

LISTEN_URL = "/api/v1/webhook/listen"

# Cap on unrelated WS messages to drain before we declare the expected
# bookmark op missing. The cross_notification_scanner can emit several
# task-import events at startup.
_WS_DRAIN_LIMIT = 20


def _envelope(payload: dict) -> dict:
    return {"webhook_type": "hook_op", "webhook_payload": payload}


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    from flow_sdk.core.network.connections import _registry
    _registry.clear()
    yield tmp_path
    set_default_records_root(original)


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


def _receive_bookmark_op(ws, *, op: str, title: str | None = None) -> dict:
    """Drain unrelated WS traffic (e.g. cross_notification_scanner task imports)
    and return the first data_op_msg matching (op, optional title) for a bookmark.
    """
    for _ in range(_WS_DRAIN_LIMIT):
        msg = ws.receive_json()
        if msg.get("message_type") != "data_op_msg":
            continue
        if msg.get("op") != op:
            continue
        if "bookmark" not in (msg.get("to_entity") or ""):
            continue
        if title is not None and msg.get("data", {}).get("title") != title:
            continue
        return msg
    raise AssertionError(
        f"Did not receive expected bookmark {op} (title={title!r}) within {_WS_DRAIN_LIMIT} messages"
    )


# do not increase timeout without approval
@pytest.mark.timeout(30)
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

            msg = _receive_bookmark_op(ws, op="create", title="WS Test Bookmark")

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

            msg = _receive_bookmark_op(ws, op="update", title="Graph Updated")

            # --- hook_op UPDATE -> WS update events ---
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

            # Two updates (targeted watch + broadcast) — drain unrelated noise.
            for _ in range(2):
                _receive_bookmark_op(ws, op="update", title="Hook Updated")

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

            _receive_bookmark_op(ws, op="delete")

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


# do not increase timeout without approval
@pytest.mark.timeout(30)
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

            msg = _receive_bookmark_op(ws, op="create", title="SDK Created Bookmark")
            assert msg["data"]["content"] == "This is the bookmark body from the SDK."

        resp = tc.get(f"/api/v1/graph/bookmark/{bookmark_id}")
        assert resp.status_code == 200
        bookmark_data = resp.json()["data"]
        assert bookmark_data["title"] == "SDK Created Bookmark"
        assert bookmark_data["content"] == "This is the bookmark body from the SDK."
        assert bookmark_data["bookmark_type"] == "context"
        assert bookmark_data["source"] == "claude-cli"
        assert bookmark_data["session_id"] == "sess-sdk-1"
        assert bookmark_data["work_dir"] == "/tmp/sdk-test"
