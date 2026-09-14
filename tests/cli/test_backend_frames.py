"""``_common.backend_frames`` — the CLI's "wait for the backend to say something" primitive.

Every other command in ``flow_sdk/cli/commands`` is request/response. This is the one seam that
lets a command hand a job to the UI and block until it lands, and it exists so the next such
command does not grow its own socket, its own gate handling and its own race.

The tests below pin the three properties a caller depends on and cannot check for itself.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from flow_sdk.cli.commands import _common

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _FakeSocket:
    """A websocket that replays *frames* and then closes."""

    def __init__(self, frames: list[str]):
        self._frames = frames
        self.opened_at: int | None = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    def __aiter__(self):
        async def _gen():
            for frame in self._frames:
                yield frame

        return _gen()


def _connect(frames: list[str], seen: list[str] | None = None):
    """A ``websockets.connect`` stand-in that records the URL and headers it was given."""

    def _factory(url, **kwargs):
        if seen is not None:
            seen.append(url)
        return _FakeSocket(frames)

    return _factory


async def _drain(port: int, kinds: set[str], **kw) -> list[dict]:
    return [f async for f in _common.backend_frames(port, kinds, **kw)]


def test_only_the_requested_kinds_are_yielded(monkeypatch):
    """A caller wakes on the frames it named and pays nothing for the rest — the socket also
    carries entity notifications and PTY output, and each spurious wake costs the caller a
    real read."""
    frames = [
        json.dumps({"message_type": "llm_config_msg"}),
        json.dumps({"message_type": "data_op_msg"}),
        json.dumps({"message_type": "pty_output_msg"}),
        json.dumps({"message_type": "cloud_login_status_msg"}),
    ]
    monkeypatch.setattr("websockets.connect", _connect(frames))

    got = asyncio.run(_drain(6001, {"llm_config_msg", "cloud_login_status_msg"}))

    assert [f["message_type"] for f in got] == ["llm_config_msg", "cloud_login_status_msg"]


def test_a_non_json_frame_is_skipped_not_fatal(monkeypatch):
    """The same socket carries msgpack binary frames (PTY streams). Those are not ours, and
    dying on one would take down a command that was waiting on something else entirely."""
    frames = ["\x00\x01binary-ish", json.dumps({"message_type": "llm_config_msg"})]
    monkeypatch.setattr("websockets.connect", _connect(frames))

    got = asyncio.run(_drain(6001, {"llm_config_msg"}))

    assert [f["message_type"] for f in got] == ["llm_config_msg"]


def test_on_connected_runs_BEFORE_any_frame_is_read(monkeypatch):
    """The load-bearing guarantee, and the reason this is a callback rather than something the
    caller does around the call: a command that opens a browser first can be beaten by a user
    who acts instantly, and the frame that mattered is gone before anyone is listening."""
    order: list[str] = []

    class _Recording(_FakeSocket):
        def __aiter__(self):
            async def _gen():
                order.append("first-frame-read")
                yield json.dumps({"message_type": "llm_config_msg"})

            return _gen()

    monkeypatch.setattr("websockets.connect", lambda url, **kw: _Recording([]))

    async def _hook() -> None:
        order.append("on_connected")

    asyncio.run(_drain(6001, {"llm_config_msg"}, on_connected=_hook))

    assert order == ["on_connected", "first-frame-read"]


def test_each_call_uses_a_fresh_connection_id(monkeypatch):
    """The backend keys its connection registry on the id in the path, so a reused one would
    evict whatever else is listening under that name."""
    seen: list[str] = []
    monkeypatch.setattr("websockets.connect", _connect([], seen))

    asyncio.run(_drain(6001, set()))
    asyncio.run(_drain(6001, set()))

    assert len(seen) == 2 and seen[0] != seen[1]
    assert all(u.startswith("ws://127.0.0.1:6001/api/v1/connect/ws/flow-cli-") for u in seen)
