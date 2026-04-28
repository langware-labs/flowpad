"""ClaudeHistoryFsRecord — the global prompt history at ~/.claude/history.jsonl."""

from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar
from flow_sdk._compat import Self

from flow_sdk.fs_store import Record, RecordType


def _default_history_path() -> Path:
    """Per-instance ~/.claude/history.jsonl (call-time, via InstanceSettings)."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().claude_history_path


class ClaudeHistoryFsRecord(Record):
    """The global Claude Code prompt history.

    Each child is a ``ClaudeHistoryEntryFsRecord`` — one prompt the user sent.
    """

    _record_type: ClassVar[str] = RecordType.HISTORY

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.HISTORY
        if "history_path" not in kwargs:
            kwargs["history_path"] = str(_default_history_path())
        super().__init__(**kwargs)
        if not self.name:
            self.name = "history"
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @property
    def entries(self) -> list:
        """Return all history entries as ``ClaudeHistoryEntryFsRecord``."""
        from .claude_history_entry import ClaudeHistoryEntryFsRecord

        path = Path(self.history_path)
        if not path.is_file():
            return []
        result = []
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                result.append(ClaudeHistoryEntryFsRecord.from_dict_entry(raw))
        result.sort(key=lambda e: e.timestamp_ms)
        return result

    @classmethod
    def default(cls) -> Self:
        """Return the history record for the default Claude installation."""
        return cls(history_path=str(_default_history_path()))
