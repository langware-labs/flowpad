"""ClaudeAccountFsRecord — represents the Claude Code account / login state.

Source: ~/.claude.json
Contains startup stats, install method, feature gates, tips history,
and API key approval state.

.. deprecated::
    Use ``ClaudeSettingsRecordList`` and its typed sub-records instead.
    This flat record captures only a handful of top-level fields.
    See ``claude_settings/`` for the full decomposition.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeAccountFsRecord(Record):
    """Claude Code account and login state.

    Mapped from ``~/.claude.json``.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.ACCOUNT
        if "id" not in kwargs:
            kwargs["id"] = "default"
        kwargs.setdefault("num_startups", 0)
        kwargs.setdefault("install_method", "")
        kwargs.setdefault("auto_updates", False)
        kwargs.setdefault("has_seen_tasks_hint", False)
        kwargs.setdefault("prompt_queue_use_count", 0)
        kwargs.setdefault("custom_api_key_responses", {})
        kwargs.setdefault("tips_history", {})
        kwargs.setdefault("cached_statsig_gates", {})
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
