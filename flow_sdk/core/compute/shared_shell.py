"""One shell for a whole wizard / compute-op run — ``run_shell``'s contract, one start.

``run_shell`` starts a fresh shell per command. ``SharedShell`` starts ONE for the run and runs
every command in it: a PowerShell host on Windows (``ControlShells``), where a new
``powershell.exe`` per check costs many times the check it runs, and one ``sh`` on macOS and
Linux (``_PosixHost``), where what one step leaves must be there for the next — an exported
variable, and a sign-in a tool grants to the process session that asked (1Password's CLI: a step
in a session of its own is asked to approve again, every time). That host has its own process
GROUP, so a timeout kills its whole tree, and stays in THIS process's session, so a sign-in a step
obtained is this process's too.

What a command leaves behind differs by host, and this is the one place that says so. The POSIX
``sh`` KEEPS it (exports, functions; the working folder is set per command, and the caller's
``extra_env`` is put back). The PowerShell host puts every environment variable back after each
command, for the reasons below — so a step that relies on a variable an earlier step exported
works on macOS and Linux only.

A PowerShell host runs many commands, so each must leave it as it found it:

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
import re
import shlex
import sys
import tempfile
import time
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

from flow_sdk.core.compute.exec import command_env, last_line, run_shell
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.utils.process_tree import kill_process_tree

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


_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class _PosixHost:
    """One ``sh`` that runs a run's commands one after another, each sourced into it.

    A command is written to a file and sourced with stdin closed (the host's stdin is its protocol
    pipe), in its own working folder, with the caller's ``extra_env`` put back afterwards — a value
    handed to one step is not the next step's. Everything else the command leaves in the shell
    stays. The end of a command is a marker line on both streams, so nothing is polled. A command
    that calls ``exit`` ends the host with that code: it is the command's result, and the next
    command starts a fresh host."""

    def __init__(self) -> None:
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._lock = asyncio.Lock()

    async def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None and proc.returncode is None:
            kill_process_tree(proc)
            await proc.wait()

    async def _host(self) -> asyncio.subprocess.Process:
        if self._proc is None or self._proc.returncode is not None:
            self._proc = await asyncio.create_subprocess_exec(
                "/bin/sh", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=command_env(), limit=2**22,
                # Its own GROUP (a timeout kills the tree), never its own SESSION (see the module docstring).
                process_group=0,
            )
        return self._proc

    @staticmethod
    def _line(script: Path, workdir: Path, extra_env: dict, mark: str) -> str:
        keep = "".join(f"__fp_had_{k}=${{{k}+x}}; __fp_old_{k}=${{{k}-}}; export {k}={shlex.quote(str(v))}; " for k, v in extra_env.items())
        back = "".join(
            f'if [ -n "$__fp_had_{k}" ]; then export {k}="$__fp_old_{k}"; else unset {k}; fi; unset __fp_had_{k} __fp_old_{k}; '
            for k in extra_env
        )
        return (
            f"{keep}cd {shlex.quote(str(workdir))} && . {shlex.quote(str(script))} </dev/null; __fp_rc=$?; {back}"
            f"printf '\\n%s %s\\n' {mark} \"$__fp_rc\"; printf '\\n%s\\n' {mark} >&2\n"
        )

    async def run(self, command: str, *, timeout_seconds: float, workdir: Path, extra_env: dict,
                  stop: Optional[asyncio.Event], on_output: Optional[Callable[[str], None]]) -> CliResult:
        t0 = time.monotonic()
        mark = f"__flowpad_done_{os.urandom(8).hex()}__"
        fd, name = tempfile.mkstemp(prefix="flowpad-", suffix=".sh")
        script = Path(name)

        async def read(stream: asyncio.StreamReader, into: list[str]) -> Optional[int]:
            """Lines up to the marker, answering the code printed after it (stdout's); None at EOF —
            the command ended the host."""
            while raw := await stream.readline():
                line = raw.decode("utf-8", "replace")
                if line.startswith(mark):
                    if into and into[-1] == "\n":  # the newline the marker was printed after
                        into.pop()
                    return int(line[len(mark):].strip() or 0)
                into.append(line)
                if on_output is not None and line.strip():
                    try:
                        on_output(last_line(line))
                    except Exception:  # noqa: BLE001 -- an observer must not fail the command
                        logger.debug("shared shell: on_output raised", exc_info=True)
            return None

        try:
            async with self._lock:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(command + "\n")
                proc = await self._host()
                proc.stdin.write(self._line(script, workdir, extra_env, mark).encode())
                await proc.stdin.drain()
                out: list[str] = []
                err: list[str] = []
                running = asyncio.ensure_future(asyncio.gather(read(proc.stdout, out), read(proc.stderr, err)))
                stopper = asyncio.ensure_future(stop.wait()) if stop is not None else None
                try:
                    await asyncio.wait({running} if stopper is None else {running, stopper}, timeout=timeout_seconds,
                                       return_when=asyncio.FIRST_COMPLETED)
                finally:
                    if stopper is not None:
                        stopper.cancel()
                    cut = not running.done()
                    if cut:
                        # Timed out, stopped or cancelled: the host and its tree go; the kill closes the pipes.
                        await self.close()
                        await asyncio.gather(running, return_exceptions=True)
                code = None if cut else running.result()[0]
                if code is None and not cut:
                    code = await proc.wait()  # no marker: the command called ``exit``, and the host's code is its own
                stopped = cut and stop is not None and stop.is_set()
                return CliResult.of_process(
                    command, code, "".join(out), "".join(err), timed_out=cut and not stopped,
                    duration_s=time.monotonic() - t0, detail="The run was stopped." if stopped else "",
                )
        except (OSError, ValueError) as exc:
            logger.warning("shared shell: could not run %r: %s", command, exc)
            await self.close()
            return CliResult.of_process(command, None, stderr=str(exc), duration_s=time.monotonic() - t0)
        finally:
            script.unlink(missing_ok=True)


class SharedShell(contextlib.AbstractAsyncContextManager):
    """A ``Shell`` (``run_shell``'s signature) that runs every command in one shell.

    The host is started on the first Windows command and ended on ``close``; a run that never
    reaches one costs nothing. A command that times out, is stopped or cancelled takes its host
    with it (and the host's child tree); the next command starts a fresh one.
    """

    def __init__(self) -> None:
        self._pool = None
        self._posix: Optional[_PosixHost] = None

    async def __aexit__(self, *_exc) -> None:
        await self.close()

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
        if self._posix is not None:
            await self._posix.close()
            self._posix = None

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
        on_output: Optional[Callable[[str], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        fresh: bool = False,
    ) -> CliResult:
        posix = (platform or sys.platform) != "win32"
        if posix and not fresh and os.name == "posix" and all(_NAME.match(k) for k in (extra_env or {})):
            if self._posix is None:
                self._posix = _PosixHost()
            return await self._posix.run(command, timeout_seconds=timeout_seconds, workdir=workdir,
                                         extra_env=extra_env or {}, stop=stop, on_output=on_output)
        if fresh or posix:
            # ``on_spawn`` is told the pid of a process of its own. A command run in the shared host has none
            # to report (the host is not the command), and is never an install: installs ask for ``fresh``.
            return await run_shell(
                command,
                timeout_seconds=timeout_seconds,
                workdir=workdir,
                extra_env=extra_env,
                platform=platform,
                stop=stop,
                on_output=on_output,
                on_spawn=on_spawn,
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
                            on_output(last_line(frame.stdout if frame.stdout is not None else frame.stderr or ""))
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
