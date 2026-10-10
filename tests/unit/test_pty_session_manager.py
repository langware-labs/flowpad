"""Unit tests for PtyRegistry multi-connection safety + the WS-lifecycle FSM.

Two invariants:
  1. A PtyState with other active connections must NOT be destroyed when a single
     client *closes* (explicit intent). Only the last close destroys it.
  2. A WS *disconnect* (transport drop) PARKS the connection (ATTACHED -> DETACHED,
     kept), and a WS *reconnect* of the same id RESUMES it (DETACHED -> ATTACHED) —
     so output survives a transient blip with no client action. Parked
     subscriptions and orphaned PtyStates are bounded by explicit reapers.
"""

import asyncio
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


# ── Parked-id reaper: the half of the sweep that runs in production ──────────

ORPHAN_KEY = ("compute-1", "provider-1", "session-orphan")


async def _one_live_and_one_orphan_state(manager: PtyRegistry, backdate: float = 10_000):
    """A viewed state with a stale parked id, and a state nobody views any more."""
    await manager.generate_session(PTY_KEY, "compute-1", CONN_A)
    await manager.attach(PTY_KEY, CONN_B)
    await manager.on_ws_disconnect(CONN_B)  # B parked on the live state
    await manager.generate_session(ORPHAN_KEY, "compute-1", "conn-gone")
    await manager.on_ws_disconnect("conn-gone")  # its only viewer parked -> orphan TTL armed

    live = await manager.get_session(PTY_KEY)
    orphan = await manager.get_session(ORPHAN_KEY)
    live.detached_connections[CONN_B] = time.time() - backdate
    orphan.detached_connections["conn-gone"] = time.time() - backdate
    orphan.last_detached_at = time.time() - backdate
    return live, orphan


@pytest.mark.asyncio
async def test_reap_parked_connections_drops_stale_ids_and_closes_nothing(manager: PtyRegistry):
    """Backdated parked ids go, on a viewed state and on an orphan alike; no PTY is closed."""
    live, orphan = await _one_live_and_one_orphan_state(manager)
    live.detached_connections["conn-fresh"] = time.time()  # parked just now: must survive

    reaped = manager.reap_parked_connections(detach_grace_seconds=900)

    assert reaped == 2
    assert live.detached_connections == {"conn-fresh": live.detached_connections["conn-fresh"]}
    assert orphan.detached_connections == {}
    assert live.attached_connections == {CONN_A}
    assert await manager.get_session(ORPHAN_KEY) is orphan, "the reaper never closes a PTY, orphan or not"


@pytest.mark.asyncio
async def test_default_cleanup_task_reaps_parked_ids_only(manager: PtyRegistry):
    """``start_cleanup_task()`` with defaults (what server startup calls): one tick drops the
    backdated parked ids and leaves a state whose orphan TTL has long passed alone."""
    live, orphan = await _one_live_and_one_orphan_state(manager)

    await manager.start_cleanup_task(interval_seconds=0.01)
    assert manager._cleanup_task is not None and not manager._cleanup_task.done()
    assert manager._cleanup_task.get_name() == "pty-parked-reaper"
    for _ in range(50):  # one tick is 10 ms; bail out as soon as it landed
        await asyncio.sleep(0.01)
        if not live.detached_connections:
            break

    assert live.detached_connections == {}
    assert orphan.detached_connections == {}
    assert await manager.get_session(ORPHAN_KEY) is orphan, "orphan TTL stays off in the default loop"
    assert len(manager.states) == 2

    await manager.stop_cleanup_task()
    assert manager._cleanup_task.done()


@pytest.mark.asyncio
async def test_cleanup_task_with_ttl_still_closes_orphans(manager: PtyRegistry):
    """Passing a TTL keeps the full sweep (orphan close + parked reap) for a caller that wants it."""
    _live, orphan = await _one_live_and_one_orphan_state(manager)

    await manager.start_cleanup_task(interval_seconds=0.01, ttl_seconds=900)
    for _ in range(50):
        await asyncio.sleep(0.01)
        if ORPHAN_KEY not in manager.states:
            break
    await manager.stop_cleanup_task()

    assert await manager.get_session(ORPHAN_KEY) is None
    assert await manager.get_session(PTY_KEY) is not None
