"""`app.tab.ready` — the moment a UI is actually there to be talked to.

`app.ready` fires when the BACKEND is up and the first bootstrap was served: no
tab has to exist, and none is known to. A wizard that asks the person something
cannot start there — the question has nowhere to go, which is why it needed a
grace period to paper over the race. `app.tab.ready` is emitted per tab, on its
first `browser_context` frame: `presence` goes out the instant a socket opens,
whereas `browser_context` carries the current URL and is re-sent on every
navigation, so the first one means a route has actually loaded.

The handler under test is the real one; the socket is a bare object, because
what these pin is when the tag is emitted and never twice for one tab.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from flow_sdk.server.routes import bootstrap, websocket
from flow_sdk.tags.bus import event_bus

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


class _Socket:
    """Enough of a WebSocket for the frame handler: it is never written to here."""


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """A fresh 'index landed' event and an empty connection table per test — both
    are module globals, and an Event set by one test would satisfy the next."""
    monkeypatch.setattr(bootstrap, "system_content_ready", asyncio.Event())
    monkeypatch.setattr(websocket, "_active_connections", {})
    # Cloud-facing and best-effort in production; nothing to mirror here.
    from flow_sdk.cloud_client import context_watch

    monkeypatch.setattr(context_watch.browser_context_watch, "on_context", AsyncMock())


@pytest.fixture
def heard():
    seen = []
    off = event_bus.on("app.tab.ready", lambda event: seen.append(event))
    yield seen
    off()


def _connect(connection_id: str) -> None:
    websocket._active_connections[connection_id] = websocket.ConnectionInfo(ws=_Socket())


async def _frame(connection_id: str, message_type: str, **extra) -> None:
    await websocket.handle_json_message(connection_id, _Socket(), {"message_type": message_type, **extra})


async def _settle() -> None:
    """Let the detached emit task run to its end."""
    for _ in range(50):
        pending = [t for t in websocket._tab_ready_tasks if not t.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)
        await asyncio.sleep(0)


async def test_a_tab_reporting_its_first_context_announces_itself():
    heard = []
    off = event_bus.on("app.tab.ready", heard.append)
    try:
        bootstrap.system_content_ready.set()
        _connect("c-1")

        await _frame("c-1", "browser_context", context={"url": "/dock/hub/home"})
        await _settle()

        assert len(heard) == 1
        assert heard[0].tag == "app.tab.ready"
        assert heard[0].data["connection_id"] == "c-1"
        assert heard[0].data["url"] == "/dock/hub/home"
    finally:
        off()


async def test_navigating_inside_one_tab_does_not_announce_it_again(heard):
    bootstrap.system_content_ready.set()
    _connect("c-1")

    await _frame("c-1", "browser_context", context={"url": "/a"})
    await _frame("c-1", "browser_context", context={"url": "/b"})
    await _frame("c-1", "browser_context", context={"url": "/c"})
    await _settle()

    assert len(heard) == 1


async def test_a_reload_or_a_second_window_is_another_tab_and_announces_again(heard):
    """This is what makes the wizard run on every load: a reload drops the
    socket and opens a new one, and a new window is one more."""
    bootstrap.system_content_ready.set()
    _connect("c-1")
    _connect("c-2")

    await _frame("c-1", "browser_context", context={"url": "/a"})
    await _frame("c-2", "browser_context", context={"url": "/a"})
    await _settle()

    assert sorted(e.data["connection_id"] for e in heard) == ["c-1", "c-2"]


async def test_presence_alone_is_not_a_loaded_route(heard):
    """`presence` is sent the moment the socket opens — before any route has
    loaded — so it must not count, or the question could land on a blank tab."""
    bootstrap.system_content_ready.set()
    _connect("c-1")

    await _frame("c-1", "presence", visible=True, focused=True)
    await _settle()

    assert heard == []


async def test_nothing_is_announced_before_the_system_content_has_landed(heard):
    """The bus has no durability: an event emitted while the wizard's trigger is
    still unarmed is never heard by it, and nothing says why the wizard never
    ran. So the tab waits — and is announced the moment the index lands."""
    _connect("c-1")

    await _frame("c-1", "browser_context", context={"url": "/a"})
    await asyncio.sleep(0.05)
    assert heard == [], "announced while the triggers were still unarmed"

    bootstrap.system_content_ready.set()
    await _settle()

    assert len(heard) == 1


async def test_a_tab_that_left_while_the_index_landed_is_not_announced(heard):
    _connect("c-1")

    await _frame("c-1", "browser_context", context={"url": "/a"})
    del websocket._active_connections["c-1"]
    bootstrap.system_content_ready.set()
    await _settle()

    assert heard == []
