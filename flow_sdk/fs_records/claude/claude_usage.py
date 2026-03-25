"""ClaudeUsageFsRecord — Claude Code API rate-limit usage from Anthropic's oauth/usage endpoint."""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeUsageFsRecord(Record):
    """Claude Code rate-limit and extra-credit usage.

    Populated from ``https://api.anthropic.com/api/oauth/usage``.
    All percentage values are 0-100 integers.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_USAGE

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_USAGE
        if "id" not in kwargs:
            kwargs["id"] = "default"
        kwargs.setdefault("five_hour_pct", 0)
        kwargs.setdefault("five_hour_resets_at", None)
        kwargs.setdefault("seven_day_pct", 0)
        kwargs.setdefault("seven_day_resets_at", None)
        kwargs.setdefault("extra_enabled", False)
        kwargs.setdefault("extra_pct", 0)
        kwargs.setdefault("extra_used_cents", 0)
        kwargs.setdefault("extra_limit_cents", 0)
        kwargs.setdefault("fetched_at", None)
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @classmethod
    def from_api_response(cls, data: dict) -> "ClaudeUsageFsRecord":
        five_hour = data.get("five_hour", {})
        seven_day = data.get("seven_day", {})
        extra = data.get("extra_usage", {})
        from datetime import datetime

        return cls(
            five_hour_pct=round((five_hour.get("utilization") or 0) * 100),
            five_hour_resets_at=five_hour.get("resets_at"),
            seven_day_pct=round((seven_day.get("utilization") or 0) * 100),
            seven_day_resets_at=seven_day.get("resets_at"),
            extra_enabled=extra.get("is_enabled", False),
            extra_pct=round((extra.get("utilization") or 0) * 100),
            extra_used_cents=extra.get("used_credits", 0),
            extra_limit_cents=extra.get("monthly_limit", 0),
            fetched_at=datetime.utcnow().isoformat(),
        )
