"""Run one wizard command and report how it exited.

Stdlib + asyncio only — no Entity import, no registry import. That is what lets
the runner's tests exercise the whole state machine in milliseconds with a stub
in this module's place.

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
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from flow_sdk.utils.process_tree import CAN_KILLPG, kill_process_tree

logger = logging.getLogger(__name__)

#: Same cap as the trigger scripts. A step that prints a megabyte is reporting
#: about its own noise, not its outcome.
OUTPUT_CAP = 8192

#: What a RECORDED probe keeps of each stream, per phase. Smaller than
#: `OUTPUT_CAP` on purpose: capturing 8 KB is right for deciding an outcome, but
#: a step records up to three phases × two streams, and `run.json` is rewritten
#: whole under a lock on every result.
PROBE_OUTPUT_CAP = 2000


def capped(text: str, limit: int = PROBE_OUTPUT_CAP) -> "tuple[str, bool]":
    """`(text, truncated)`, keeping the END.

    The end is where the error is: a compiler's last line, a traceback's final
    frame, the shell's complaint. Keeping the head would reliably record the
    part nobody needs — which is also why `ShellResult.tail` is one of these.

    A module function rather than a static method: it touches nothing on
    `ShellResult`, and hanging it off the class implied it was part of what a
    shell result IS.
    """
    if len(text) <= limit:
        return text, False
    return text[-limit:], True


@dataclass(frozen=True)
class ShellResult:
    """What one command did. ``returncode is None`` only when it never ran."""

    returncode: Optional[int]
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    duration_s: float = 0.0

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out

    def tail(self, limit: int = 300) -> str:
        """The most useful line to show a human: stderr if there is any, else stdout."""
        return capped((self.stderr or self.stdout or "").strip(), limit)[0]


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
) -> ShellResult:
    """Run one shell one-liner. Never raises — a failure IS the result.

    ``stdin`` is DEVNULL on purpose. An installer that decides to ask a
    question must fail on a closed stdin rather than block a headless run
    forever waiting for an answer nobody is there to give.
    """
    platform = platform or sys.platform
    env = {**os.environ, **(extra_env or {})}
    t0 = time.monotonic()
    try:
        proc = await _spawn(command, cwd=str(workdir), env=env, platform=platform)
    except (OSError, ValueError) as exc:
        # No shell, no powershell, unusable cwd. The step must see a verdict.
        logger.warning("wizard: could not spawn %r: %s", command, exc)
        return ShellResult(returncode=None, stderr=str(exc), duration_s=time.monotonic() - t0)

    timed_out = False
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        kill_process_tree(proc)
        timed_out = True
        try:
            stdout, stderr = await proc.communicate()
        except Exception:  # noqa: BLE001 — the kill already decided the outcome
            stdout, stderr = b"", b""
    return ShellResult(
        returncode=proc.returncode,
        stdout=stdout.decode(errors="replace")[:OUTPUT_CAP] if stdout else "",
        stderr=stderr.decode(errors="replace")[:OUTPUT_CAP] if stderr else "",
        timed_out=timed_out,
        duration_s=time.monotonic() - t0,
    )
