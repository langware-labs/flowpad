"""The control shell: where the hub's commands run on a Windows machine.

The hub drives a connected machine with one shell command per control operation
(arm the cookie gate, probe the app, restart it), spoken in the machine's own
shell. On Windows that is Windows PowerShell, and STARTING it is slow: measured on
a Windows 11 VM with Defender real-time protection on, 12 s from an interactive
prompt and 30–50 s from the worker (against 0.4 s for ``cmd.exe``). Antivirus and
EDR scan every PowerShell launch, so a slow start is the normal case on a real
machine — and the hub's health probe gives a command 15 s, while Open polls it
every few seconds. A PowerShell per command can never keep up: on the VM one
started every ~50 s while probes arrived every few.

So the worker keeps a few PowerShell HOSTS running for its whole life — the
machine's control shells — and each runs the hub's commands one after another.
A command is sent as one line (its script, base64); the host runs it and answers
with framed lines: ``O <b64>`` for a line of stdout, ``E <b64>`` for stderr, then
``X <exit code>``. Starting a host is paid once, never on a request.

Every script touches .NET and the engine only where it can — not a cmdlet from a
module (``New-Object``, ``Set-Location``): a module's first use autoloads it, which
cost 1.2 s per command on the VM. Progress is off, since a piped PowerShell
serializes every progress record to stderr as CLIXML.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import subprocess
from dataclasses import dataclass
from typing import AsyncIterator, Mapping

logger = logging.getLogger(__name__)

#: Control shells kept running. Open sends three probes at once.
HOSTS = 3
#: Ceiling when every host is busy (a long command holds its host until it ends).
MAX_HOSTS = 6
_LIMIT = 10 * 1024 * 1024

READY = b"R"

# The host loop. Exit code like `sh -c`: the last native command's; else 1 when the
# script threw, or wrote an error that did not come from a native program's stderr.
_HOST = r"""$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$__utf8 = [Text.UTF8Encoding]::new($false)
$__in = [IO.StreamReader]::new([Console]::OpenStandardInput(), $__utf8)
$__out = [Console]::Out
function __frame([string]$kind, [string]$text) {
  $__out.WriteLine($kind + ' ' + [Convert]::ToBase64String($__utf8.GetBytes($text))); $__out.Flush()
}
$__out.WriteLine('R'); $__out.Flush()
while ($null -ne ($__line = $__in.ReadLine())) {
  $__script = $__utf8.GetString([Convert]::FromBase64String($__line))
  $global:LASTEXITCODE = 0
  $__failed = $false
  try {
    & ([scriptblock]::Create($__script)) 2>&1 | ForEach-Object {
      if ($_ -is [Management.Automation.ErrorRecord]) {
        if ($_.FullyQualifiedErrorId -notlike 'NativeCommandError*') { $__failed = $true }
        __frame 'E' $_.ToString()
      } elseif ($_ -is [string]) {
        __frame 'O' $_
      } else {
        __frame 'O' (($_ | Out-String).TrimEnd())
      }
    }
  } catch {
    $__failed = $true
    __frame 'E' $_.ToString()
  }
  $__code = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($__failed) { 1 } else { 0 }
  $__out.WriteLine('X ' + $__code); $__out.Flush()
}
"""

_SCRIPT = """$null = $ExecutionContext.SessionState.Path.SetLocation([WildcardPattern]::Escape({cwd}))
{env}{cmd}
"""


def _ps_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def command_script(cmd: str, cwd: str, env: Mapping[str, str] | None = None) -> str:
    """The script a control shell runs for one hub command.

    Env is set for the command and restored after it: a host runs many commands,
    and one command's variables must not leak into the next.
    """
    env = dict(env or {})
    if not env:
        return _SCRIPT.format(cwd=_ps_literal(cwd), env="", cmd=cmd)
    saved = "".join(
        f"$__saved[{_ps_literal(n)}] = [Environment]::GetEnvironmentVariable({_ps_literal(n)})\n"
        f"[Environment]::SetEnvironmentVariable({_ps_literal(n)}, {_ps_literal(str(v))})\n"
        for n, v in env.items()
    )
    body = _SCRIPT.format(cwd=_ps_literal(cwd), env="$__saved = @{}\n" + saved, cmd=cmd)
    return (
        "try {\n" + body + "} finally {\n  foreach ($__k in $__saved.Keys) "
        "{ [Environment]::SetEnvironmentVariable($__k, $__saved[$__k]) }\n}\n"
    )


@dataclass(frozen=True)
class Output:
    stdout: str | None = None
    stderr: str | None = None
    exit_code: int | None = None


class ControlShell:
    """One running PowerShell host; runs one command at a time."""

    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process

    @property
    def alive(self) -> bool:
        return self.process.returncode is None

    async def run(self, script: str) -> AsyncIterator[Output]:
        """Run ``script``; yield its output as it comes, ending with its exit code."""
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(base64.b64encode(script.encode("utf-8")) + b"\n")
        await self.process.stdin.drain()
        while True:
            line = await self.process.stdout.readline()
            if not line:
                raise ConnectionError("the control shell exited")
            kind, _, payload = line.rstrip(b"\r\n").partition(b" ")
            if kind == b"X":
                yield Output(exit_code=int(payload or b"0"))
                return
            text = base64.b64decode(payload).decode("utf-8", errors="replace") + "\n"
            yield Output(stdout=text) if kind == b"O" else Output(stderr=text)

    def kill(self) -> None:
        """End the host AND what it is running (a native child outlives a killed parent)."""
        if not self.alive:
            return
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(self.process.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            self.process.kill()


class ControlShells:
    """The machine's control shells: started once, warmed one at a time, reused."""

    def __init__(
        self,
        executable: str,
        *,
        env: Mapping[str, str],
        cwd: str,
        hosts: int = HOSTS,
        max_hosts: int = MAX_HOSTS,
        lazy: bool = False,
    ) -> None:
        self.executable = executable
        #: How many hosts to keep warm, and how many at most.
        self.hosts = hosts
        self.max_hosts = max_hosts
        #: Start a host only when one is asked for -- never a replacement for one discarded or dead.
        self.lazy = lazy
        self.env = dict(env)
        self.cwd = cwd
        self._idle: asyncio.Queue[ControlShell] = asyncio.Queue()
        self._count = 0
        self._wanted = asyncio.Event()
        self._warmer: asyncio.Task | None = None
        # Every PowerShell this pool started and that may still run — idle, busy or
        # still starting. `close` ends them all: one left starting when the worker
        # stopped outlived it (seen on Windows: an orphan at 95 s of CPU, parent gone).
        self._processes: set[asyncio.subprocess.Process] = set()

    async def _start_one(self) -> ControlShell | None:
        encoded = base64.b64encode(_HOST.encode("utf-16-le")).decode("ascii")
        process = await asyncio.create_subprocess_exec(
            self.executable,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=self.cwd,
            env=self.env,
            limit=_LIMIT,
        )
        self._processes.add(process)
        assert process.stdout is not None
        line = await process.stdout.readline()
        if line.strip() != READY:
            logger.warning("[connect] a control shell did not start: %r", line[:200])
            if process.returncode is None:
                process.kill()
            self._processes.discard(process)
            return None
        return ControlShell(process)

    async def _keep_warm(self) -> None:
        # One at a time: starts are CPU-bound, and started together they share it
        # (on the VM four cold starts burned 100 s of CPU each, none done in 2 min).
        while True:
            await self._wanted.wait()
            self._wanted.clear()
            while self._count < self.hosts or (self._idle.empty() and self._count < self.max_hosts):
                shell = await self._start_one()
                if shell is None:
                    break  # the next command asks again; no hot loop on a broken PowerShell
                self._count += 1
                self._idle.put_nowait(shell)

    def start(self) -> None:
        """Begin starting the control shells — call once the worker's loop is running."""
        if self._warmer is None:
            self._warmer = asyncio.create_task(self._keep_warm())
        self._wanted.set()

    async def acquire(self) -> ControlShell:
        self.start()
        while True:
            shell = await self._idle.get()
            if shell.alive:
                return shell
            self._count -= 1
            self._wanted.set()

    def release(self, shell: ControlShell) -> None:
        if shell.alive:
            self._idle.put_nowait(shell)
        else:
            self._count -= 1
            self._want_replacement()

    def _want_replacement(self) -> None:
        if not self.lazy:
            self._wanted.set()

    def discard(self, shell: ControlShell) -> None:
        """A shell whose command was cancelled or broke: end it, start a fresh one."""
        shell.kill()
        self._processes.discard(shell.process)
        self._count -= 1
        self._want_replacement()

    async def close(self) -> None:
        """End every control shell this pool started — idle, busy, or still starting."""
        if self._warmer is not None:
            self._warmer.cancel()
        # Off the loop: each kill is a blocking ``taskkill`` (a new process -- slow on a scanned box).
        await asyncio.gather(*(asyncio.to_thread(ControlShell(p).kill) for p in list(self._processes)))
        for process in list(self._processes):
            await process.wait()
        self._processes.clear()
