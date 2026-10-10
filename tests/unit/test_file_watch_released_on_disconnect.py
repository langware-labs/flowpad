"""A dropped WebSocket ends the file-watch loops it was the last to listen to.

A file watch owns an ``awatch`` task and the worker thread it holds, not just a
``watch_registry`` row. A closed, reloaded or crashed tab sends no ``fs/unwatch``,
so the WebSocket teardown must end those loops itself — otherwise one leaked
loop per abandoned folder stays until a file in it changes, and 40 of them fill
anyio's default thread pool.

Real ``file_watch`` (what ``fs/watch`` calls), real ``websocket_endpoint`` run to
its ``finally:`` with a socket whose peer vanished. Only the socket is a stand-in.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.actions.fs import file_watch
from flow_sdk.app.actions import watch_registry
from flow_sdk.server.routes.websocket import websocket_endpoint

pytestmark = pytest.mark.asyncio


class _DroppedSocket:
    """Accept works; the first receive is an abnormal close (code 1006)."""

    async def accept(self) -> None:
        pass

    async def send_text(self, _text: str) -> None:
        pass

    async def receive(self) -> dict:
        return {"type": "websocket.disconnect", "code": 1006}


@pytest.fixture(autouse=True)
def _clean_watch_state():
    """Each test starts and ends with no loops, so one cannot mask another."""
    yield
    for local in list(file_watch._addresses):
        file_watch._stop(local)
    file_watch._loops.clear()
    watch_registry._watched_entities.clear()


def _watch(connection_id: str, target) -> str:
    local = str(target)
    file_watch.watch_file(connection_id, local, "compute_node-x", local.lstrip("/"))
    return local


async def test_a_dropped_socket_stops_its_watch_loop(tmp_path):
    target = tmp_path / "snippet.py"
    target.write_text("x\n")
    cid = str(uuid.uuid4())
    local = _watch(cid, target)
    loop = file_watch._loops[file_watch._folder(local)]
    assert file_watch.watching(local)

    await websocket_endpoint(_DroppedSocket(), cid)  # the endpoint's own finally: runs

    assert not file_watch.watching(local), "the loop outlived the only socket watching"
    assert local not in file_watch._addresses
    await asyncio.sleep(0)  # let the cancelled task settle
    assert loop.cancelled() or loop.done()


async def test_a_dropped_socket_leaves_the_other_watcher(tmp_path):
    target = tmp_path / "shared.py"
    target.write_text("x\n")
    c1, c2 = str(uuid.uuid4()), str(uuid.uuid4())
    local = _watch(c1, target)
    _watch(c2, target)
    loop = file_watch._loops[file_watch._folder(local)]

    await websocket_endpoint(_DroppedSocket(), c1)

    assert file_watch.watching(local), "c2 still watches: its loop must survive c1's drop"
    assert file_watch._loops[file_watch._folder(local)] is loop, "same loop, not a restart"
    assert watch_registry.get_watched_by(file_watch._key("compute_node-x", local.lstrip("/"))) == {c2}


async def test_one_drop_releases_every_folder_it_watched_alone(tmp_path):
    """One tab with several open files in different folders: all its loops end."""
    cid = str(uuid.uuid4())
    locals_ = []
    for i in range(3):
        d = tmp_path / f"d{i}"
        d.mkdir()
        f = d / "a.py"
        f.write_text("x\n")
        locals_.append(_watch(cid, f))
    assert sum(1 for t in file_watch._loops.values() if not t.done()) == 3

    await websocket_endpoint(_DroppedSocket(), cid)

    assert file_watch._loops == {}
    assert file_watch._addresses == {}
    assert all(not file_watch.watching(local) for local in locals_)
