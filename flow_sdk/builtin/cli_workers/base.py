"""WorkerCLICommand — cross-platform base for building shell command strings.

Subclasses implement _build_worker_args() to produce the executable + its flags.
The base handles workdir (cd prefix), env vars prefix, and instruction injection,
all in both POSIX and Win32 flavours.
"""

from __future__ import annotations

import shlex
import sys
from typing import Any


class WorkerCLICommand:
    """Base class for worker CLI commands.

    Converts a structured configuration into a shell command string suitable
    for PTY injection. Subclasses override _build_worker_args() to provide
    the actual executable and its flags.

    Usage::

        cmd = ClaudeCLICommand(session_id="abc", resume=True, workdir="/proj")
        cmd.add_env("FLOWPAD_EXECUTION_SCOPE", json.dumps([...]))
        shell_str = cmd.to_shell_string(instruction="fix the bug")
    """

    def __init__(
        self,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> None:
        self.workdir: str | None = workdir
        self.env_vars: dict[str, str] = dict(env_vars or {})

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add_env(self, key: str, value: str) -> None:
        """Add (or overwrite) an environment variable for the command."""
        self.env_vars[key] = value

    def to_shell_string(self, instruction: str | None = None) -> str:
        """Build the full shell command string, cross-platform.

        POSIX:  cd <workdir> && KEY=val ... <worker_args> [instruction]
        Win32:  cd <workdir>; $env:KEY = 'val'; ... <worker_args> [instruction]
        """
        args = self._build_worker_args()
        if sys.platform == "win32":
            return self._build_win32(args, instruction)
        return self._build_posix(args, instruction)

    def to_json(self) -> dict[str, Any]:
        """Serialise to a plain dict (suitable for storage in cli_config)."""
        return {
            "workdir": self.workdir,
            "env_vars": self.env_vars,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "WorkerCLICommand":
        """Deserialise from a plain dict."""
        return cls(
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, WorkerCLICommand):
            return NotImplemented
        return self.to_json() == other.to_json()

    # ------------------------------------------------------------------
    # Subclass contract
    # ------------------------------------------------------------------

    def _build_worker_args(self) -> list[str]:
        """Return the executable + flags as a list of strings.

        Subclasses must override this. Do NOT include workdir or env vars —
        those are handled by to_shell_string().
        """
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Internal builders
    # ------------------------------------------------------------------

    def _build_posix(self, args: list[str], instruction: str | None) -> str:
        workdir = self.workdir or "."
        cd_part = f"cd {shlex.quote(workdir)}"

        env_part = " ".join(
            f"{k}={shlex.quote(v)}" for k, v in self.env_vars.items()
        )

        cmd = f"{cd_part} && {env_part} {' '.join(args)}" if env_part else f"{cd_part} && {' '.join(args)}"

        if instruction:
            if "\n" in instruction:
                # Multi-line: heredoc avoids continuation prompts in PTY
                cmd += f" \"$(cat <<'EOF'\n{instruction}\nEOF\n)\""
            else:
                cmd += f" {shlex.quote(instruction)}"

        return cmd

    def _build_win32(self, args: list[str], instruction: str | None) -> str:
        import base64 as _b64

        def _ps_quote(s: str) -> str:
            return "'" + s.replace("'", "''") + "'"

        workdir = self.workdir or "."
        cd_part = f"cd {_ps_quote(workdir)}"

        env_commands = [f"$env:{k} = {_ps_quote(v)}" for k, v in self.env_vars.items()]
        env_part = "; ".join(env_commands) + "; " if env_commands else ""

        cmd_part = " ".join(args)

        if instruction:
            prompt_b64 = _b64.b64encode(instruction.encode("utf-8")).decode("ascii")
            decode_cmd = (
                f"[System.Text.Encoding]::UTF8.GetString"
                f"([Convert]::FromBase64String('{prompt_b64}'))"
            )
            cmd_part += f" ({decode_cmd})"

        return f"{cd_part}; {env_part}{cmd_part}"
