"""The event loop must stay LIVE while opening an agentic process.

Opening an agentic process ("Start Claude") spawns the worker PTY through
``LocalComputeProvider.get_or_create_pty_session``. That method runs
``PtyProcess.spawn`` (a fork+exec) — plus the pre-spawn synchronous I/O
(``find_command``, ``os.makedirs``) — directly on the asyncio event loop,
without offloading to a thread. While the spawn runs, the loop is starved:
every other request (even a trivial non-DB health probe) hangs.

This is the proven root cause of the "Start Claude takes ~20s and the entire
backend is frozen" report: the heavier the forked child (Claude vs a trivial
command), the longer the loop is held. Even a trivial ``/bin/cat`` spawn blocks
the loop ~100ms here; a real Claude boot scales that to seconds.

The proven on/off switch: wrapping the spawn in ``asyncio.to_thread`` makes the
freeze disappear; reverting it brings the freeze back.

This test asserts the loop stays responsive (a concurrent heartbeat keeps
ticking) across the spawn. It FAILS today (spawn on the loop) and PASSES once
the spawn is offloaded off the event loop.
"""

import asyncio
import time

import pytest

from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider

# A single synchronous section on the event loop must not exceed this. The
# heartbeat ticks every 5ms, so a healthy loop keeps every gap near 5ms; a
# blocking spawn produces one large gap. Generous enough to absorb scheduler
# jitter, far below the on-loop spawn cost.
MAX_LOOP_GAP_S = 0.05


@pytest.mark.asyncio
async def test_opening_agentic_process_keeps_event_loop_live():
    """Spawning the worker PTY must not block the event loop."""
    provider = LocalComputeProvider()
    node_id = await provider.create_node("loop-live-node", None)

    gaps: list[float] = []
    last = time.monotonic()
    stop = False

    async def heartbeat():
        nonlocal last
        while not stop:
            now = time.monotonic()
            gaps.append(now - last)
            last = now
            await asyncio.sleep(0.005)

    hb = asyncio.create_task(heartbeat())
    try:
        await asyncio.sleep(0.05)  # let the heartbeat settle into a steady cadence

        # Open the worker PTY exactly as _perform_open does — real code path,
        # real fork+exec. A trivial long-lived child stands in for the Claude
        # worker; the loop-blocking property is independent of which child is
        # spawned (it's the spawn + pre-spawn sync I/O that runs on the loop).
        last = time.monotonic()
        await provider.get_or_create_pty_session(
            node_id,
            "loop-live-sess",
            on_output=lambda _b: None,
            spawn_args=["/bin/cat"],
        )

        await asyncio.sleep(0.05)  # let the heartbeat resume after the spawn
    finally:
        stop = True
        await hb
        await provider._cleanup_dead_pty_session((node_id, "loop-live-sess"), reason="test teardown")

    worst = max(gaps)
    assert worst < MAX_LOOP_GAP_S, (
        f"event loop blocked for {worst * 1000:.0f}ms while opening the agentic "
        f"process — the PTY spawn is running on the loop instead of in a thread"
    )
