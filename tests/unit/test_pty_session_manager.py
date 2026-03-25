"""Unit tests for PtySessionManager multi-connection safety.

The core invariant: a PTY session with other active connections must NOT be
destroyed when a single client requests close.  Only when the last connection
detaches should the session be eligible for cleanup.
"""

import pytest

from flow_sdk.builtin.faas.pty_session_manager import PtySessionManager


@pytest.fixture(autouse=True)
def reset_manager():
    """Ensure a fresh singleton for each test."""
    PtySessionManager.reset_instance()
    yield
    PtySessionManager.reset_instance()


@pytest.fixture
def manager() -> PtySessionManager:
    return PtySessionManager.get_instance()


PTY_KEY = ("compute-1", "provider-1", "session-1")
CONN_A = "conn-a"
CONN_B = "conn-b"


@pytest.mark.asyncio
async def test_close_for_connection_keeps_session_for_other_connections(manager: PtySessionManager):
    """Two connections attached. One closes. Session must survive for the other."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.attach_session(PTY_KEY, CONN_B)

    await manager.close_for_connection(PTY_KEY, CONN_B)

    session = await manager.get_session(PTY_KEY)
    assert session is not None, "Session was destroyed while connection A is still attached"
    assert CONN_A in session.connection_ids
    assert CONN_B not in session.connection_ids


@pytest.mark.asyncio
async def test_close_for_connection_last_one_destroys(manager: PtySessionManager):
    """Last connection closes. Session should be destroyed."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)

    await manager.close_for_connection(PTY_KEY, CONN_A)

    assert await manager.get_session(PTY_KEY) is None
