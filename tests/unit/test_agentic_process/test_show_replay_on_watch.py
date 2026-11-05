"""A `flow show` emitted while a client's `/watch` is still in flight reaches that client.

The live `on_show` event goes to WATCHERS only. A page opens its socket, then posts `/watch`;
a show that lands between the two used to reach no one there, and the vibe Display stayed empty
(vibe matrix VW-19/20). The watch path now replays the newest show to the connection that just
began watching — only when the show is newer than that connection, never an older one.
"""

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from flow_sdk.app.actions import watch_registry
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.core.network import connections


class FakeSocket:
    def __init__(self):
        self.frames: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.frames.append(json.loads(text))


def shows(socket: FakeSocket) -> list[dict]:
    return [
        f["flow_data"]["attributes"]["payload"]
        for f in socket.frames
        if f.get("message_type") == "flow_data_msg" and f["flow_data"]["attributes"].get("event") == "on_show"
    ]


@pytest.fixture()
def world(monkeypatch):
    connections._registry.clear()
    watch_registry._watched_entities.clear()
    process = AgenticProcess(id=str(uuid4()))
    monkeypatch.setattr(AgenticProcess, "get_by_id", classmethod(lambda cls, _id: _async(process)))

    async def placement(_pid):
        return {"tab_id": "t1", "host": True, "project_id": None}

    monkeypatch.setattr("flow_sdk.builtin.tab.show_placement", placement)
    yield process
    connections._registry.clear()
    watch_registry._watched_entities.clear()


async def _async(value):
    return value


def shown_at(process: AgenticProcess, when: datetime) -> dict:
    target = {"kind": "entity", "typeid": "markdown-x", "type": "markdown", "id": "x"}
    process.context_data = {"last_shown": target, "display_stack": [{**target, "shown_at": when.isoformat()}]}
    return target


async def watch(conn: str, process: AgenticProcess) -> None:
    await watch_registry.create_watch(conn, SimpleNamespace(type="agentic_process", id=process.id))


async def test_a_show_between_socket_open_and_watch_is_replayed_to_that_connection(world):
    socket, other = FakeSocket(), FakeSocket()
    connections.add_connection("c1", socket)
    connections.add_connection("c2", other)
    target = shown_at(world, datetime.now(timezone.utc) + timedelta(milliseconds=1))

    await watch("c1", world)

    assert shows(socket) == [{**target, "placement": {"tab_id": "t1", "host": True, "project_id": None}}]
    assert shows(other) == []  # only the connection that missed it


async def test_a_show_older_than_the_connection_is_not_replayed(world):
    shown_at(world, datetime.now(timezone.utc) - timedelta(seconds=5))
    socket = FakeSocket()
    connections.add_connection("c1", socket)

    await watch("c1", world)

    assert shows(socket) == []


async def test_nothing_shown_nothing_replayed(world):
    socket = FakeSocket()
    connections.add_connection("c1", socket)

    await watch("c1", world)

    assert shows(socket) == []
