""" "Task it" — a conversation message made a task (``Task.fromMessage`` in the TS SDK).

The UI creates a plain task with ``origin_conversation`` + ``origin_message`` and finds it again
with ONE query per conversation (``origin_conversation``), keyed by ``origin_message``. Both fields
are PRIVATE local row ids; a new task is not on the hub, so the ordinary create keeps them.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.task import Task
from tests.unit._project_names import unique_project_name

pytestmark = pytest.mark.asyncio

GRAPH = "/api/v1/graph"


async def test_a_message_task_keeps_its_message_and_is_found_by_its_conversation(bootstrapped_client):
    resp = await bootstrapped_client.post(
        f"{GRAPH}/task",
        json={
            "type": "task",
            "title": "Render HTML in machine output",
            "assignee": "owner@x.com",
            "origin_conversation": "conv-7",
            "origin_message": "msg-42",
        },
    )
    assert resp.status_code == 200, resp.text
    task_id = resp.json()["data"]["id"]

    row = await Task.get_one({"id": task_id})
    assert (row.origin_conversation, row.origin_message) == ("conv-7", "msg-42")

    found = await Task.get_all({"origin_conversation": "conv-7"})
    assert [(t.id, t.origin_message) for t in found] == [(task_id, "msg-42")], "the bubble's one query"
    assert await Task.get_all({"origin_conversation": "conv-other"}) == []


async def test_a_message_makes_one_task_however_often_it_is_asked(bootstrapped_client, tmp_path):
    """One message, at most one task — on the server, not only in the bubble: a second create for
    the same message (a double click, a second tab, Send racing the bubble) answers with the first
    task, whether the create is standalone or addressed under a project."""
    project = await bootstrapped_client.post(
        "/api/v1/graph/project",
        json={"name": unique_project_name("task-it"), "fs_storage_mount_path": str(tmp_path)},
    )
    assert project.status_code == 200, project.text
    pid = project.json()["data"]["id"]

    ask = {"type": "task", "title": "Ship it", "origin_conversation": "conv-9", "origin_message": "msg-9"}
    ids = []
    for url in (f"{GRAPH}/project/{pid}/task", f"{GRAPH}/project/{pid}/task", f"{GRAPH}/task"):
        resp = await bootstrapped_client.post(url, json=ask)
        assert resp.status_code == 200, resp.text
        ids.append(resp.json()["data"]["id"])

    assert len(set(ids)) == 1, ids
    assert len(await Task.get_all({"origin_message": "msg-9"})) == 1
