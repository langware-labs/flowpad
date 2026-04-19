"""Shared test helpers for PTY long-tests (test_e2b_pty.py, test_docker_pty.py).

Only the `_make_shell` factory stays per-file because it depends on the
provider-specific `compute_node_uname` format (`"sandbox"` vs `"docker-<name>"`).
"""
from __future__ import annotations

import asyncio


async def write_and_collect(
    pty,
    data: bytes,
    needle: bytes,
    timeout: float = 10.0,
) -> bytes:
    """Subscribe to pty.output() FIRST, then write — so we never race past the
    command's output. Consume until `needle` is seen or `timeout` fires.
    """
    buf = bytearray()

    async def _loop():
        async for chunk in pty.output():
            buf.extend(chunk)
            if needle in buf:
                return

    task = asyncio.create_task(_loop())
    await asyncio.sleep(0.05)
    await pty.write(data)
    try:
        await asyncio.wait_for(task, timeout=timeout)
    except asyncio.TimeoutError:
        task.cancel()
    return bytes(buf)


async def close_shell(shell) -> None:
    """Best-effort teardown — stops the PTY and deletes the Shell entity."""
    try:
        await shell.stop()
    except Exception:
        pass
    try:
        await shell.delete()
    except Exception:
        pass
