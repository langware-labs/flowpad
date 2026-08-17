"""create-group-task / sync-group integration (hub boundary faked).

Groups only — single-assignee assignment is ``test_task_assign_action.py``.

Exercises the real action handlers over the in-process ASGI app: parent task +
contacts group are created through the normal graph routes, then the group
fan-out runs with `share`/`create_child`/`hub_post`/`hub_put`/`hub_get` faked
at their source modules. Asserts the plan's contract: title-only clone, deduped
member rows keyed (parent_id, assignee), child-first invitation targets with
editor/guest roles, idempotent re-run, and owner-side member-field sync (LWW).
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.task import Task, TaskKind

pytestmark = pytest.mark.asyncio

GRAPH = "/api/v1/graph"


async def _create(client, type_name: str, body: dict) -> dict:
    resp = await client.post(f"{GRAPH}/{type_name}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_create_group_task_fans_out_and_is_idempotent(bootstrapped_client, hub_faked):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Ship It"})
    group = await _create(
        bootstrapped_client,
        "contacts_group",
        {
            "type": "contacts_group",
            "name": "Team",
            "contacts": [
                {"email": "bob@x.com", "name": "Bob"},
                {"email": "carol@x.com"},
                {"email": "owner@x.com"},  # the owner — must be dropped
                {"name": "No Email"},  # email-less — reported in failed[]
            ],
        },
    )

    resp = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/create-group-task", json={"group_id": group["id"]}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert sorted(data["created"]) == ["bob@x.com", "carol@x.com"]
    assert data["skipped"] == []
    assert len(data["failed"]) == 1 and "No Email" in data["failed"][0]["error"]

    # Parent flipped to group and shared.
    parent_row = await Task.get_one({"id": parent["id"]})
    assert parent_row.kind == TaskKind.GROUP.value
    assert parent_row.remote is True

    # Children: title-only clone, member identity, hub child creation.
    children = await Task.get_all({"parent_id": parent["id"]})
    assert len(children) == 2
    by_assignee = {c.assignee: c for c in children}
    assert set(by_assignee) == {"bob@x.com", "carol@x.com"}
    for c in children:
        assert c.title == "Ship It"
        assert c.kind == TaskKind.STANDARD.value
        assert c.status == "to_do"
        assert c.remote is True
    assert len(hub_faked["children"]) == 2  # created via create_child (is_child edge)

    # One invitation per member: child target FIRST (editor), parent guest.
    member_posts = [p for p in hub_faked["posts"] if p[0].endswith("/members")]
    assert len(member_posts) == 2
    for path, body in member_posts:
        child = by_assignee[body["recipient_email"]]
        assert path == f"/graph/task/{child.id}/members"
        targets = body["invitation_targets"]
        assert targets[0] == {"typeid": f"task-{child.id}", "role": "editor"}
        assert targets[1] == {"typeid": f"task-{parent['id']}", "role": "guest"}

    # Idempotent re-run: nothing new, both skipped (invites re-attempted).
    resp2 = await bootstrapped_client.post(
        f"{GRAPH}/task/{parent['id']}/create-group-task", json={"group_id": group["id"]}
    )
    data2 = resp2.json()["data"]
    assert data2["created"] == []
    assert sorted(data2["skipped"]) == ["bob@x.com", "carol@x.com"]
    assert len(await Task.get_all({"parent_id": parent["id"]})) == 2


async def test_sync_group_merges_member_owned_fields(bootstrapped_client, hub_faked, monkeypatch):
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Audit"})
    group = await _create(
        bootstrapped_client,
        "contacts_group",
        {"type": "contacts_group", "name": "G", "contacts": [{"email": "bob@x.com"}]},
    )
    await bootstrapped_client.post(f"{GRAPH}/task/{parent['id']}/create-group-task", json={"group_id": group["id"]})
    child = (await Task.get_all({"parent_id": parent["id"]}))[0]

    import flow_sdk.app.actions.group_task_action as gta

    hub_rows = {
        child.id: {
            "id": child.id,
            "status": "done",
            "completed_at": "2026-07-14T10:00:00Z",
            "updated_date": "2999-01-01T00:00:00Z",  # newer than local → stale
        }
    }

    async def fake_hub_get(entity_type, entity_id=None, *a, **k):
        return hub_rows.get(entity_id)

    monkeypatch.setattr(gta, "hub_get", fake_hub_get)
    # The owner-side sync ALSO pulls each child's comments via
    # ``_sync_remote_children`` (a separate ``hub_get``); stub it to no children
    # so this test stays focused on the member-owned field merge.
    import flow_sdk.app.actions.flow_message_action as fma

    async def fake_sync_remote_children(*a, **k):
        return set()

    monkeypatch.setattr(fma, "_sync_remote_children", fake_sync_remote_children)

    resp = await bootstrapped_client.post(f"{GRAPH}/task/{parent['id']}/sync-group", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["synced"] == 1

    fresh = await Task.get_one({"id": child.id})
    assert fresh.status == "done"
    assert fresh.completed_at is not None
