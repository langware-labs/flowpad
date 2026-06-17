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


def read_pty_stream(shell_id: str) -> str:
    """Cumulative raw PTY terminal output from the on-disk .pty stream file.

    The stream file is written on every output chunk from session start, so it
    is the capture source for tests that used to read the in-memory replay
    buffer (now removed). Since the framed-format migration the .pty file is an
    asciinema-style JSONL envelope (``{"v":1,...}`` header + ``["o", b64, seq]``
    output frames), NOT raw bytes — so reconstruct the terminal byte stream via
    ``PtyStreamFile.read_all()`` (the canonical decoder) instead of returning
    the JSONL envelope verbatim, which would defeat any VT100 rendering.
    """
    from flow_sdk.builtin.shell import get_shell_record, shell_pty_stream_path
    from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile

    record = get_shell_record(shell_id)
    if not record:
        return ""
    pty_pid = record.__dict__.get("pty_pid")
    if not pty_pid:
        return ""
    path = shell_pty_stream_path(record.id, pty_pid)
    if not path.exists():
        return ""
    return PtyStreamFile(path).read_all().decode("utf-8", errors="replace")


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
