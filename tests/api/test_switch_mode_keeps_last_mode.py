"""Switching a live terminal session to chat must not undo the mode the user picked.

The footer toggle fires two requests for one click: the view-mode memory stamps
``last_mode`` with a full-entity PUT, and the transport reconcile POSTs
``switch-mode`` ``cli``. ``switch-mode`` loads the process, then ``exit()`` tears
the live PTY down and saves that instance — the whole row — after the PUT has
already committed. The stale ``last_mode`` won, so the next tab open landed back
on the terminal (session 248f564f: ``last_mode=advanced`` with ``pty_mode=False``).

Real process, real PTY, real routes. The PUT is sent the moment ``exit()`` has
announced ``stopping`` — the window the UI's PUT lands in.
"""

import asyncio

import pytest

from flow_sdk.responses.response import ApiResponse
from flow_sdk.tags.bus import on_tag

pytestmark = pytest.mark.usefixtures("usable_claude_source")


async def _live_process(client) -> str:
    bootstrap = await client.get("/api/v1/graph/bootstrap")
    node_id = bootstrap.json()["data"]["default_compute_node"]["id"]
    resp = await client.post(
        f"/api/v1/graph/compute_node/{node_id}/createProcess",
        json={"context": {"compute_node_id": f"compute_node-{node_id}"}, "visible": True},
    )
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data["id"]


async def _entity(client, base: str) -> dict:
    resp = await client.get(base)
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


@pytest.mark.asyncio
async def test_switch_to_chat_keeps_the_mode_the_user_picked(bootstrapped_client):
    client = bootstrapped_client
    pid = await _live_process(client)
    base = f"/api/v1/graph/agentic_process/{pid}"
    resp = await client.patch(base, json={"last_mode": "advanced"})
    assert resp.status_code == 200, resp.text
    entity = await _entity(client, base)
    assert entity["status"] == "running" and entity["pty_mode"] is True, entity

    # What `viewModeMemory.stamp` sends: the whole cached entity, mode changed.
    stamped = {**entity, "last_mode": "standard"}

    updates: asyncio.Queue[None] = asyncio.Queue()
    off = on_tag("entity.updated", lambda _e: updates.put_nowait(None), target=f"agentic_process:{pid}")
    try:
        switch = asyncio.create_task(client.post(f"{base}/switch-mode", json={"mode": "cli"}))
        while (await _entity(client, base))["status"] != "stopping":
            await updates.get()
        resp = await client.put(base, json=stamped)
        assert resp.status_code == 200, resp.text
        assert (await switch).status_code == 200
    finally:
        off()

    after = await _entity(client, base)
    assert after["pty_mode"] is False, after
    assert after["last_mode"] == "standard", f"switch-mode clobbered the user's mode: {after['last_mode']!r}"
