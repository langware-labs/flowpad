"""L2 baseline: time from AgenticProcess.start() to the workdir appearing in PTY output.

Same measurement as the bare-PTY Python baseline (~642 ms median), but the path
goes through the full backend stack — Shell entity + Project + ComputeNode +
PtyRegistry + replay buffer — minus the HTTP/WS layer.

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


async def _wait_for_first_output(shell_id: str, timeout_s: float, min_bytes: int = 1) -> tuple[float | None, int]:
    """Poll the on-disk PTY stream file; return (elapsed, bytes) once the worker
    writes its first output. "First output" (any bytes from the spawned CLI) is a
    stable, marker-free readiness signal — the old workdir-name marker was brittle
    (Claude renders an abbreviated cwd, not the raw tmp dir name).

    The in-memory replay buffer + pty.output()/snapshot() were removed — the
    canonical capture is now the .pty stream file (see _pty_helpers.read_pty_stream).
    """
    from tests.long_tests._pty_helpers import read_pty_stream

    t0 = time.perf_counter()
    deadline = t0 + timeout_s
    text = ""
    while time.perf_counter() < deadline:
        text = read_pty_stream(shell_id)
        if len(text) >= min_bytes:
            return (time.perf_counter() - t0, len(text))
        await asyncio.sleep(0.02)
    return (None, len(text))


@pytest.mark.skip(
    reason=(
        "Manual profiling bench (spawns real `claude` per iteration). Un-skip to "
        "run: `DEEP_TESTING=1 uv run pytest tests/long_tests/test_claude_ready_bench.py -s`. "
        "Reports two series: start_pty() backend cost and start->first-output total. "
        "Rehabilitated 2026-07-01 (re-fetch after start_pty; first-output signal "
        "replaces the brittle workdir marker; reads the .pty stream file)."
    ),
)
@pytest.mark.asyncio
@pytest.mark.timeout(60 * (ITERATIONS + 2))
async def test_agentic_process_ready_time_L2(local_project, local_compute_node):
    assert local_compute_node is not None

    # Warm-up: one throwaway launch so imports, caches, disk touches don't pollute iter 1.
    warm = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE).save()
    try:
        r = await warm.start_pty()
        assert isinstance(r, ApiSuccessResponse)
        # Wait briefly for spawn to settle
        await asyncio.sleep(0.5)
    finally:
        try:
            await warm.close()
        except Exception:
            pass

    # Two independent series: the backend start_pty() cost (our code — the part
    # that should be sub-second) and time-to-first-PTY-output (dominated by the
    # external Claude CLI cold start).
    start_samples: list[float] = []
    total_samples: list[float] = []
    print(f"\n[L2] AgenticProcess claude-ready, {ITERATIONS} iterations")

    for i in range(1, ITERATIONS + 1):
        process = await AgenticProcess(worker_type=WorkerType.CLAUDE_CODE).save()
        try:
            t0 = time.perf_counter()
            result = await process.start_pty()
            t_start_returned = time.perf_counter()

            assert isinstance(result, ApiSuccessResponse), f"start() failed: {result}"
            start_cost_ms = (t_start_returned - t0) * 1000
            start_samples.append(start_cost_ms)

            # start_pty() mutates a reloaded copy under the open lock, not this
            # in-memory object — re-fetch to observe the spawned shell (matches
            # the production HTTP path, see test_clean_claude_pty).
            process = await AgenticProcess.get_by_id(process.id)
            shell = await process.shell()
            assert shell is not None

            elapsed, nbytes = await _wait_for_first_output(shell.id, PER_ITER_TIMEOUT)
            if elapsed is None:
                print(f"  iter {i:2d}: start()={start_cost_ms:7.1f} ms   "
                      f"first-output=TIMEOUT ({nbytes}B)")
                continue

            total_ms = start_cost_ms + elapsed * 1000
            total_samples.append(total_ms)
            print(f"  iter {i:2d}: start()={start_cost_ms:7.1f} ms   "
                  f"+{elapsed*1000:7.1f} ms to first output   = {total_ms:7.1f} ms total ({nbytes}B)")
        finally:
            try:
                await process.close()
            except Exception:
                pass
            if i < ITERATIONS:
                await asyncio.sleep(BETWEEN_ITERS_S)

    def _stats(name: str, xs: list[float]) -> None:
        if not xs:
            print(f"\n{name}: no samples")
            return
        xs = sorted(xs)
        med = statistics.median(xs)
        mean = statistics.mean(xs)
        stdev = statistics.stdev(xs) if len(xs) > 1 else 0.0
        print(f"\n{name} (ms):")
        print(f"  n      = {len(xs)}")
        print(f"  min    = {xs[0]:7.1f}")
        print(f"  median = {med:7.1f}")
        print(f"  mean   = {mean:7.1f}")
        print(f"  max    = {xs[-1]:7.1f}")
        print(f"  stdev  = {stdev:7.1f}")

    _stats("L2 start_pty() backend cost", start_samples)
    _stats("L2 start->first-output total", total_samples)
    assert start_samples, "no successful start_pty() samples"
