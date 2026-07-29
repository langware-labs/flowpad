"""A stand-in for an E2B ``AsyncSandbox`` that runs commands locally.

The provider reaches the remote API through exactly one seam,
``E2BComputeProvider._get_or_boot_sandbox``. Replacing that seam — and nothing
else — leaves the whole command path under test: the env-prefix construction,
the ``background`` handling, and the ``CLICommand`` plumbing all run for real.

Commands are **executed**, not pattern-matched, so a test can assert what the
child process actually saw rather than what we hoped the prefix said. The exact
command string is also recorded, which is what lets a test pin the quoting.

This is not a mock of the thing under test — it stands in for the network. The
provider's own logic is untouched.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class _FakeResult:
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    error: str | None = None


class _FakeCommands:
    def __init__(self, owner: "FakeSandbox") -> None:
        self._owner = owner

    async def run(
        self,
        command: str,
        on_stdout=None,
        on_stderr=None,
        timeout=None,
        background: bool = False,
        cwd: str | None = None,
        **_: object,
    ):
        self._owner.commands_run.append(command)
        self._owner.backgrounds.append(background)

        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd if cwd and self._owner.honor_cwd else None,
        )
        out, err = await process.communicate()
        stdout = out.decode(errors="replace")
        stderr = err.decode(errors="replace")

        if on_stdout and stdout:
            on_stdout(stdout)
        if on_stderr and stderr:
            on_stderr(stderr)

        return _FakeResult(stdout=stdout, stderr=stderr, exit_code=process.returncode or 0)


@dataclass
class FakeSandbox:
    """Records every command string, and runs it in a local shell."""

    sandbox_id: str = "fake-sandbox"
    #: E2B's default cwd is /home/user, which does not exist on a dev machine.
    honor_cwd: bool = False
    commands_run: list[str] = field(default_factory=list)
    backgrounds: list[bool] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.commands = _FakeCommands(self)

    @property
    def last_command(self) -> str:
        return self.commands_run[-1] if self.commands_run else ""

    async def kill(self) -> None:
        return None
