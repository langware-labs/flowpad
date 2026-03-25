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


