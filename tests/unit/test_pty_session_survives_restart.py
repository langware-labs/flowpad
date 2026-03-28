"""Tests demonstrating PTY session loss on server restart.

Root cause: PtySessionManager stores sessions in a plain dict in memory.
When the server worker process restarts (auto-reload, crash, etc.) all
sessions vanish.  The frontend keeps sending input to session IDs that
no longer exist, receiving "PTY session not found" on every keystroke,
which makes the terminal appear frozen.

These tests reproduce the exact failure sequence observed in production.
"""

import pytest

from flow_sdk.compute.providers.local.pty_session_manager import PtySessionManager
from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def reset_manager():
    """Ensure a fresh singleton for each test."""
    PtySessionManager.reset_instance()
    yield
    PtySessionManager.reset_instance()


@pytest.fixture
def manager() -> PtySessionManager:
    return PtySessionManager.get_instance()


PTY_KEY_1 = ("compute-1", "provider-1", "shell-1772992530741")
PTY_KEY_2 = ("compute-1", "provider-1", "shell-1772966858874")
CONN = "ws-conn-abc123"


# ── Root cause: sessions are lost on restart ───────────────────────────


@pytest.mark.asyncio
async def test_sessions_lost_after_singleton_reset(manager: PtySessionManager):
    """Simulate server restart: reset_instance() wipes all sessions.

    This is the root cause.  After reset the manager returns a fresh
    instance with an empty sessions dict, so every subsequent
    get_session() returns None → "PTY session not found".
    """
    # Create two sessions (mimics two open terminal tabs)
    await manager.generate_session(PTY_KEY_1, "compute-1", CONN)
    await manager.generate_session(PTY_KEY_2, "compute-1", CONN)
    assert len(manager.sessions) == 2

    # Server restarts → singleton is re-created
    PtySessionManager.reset_instance()
    new_manager = PtySessionManager.get_instance()

    # Both sessions are gone
    assert await new_manager.get_session(PTY_KEY_1) is None
    assert await new_manager.get_session(PTY_KEY_2) is None
    assert len(new_manager.sessions) == 0


# ── Consequence: input to lost sessions fails ─────────────────────────


@pytest.mark.asyncio
async def test_input_to_lost_session_returns_none(manager: PtySessionManager):
    """After restart, get_session returns None for previously valid keys.

    This is the exact check that _send_pty_input does in compute_node.py
    before forwarding input.  When it returns None the backend sends back
    an error response: "PTY session not found: <session_id>".
    """
    await manager.generate_session(PTY_KEY_1, "compute-1", CONN)
    assert await manager.get_session(PTY_KEY_1) is not None

    # Simulate restart
    PtySessionManager.reset_instance()
    manager = PtySessionManager.get_instance()

    # Same key that worked moments ago now fails
    session = await manager.get_session(PTY_KEY_1)
    assert session is None, (
        "Session should be None after restart — this is the root cause of "
        "'PTY session not found' errors flooding the frontend"
    )


# ── WebSocket disconnect: stale connection_ids ─────────────────────────


@pytest.mark.asyncio
async def test_disconnect_leaves_stale_connection_ids(manager: PtySessionManager):
    """Without cleanup, disconnected WebSocket connection_ids accumulate.

    When a browser tab refreshes, its WebSocket disconnects.  If the old
    connection_id is never removed from the session's connection_ids set,
    PTY output routing tries to send to a dead connection and silently
    fails — the terminal receives no output.
    """
    session = await manager.generate_session(PTY_KEY_1, "compute-1", CONN)
    assert CONN in session.connection_ids

    # Tab refreshes → old WS disconnects, new one connects
    new_conn = "ws-conn-new456"
    await manager.attach_session(PTY_KEY_1, new_conn)

    # Without explicit detach, old conn is still in the set
    assert CONN in session.connection_ids, "Old connection should still be present (this is the stale state)"
    assert new_conn in session.connection_ids

    # After explicit detach (our fix in websocket.py disconnect handler)
    await manager.detach_session(PTY_KEY_1, CONN)
    assert CONN not in session.connection_ids
    assert new_conn in session.connection_ids


@pytest.mark.asyncio
async def test_detach_does_not_destroy_session(manager: PtySessionManager):
    """Detaching a connection must NOT destroy the PTY session.

    The session should stay alive so the new WebSocket connection can
    reattach to it.  Only close_for_connection with zero remaining
    connections should destroy a session.
    """
    await manager.generate_session(PTY_KEY_1, "compute-1", CONN)

    await manager.detach_session(PTY_KEY_1, CONN)

    session = await manager.get_session(PTY_KEY_1)
    assert session is not None, "Detach must not destroy the session"
    assert len(session.connection_ids) == 0
    assert session.last_detached_at is not None


# ── Recovery: scan and resume ──────────────────────────────────────────


@pytest.fixture
def use_tmp_records(tmp_path):
    """Point ShellRecord storage at a temp directory."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def test_plain_running_session_has_no_process(use_tmp_records):
    """A plain RUNNING shell (no Claude) should have no agentic_process_id."""
    record = ShellRecord(
        id="plain-1",
        pty_pid="plain-1",
        state=ShellStatus.RUNNING,
    )
    record.save()

    assert record.data.get("agentic_process_id") is None
