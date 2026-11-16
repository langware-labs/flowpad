"""A terminal-command runs in its terminal's own lane, not on the connection's receive loop.

Awaited inline, a terminal start (spawn + stream-file seq) held every later message on the
connection: restoring 12 terminals left a resize waiting 3.4s. Per terminal the order holds,
so a shell's input still waits for its own start.
"""

import asyncio

import pytest

from flow_sdk.server.routes.websocket import _after, _terminal_lane

pytestmark = pytest.mark.timeout(10)


def _msg(shell_id, sub_path="start"):
    return {"message_type": "rest_api_msg", "action": "terminal-command", "sub_path": sub_path, "body": {"shell_id": shell_id}}


def test_only_terminal_commands_get_a_lane():
    assert _terminal_lane(_msg("s1")) == "s1"
    assert _terminal_lane({"message_type": "rest_api_msg", "action": "terminal-command", "body": {"session_id": "h1"}}) == "h1"
    assert _terminal_lane({"message_type": "rest_api_msg", "action": "get-history", "body": {"shell_id": "s1"}}) is None
    assert _terminal_lane({"message_type": "ping"}) is None


async def test_a_slow_start_holds_only_its_own_terminal():
    order: list[str] = []
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_start():
        started.set()
        await release.wait()
        order.append("a:start")

    async def record(name):
        order.append(name)

    lanes: dict[str, asyncio.Task] = {}
    for lane, work in (("a", slow_start()), ("a", record("a:resize")), ("b", record("b:resize"))):
        lanes[lane] = asyncio.create_task(_after(lanes.get(lane), work))
    await started.wait()
    await asyncio.sleep(0)
    assert order == ["b:resize"], "another terminal is not held by a's start"
    release.set()
    await asyncio.gather(*lanes.values())
    assert order == ["b:resize", "a:start", "a:resize"], "a's resize still follows a's start"


async def test_a_failed_message_does_not_stop_its_lane():
    async def boom():
        raise RuntimeError("x")

    ran = []

    async def after():
        ran.append(1)

    first = asyncio.create_task(_after(None, boom()))
    await _after(first, after())
    assert ran == [1]
