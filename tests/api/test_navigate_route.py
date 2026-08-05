"""Tests for POST /api/v1/agent/navigate/entity.

Error contract is critical — the CLI (and therefore the agent) maps
HTTP status + error_code to exit codes. Each case locks that mapping.

We avoid calling ``/api/v1/graph/bootstrap`` in the "needs a real entity"
tests because system-project enumeration makes it slow (multi-second) on
a freshly-reset DB. Instead we call ``init_db()`` once and create a
throwaway ``Project`` directly — persistence is via the shared SQLite
file and survives across the TestClient's ASGI lifespan.
"""

import uuid

import pytest
from starlette.testclient import TestClient


pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


def _consume_confirmation(ws):
    data = ws.receive_json()
    assert data["message_type"] == "response_msg"
    assert data["status"] == "ok"


def _receive_ui_command(ws):
    """Return the next ``ui_command`` frame, skipping unrelated broadcasts.

    Other server tasks (entity create → ``data_op_msg``, hub status →
    ``hub_client_error_msg``) can enqueue frames on the same socket between the
    navigate POST and its ``ui_command``. Drain past them so the assertion locks
    the command, not whatever happened to arrive first.
    """
    last = None
    for _ in range(50):
        last = ws.receive_json()
        if last.get("message_type") == "ui_command":
            return last
    pytest.fail(f"timed out waiting for ui_command; last frame={last!r}")


def _flush(ws):
    """Round-trip a ping to ensure prior fire-and-forget messages were applied.

    `presence` doesn't ACK (the client never awaits one); the WS handler is
    sequential, so a `pong` reply guarantees every earlier message on this
    socket has been processed. Other server tasks can enqueue data_op messages
    on the same socket, so skip unrelated frames until the barrier pong arrives.
    """
    marker = f"barrier-{uuid.uuid4()}"
    ws.send_json({"message_type": "ping", "message_id": marker, "text": marker})
    last = None
    for _ in range(50):
        last = ws.receive_json()
        if last.get("message_type") == "pong" and last.get("text") == marker:
            return
    pytest.fail(f"timed out waiting for barrier pong; last frame={last!r}")


async def _make_project() -> str:
    """Create a Project entity directly in the DB, return its id.

    Bypasses bootstrap (slow on fresh DBs) while still exercising the real
    entity storage path that ``/api/v1/agent/navigate/entity`` reads from.
    """
    from flow_sdk.builtin.project import Project
    from flow_sdk.db.database import init_db

    await init_db()
    project = Project(
        type="project",
        uname=f"navtest-{uuid.uuid4().hex[:8]}",
        name="NavTest",
        visitor_role="owner",
    )
    await project.save()
    return project.id


@pytest.mark.asyncio
async def test_navigate_entity_not_found_returns_404():
    """Unknown id → 404 ENTITY_NOT_FOUND (maps to CLI exit 4)."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        # Open a tab so "no active tab" isn't the failure mode.
        with client.websocket_connect(f"/api/v1/connect/ws/{uuid.uuid4()}") as ws:
            _consume_confirmation(ws)

            resp = client.post(
                "/api/v1/agent/navigate/entity",
                json={"typeid": f"project-{uuid.uuid4()}"},
            )

            assert resp.status_code == 404
            body = resp.json()
            assert body["ok"] is False
            assert body["error_code"] == "ENTITY_NOT_FOUND"


@pytest.mark.asyncio
async def test_navigate_unknown_type_returns_404():
    """Unknown type collapses to ENTITY_NOT_FOUND (per alert #8 in /qca)."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        with client.websocket_connect(f"/api/v1/connect/ws/{uuid.uuid4()}") as ws:
            _consume_confirmation(ws)

            resp = client.post(
                "/api/v1/agent/navigate/entity",
                json={"typeid": f"no_such_type-{uuid.uuid4()}"},
            )

            assert resp.status_code == 404
            body = resp.json()
            assert body["error_code"] == "ENTITY_NOT_FOUND"


@pytest.mark.asyncio
async def test_navigate_invalid_typeid_returns_error():
    """Malformed typeid → 400 or 404 (both map to non-zero CLI exit)."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/agent/navigate/entity",
            json={"typeid": "not-a-valid-typeid-because-id-isnt-a-real-identifier"},
        )
        # Depending on identifier-validator, this is 400 (parse) or 404 (miss).
        # Both are agent-compatible failures.
        assert resp.status_code in (400, 404)
        assert resp.json()["ok"] is False


@pytest.mark.asyncio
async def test_navigate_no_active_tab_returns_409():
    """No open WS connections → 409 NO_ACTIVE_TAB (maps to CLI exit 3)."""
    from flow_sdk.server.app import app

    project_id = await _make_project()

    with TestClient(app) as client:
        # No websocket open — get_active_connection() returns None.
        resp = client.post(
            "/api/v1/agent/navigate/entity",
            json={"typeid": f"project-{project_id}"},
        )

        assert resp.status_code == 409
        body = resp.json()
        assert body["ok"] is False
        assert body["error_code"] == "NO_ACTIVE_TAB"


@pytest.mark.asyncio
async def test_navigate_success_sends_ui_command_to_active_tab():
    """Happy path: entity exists + active tab → 200 and WS receives ui_command."""
    from flow_sdk.server.app import app

    project_id = await _make_project()

    with TestClient(app) as client:
        connection_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)

            ws.send_json(
                {
                    "message_type": "presence",
                    "message_id": "p-active",
                    "visible": True,
                    "focused": True,
                }
            )
            _flush(ws)

            resp = client.post(
                "/api/v1/agent/navigate/entity",
                json={"typeid": f"project-{project_id}"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["ok"] is True
            assert body["connection_id"] == connection_id
            assert body["type"] == "project"
            assert body["id"] == project_id

            msg = _receive_ui_command(ws)
            assert msg["message_type"] == "ui_command"
            assert msg["kind"] == "navigate_entity"
            assert msg["type"] == "project"
            assert msg["id"] == project_id


async def _make_markdown(asset_ref: str) -> str:
    """Create a markdown entity owning ``asset_ref``, return its id.

    Exercises the real ``Entity.get_by_asset_ref`` path the file route uses to
    decide between the entity view and the raw-vfs fallback.
    """
    from flow_sdk.builtin.claude_memory_entities import Markdown
    from flow_sdk.db.database import init_db

    await init_db()
    md = Markdown(
        type="markdown",
        uname=f"navmd-{uuid.uuid4().hex[:8]}",
        name="hello",
        asset_ref=asset_ref,
        visitor_role="owner",
    )
    await md.save()
    return md.id


def _canonical(path: str) -> str:
    import os

    from flow_sdk.fs_store.path_utils import canonical_posix_path

    return canonical_posix_path(os.path.abspath(os.path.expanduser(path)))


@pytest.mark.asyncio
async def test_navigate_file_unindexed_falls_back_to_vfs(tmp_path):
    """A path no entity owns → 200 mode=vfs, WS gets a navigate_vfs command.

    This is the 'agent writes hello.md, then opens it' path — no indexing.
    """
    from flow_sdk.server.app import app

    path = _canonical(str(tmp_path / "hello.md"))

    with TestClient(app) as client:
        connection_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
            ws.send_json(
                {"message_type": "presence", "message_id": "p", "visible": True, "focused": True}
            )
            _flush(ws)

            resp = client.post("/api/v1/agent/navigate/file", json={"path": path})
            assert resp.status_code == 200
            body = resp.json()
            assert body["ok"] is True
            assert body["mode"] == "vfs"
            assert body["path"] == path
            assert body["connection_id"] == connection_id

            msg = _receive_ui_command(ws)
            assert msg["message_type"] == "ui_command"
            assert msg["kind"] == "navigate_vfs"
            assert msg["path"] == path


@pytest.mark.asyncio
async def test_navigate_file_indexed_navigates_to_entity(tmp_path):
    """A path an entity owns → 200 mode=entity, WS gets navigate_entity."""
    from flow_sdk.server.app import app

    path = _canonical(str(tmp_path / "hello.md"))
    md_id = await _make_markdown(path)

    with TestClient(app) as client:
        connection_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
            ws.send_json(
                {"message_type": "presence", "message_id": "p", "visible": True, "focused": True}
            )
            _flush(ws)

            resp = client.post("/api/v1/agent/navigate/file", json={"path": path})
            assert resp.status_code == 200
            body = resp.json()
            assert body["ok"] is True
            assert body["mode"] == "entity"
            assert body["type"] == "markdown"
            assert body["id"] == md_id

            msg = _receive_ui_command(ws)
            assert msg["message_type"] == "ui_command"
            assert msg["kind"] == "navigate_entity"
            assert msg["type"] == "markdown"
            assert msg["id"] == md_id


@pytest.mark.asyncio
async def test_navigate_file_no_active_tab_returns_409(tmp_path):
    """No open WS connection → 409 NO_ACTIVE_TAB (CLI exit 3)."""
    from flow_sdk.server.app import app

    path = _canonical(str(tmp_path / "hello.md"))

    with TestClient(app) as client:
        resp = client.post("/api/v1/agent/navigate/file", json={"path": path})
        assert resp.status_code == 409
        assert resp.json()["error_code"] == "NO_ACTIVE_TAB"


@pytest.mark.asyncio
async def test_navigate_picks_focused_tab_when_multiple_connected():
    """With two tabs, only the focused one gets the command."""
    from flow_sdk.server.app import app

    project_id = await _make_project()

    with TestClient(app) as client:
        id_bg = str(uuid.uuid4())
        id_fg = str(uuid.uuid4())

        with client.websocket_connect(f"/api/v1/connect/ws/{id_bg}") as ws_bg:
            _consume_confirmation(ws_bg)
            with client.websocket_connect(f"/api/v1/connect/ws/{id_fg}") as ws_fg:
                _consume_confirmation(ws_fg)

                ws_bg.send_json(
                    {"message_type": "presence", "message_id": "p-bg", "visible": True, "focused": False}
                )
                _flush(ws_bg)
                ws_fg.send_json(
                    {"message_type": "presence", "message_id": "p-fg", "visible": True, "focused": True}
                )
                _flush(ws_fg)

                resp = client.post(
                    "/api/v1/agent/navigate/entity",
                    json={"typeid": f"project-{project_id}"},
                )
                assert resp.status_code == 200
                assert resp.json()["connection_id"] == id_fg

                msg = _receive_ui_command(ws_fg)
                assert msg["message_type"] == "ui_command"
                assert msg["id"] == project_id


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/v1/agent/navigate/view — the SCREEN form
#
# Validation runs against the dock-address table BEFORE the UI is touched, so a
# bad address is a clean error the agent can act on rather than a silent no-op
# in the browser. These lock the status + error_code the CLI maps to exit codes.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "address",
    ["nonsense", "skills", "helpdesk", ""],
    ids=["unknown-view", "not-addressable", "pointer-required", "empty"],
)
async def test_navigate_view_rejects_bad_addresses_before_touching_the_ui(address):
    """A rejected address never reaches a browser tab — note there is no WS here.

    `skills` is the interesting one: it still DECODES (it is baked into saved
    tabs) but is not a destination, so offering it would be a lie.
    """
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        resp = client.post("/api/v1/agent/navigate/view", json={"view": address})
        assert resp.status_code == 400
        assert resp.json()["error_code"] == "INVALID_VIEW"


async def test_navigate_view_entity_shaped_pointer_that_names_nothing_is_404():
    """`conversation/<bogus>` fails here rather than opening a broken dock."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/agent/navigate/view",
            json={"view": f"conversation/{uuid.uuid4()}"},
        )
        assert resp.status_code == 404
        assert resp.json()["error_code"] == "ENTITY_NOT_FOUND"


async def test_navigate_view_no_active_tab_returns_409():
    """Same targeting contract as the other navigate verbs (`_pick_target`)."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        resp = client.post("/api/v1/agent/navigate/view", json={"view": "events"})
        assert resp.status_code == 409
        assert resp.json()["error_code"] == "NO_ACTIVE_TAB"


async def test_navigate_view_sends_navigate_dock_to_the_active_tab():
    """Happy path: a pointerless screen reaches the browser as `navigate_dock`."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        connection_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
            ws.send_json(
                {"message_type": "presence", "message_id": "p-view", "visible": True, "focused": True}
            )
            _flush(ws)

            resp = client.post("/api/v1/agent/navigate/view", json={"view": "events"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["ok"] is True
            assert body["mode"] == "dock"
            assert body["view_type"] == "events"

            msg = _receive_ui_command(ws)
            assert msg["kind"] == "navigate_dock"
            assert msg["view_type"] == "events"
            # A pointerless view omits the key rather than sending null (the
            # payload shape; see `dock_target`). The frontend reads it with `??`.
            assert msg.get("pointer") is None
            assert msg["page"] == "desk"


async def test_navigate_view_carries_pointer_options_and_page():
    """The whole address survives the wire — pointer, query options and page."""
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        connection_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
            ws.send_json(
                {"message_type": "presence", "message_id": "p-opts", "visible": True, "focused": True}
            )
            _flush(ws)

            resp = client.post(
                "/api/v1/agent/navigate/view",
                json={"view": "/dock/hub/worldview/organization?focus=deployment"},
            )
            assert resp.status_code == 200

            msg = _receive_ui_command(ws)
            assert msg["kind"] == "navigate_dock"
            assert msg["view_type"] == "worldview"
            assert msg["pointer"] == "organization"
            assert msg["options"] == {"focus": "deployment"}
            assert msg["page"] == "hub"


async def test_navigate_view_forwards_a_retired_view():
    """A saved `environment` address still opens — as `credentials/environment`.

    Retirement is expressed by the forward map, not by absence, so an address
    that predates the retirement keeps working instead of erroring.
    """
    from flow_sdk.server.app import app

    with TestClient(app) as client:
        connection_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/v1/connect/ws/{connection_id}") as ws:
            _consume_confirmation(ws)
            ws.send_json(
                {"message_type": "presence", "message_id": "p-retired", "visible": True, "focused": True}
            )
            _flush(ws)

            resp = client.post("/api/v1/agent/navigate/view", json={"view": "environment"})
            assert resp.status_code == 200

            msg = _receive_ui_command(ws)
            assert msg["view_type"] == "credentials"
            assert msg["pointer"] == "environment"
