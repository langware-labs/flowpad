"""Compute-node command streaming — real tests.

Drives the public Python provider API (`LocalComputeProvider.run_command`) with
cheap `python3 -c` argv that emit output on a controlled schedule, and asserts
the documented streaming contract:

- background `run_command` streams stdout/stderr *incrementally* (via the
  `CLICommand.stdout_stream` / `stderr_stream` async generators), not batched
  until process exit;
- stdout and stderr stream concurrently without blocking each other;
- large output drains without deadlocking on a full OS pipe buffer;
- foreground (`background=False`) buffers the whole result and marks complete.

No mocks — real subprocesses via the real provider. Delays are kept small so
each test finishes well under the 30s unit cap.
"""

import asyncio
import shlex
import sys
import time

import pytest

from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider
from flow_sdk.flowpad_types import RuntimeEnvironment


@pytest.fixture
async def node():
    """A started local compute node; provider node id is yielded."""
    provider = LocalComputeProvider()
    node_id = await provider.create_node("stream-test-node", RuntimeEnvironment(name="stream-test"))
    await provider.startup(node_id)
    try:
        yield provider, node_id
    finally:
        await provider.shutdown(node_id)


def _py(script: str) -> str:
    """A shell command that runs `script` under this interpreter."""
    return f"{shlex.quote(sys.executable)} -u -c {shlex.quote(script)}"


async def _collect_with_times(stream) -> list[tuple[float, str]]:
    """Drain an async line stream, tagging each line with its arrival time."""
    out: list[tuple[float, str]] = []
    async for line in stream:
        out.append((time.monotonic(), line))
    return out


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_realtime_stdout_streaming(node):
    """stdout arrives line-by-line as the process emits it, not batched at exit.

    The child emits 3 lines spaced 0.3s apart; because streaming is real-time
    the span between the first and last received line must be at least ~2 delays.
    """
    provider, node_id = node
    script = (
        "import time,sys\n"
        "for i in range(3):\n"
        "    print(f'line{i}')\n"
        "    time.sleep(0.3)\n"
    )
    cmd = await provider.run_command(node_id, _py(script), background=True)

    stamped = await _collect_with_times(cmd.stdout_stream())
    await cmd.wait()

    lines = [ln.strip() for _, ln in stamped]
    assert lines == ["line0", "line1", "line2"]
    span = stamped[-1][0] - stamped[0][0]
    assert span >= 0.4, f"lines arrived batched (span={span:.3f}s), expected real-time"
    assert cmd.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_delayed_two_line_chunking(node):
    """Two lines emitted 0.4s apart arrive as two separately-timed chunks."""
    provider, node_id = node
    script = (
        "import time\n"
        "print('first')\n"
        "time.sleep(0.4)\n"
        "print('second')\n"
    )
    cmd = await provider.run_command(node_id, _py(script), background=True)

    stamped = await _collect_with_times(cmd.stdout_stream())
    await cmd.wait()

    lines = [ln.strip() for _, ln in stamped]
    assert lines == ["first", "second"]
    gap = stamped[1][0] - stamped[0][0]
    assert gap >= 0.3, f"second chunk arrived too soon (gap={gap:.3f}s) — output was batched"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_concurrent_stdout_stderr_streaming(node):
    """stdout and stderr stream simultaneously and interleave without deadlock.

    The child alternates a stdout and a stderr write on each iteration. Both
    streams are drained concurrently via ``asyncio.gather``; all lines on each
    channel must be received.
    """
    provider, node_id = node
    script = (
        "import sys,time\n"
        "for i in range(5):\n"
        "    print(f'out{i}', file=sys.stdout, flush=True)\n"
        "    print(f'err{i}', file=sys.stderr, flush=True)\n"
        "    time.sleep(0.05)\n"
    )
    cmd = await provider.run_command(node_id, _py(script), background=True)

    out_stamped, err_stamped = await asyncio.gather(
        _collect_with_times(cmd.stdout_stream()),
        _collect_with_times(cmd.stderr_stream()),
    )
    await cmd.wait()

    out_lines = [ln.strip() for _, ln in out_stamped]
    err_lines = [ln.strip() for _, ln in err_stamped]
    assert out_lines == [f"out{i}" for i in range(5)]
    assert err_lines == [f"err{i}" for i in range(5)]
    assert cmd.exit_code == 0

    # Interleave check: an err line landed before the last out line (and vice
    # versa) — i.e. the two channels were not drained one-after-the-other.
    first_err = err_stamped[0][0]
    last_out = out_stamped[-1][0]
    assert first_err < last_out, "stderr did not interleave with stdout"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_large_output_streaming(node):
    """1000 lines (~100 bytes each) drain without deadlocking on pipe buffers.

    ~100KB of output exceeds a typical 64KB OS pipe buffer; if the reader ever
    blocked while the writer filled the pipe the child would wedge. Draining the
    stream must yield every line.
    """
    provider, node_id = node
    script = (
        "for i in range(1000):\n"
        "    print(f'{i:05d}-' + 'x'*90)\n"
    )
    cmd = await provider.run_command(node_id, _py(script), background=True)

    received = [ln async for ln in cmd.stdout_stream()]
    await cmd.wait()

    assert len(received) == 1000
    assert received[0].startswith("00000-")
    assert received[-1].startswith("00999-")
    assert cmd.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_foreground_command_blocking(node):
    """Foreground (`background=False`) buffers the full result and completes.

    `run_command` returns only once the process has finished; the whole output
    is available on ``all_stdout`` and the exit code is set — no streaming
    generator needed.
    """
    provider, node_id = node
    script = (
        "for i in range(3):\n"
        "    print(f'fg{i}')\n"
    )
    cmd = await provider.run_command(node_id, _py(script), background=False)

    assert cmd.exit_code == 0
    out = cmd.all_stdout
    assert "fg0" in out and "fg1" in out and "fg2" in out
