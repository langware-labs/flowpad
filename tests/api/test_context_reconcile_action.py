"""Tests for the reconcile-context HTTP endpoint.

``reconcile-context`` prunes context references whose target is gone both
locally AND on the hub, but ONLY for local-origin holders. A local 404 alone is
never enough — remote/shared entities are fetched from the hub, so "missing
locally" can just mean "not synced yet". These tests pin the safety properties:

  * hub unknown (unset/unreachable) → NEVER prune (conservative).
  * hub says absent (404) → prune (local-origin holder).
  * hub says present → leave it (it's remote, not gone).
  * target still exists locally → never considered dangling.

  POST /api/v1/graph/<type>/<id>/reconcile-context
"""

from __future__ import annotations

import uuid

import pytest

import flow_sdk.app.actions.context_resolve_action as reconcile_mod


def _new_id() -> str:
    return str(uuid.uuid4())


async def _make_task(bootstrapped_client, title: str) -> dict:
    resp = await bootstrapped_client.post("/api/v1/graph/task", json={"title": title})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def _share(bootstrapped_client, task_id: str, typeid: str) -> None:
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task_id}/share-context",
        json={"typeid": typeid},
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_reconcile_keeps_dangling_ref_when_hub_unknown(bootstrapped_client, monkeypatch):
    """The core safety property: with no definitive hub answer (indeterminate —
    hub down / unreachable / non-404), a locally missing ref is NOT deleted; it
    might be a remote entity not yet synced. Patched to keep the test hermetic
    (no real network call to the configured hub)."""
    task = await _make_task(bootstrapped_client, "reconcile-hub-unknown")
    dangling = f"spec-{_new_id()}"  # known type, no local row

    async def _indeterminate(_typeid):
        return ("indeterminate", None)

    monkeypatch.setattr(reconcile_mod, "hub_resolve_by_typeid", _indeterminate)

    await _share(bootstrapped_client, task["id"], dangling)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/reconcile-context",
        json={},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is False
    assert data["removed"] == []
    assert dangling in data["indeterminate"]

    # The ref must survive — we never delete on an unknown hub.
    reread = await bootstrapped_client.get(f"/api/v1/graph/task/{task['id']}")
    assert dangling in (reread.json()["data"].get("shared_context_entities") or [])


@pytest.mark.asyncio
async def test_reconcile_removes_ref_absent_on_hub(bootstrapped_client, monkeypatch):
    """Hub returns a definitive 404 for the target → truly gone → pruned from a
    local-origin holder, and a ``context_refs_cleaned`` mutation is persisted."""
    task = await _make_task(bootstrapped_client, "reconcile-hub-absent")
    dangling = f"spec-{_new_id()}"
    await _share(bootstrapped_client, task["id"], dangling)

    async def _absent(_typeid):
        return ("absent", None)

    monkeypatch.setattr(reconcile_mod, "hub_resolve_by_typeid", _absent)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/reconcile-context",
        json={},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is True
    assert data["removed"] == [dangling]
    assert data["holder_remote"] is False

    reread = await bootstrapped_client.get(f"/api/v1/graph/task/{task['id']}")
    assert (reread.json()["data"].get("shared_context_entities") or []) == []


@pytest.mark.asyncio
async def test_reconcile_keeps_ref_present_on_hub(bootstrapped_client, monkeypatch):
    """Hub HAS the target (it's a remote entity, not yet materialized locally) →
    leave it. This is the user's correction: local-miss != gone."""
    task = await _make_task(bootstrapped_client, "reconcile-hub-present")
    remote_ref = f"spec-{_new_id()}"
    await _share(bootstrapped_client, task["id"], remote_ref)

    async def _present(_typeid):
        return ("present", {"id": "x"})

    monkeypatch.setattr(reconcile_mod, "hub_resolve_by_typeid", _present)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{task['id']}/reconcile-context",
        json={},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["ok"] is False
    assert data["removed"] == []
    assert remote_ref in data["remote_present"]

    reread = await bootstrapped_client.get(f"/api/v1/graph/task/{task['id']}")
    assert remote_ref in (reread.json()["data"].get("shared_context_entities") or [])


@pytest.mark.asyncio
async def test_reconcile_never_touches_live_local_ref(bootstrapped_client, monkeypatch):
    """A ref whose target exists locally is not dangling — it must never be
    probed against the hub or removed, even when the hub would say 'absent'."""
    holder = await _make_task(bootstrapped_client, title="holder")
    live = await _make_task(bootstrapped_client, title="live-target")
    live_ref = f"task-{live['id']}"
    await _share(bootstrapped_client, holder["id"], live_ref)

    async def _absent(_typeid):  # would delete if it were ever consulted
        return ("absent", None)

    monkeypatch.setattr(reconcile_mod, "hub_resolve_by_typeid", _absent)

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/task/{holder['id']}/reconcile-context",
        json={},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["removed"] == []

    reread = await bootstrapped_client.get(f"/api/v1/graph/task/{holder['id']}")
    assert live_ref in (reread.json()["data"].get("shared_context_entities") or [])
