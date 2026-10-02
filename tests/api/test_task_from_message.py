""""Task it" — a conversation message made a task (``Task.fromMessage`` in the TS SDK).

The UI creates a plain task with ``origin_conversation`` + ``origin_message`` and finds it again
with ONE query per conversation (``origin_conversation``), keyed by ``origin_message``. Both fields
are PRIVATE local row ids; a new task is not on the hub, so the ordinary create keeps them.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.task import Task

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
