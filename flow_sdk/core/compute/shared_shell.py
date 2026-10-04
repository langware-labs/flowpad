"""One shell for a whole wizard / compute-op run — ``run_shell``'s contract, one start.

``run_shell`` starts a fresh shell per command. On macOS and Linux that costs milliseconds; on
Windows it is a new ``powershell.exe`` each time, which on a slow box costs many times the check
it runs. ``SharedShell`` starts one PowerShell host for the run (``ControlShells``) and runs every
command in it; elsewhere it IS ``run_shell``.

A host runs many commands, so each must leave it as it found it:

* ``exit N`` — run as a scriptblock inside the host loop, ``exit`` ends the HOST. Run as a script
  FILE (``& <file>.ps1``) it ends only that script and sets ``$LASTEXITCODE = N``, so each command
  is written to a temp ``.ps1`` and invoked.
* ``$env:…`` — env vars belong to the process and outlive the command (a check's
  ``$env:Path += …`` would grow PATH on every call), so every variable the command changed — the
  caller's ``extra_env`` included — is put back after it.

A call that asks for a process of its own (``fresh=True``: an installer) goes to ``run_shell``:
a host's stdin is its protocol pipe, and an installer that asks a question must fail on a closed
stdin, never read the next command.

The stack: the run's shell is opened where a wizard or op is run with none (``shell_for``), and
every nested wizard and op reuses it unless it declares ``isolated_shell``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

from flow_sdk.core.compute.exec import command_env, run_shell
from flow_sdk.schema.data_spec.returned_value_spec import CliResult

logger = logging.getLogger(__name__)


def _script(script_file: Path, cwd: str, extra_env: dict) -> str:
    """Run *script_file* in *cwd* with *extra_env*, so neither its ``exit`` nor any env change outlives it."""
    from flow_sdk.compute.user_machine.control_shell import _ps_literal  # noqa: PLC0415

    sets = "".join(
        f"[Environment]::SetEnvironmentVariable({_ps_literal(k)}, {_ps_literal(str(v))})\n"
        for k, v in extra_env.items()
    )
    path = _ps_literal(str(script_file))
    return (
        "$__env = [Environment]::GetEnvironmentVariables()\n"
        f"try {{\n{sets}"
        f"$null = $ExecutionContext.SessionState.Path.SetLocation([WildcardPattern]::Escape({_ps_literal(cwd)}))\n"
        f"& {path}\n"
        "} finally {\n"
        "  $__now = [Environment]::GetEnvironmentVariables()\n"
        "  foreach ($__k in @($__now.Keys)) { if (-not $__env.Contains($__k)) "
        "{ [Environment]::SetEnvironmentVariable($__k, $null) } }\n"
        "  foreach ($__k in $__env.Keys) { if ($__now[$__k] -cne $__env[$__k]) "
        "{ [Environment]::SetEnvironmentVariable($__k, $__env[$__k]) } }\n"
        "}\n"
    )


class SharedShell(contextlib.AbstractAsyncContextManager):
    """A ``Shell`` (``run_shell``'s signature) that runs every command in one shell.

    The host is started on the first Windows command and ended on ``close``; a run that never
    reaches one costs nothing. A command that times out, is stopped or cancelled takes its host
    with it (and the host's child tree); the next command starts a fresh one.
    """

    def __init__(self) -> None:
        self._pool = None

    async def __aexit__(self, *_exc) -> None:
        await self.close()

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    def _hosts(self):
        if self._pool is None:
            from flow_sdk.compute.user_machine.control_shell import ControlShells  # noqa: PLC0415

            # One host, started only when asked for: a run asks one question at a time, and a
            # second host (or a replacement nobody asked for) would only race it for the CPU.
            self._pool = ControlShells(
                "powershell", env=command_env(), cwd=str(Path.cwd()), hosts=1, max_hosts=1, lazy=True
            )
        return self._pool

    async def __call__(
        self,
        command: str,
        *,
        timeout_seconds: float,
        workdir: Path,
        extra_env: Optional[dict] = None,
        platform: str = "",
        stop: Optional[asyncio.Event] = None,
        on_output: Optional[Callable[[], None]] = None,
        fresh: bool = False,
    ) -> CliResult:
        if fresh or (platform or sys.platform) != "win32":
            return await run_shell(
                command,
                timeout_seconds=timeout_seconds,
                workdir=workdir,
                extra_env=extra_env,
                platform=platform,
                stop=stop,
                on_output=on_output,
            )
        pool = self._hosts()
        fd, name = tempfile.mkstemp(prefix="flowpad-", suffix=".ps1")
        script_file = Path(name)
        stdout: list[str] = []
        stderr: list[str] = []
        code: Optional[int] = None
        host = running = stopper = None
        t0 = time.monotonic()
        try:
            # utf-8-sig: Windows PowerShell 5.1 reads a BOM-less script as the ANSI code page.
            with os.fdopen(fd, "w", encoding="utf-8-sig") as f:
                f.write(command)
            host = await pool.acquire()
            script = _script(script_file, str(workdir), extra_env or {})

            async def drain() -> None:
                nonlocal code
                async for frame in host.run(script):
                    if frame.exit_code is not None:
                        code = frame.exit_code
                        continue
                    if frame.stdout is not None:
                        stdout.append(frame.stdout)
                    else:
                        stderr.append(frame.stderr or "")
                    if on_output is not None:
                        try:
                            on_output()
                        except Exception:  # noqa: BLE001 -- an observer must not fail the command
                            logger.debug("shared shell: on_output raised", exc_info=True)

            running = asyncio.ensure_future(drain())
            stopper = asyncio.ensure_future(stop.wait()) if stop is not None else None
            waits = {running} if stopper is None else {running, stopper}
            await asyncio.wait(waits, timeout=timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
        finally:
            if stopper is not None:
                stopper.cancel()
            finished = running is not None and running.done() and not running.cancelled() and not running.exception()
            if host is not None and finished:
                pool.release(host)
            elif host is not None:
                # Timed out, stopped, cancelled, or the host died mid-command: end the host and its
                # child tree so nothing keeps running unseen.
                if running is not None:
                    running.cancel()
                pool.discard(host)
                if running is not None:
                    await asyncio.gather(running, return_exceptions=True)
            script_file.unlink(missing_ok=True)

        died = not finished and running is not None and running.done() and not running.cancelled()
        if died:
            stderr.append(f"shared shell: the host ended mid-command ({running.exception()!r})\n")
        stopped = not finished and stop is not None and stop.is_set()
        return CliResult.of_process(
            command,
            code if finished else None,
            "".join(stdout),
            "".join(stderr),
            timed_out=not finished and not stopped and not died,
            duration_s=time.monotonic() - t0,
            detail="The run was stopped." if stopped else "",
        )


@contextlib.asynccontextmanager
async def shell_for(isolated: bool, shell) -> AsyncIterator:
    """The shell a wizard / op runs its subtree in — the base of the shell stack.

    The one it was handed (the run's), unless it was handed none (it IS the run) or asked for its
    own (``isolated_shell``): then a ``SharedShell`` opened here and closed when the subtree ends."""
    if shell is not None and not isolated:
        yield shell
        return
    async with SharedShell() as own:
        yield own
