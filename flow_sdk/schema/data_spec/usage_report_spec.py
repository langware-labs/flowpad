"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec import FreeSection, SectionedHeader


class UsageReportSpec(SectionedHeader):
    """``report.json`` — a FLAT document ``{name, data: {…metrics}, markdown}``:
    the headline metrics live under ``data``; the payload IS the file."""

    _section: ClassVar[str | None] = "data"
    _section_fields: ClassVar[frozenset[str]] = frozenset({
        "period_start", "period_end", "period_kind", "generated_at", "total_cost_usd", "session_count",
        "total_duration_ms", "total_tokens", "prompt_count", "skill_invocations", "agent_spawns", "cache_hit_rate",
    })

    name: Optional[str] = None
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    period_kind: Optional[str] = None
    generated_at: Optional[str] = None
    total_cost_usd: Optional[float] = None
    session_count: Optional[int] = None
    total_duration_ms: Optional[int] = None
    total_tokens: Optional[int] = None
    prompt_count: Optional[int] = None
    skill_invocations: Optional[int] = None
    agent_spawns: Optional[int] = None
    cache_hit_rate: Optional[float] = None
    report: Optional[FreeSection] = None
