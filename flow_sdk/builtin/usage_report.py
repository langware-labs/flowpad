"""UsageReport entity — a deterministic agentic-usage summary over a date range.

Produced by the daily ``builtin_daily_usage_analysis`` trigger (and reusable for
weekly/monthly). The entity row carries only the small headline fields the Home
Feed card needs to render instantly; the full payload — token split, breakdowns,
sample prompts, and the per-session drill-down spine + the rendered markdown —
lives in the entity's ``asset_ref`` file (``.claude/usage_reports/<name>/report.json``)
and the viewer streams it via FSRef.

``report`` is a create-time ferry (db-excluded): it carries the JSON payload
through the create POST into ``default_body_fn`` (which materializes report.json)
and is never persisted or returned on GET.
"""
from __future__ import annotations

import json
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class UsageReport(Entity):
    type: str = APIField(default=EntityType.USAGE_REPORT.value)
    name: str = APIField("")
    period_start: Optional[str] = APIField(None, description="ISO start of the analyzed range (inclusive)")
    period_end: Optional[str] = APIField(None, description="ISO end of the analyzed range (exclusive)")
    period_kind: str = APIField("day", description="day | week | month | range")
    generated_at: Optional[str] = APIField(None)

    # Headline (drives the feed card; full detail is in report.json)
    total_cost_usd: float = APIField(0.0)
    session_count: int = APIField(0)
    total_duration_ms: int = APIField(0)
    total_tokens: int = APIField(0)
    prompt_count: int = APIField(0)
    skill_invocations: int = APIField(0)
    agent_spawns: int = APIField(0)
    cache_hit_rate: float = APIField(0.0)

    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    # Create-time ferry only: JSON text consumed by default_body_fn (which
    # materializes report.json at asset_ref). Never persisted to DB/blob.
    report: Optional[str] = NoDBAPIField(default=None)

    @classmethod
    def from_data(cls, data, *, name: str | None = None, markdown: str | None = None) -> "UsageReport":
        """Build the entity from a UsageReportData (single mapping authority).

        ``data`` is a ``flow_sdk.usage_report.UsageReportData`` (or its ``.to_dict()``).
        ``markdown`` is the rendered report body; both are ferried into report.json.
        """
        d = data.to_dict() if hasattr(data, "to_dict") else dict(data)
        start = (d.get("period_start") or "")[:10]
        kind = d.get("period_kind") or "day"
        report_name = name or (f"usage-{kind}-{start}" if start else "usage-report")
        payload = {"data": d, "markdown": markdown or ""}
        return cls(
            name=report_name,
            period_start=d.get("period_start"),
            period_end=d.get("period_end"),
            period_kind=kind,
            generated_at=d.get("generated_at"),
            total_cost_usd=float(d.get("total_cost_usd") or 0.0),
            session_count=int(d.get("session_count") or 0),
            total_duration_ms=int(d.get("total_duration_ms") or 0),
            total_tokens=int(d.get("total_tokens") or 0),
            prompt_count=int(d.get("prompt_count") or 0),
            skill_invocations=int(d.get("skill_invocations") or 0),
            agent_spawns=int(d.get("agent_spawns") or 0),
            cache_hit_rate=float(d.get("cache_hit_rate") or 0.0),
            report=json.dumps(payload),
        )
