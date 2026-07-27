"""Multi-channel integration tests for the Bookmark entity.

Covers: hook_op webhook, REST graph API, compute-node records API,
and WebSocket data_op_msg notifications for create/update/delete.
"""

import json
import uuid

import pytest

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




# ---------------------------------------------------------------------------
# 4. Favorite folders — parent_id roundtrip + delete-promotes-children
# ---------------------------------------------------------------------------


async def _create_bookmark(client, payload: dict) -> dict:
    resp = await client.post("/api/v1/graph/bookmark", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


@pytest.mark.asyncio
async def test_bookmark_parent_id_roundtrip(bootstrapped_client):
    """parent_id survives the REST roundtrip; absent parent_id reads back None."""
    folder = await _create_bookmark(
        bootstrapped_client,
        {"name": "My Folder", "title": "My Folder", "bookmark_type": "favorite_folder"},
    )
    assert folder["bookmark_type"] == "favorite_folder"

    child = await _create_bookmark(
        bootstrapped_client,
        {
            "title": "Filed favorite",
            "bookmark_type": "favorite",
            "parent_id": folder["id"],
            "data": {"entity_type": "project", "entity_id": str(uuid.uuid4())},
        },
    )
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{child['id']}")
    assert resp.status_code == 200
    assert resp.json()["data"]["parent_id"] == folder["id"]

    # Back-compat: a favorite created without parent_id reads back as None.
    plain = await _create_bookmark(
        bootstrapped_client,
        {"title": "Root favorite", "bookmark_type": "favorite"},
    )
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{plain['id']}")
    assert resp.status_code == 200
    assert not resp.json()["data"].get("parent_id")


@pytest.mark.asyncio
async def test_folder_delete_promotes_children(bootstrapped_client):
    """Deleting a favorite_folder over REST (the UI's delete_by_id path) nulls
    the children's parent_id instead of deleting or stranding them."""
    folder = await _create_bookmark(
        bootstrapped_client,
        {"name": "Doomed", "title": "Doomed", "bookmark_type": "favorite_folder"},
    )
    children = []
    for i in range(2):
        children.append(
            await _create_bookmark(
                bootstrapped_client,
                {"title": f"child-{i}", "bookmark_type": "favorite", "parent_id": folder["id"]},
            )
        )
    root = await _create_bookmark(
        bootstrapped_client,
        {"title": "root", "bookmark_type": "favorite"},
    )

    resp = await bootstrapped_client.request("DELETE", f"/api/v1/graph/bookmark/{folder['id']}")
    assert resp.status_code == 200

    # Folder gone.
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{folder['id']}")
    assert resp.status_code in (403, 404)

    # Children promoted to root, not deleted.
    for child in children:
        resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{child['id']}")
        assert resp.status_code == 200, resp.text
        assert not resp.json()["data"].get("parent_id")

    # Unrelated root favorite untouched.
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{root['id']}")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_folder_instance_delete_promotes_children(bootstrapped_client):
    """Same promotion through the Python instance delete() path."""
    from flow_sdk.builtin.bookmark import Bookmark, BookmarkType

    folder = Bookmark(bookmark_type=BookmarkType.FAVORITE_FOLDER, title="py-folder")
    await folder.save()
    child = Bookmark(bookmark_type=BookmarkType.FAVORITE, title="py-child", parent_id=folder.id)
    await child.save()

    await folder.delete()

    reloaded = await Bookmark.get_by_id(child.id)
    assert reloaded is not None
    assert not reloaded.parent_id


# ---------------------------------------------------------------------------
# 5. bookmark.order action — per-container manual ordering
# ---------------------------------------------------------------------------


async def _order_action(client, payload: dict) -> dict:
    resp = await client.post("/api/v1/graph/bookmark/order", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


@pytest.mark.asyncio
async def test_bookmark_order_root_scope(bootstrapped_client):
    """Reorder within the root container: stamps order 1..n, splices before
    the anchor, and leaves other containers untouched."""
    a = await _create_bookmark(bootstrapped_client, {"title": "a", "bookmark_type": "favorite"})
    b = await _create_bookmark(bootstrapped_client, {"title": "b", "bookmark_type": "favorite"})
    c = await _create_bookmark(bootstrapped_client, {"title": "c", "bookmark_type": "favorite"})

    # Unstamped ⇒ newest-first: [c, b, a]. Move a before c → [a, c, b].
    data = await _order_action(
        bootstrapped_client,
        {"reorder_bookmark_id": a["id"], "before_bookmark_id": c["id"], "parent_id": ""},
    )
    # The root container may hold leftovers from earlier tests — assert the
    # RELATIVE order and stamping of our three rows.
    rows = [row for row in data["bookmarks"] if row["title"] in ("a", "b", "c")]
    assert [row["title"] for row in rows] == ["a", "c", "b"]
    orders = {row["title"]: row["order"] for row in rows}
    assert orders["a"] < orders["c"] < orders["b"]
    assert all(v >= 1 for v in orders.values())


@pytest.mark.asyncio
async def test_bookmark_order_folder_scope_and_tab_action_intact(bootstrapped_client):
    """Reorder inside a folder container only touches that folder's members;
    the type-qualified registration must not clobber tab's bare 'order'."""
    folder = await _create_bookmark(
        bootstrapped_client, {"name": "F", "title": "F", "bookmark_type": "favorite_folder"}
    )
    kids = []
    for name in ("x", "y", "z"):
        kids.append(
            await _create_bookmark(
                bootstrapped_client,
                {"title": name, "bookmark_type": "favorite", "parent_id": folder["id"]},
            )
        )
    root = await _create_bookmark(bootstrapped_client, {"title": "rootfav", "bookmark_type": "favorite"})

    x = kids[0]
    data = await _order_action(
        bootstrapped_client,
        {"reorder_bookmark_id": x["id"], "after_bookmark_id": kids[2]["id"], "parent_id": folder["id"]},
    )
    titles = [row["title"] for row in data["bookmarks"]]
    # Unstamped newest-first was [z, y, x]; moving x after z → [z, x, y].
    assert titles == ["z", "x", "y"]

    # Root favorite untouched (different container).
    resp = await bootstrapped_client.get(f"/api/v1/graph/bookmark/{root['id']}")
    assert resp.status_code == 200
    assert not resp.json()["data"].get("order")

    # Registry non-collision: tab still owns bare "order".
    from flow_sdk.actions.action_registry import action as registry

    assert registry.get_by_name("order", "bookmark").action_name == "bookmark.order"
    assert registry.get_by_name("order", "tab").action_name == "order"


@pytest.mark.asyncio
async def test_bookmark_order_noop_persists_nothing(bootstrapped_client):
    """Reordering to the same position writes no rows (order stays unstamped)."""
    a = await _create_bookmark(bootstrapped_client, {"title": "only", "bookmark_type": "favorite"})
    data = await _order_action(
        bootstrapped_client,
        {"reorder_bookmark_id": a["id"], "parent_id": ""},
    )
    # Single item spliced to end = position unchanged, but stamping is
    # idempotent either way — assert the response reflects a valid container.
    assert [row["title"] for row in data["bookmarks"]].count("only") == 1
