"""``ShellCommandEntry`` — agent ran a shell command.

Claude ``Bash`` and Codex ``exec_command`` (function_call) produce this.
Result data (exit_code, stdout, duration) is folded in by a second pass
in the parser keyed on ``tool_use_id``.
"""

from __future__ import annotations

from typing import Any

from .._helpers import render_block
from ..entry import EntryKind, TranscriptEntry


class ShellCommandEntry(TranscriptEntry):
    kind = EntryKind.SHELL_COMMAND

    def __init__(
        self,
        *,
        command: str,
        cwd: str | None = None,
        exit_code: int | None = None,
        stdout_preview: str | None = None,
        stderr_preview: str | None = None,
        duration_ms: int | None = None,
        timeout: int | None = None,
        tool_name: str = "",
        tool_use_id: str = "",
        **base: Any,
    ) -> None:
        super().__init__(**base)
        self.command = command
        self.cwd = cwd
        self.exit_code = exit_code
        self.stdout_preview = stdout_preview
        self.stderr_preview = stderr_preview
        self.duration_ms = duration_ms
        self.timeout = timeout
        self.tool_name = tool_name
        self.tool_use_id = tool_use_id

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "command": self.command,
            "cwd": self.cwd,
            "exit_code": self.exit_code,
            "stdout_preview": self.stdout_preview,
            "stderr_preview": self.stderr_preview,
            "duration_ms": self.duration_ms,
            "timeout": self.timeout,
            "tool_name": self.tool_name,
            "tool_use_id": self.tool_use_id,
        }

    def _body_lines(self) -> list[str]:
        out: list[str] = []
        out.extend(render_block("command", self.command))
        if self.cwd:
            out.append(f"cwd: {self.cwd}")
        if self.tool_use_id:
            out.append(f"tool_use_id: {self.tool_use_id}")
        meta_parts: list[str] = []
        if self.exit_code is not None:
            meta_parts.append(f"exit={self.exit_code}")
        if self.duration_ms is not None:
            meta_parts.append(f"duration={self.duration_ms / 1000.0:.1f}s")
        if self.timeout is not None:
            meta_parts.append(f"timeout={self.timeout}")
        if meta_parts:
            out.append(" · ".join(meta_parts))
        if self.stdout_preview:
            out.extend(render_block("stdout", self.stdout_preview))
        if self.stderr_preview:
            out.extend(render_block("stderr", self.stderr_preview))
        return out
