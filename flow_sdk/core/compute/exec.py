"""Run one wizard command and report how it exited.

Stdlib, asyncio and ``DataSpec`` — no Entity import, no registry import. That
is what lets the runner's tests exercise the whole state machine in
milliseconds with a stub in this module's place.

The subprocess discipline is ported from ``hook_models._exec_script``, which
learned it the hard way: killing the child alone leaves its forks holding the
stdout pipe open, so the follow-up ``communicate()`` blocks for as long as they
run and ``timeout_seconds`` bounds nothing. Killing the whole process group is
what makes the timeout real.

Shell string, not argv, and deliberately: the per-OS values are one-liners with
pipes and redirects (``command -v git >/dev/null 2>&1``), the same contract as
``CapabilitySpec.install_commands``. ``win32`` is POWERSHELL rather than
cmd.exe, because that is what the built-in terminal spawns there.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.utils.process_tree import CAN_KILLPG, kill_process_tree

logger = logging.getLogger(__name__)

async def _spawn(command: str, *, cwd: str, env: dict, platform: str):
    if platform == "win32":
        return await asyncio.create_subprocess_exec(
            "powershell", "-NoProfile", "-NonInteractive", "-Command", command,
            cwd=cwd, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
    return await asyncio.create_subprocess_shell(
        command,
        cwd=cwd, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        # Own process GROUP so a timeout can kill the whole tree.
        start_new_session=CAN_KILLPG,
    )


async def run_shell(
    command: str,
    *,
    timeout_seconds: float,
    workdir: Path,
    extra_env: Optional[dict] = None,
    platform: str = "",
    stop: Optional[asyncio.Event] = None,
) -> CliResult:
    """Run one shell one-liner. Never raises — a failure IS the result.

    ``stdin`` is DEVNULL on purpose. An installer that decides to ask a
    question must fail on a closed stdin rather than block a headless run
    forever waiting for an answer nobody is there to give.

    Setting *stop* ends the run early, the same way a timeout does: the whole
    process group is killed and what it printed is kept. Cancelling the call
    kills the process group too — a cancelled caller must not leave it running.
    """
    platform = platform or sys.platform
    # Unbuffered Python: stdout is a pipe here, so Python block-buffers it, and
    # the kill on a timeout drops the buffer — a step that printed and then hung
    # would report nothing at all. The caller's env still wins.
    env = {**os.environ, "PYTHONUNBUFFERED": "1", **(extra_env or {})}
    t0 = time.monotonic()
    try:
        proc = await _spawn(command, cwd=str(workdir), env=env, platform=platform)
    except (OSError, ValueError) as exc:
        # No shell, no powershell, unusable cwd. The step must see a verdict.
        logger.warning("wizard: could not spawn %r: %s", command, exc)
        return CliResult.of_process(command, None, stderr=str(exc), duration_s=time.monotonic() - t0)

    timed_out = False
    # Not `wait_for(communicate())`: cancelling communicate on timeout throws
    # away what it had already read, so a command that printed and then hung
    # came back with no output at all — exactly the output that says where it
    # hung. Reading to EOF under a shield keeps it; the kill closes the pipes.
    finished = asyncio.ensure_future(asyncio.gather(proc.stdout.read(), proc.stderr.read(), proc.wait()))
    stopper = asyncio.ensure_future(stop.wait()) if stop is not None else None
    waiters = [finished, stopper] if stopper is not None else [finished]
    try:
        await asyncio.wait(waiters, timeout=timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        # Reap before re-raising, exactly as a timeout does: the kill closes the
        # pipes, and returning earlier leaves the process and its transports open.
        kill_process_tree(proc)
        try:
            await asyncio.shield(finished)
        except BaseException:  # noqa: BLE001 — being cancelled already decided the outcome
            pass
        raise
    finally:
        if stopper is not None:
            stopper.cancel()
    stopped = False
    if not finished.done():
        kill_process_tree(proc)
        stopped = stop is not None and stop.is_set()
        timed_out = not stopped
    try:
        # Already done on the fast path; on the kill path the closed pipes end it.
        stdout, stderr, _ = await finished
    except Exception:  # noqa: BLE001 — the kill already decided the outcome
        stdout, stderr = b"", b""
    # ``of_process`` keeps the END of each stream: that is where the error is.
    return CliResult.of_process(
        command,
        proc.returncode,
        stdout.decode(errors="replace") if stdout else "",
        stderr.decode(errors="replace") if stderr else "",
        timed_out=timed_out,
        duration_s=time.monotonic() - t0,
        detail="The run was stopped." if stopped else "",
    )
