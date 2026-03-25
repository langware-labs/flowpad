"""ClaudeCommandFsRecord — represents a custom slash command.

Source: ~/.claude/commands/<name>.md (user-level) or .claude/commands/<name>.md (project-level)
Each file is a markdown prompt template invoked via /<name>.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeCommandFsRecord(Record):
    """A custom Claude Code slash command.

    Mapped from ``commands/<name>.md``.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.COMMAND
        kwargs.setdefault("command_name", "")
        kwargs.setdefault("content", "")
        kwargs.setdefault("scope", "user")
        super().__init__(**kwargs)
        if self.command_name:
            scope_val = self.scope.value if hasattr(self.scope, "value") else self.scope
            self.id = f"{scope_val}:{self.command_name}"
            if not self.name:
                self.name = self.command_name
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
