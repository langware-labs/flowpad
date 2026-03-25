"""ClaudeHookFsRecord — represents a Claude Code event hook configuration.

Source: ~/.claude/settings.json (user-level) and .claude/settings.json (project-level)
Hooks are organized by event type, each with a matcher and a list of commands.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeHookEntryFsRecord(Record):
    """A single hook command entry within a hook event group.

    Each entry has a type (e.g. "command") and a command string.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.HOOK_ENTRY
        kwargs.setdefault("hook_type", "command")
        kwargs.setdefault("command", "")
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))


class ClaudeHookFsRecord(Record):
    """A Claude Code event hook group.

    Mapped from ``settings.json`` ``hooks.<event>[]`` entries.
    Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
    PostToolUse, Notification, Stop, SubagentStop, PreCompact,
    PermissionRequest.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.HOOK
        kwargs.setdefault("event", "")
        kwargs.setdefault("matcher", "*")
        kwargs.setdefault("hooks", [])
        kwargs.setdefault("scope", "user")
        super().__init__(**kwargs)
        if self.event:
            scope_val = self.scope.value if hasattr(self.scope, "value") else self.scope
            self.id = f"{scope_val}:{self.event}"
            if not self.name:
                self.name = self.event
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
