"""The ``loop_stall`` toplog tag names the code that froze the event loop.

A blocking call on the backend loop silences every request and every log line for as
long as it runs (a 16s freeze on prod, 2026-11-03, left nothing in the log). The
watchdog thread sees its stamp go late and logs the loop thread's stack.

No mocks: the loop is really blocked by a synchronous sleep, the real watchdog
thread reports it, read from the real ``toplog`` logger. Only the thresholds are
shortened so the test stays well under a second.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from flow_sdk import toplog
from flow_sdk.server import loop_stall_watchdog as wd

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


@pytest.fixture()
def fast_watchdog(monkeypatch):
    monkeypatch.setattr(wd, "POLL_S", 0.02)
    monkeypatch.setattr(wd, "STALL_S", 0.15)
    monkeypatch.setattr(wd, "_thread", None)


def _blocking_call_on_the_loop() -> None:
    time.sleep(0.4)


async def _stall_once() -> None:
    wd.start()
    await asyncio.sleep(0.1)  # the watcher is stamping
    _blocking_call_on_the_loop()
    await asyncio.sleep(0.15)  # loop is back: the queued stamps run


def _lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if "[loop_stall]" in r.getMessage()]


@pytest.mark.asyncio
async def test_a_stall_logs_the_blocking_frame_and_its_length(fast_watchdog, caplog) -> None:
    toplog.enable()
    toplog.on(wd.TAG)
    try:
        with caplog.at_level("INFO", logger="toplog"):
            await _stall_once()
    finally:
        toplog.disable()

    lines = _lines(caplog)
    stalled = [line for line in lines if "loop stalled" in line]
    assert stalled, f"no stall line in {lines}"
    assert "_blocking_call_on_the_loop" in stalled[0]
    assert any("loop resumed after" in line for line in lines)


@pytest.mark.asyncio
async def test_nothing_is_logged_when_the_tag_is_off(fast_watchdog, caplog) -> None:
    toplog.disable()
    with caplog.at_level("INFO", logger="toplog"):
        await _stall_once()

    assert _lines(caplog) == []
