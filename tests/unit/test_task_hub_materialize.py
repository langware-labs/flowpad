"""The hub→local materialize boundary must not damage the local row.

Two regressions, both observed live on dev-1/dev-2:

* ``upsert_from_hub_child`` used a blind ``model_validate``, so the local
  ``asset_ref`` was dropped. Since the ORIGIN also receives an op for the child
  it just created, it clobbered its own row and the next save re-derived the
  folder under the parent — producing ``<task>/agentic-assets/task/<task>/``.
* a hub payload built from the DB row carries blob fields EMPTY, and ``""`` is
  not ``None`` — merging it blanked the task body on every status flip.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.task import Task


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_upsert_from_hub_child_keeps_the_local_asset_ref(monkeypatch):
    local = Task(id="child-1", title="Ship it", parent_id="parent-1", remote=True)
    local.asset_ref = "/home/me/agentic-assets/task/ship_it--m-child1ab"
    saved: dict = {}

    async def fake_get_one(cls, query):
        return local

    async def fake_save(self, *args, **kwargs):
        saved["asset_ref"] = self.asset_ref
        return self

    monkeypatch.setattr(Task, "get_one", classmethod(fake_get_one))
    monkeypatch.setattr(Task, "save", fake_save)
    async def fake_edge(self):
        return True

    monkeypatch.setattr(Task, "ensure_child_edge", fake_edge)

    # The hub echoes the SENDER's path (or nothing at all) — neither may land.
    await Task.upsert_from_hub_child(
        {"id": "child-1", "title": "Ship it", "asset_ref": "/other/machine/tasks/ship_it"},
        "task-parent-1",
    )

    assert saved["asset_ref"] == "/home/me/agentic-assets/task/ship_it--m-child1ab"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_materialize_remote_task_keeps_the_body_when_the_hub_sends_empty(monkeypatch):
    from flow_sdk.app.actions.task_receive import materialize_remote_task

    existing = Task(id="t-1", title="Ship it", description="the issue text", remote=True)
    saved: dict = {}

    async def fake_get_one(cls, query):
        return existing

    async def fake_save(self, *args, **kwargs):
        saved["description"] = self.description
        return self

    monkeypatch.setattr(Task, "get_one", classmethod(fake_get_one))
    monkeypatch.setattr(Task, "save", fake_save)
    monkeypatch.setattr(Task, "is_stale", staticmethod(lambda existing, data: True))

    out = await materialize_remote_task(
        {"id": "t-1", "title": "Ship it", "status": "in_progress", "description": ""},
        someone_typeid=None,
    )

    assert out.status == "in_progress", "the field the assignee owns must still land"
    assert out.description == "the issue text"
    assert saved.get("description", "the issue text") == "the issue text"
