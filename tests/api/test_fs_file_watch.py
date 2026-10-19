"""``fs/watch`` / ``fs/unwatch``: a connection learns that a file changed on disk.

Real route, real watchfiles; only the WebSocket is a fake that records what it
was sent. Budgets below bound how long an EVENT may take to arrive; a passing
run takes ~0.2s.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from flow_sdk.actions.fs import file_watch
from flow_sdk.core.network import connections

pytestmark = pytest.mark.asyncio


class _FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))


@pytest.fixture
def sockets(monkeypatch):
    registry: dict[str, _FakeSocket] = {"c1": _FakeSocket(), "c2": _FakeSocket()}
    monkeypatch.setattr(connections, "get_connection", lambda cid: registry.get(cid))
    return registry


def _url(action: str, abs_path: str) -> str:
    return f"/api/v1/graph/compute_node/@local/fs/{action}{abs_path}"


async def _post(client, action: str, abs_path: str, connection_id: str) -> dict:
    resp = await client.post(_url(action, abs_path), json={"connection_id": connection_id})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _changed(sock: _FakeSocket, count: int = 1) -> list[dict]:
    for _ in range(100):  # up to 5s for FSEvents to deliver; typically ~0.1s
        if len(sock.sent) >= count:
            return sock.sent
        await asyncio.sleep(0.05)
    return sock.sent


async def test_a_watcher_hears_a_change_and_an_unwatched_one_does_not(bootstrapped_client, sockets, tmp_path):
    target = tmp_path / "snippet.py"
    target.write_text("# %% flowpad:snippet\nprint(1)\n")
    local = str(target)

    assert (await _post(bootstrapped_client, "watch", local, "c1"))["status"] == "SUCCESS"
    assert file_watch.watching(local)
    await asyncio.sleep(0.2)  # the watcher is live before the write
    target.write_text("# %% flowpad:snippet\nprint(2)\n")

    got = await _changed(sockets["c1"])
    assert got, "the watching connection was never told the file changed"
    assert got[0]["message_type"] == "file_changed_msg"
    assert got[0]["path"] == local.lstrip("/")
    assert got[0]["entity"].startswith("compute_node-")
    assert sockets["c2"].sent == [], "a connection that did not watch must hear nothing"

    await _post(bootstrapped_client, "unwatch", local, "c1")
    assert not file_watch.watching(local), "the last unwatch must stop the watch loop"


async def test_a_replace_by_rename_is_seen(bootstrapped_client, sockets, tmp_path):
    """Saves are atomic renames; a watch on the file itself would lose them."""
    from flow_sdk.capsules.atomic import atomic_write  # noqa: PLC0415

    target = tmp_path / "s.py"
    target.write_text("a\n")
    await _post(bootstrapped_client, "watch", str(target), "c1")
    await asyncio.sleep(0.2)
    atomic_write(target, b"b\n")
    atomic_write(target, b"c\n")
    assert await _changed(sockets["c1"]), "a replace-by-rename was not reported"
    await _post(bootstrapped_client, "unwatch", str(target), "c1")


async def test_two_watchers_one_file_one_loop(bootstrapped_client, sockets, tmp_path):
    target = tmp_path / "shared.py"
    target.write_text("x\n")
    await _post(bootstrapped_client, "watch", str(target), "c1")
    await _post(bootstrapped_client, "watch", str(target), "c2")
    await _post(bootstrapped_client, "unwatch", str(target), "c1")
    assert file_watch.watching(str(target)), "c2 still watches"
    await asyncio.sleep(0.2)
    target.write_text("y\n")
    assert await _changed(sockets["c2"])
    assert sockets["c1"].sent == []
    await _post(bootstrapped_client, "unwatch", str(target), "c2")
    assert not file_watch.watching(str(target))


async def test_watching_a_missing_file_is_refused(bootstrapped_client, sockets, tmp_path):
    # The fs action reports a refusal as a FAIL envelope (HTTP 500, like its siblings).
    resp = await bootstrapped_client.post(_url("watch", str(tmp_path / "nope.py")), json={"connection_id": "c1"})
    assert resp.json()["status"] == "FAIL" and resp.json()["data"]["error_code"] == "NOT_FOUND"
    assert not file_watch.watching(str(tmp_path / "nope.py"))
