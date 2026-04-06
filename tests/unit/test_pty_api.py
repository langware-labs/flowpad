"""Unit tests for the new Pty API surface.

Covers: write(), snapshot(), connections, cols, rows, name property, output().
Uses LocalPtySession with mocked provider/manager/buffer — no real OS PTY.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.compute.providers.desktop.local_pty_session import LocalPtySession
from flow_sdk.compute.providers.desktop.pty_session_manager import PtySessionManager, PtySessionState
from flow_sdk.compute.providers.desktop.pty_replay_buffer import OutputChunk, PtyReplayBuffer

PTY_KEY = ("cn-1", "pn-1", "shell-1")


def _make_session(cols: int = 80, rows: int = 24, name: str | None = None) -> PtySessionState:
    state = PtySessionState(pty_key=PTY_KEY, cols=cols, rows=rows, name=name)
    return state


def _make_pty(session: PtySessionState | None = None) -> tuple[LocalPtySession, MagicMock, MagicMock, MagicMock]:
    provider = MagicMock()
    provider.is_pty_alive = MagicMock(return_value=True)
    provider.send_pty_input = AsyncMock()

    mgr = MagicMock()
    mgr.sessions = {}
    if session is not None:
        mgr.sessions[PTY_KEY] = session

    buf = MagicMock()
    buf.get_replay = MagicMock(return_value=[])
    buf.get_latest_seq = MagicMock(return_value=0)

    pty = LocalPtySession(PTY_KEY[0], PTY_KEY[1], PTY_KEY[2], provider, mgr, buf)
    return pty, provider, mgr, buf


# ---------------------------------------------------------------------------
# write() — renamed from send()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_write_calls_send_pty_input():
    """write(data) delegates to provider.send_pty_input."""
    session = _make_session()
    pty, provider, _, _ = _make_pty(session)

    await pty.write(b"hello\r")
    provider.send_pty_input.assert_awaited_once_with(PTY_KEY[1], PTY_KEY[2], b"hello\r", 80, 24)


@pytest.mark.asyncio
async def test_write_uses_session_dims():
    """write() reads cols/rows from session state."""
    session = _make_session(cols=120, rows=40)
    pty, provider, _, _ = _make_pty(session)

    await pty.write(b"x")
    args = provider.send_pty_input.call_args[0]
    assert args[3] == 120  # cols
    assert args[4] == 40   # rows


# ---------------------------------------------------------------------------
# snapshot() — renamed from get_replay()
# ---------------------------------------------------------------------------

def test_snapshot_delegates_to_buffer():
    """snapshot(since) calls buf.get_replay with the correct key and since value."""
    session = _make_session()
    pty, _, _, buf = _make_pty(session)

    pty.snapshot(since=5)
    buf.get_replay.assert_called_once_with(PTY_KEY, 5)


def test_snapshot_default_since_zero():
    """snapshot() with no args uses since=0."""
    session = _make_session()
    pty, _, _, buf = _make_pty(session)

    pty.snapshot()
    buf.get_replay.assert_called_once_with(PTY_KEY, 0)


# ---------------------------------------------------------------------------
# connections — frozenset property
# ---------------------------------------------------------------------------

def test_connections_returns_frozenset():
    """connections is a frozenset of connection IDs from session state."""
    session = _make_session()
    session.connection_ids = {"conn-a", "conn-b"}
    pty, _, _, _ = _make_pty(session)

    result = pty.connections
    assert isinstance(result, frozenset)
    assert result == frozenset({"conn-a", "conn-b"})


def test_connections_empty_when_no_session():
    """connections returns empty frozenset when session does not exist."""
    pty, _, _, _ = _make_pty(session=None)
    assert pty.connections == frozenset()


# ---------------------------------------------------------------------------
# cols / rows properties
# ---------------------------------------------------------------------------

def test_cols_from_session_state():
    """cols returns session.cols."""
    session = _make_session(cols=132)
    pty, _, _, _ = _make_pty(session)
    assert pty.cols == 132


def test_rows_from_session_state():
    """rows returns session.rows."""
    session = _make_session(rows=50)
    pty, _, _, _ = _make_pty(session)
    assert pty.rows == 50


def test_cols_default_when_no_session():
    """cols returns 80 when session does not exist."""
    pty, _, _, _ = _make_pty(session=None)
    assert pty.cols == 80


def test_rows_default_when_no_session():
    """rows returns 24 when session does not exist."""
    pty, _, _, _ = _make_pty(session=None)
    assert pty.rows == 24


# ---------------------------------------------------------------------------
# name property (r/w)
# ---------------------------------------------------------------------------

def test_name_getter_returns_session_name():
    """name returns session.name."""
    session = _make_session(name="my-tab")
    pty, _, _, _ = _make_pty(session)
    assert pty.name == "my-tab"


def test_name_setter_updates_session_state():
    """Setting pty.name updates session.name."""
    session = _make_session()
    pty, _, _, _ = _make_pty(session)

    pty.name = "new-name"
    assert session.name == "new-name"


def test_name_none_when_no_session():
    """name returns None when no session exists."""
    pty, _, _, _ = _make_pty(session=None)
    assert pty.name is None


# ---------------------------------------------------------------------------
# output() — AsyncIterator
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_output_yields_data_from_queue():
    """output() yields data put into the registered queue."""
    session = _make_session()
    pty, _, _, _ = _make_pty(session)

    received = []

    async def consumer():
        async for chunk in pty.output():
            received.append(chunk)
            break  # stop after first chunk

    # Start consumer in background
    consumer_task = asyncio.create_task(consumer())
    await asyncio.sleep(0)  # let consumer register queue

    # Simulate on_output callback: put data into the queue
    assert len(session.output_queues) == 1
    await session.output_queues[0].put(b"hello world")

    await consumer_task
    assert received == [b"hello world"]


@pytest.mark.asyncio
async def test_output_stops_on_none_sentinel():
    """output() stops iteration when None is enqueued."""
    session = _make_session()
    pty, _, _, _ = _make_pty(session)

    received = []

    async def consumer():
        async for chunk in pty.output():
            received.append(chunk)

    consumer_task = asyncio.create_task(consumer())
    await asyncio.sleep(0)

    q = session.output_queues[0]
    await q.put(b"first")
    await q.put(b"second")
    await q.put(None)  # sentinel

    await consumer_task
    assert received == [b"first", b"second"]


@pytest.mark.asyncio
async def test_output_queue_removed_on_exit():
    """Queue is removed from session.output_queues after iteration ends naturally."""
    session = _make_session()
    pty, _, _, _ = _make_pty(session)

    received = []

    async def consumer():
        async for chunk in pty.output():
            received.append(chunk)

    consumer_task = asyncio.create_task(consumer())
    await asyncio.sleep(0)
    assert len(session.output_queues) == 1

    # Stop naturally via None sentinel — this runs the generator's finally block
    await session.output_queues[0].put(b"x")
    await session.output_queues[0].put(None)
    await consumer_task
    assert received == [b"x"]
    assert len(session.output_queues) == 0


@pytest.mark.asyncio
async def test_output_returns_immediately_when_no_session():
    """output() yields nothing when session doesn't exist."""
    pty, _, _, _ = _make_pty(session=None)
    received = []
    async for chunk in pty.output():
        received.append(chunk)
    assert received == []
