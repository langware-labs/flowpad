"""Tests for the share-context / unshare-context HTTP endpoints.

These are the only canonical way for the frontend to publish a TypeId to
an entity's ``shared_context_entities``. The TS SDK has no
``addSharedContextEntities`` method by design.

  POST /api/v1/graph/<type>/<id>/share-context     body: {"typeid": "<type>-<id>"}
  POST /api/v1/graph/<type>/<id>/unshare-context   body: {"typeid": "<type>-<id>"}
"""

from __future__ import annotations

import uuid

import pytest


def _new_id() -> str:
    return str(uuid.uuid4())


async def _make_task(bootstrapped_client) -> dict:
    """Create a Task via the standard graph CRUD POST so the HTTP request
    context (with its embedded_storage) is established for the save path.
    Returns the persisted Task dict (with id populated)."""
    resp = await bootstrapped_client.post(
        "/api/v1/graph/task",
        json={"title": "ctx-share-test"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


@pytest.mark.asyncio
async def test_share_context_appends_single_typeid(bootstrapped_client):
    task = await _make_task(bootstrapped_client)
    conv_id = _new_id()

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeid": f"conversation-{conv_id}"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is True
    assert data["shared_context_entities"] == [f"conversation-{conv_id}"]

    # Verify persistence by re-reading via HTTP (GET).
    reread = await bootstrapped_client.get(f"/api/v1/graph/task/{task['id']}")
    assert reread.status_code == 200, reread.text
    body = reread.json()["data"]
    assert body.get("shared_context_entities") == [f"conversation-{conv_id}"]


@pytest.mark.asyncio
async def test_share_context_round_trips_data(bootstrapped_client):
    """POST with ``data: {path: ...}`` should persist into the sidecar and
    survive a re-read. This is what powers the chip 404 self-heal."""
    task = await _make_task(bootstrapped_client)
    plan_id = _new_id()
    plan_path = "/Users/alice/.claude/plans/some-plan.md"

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeid": f"plan-{plan_id}", "data": {"path": plan_path}},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is True
    assert data["shared_context_entities"] == [f"plan-{plan_id}"]
    assert data["shared_context_entity_data"] == {
        f"plan-{plan_id}": {"path": plan_path}
    }

    reread = await bootstrapped_client.get(f"/api/v1/graph/task/{task['id']}")
    assert reread.status_code == 200, reread.text
    body = reread.json()["data"]
    assert body["shared_context_entities"] == [f"plan-{plan_id}"]
    assert body["shared_context_entity_data"] == {
        f"plan-{plan_id}": {"path": plan_path}
    }


@pytest.mark.asyncio
async def test_share_context_batch_typeids(bootstrapped_client):
    task = await _make_task(bootstrapped_client)
    a, b = _new_id(), _new_id()

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeids": [f"spec-{a}", f"conversation-{b}"]},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is True
    shared = set(data["shared_context_entities"])
    assert shared == {f"spec-{a}", f"conversation-{b}"}


@pytest.mark.asyncio
async def test_share_context_is_idempotent(bootstrapped_client):
    task = await _make_task(bootstrapped_client)
    conv_id = _new_id()

    first = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeid": f"conversation-{conv_id}"},
    )
    assert first.status_code == 200
    assert first.json()["data"]["ok"] is True

    again = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeid": f"conversation-{conv_id}"},
    )
    assert again.status_code == 200
    body = again.json()["data"]
    assert body["ok"] is False  # nothing new added
    assert body["shared_context_entities"] == [f"conversation-{conv_id}"]


@pytest.mark.asyncio
async def test_unshare_context_removes_typeid(bootstrapped_client):
    task = await _make_task(bootstrapped_client)
    conv_id = _new_id()

    # seed via share-context
    await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeid": f"conversation-{conv_id}"},
    )

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/unshare-context",
        json={"typeid": f"conversation-{conv_id}"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is True
    assert data["shared_context_entities"] == []


@pytest.mark.asyncio
async def test_share_context_malformed_typeid_returns_400(bootstrapped_client):
    task = await _make_task(bootstrapped_client)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={"typeid": "not-a-uuid"},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.asyncio
async def test_share_context_missing_body_returns_400(bootstrapped_client):
    task = await _make_task(bootstrapped_client)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/share-context",
        json={},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.asyncio
async def test_share_context_unknown_entity_returns_404(bootstrapped_client):
    bogus_id = _new_id()
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{bogus_id}/share-context",
        json={"typeid": f"spec-{_new_id()}"},
    )
    assert resp.status_code == 404, resp.text
