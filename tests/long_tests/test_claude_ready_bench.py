"""L2 baseline: time from AgenticProcess.start() to the workdir appearing in PTY output.

Same measurement as the bare-PTY Python baseline (~642 ms median), but the path
goes through the full backend stack — Shell entity + Project + ComputeNode +
PtySessionManager + replay buffer — minus the HTTP/WS layer.

    L1: ~/tmp/claude_ready_bench.py  → spawn `claude` in PtyProcess directly
    L2: THIS FILE                    → AgenticProcess.start() in-process

Run:
    uv run pytest tests/long_tests/test_claude_ready_bench.py -v -s

Temporary bench file — delete after we're done comparing layers.
"""
from __future__ import annotations

import asyncio
import statistics
import time
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.responses import ApiSuccessResponse
from tests.test_settings import test_service_config


pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    )
]

ITERATIONS = 10
PER_ITER_TIMEOUT = 30.0
# Soft sleep between iterations so Claude's auth/TTL caches behave like repeat launches.
BETWEEN_ITERS_S = 1.0


async def _wait_for_marker(pty, marker: bytes, timeout_s: float) -> tuple[float | None, int]:
    """Subscribe to pty.output(); return (elapsed from now, bytes read) once marker seen."""
    buf = bytearray()
    t0 = time.perf_counter()

    # Drain the replay buffer first in case some chunks already landed
    # between start() returning and us subscribing.
    for chunk in pty.snapshot(since=0):
        buf.extend(chunk.data)
        if marker in buf:
            return (time.perf_counter() - t0, len(buf))

    deadline = t0 + timeout_s

    async def read_loop():
        async for data in pty.output():
            buf.extend(data)
            if marker in buf:
                return
    try:
        await asyncio.wait_for(read_loop(), timeout=max(0.01, deadline - time.perf_counter()))
    except asyncio.TimeoutError:
        return (None, len(buf))
    return (time.perf_counter() - t0, len(buf))


@pytest.mark.asyncio
@pytest.mark.timeout(60 * (ITERATIONS + 2))
async def test_agentic_process_ready_time_L2(local_project, local_compute_node):
    assert local_compute_node is not None

    # Warm-up: one throwaway launch so imports, caches, disk touches don't pollute iter 1.
    warm = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE).save()
    try:
        r = await warm.start()
        assert isinstance(r, ApiSuccessResponse)
        # Wait briefly for spawn to settle
        await asyncio.sleep(0.5)
    finally:
        try:
            await warm.close()
        except Exception:
            pass

    samples: list[float] = []
    print(f"\n[L2] AgenticProcess claude-ready, {ITERATIONS} iterations")

    for i in range(1, ITERATIONS + 1):
        process = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE).save()
        marker = None
        try:
            t0 = time.perf_counter()
            result = await process.start()
            t_start_returned = time.perf_counter()

            assert isinstance(result, ApiSuccessResponse), f"start() failed: {result}"

            # Marker = last path component of the project's workdir.
            # Claude prints it on the first frame (the "~/…/proj" line).
            workdir = process.workdir or str(Path.home())
            marker = Path(workdir).name.encode()

            shell = await process.shell()
            assert shell is not None
            pty = shell.compute_node.get_pty(shell.id)
            assert pty is not None, "PTY should exist after start()"

            elapsed, nbytes = await _wait_for_marker(pty, marker, PER_ITER_TIMEOUT)
            if elapsed is None:
                print(f"  iter {i:2d}: TIMEOUT (read {nbytes} bytes, no {marker!r})")
                continue

            # "start to marker" = time from before start() to when marker appeared.
            total_ms = (t_start_returned - t0 + elapsed) * 1000
            start_cost_ms = (t_start_returned - t0) * 1000
            wait_ms = elapsed * 1000
            samples.append(total_ms)
            print(f"  iter {i:2d}: {total_ms:7.1f} ms   "
                  f"(start()={start_cost_ms:.1f} ms, then +{wait_ms:.1f} ms for marker, {nbytes}B)")
        finally:
            try:
                await process.close()
            except Exception:
                pass
            if i < ITERATIONS:
                await asyncio.sleep(BETWEEN_ITERS_S)

    assert samples, "no successful samples"
    samples.sort()
    mn = samples[0]
    mx = samples[-1]
    med = statistics.median(samples)
    mean = statistics.mean(samples)
    stdev = statistics.stdev(samples) if len(samples) > 1 else 0.0

    print(f"\nL2 claude-ready (AgenticProcess, in-process, ms):")
    print(f"  n      = {len(samples)}")
    print(f"  min    = {mn:7.1f}")
    print(f"  median = {med:7.1f}")
    print(f"  mean   = {mean:7.1f}")
    print(f"  max    = {mx:7.1f}")
    print(f"  stdev  = {stdev:7.1f}")
