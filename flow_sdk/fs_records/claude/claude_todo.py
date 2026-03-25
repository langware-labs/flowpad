"""ClaudeTodoFsRecord — represents a Claude Code todo list from a session.

Source: ~/.claude/todos/<session-id>-agent-<session-id>.json
Each file is a JSON array of todo items with content, status, priority, and id.
"""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeTodoItemFsRecord(Record):
    """A single todo item within a Claude Code session todo list.

    Mapped from entries in ``~/.claude/todos/<session-id>-agent-<session-id>.json``.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TODO_ITEM
        kwargs.setdefault("content", "")
        kwargs.setdefault("status", "")
        kwargs.setdefault("priority", "")
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))


class ClaudeTodoFsRecord(Record):
    """A Claude Code session todo list.

    Mapped from ``~/.claude/todos/<session-id>-agent-<session-id>.json``.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.TODO_FILE
        kwargs.setdefault("session_id", "")
        kwargs.setdefault("items", [])
        kwargs.setdefault("total_count", 0)
        kwargs.setdefault("completed_count", 0)
        super().__init__(**kwargs)
        if self.session_id:
            self.id = self.session_id
            if not self.name:
                self.name = self.session_id
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
