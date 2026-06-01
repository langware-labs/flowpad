"""Operations module for claude_hook — stub.

Original implementation was the deleted ClaudeHookRecord subclass. Stub kept
so callers importable; real persist/discover restored in Phase 4.
"""
from __future__ import annotations

from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord


_RECORD_TYPE = "claude_hook"


class _ClaudeHookFactory:
    def __call__(self, **kwargs: Any) -> FSRecord:
        kwargs.setdefault("type", _RECORD_TYPE)
        return FSRecord(**kwargs)

    @staticmethod
    def get(uid: str, **_kwargs: Any) -> FSRecord | None:
        try:
            return FSRecord.load(_RECORD_TYPE, uid)
        except FileNotFoundError:
            return None

    @staticmethod
    def discover(**_kwargs: Any) -> list[FSRecord]:
        return []


ClaudeHookRecord = _ClaudeHookFactory()


class ClaudeHookRecordList(list):
    @classmethod
    def discover(cls, **_kwargs: Any) -> 'ClaudeHookRecordList':
        return cls()


def persist_hook_to_settings_json(*args: Any, **kwargs: Any) -> None:
    """Stub. Real impl in Phase 4."""
    pass


def delete_hook_from_settings_json(*args: Any, **kwargs: Any) -> None:
    """Stub. Real impl in Phase 4."""
    pass


def list_claude_hooks(*args: Any, **kwargs: Any) -> list:
    """Stub. Real impl in Phase 4."""
    return []


def _stable_hook_hash(*args: Any, **kwargs: Any) -> str:
    """Stub. Real impl in Phase 4."""
    import uuid
    return str(uuid.uuid4())
