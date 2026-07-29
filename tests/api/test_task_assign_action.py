"""``assign-task`` — one task, one assignee, one editor invite (hub faked).

The contract this pins is the whole point of decoupling the task primitive from
the contacts-group fan-out: handing a task to ONE person creates NO second row
and leaves the sender's task a plain task. It used to be implemented as "a group
of one", which minted a child member task and flipped the sender's own task to
``kind=group`` named after the assignee.

Group fan-out lives in ``test_group_task_action.py``; the shared faked-hub
fixtures are in ``conftest.py``.
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


async def _assign(client, task_id: str, **body):
    resp = await client.post(f"{GRAPH}/task/{task_id}/assign-task", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_assign_shares_the_task_and_grants_the_assignee_editor(bootstrapped_client, hub_faked):
    task = await _create(bootstrapped_client, "task", {"type": "task", "title": "Fix Login"})

    data = await _assign(
        bootstrapped_client, task["id"], email="Bob@X.com", name="Bob", message="please take a look"
    )
    assert data == {"self": False, "assignee": "bob@x.com"}

    row = await Task.get_one({"id": task["id"]})
    assert row.assignee == "bob@x.com"
    assert row.reporter == "owner@x.com"
    assert row.remote is True, "the task itself goes to the hub — that IS the assignment"

    # THE contract: no second row, and the sender's task is still a plain task.
    assert await Task.get_all({"parent_id": task["id"]}) == []
    assert row.kind == TaskKind.STANDARD.value
    assert row.group_name is None
    assert hub_faked["children"] == [], "no member task is created for a single assignee"

    # One invitation, one target: editor on the task itself.
    member_posts = [p for p in hub_faked["posts"] if p[0].endswith("/members")]
    assert len(member_posts) == 1
    path, body = member_posts[0]
    assert path == f"/graph/task/{task['id']}/members"
    assert body["recipient_email"] == "bob@x.com"
    assert body["invitation_targets"] == [{"typeid": f"task-{task['id']}", "role": "editor"}]
    assert body["message"] == "please take a look"

    # A FIRST assign needs no field PUT: `share()` POSTs the whole field body,
    # stamps included. Only a re-assign of an already-remote task does.
    assert [p for p in hub_faked["puts"] if p[0] == f"/graph/task/{task['id']}"] == []


async def test_assign_is_idempotent(bootstrapped_client, hub_faked):
    task = await _create(bootstrapped_client, "task", {"type": "task", "title": "Fix Login"})
    await _assign(bootstrapped_client, task["id"], email="bob@x.com")
    await _assign(bootstrapped_client, task["id"], email="bob@x.com")

    assert await Task.get_all({"parent_id": task["id"]}) == []
    row = await Task.get_one({"id": task["id"]})
    assert row.assignee == "bob@x.com"
    assert row.kind == TaskKind.STANDARD.value


async def test_reassigning_moves_the_task_to_someone_else(bootstrapped_client, hub_faked):
    task = await _create(bootstrapped_client, "task", {"type": "task", "title": "Fix Login"})
    await _assign(bootstrapped_client, task["id"], email="bob@x.com")
    await _assign(bootstrapped_client, task["id"], email="carol@x.com")

    row = await Task.get_one({"id": task["id"]})
    assert row.assignee == "carol@x.com"
    assert row.reporter == "owner@x.com", "the reporter is stamped once and stays"
    invited = [b["recipient_email"] for p, b in hub_faked["posts"] if p.endswith("/members")]
    assert invited == ["bob@x.com", "carol@x.com"]

    # The task was already remote the second time, so THIS is the assign that
    # has to push the new assignee to the hub row (a server-side save never
    # hub-reflects, and `share()` already happened).
    pushed = [p for p in hub_faked["puts"] if p[0] == f"/graph/task/{task['id']}"]
    assert pushed and pushed[-1][1] == {"assignee": "carol@x.com", "reporter": "owner@x.com"}


async def test_assigning_to_yourself_stays_local(bootstrapped_client, hub_faked):
    task = await _create(bootstrapped_client, "task", {"type": "task", "title": "Mine"})

    data = await _assign(bootstrapped_client, task["id"], email="owner@x.com")
    assert data == {"self": True, "assignee": "owner@x.com"}

    row = await Task.get_one({"id": task["id"]})
    assert row.assignee == "owner@x.com"
    assert row.remote is not True, "nothing was shared"
    assert hub_faked["posts"] == [] and hub_faked["puts"] == []


async def test_assign_requires_an_email(bootstrapped_client, hub_faked):
    task = await _create(bootstrapped_client, "task", {"type": "task", "title": "Fix Login"})
    resp = await bootstrapped_client.post(f"{GRAPH}/task/{task['id']}/assign-task", json={})
    assert resp.status_code == 400
    assert "email" in resp.text


async def test_a_sub_task_can_be_assigned(bootstrapped_client, hub_faked):
    """A task with a parent is just a task. Only the group fan-out refuses one —
    the old assign-task inherited that guard from the group path for no reason."""
    parent = await _create(bootstrapped_client, "task", {"type": "task", "title": "Epic"})
    child = await _create(
        bootstrapped_client, "task", {"type": "task", "title": "Step", "parent_id": parent["id"]}
    )

    data = await _assign(bootstrapped_client, child["id"], email="bob@x.com")
    assert data == {"self": False, "assignee": "bob@x.com"}
