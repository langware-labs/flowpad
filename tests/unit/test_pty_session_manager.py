"""Unit tests for PtyRegistry multi-connection safety + the WS-lifecycle FSM.

Two invariants:
  1. A PtyState with other active connections must NOT be destroyed when a single
     client *closes* (explicit intent). Only the last close destroys it.
  2. A WS *disconnect* (transport drop) PARKS the connection (ATTACHED -> DETACHED,
     kept), and a WS *reconnect* of the same id RESUMES it (DETACHED -> ATTACHED) —
     so output survives a transient blip with no client action. Parked
     subscriptions and orphaned PtyStates are bounded by explicit reapers.
"""

import time

import pytest

from flow_sdk.compute.providers.desktop.pty_session_manager import PtyRegistry


@pytest.fixture(autouse=True)
def reset_manager():
    """Ensure a fresh singleton for each test."""
    PtyRegistry.reset_instance()
    yield
    PtyRegistry.reset_instance()


@pytest.fixture
def manager() -> PtyRegistry:
    return PtyRegistry.get_instance()


PTY_KEY = ("compute-1", "provider-1", "session-1")
CONN_A = "conn-a"
CONN_B = "conn-b"


@pytest.mark.asyncio
async def test_close_for_connection_keeps_session_for_other_connections(manager: PtyRegistry):
    """Two connections attached. One closes. Session must survive for the other."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.attach(PTY_KEY, CONN_B)

    await manager.close_for_connection(PTY_KEY, CONN_B)

    session = await manager.get_session(PTY_KEY)
    assert session is not None, "Session was destroyed while connection A is still attached"
    assert CONN_A in session.attached_connections
    assert CONN_B not in session.attached_connections


@pytest.mark.asyncio
async def test_close_for_connection_last_one_destroys(manager: PtyRegistry):
    """Last connection closes. Session should be destroyed."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)

    await manager.close_for_connection(PTY_KEY, CONN_A)

    assert await manager.get_session(PTY_KEY) is None


# ── WS-lifecycle FSM: park (disconnect) / resume (reconnect) ──────────────────


@pytest.mark.asyncio
async def test_ws_disconnect_parks_connection(manager: PtyRegistry):
    """A WS disconnect PARKS the connection (DETACHED), it does NOT discard or close."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)

    await manager.on_ws_disconnect(CONN_A)

    state = await manager.get_session(PTY_KEY)
    assert state is not None, "disconnect must NOT close the PtyState (PTY stays alive)"
    assert CONN_A not in state.attached_connections, "disconnect detaches"
    assert CONN_A in state.detached_connections, "disconnect parks, not discards"
    assert state.last_detached_at is not None, "orphan TTL is armed when attached empties"


@pytest.mark.asyncio
async def test_ws_connect_resumes_parked_connection(manager: PtyRegistry):
    """A WS reconnect of the SAME id resumes membership (ATTACHED) with no client action."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.on_ws_disconnect(CONN_A)

    await manager.on_ws_connect(CONN_A)

    state = await manager.get_session(PTY_KEY)
    assert CONN_A in state.attached_connections, "reconnect resumes the subscription"
    assert CONN_A not in state.detached_connections, "reconnect clears the parked entry"
    assert state.last_detached_at is None, "orphan TTL disarmed once attached again"


@pytest.mark.asyncio
async def test_ws_connect_is_noop_for_fresh_connection(manager: PtyRegistry):
    """A brand-new connection with no parked subscription is a safe no-op."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)

    await manager.on_ws_connect(CONN_B)  # never subscribed

    state = await manager.get_session(PTY_KEY)
    assert CONN_B not in state.attached_connections
    assert CONN_A in state.attached_connections


@pytest.mark.asyncio
async def test_one_client_parked_other_still_receives(manager: PtyRegistry):
    """Parking one connection leaves the others attached (multi-viewer safe)."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.attach(PTY_KEY, CONN_B)

    await manager.on_ws_disconnect(CONN_A)

    state = await manager.get_session(PTY_KEY)
    assert state.attached_connections == {CONN_B}
    assert CONN_A in state.detached_connections
    assert state.last_detached_at is None, "still has an attached viewer — TTL not armed"


# ── Bounded reapers (leak prevention) ────────────────────────────────────────


@pytest.mark.asyncio
async def test_orphan_ttl_closes_fully_parked_state(manager: PtyRegistry):
    """A PtyState with everyone parked (no attached) is closed after the orphan TTL."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.on_ws_disconnect(CONN_A)

    # Backdate so the orphan TTL is exceeded.
    state = await manager.get_session(PTY_KEY)
    state.last_detached_at = time.time() - 10_000

    closed = await manager.cleanup_expired_sessions(ttl_seconds=900)
    assert closed == 1
    assert await manager.get_session(PTY_KEY) is None


@pytest.mark.asyncio
async def test_detach_grace_reaps_stale_parked_id_on_live_state(manager: PtyRegistry):
    """A parked id on a still-attached PtyState is reaped after the detach grace."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.attach(PTY_KEY, CONN_B)
    await manager.on_ws_disconnect(CONN_B)  # B parked, A still attached

    state = await manager.get_session(PTY_KEY)
    state.detached_connections[CONN_B] = time.time() - 10_000  # backdate past grace

    closed = await manager.cleanup_expired_sessions(ttl_seconds=900, detach_grace_seconds=900)
    assert closed == 0, "state has an attached viewer — must not be closed"
    assert CONN_B not in state.detached_connections, "stale parked id reaped"
    assert state.attached_connections == {CONN_A}
