"""Regression guard: PTY output survives a WebSocket drop + reconnect.

Symptom that regressed (production): after the client connection dropped and the
SAME client reconnected (e.g. laptop sleep/wake), the terminal froze — input
still reached the shell but live output never came back — until a manual refresh.

Root cause: the PTY output fan-out (`pty_actions.on_pty_output` -> iterate
`PtyState.attached_connections`) only delivers to connections currently attached.
The connection-membership FSM was asymmetric/lossy — WS disconnect *discarded* the
connection and WS reconnect did *nothing* — so a live PTY kept producing output
that was no longer addressed to the reconnected client.

The fix made the FSM backend-owned and symmetric, driven by the WS lifecycle:
  - WS disconnect -> `PtyRegistry.on_ws_disconnect` PARKS the connection
    (ATTACHED -> DETACHED, kept), websocket.py finally-block.
  - WS connect    -> `PtyRegistry.on_ws_connect`   RESUMES it
    (DETACHED -> ATTACHED), websocket.py accept-block.
The same stable `connection_id` reconnects, so output resumes with no client action.

These tests drive the REAL pieces — a real `/bin/sh` PTY via the real
`LocalComputeProvider`, the real `PtyRegistry`, and the real WS-lifecycle hooks
`on_ws_disconnect`/`on_ws_connect`. The output fan-out here mirrors
`pty_actions.on_pty_output` (deliver each chunk to every id in
`attached_connections`).

`test_output_resumes_after_connection_drop_and_reconnect` is the guard: park then
resume the same connection and output must resume. `test_explicit_reattach_resumes_output`
covers the explicit-`attach` path (a manual refresh) for the same outcome.
"""

import asyncio
import sys
import uuid
from contextlib import asynccontextmanager

import pytest

from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider
from flow_sdk.compute.providers.desktop.pty_session_manager import PtyRegistry

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="shell-based PTY repro uses /bin/sh"
)

# do not increase timeout without approval
PYTEST_TIMEOUT = 30
# wall-clock budget to see a marker echo back from a local /bin/sh; generous but
# bounded — a healthy local PTY echoes in tens of ms, never seconds.
_MARKER_POLL_SECONDS = 5.0


async def _spawn_shell(provider, provider_node_id, shell_id, on_output, workdir):
    """Spawn a real /bin/sh PTY (no rc files -> fast, deterministic)."""
    await provider.get_or_create_pty_session(
        provider_node_id,
        shell_id,
        on_output=on_output,
        rows=24,
        cols=80,
        working_dir=str(workdir),
        spawn_args=["/bin/sh"],
    )


async def _send(provider, provider_node_id, shell_id, line: str):
    await provider.send_pty_input(
        provider_node_id, shell_id, line.encode("utf-8"), cols=80, rows=24
    )


async def _wait_for(sink: bytearray, marker: bytes) -> bool:
    """Poll the per-connection delivery sink for `marker` within the budget."""
    deadline = _MARKER_POLL_SECONDS
    step = 0.05
    waited = 0.0
    while waited < deadline:
        if marker in sink:
            return True
        await asyncio.sleep(step)
        waited += step
    return marker in sink


@pytest.fixture(autouse=True)
def _reset_registry():
    """Fresh PtyRegistry singleton per test."""
    PtyRegistry.reset_instance()
    yield
    PtyRegistry.reset_instance()


@asynccontextmanager
async def _attached_pty(tmp_path):
    """A real `/bin/sh` PTY with connection A attached and a per-connection
    delivery sink wired like the production fan-out (`pty_actions.on_pty_output`:
    each chunk goes to every id in `attached_connections`). Asserts the baseline
    (an attached client receives output), yields `(mgr, mgr_key, conn_a, delivered,
    send)`, and closes the PTY on exit.
    """
    mgr = PtyRegistry.get_instance()
    provider = LocalComputeProvider()
    provider.default_working_dir = str(tmp_path)
    compute_node_id = "test-compute-node"
    provider_node_id = "test-provider-node"
    shell_id = f"shell-{uuid.uuid4()}"
    conn_a = f"conn-{uuid.uuid4()}"
    mgr_key = (compute_node_id, provider_node_id, shell_id)
    delivered: dict[str, bytearray] = {}

    def on_output(data: bytes):
        session = mgr.states.get(mgr_key)
        if session:
            for cid in list(session.attached_connections):
                delivered.setdefault(cid, bytearray()).extend(data)

    async def send(line: str):
        await _send(provider, provider_node_id, shell_id, line)

    try:
        await _spawn_shell(provider, provider_node_id, shell_id, on_output, tmp_path)
        await mgr.generate_session(mgr_key, compute_node_id, conn_a, cols=80, rows=24)
        await send("printf 'MARK_BASELINE\\n'\n")
        assert await _wait_for(
            delivered.setdefault(conn_a, bytearray()), b"MARK_BASELINE"
        ), "baseline failed: attached connection never received output (harness broken)"
        yield mgr, mgr_key, conn_a, delivered, send
    finally:
        await provider.close_pty_session(provider_node_id, shell_id)


@pytest.mark.timeout(PYTEST_TIMEOUT)
async def test_output_resumes_after_connection_drop_and_reconnect(tmp_path):
    """A transient connection drop + reconnect must NOT permanently kill output.

    Drives the real WS-lifecycle FSM: `on_ws_disconnect` parks the connection
    (ATTACHED -> DETACHED), `on_ws_connect` resumes it (DETACHED -> ATTACHED) on
    the same connection_id. Output must resume with no explicit client attach —
    the backend owns membership. Guards against the sleep/wake freeze regression.
    """
    async with _attached_pty(tmp_path) as (mgr, mgr_key, conn_a, delivered, send):
        # WS drops (the server's finally-block on close):
        await mgr.on_ws_disconnect(conn_a)
        state = mgr.states[mgr_key]
        assert conn_a not in state.attached_connections, "disconnect should detach"
        assert conn_a in state.detached_connections, "disconnect should PARK, not discard"

        # Same client reconnects (WS accept) — no explicit client attach:
        await mgr.on_ws_connect(conn_a)
        assert conn_a in state.attached_connections, "reconnect should resume (re-attach)"
        assert conn_a not in state.detached_connections, "reconnect should clear the parked entry"

        before = len(delivered[conn_a])
        await send("printf 'MARK_AFTER_RECONNECT\\n'\n")
        assert await _wait_for(delivered[conn_a], b"MARK_AFTER_RECONNECT"), (
            "after a connection drop + reconnect the PTY output must resume to the "
            f"reconnected client (sink grew {len(delivered[conn_a]) - before} bytes)."
        )


@pytest.mark.timeout(PYTEST_TIMEOUT)
async def test_explicit_reattach_resumes_output(tmp_path):
    """Positive control: the PTY + session survive the drop.

    Re-attaching the connection (what a manual page refresh does) immediately
    resumes output — proving the failure above is solely the missing re-attach,
    not a dead PTY or lost session.
    """
    async with _attached_pty(tmp_path) as (mgr, mgr_key, conn_a, delivered, send):
        await mgr.on_ws_disconnect(conn_a)
        await mgr.attach(mgr_key, conn_a)

        before = len(delivered[conn_a])
        await send("printf 'MARK_RESUMED\\n'\n")
        assert await _wait_for(delivered[conn_a], b"MARK_RESUMED"), (
            f"explicit re-attach should resume output (sink grew {len(delivered[conn_a]) - before} bytes)"
        )
