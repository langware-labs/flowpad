"""A process rename reaches every client subscribed to its project's chat-history list.

A process update goes only to the connections that watch that process (``_resolve_recipients``),
and the Chats list is not one: since 77912b35c its rows hold no backend watch. An idle browser
showing the list never got a rename (p14 worker_session_name_observers). The list now subscribes
once (``project/<id>/watch/chats``) and the rename alone is routed to it: a lightweight frame,
only on a change of the name, not the process's runtime churn and not a per-row watch.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest

import flow_sdk.core.network.connections as connections
import flow_sdk.core.network.resource_tracker as tracker
from flow_sdk.app.actions import watch_registry


class _Socket:
    def __init__(self) -> None:
        self.frames: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.frames.append(json.loads(text))


@pytest.fixture()
def sockets(monkeypatch):
    socks = {name: _Socket() for name in ("publisher", "observer", "other_project", "idle")}
    monkeypatch.setattr(connections, "get_all_connections", lambda: dict(socks))
    monkeypatch.setattr(watch_registry, "_watched_entities", {})
    monkeypatch.setattr(tracker, "_last_names", {})
    return socks


def _update(pid: str, project: str, name: str, **extra) -> dict:
    data = {"id": pid, "type": "agentic_process", "name": name, "session_id": "s-1", "project_id": project,
            "naming_state": {"phase": "native"}, "auto_rename": True, "status": "running", "shell_id": "sh", **extra}
    return {"message_type": "data_op_msg", "op": "update", "to_entity": f"agentic_process-{pid}", "data": data}


async def _send(message: dict) -> None:
    tracker._sync_handle_entity_op(message)
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_a_rename_reaches_the_project_chat_list_but_not_other_lists_or_churn(sockets):
    pid, project = str(uuid.uuid4()), str(uuid.uuid4())
    watch_registry.add_watch("publisher", f"agentic_process:{pid}")
    await watch_registry.watch_chat_list("observer", project, on=True)
    await watch_registry.watch_chat_list("other_project", str(uuid.uuid4()), on=True)

    await _send(_update(pid, project, "First title"))
    await _send(_update(pid, project, "First title", status="idle"))  # churn, same name
    await _send(_update(pid, project, "Renamed"))

    observer = sockets["observer"].frames
    assert [f["data"]["name"] for f in observer] == ["First title", "Renamed"]
    assert set(observer[0]["data"]) == set(tracker._RENAME_FIELDS)  # lightweight: no shell_id / status
    assert observer[0]["to_entity"] == f"agentic_process-{pid}" and observer[0]["op"] == "update"
    # The watcher gets every full update once, never a second rename copy.
    assert [f["data"].get("status") for f in sockets["publisher"].frames] == ["running", "idle", "running"]
    assert sockets["other_project"].frames == [] and sockets["idle"].frames == []


@pytest.mark.asyncio
async def test_a_released_list_gets_no_rename(sockets):
    pid, project = str(uuid.uuid4()), str(uuid.uuid4())
    watch_registry.add_watch("publisher", f"agentic_process:{pid}")
    await watch_registry.watch_chat_list("observer", project, on=True)
    await watch_registry.watch_chat_list("observer", project, on=False)
    await _send(_update(pid, project, "Nobody listens"))
    assert sockets["observer"].frames == []
    assert len(sockets["publisher"].frames) == 1
