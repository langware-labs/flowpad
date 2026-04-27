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


def _flush(ws):
    """Round-trip a ping to ensure prior fire-and-forget messages were applied.

    `presence` doesn't ACK (the client never awaits one); the WS handler is
    sequential, so a `pong` reply guarantees every earlier message on this
    socket has been processed.
    """
    ws.send_json({"message_type": "ping", "message_id": "barrier", "text": "x"})
    pong = ws.receive_json()
    assert pong["message_type"] == "pong"


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

            msg = ws.receive_json()
            assert msg["message_type"] == "ui_command"
            assert msg["kind"] == "navigate_entity"
            assert msg["type"] == "project"
            assert msg["id"] == project_id


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

                msg = ws_fg.receive_json()
                assert msg["message_type"] == "ui_command"
                assert msg["id"] == project_id
