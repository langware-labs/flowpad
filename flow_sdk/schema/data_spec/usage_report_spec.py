"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.schema.data_spec import DataSpec, SectionedHeader
from flow_sdk.schema.data_spec.io.native import FreeForm


class UsageReportSpec(SectionedHeader):
    """``report.json`` — a FLAT document ``{name, data: {…metrics}, markdown}``:
    the headline metrics live under ``data``; the payload IS the file."""

    main_file: ClassVar[str | None] = "report.json"
    manifest_layout: ClassVar[str | None] = "flat"

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
    report: Optional[FreeForm] = None


class UsageSessionSpec(DataSpec):
    """One session's slice of a usage summary; ``session_id`` deep-links its transcript."""

    spec_kind: ClassVar[str] = "usage.summary.session"

    session_id: str
    title: str = ""
    cwd: str = ""
    project: str = ""
    start: Optional[str] = None
    duration_ms: int = 0
    cost_usd: float = 0.0
    total_tokens: int = 0
    prompt_count: int = 0
    skills: list[str] = []
    agents: list[str] = []
    tool_failures: int = 0
    agent_trace_id: Optional[str] = None


class UsageSummarySpec(DataSpec):
    """A usage summary over ``[period_start, period_end)`` -- what ``analyze_usage`` answers, what the
    Daily usage summary posts as ``usage.summary.value.json``, what its viewer shows."""

    spec_kind: ClassVar[str] = "usage.summary"

    period_start: str
    period_end: str
    period_kind: str = "day"
    generated_at: str = ""
    total_cost_usd: float = 0.0
    session_count: int = 0
    #: Active time: parallel sessions count once, idle gaps not at all.
    total_duration_ms: int = 0
    total_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_hit_rate: float = 0.0
    prompt_count: int = 0
    skill_invocations: int = 0
    agent_spawns: int = 0
    top_skills: list[dict] = []
    top_agents: list[dict] = []
    top_tools: list[dict] = []
    models: list[dict] = []
    sample_prompts: list[str] = []
    busiest_session_id: Optional[str] = None
    most_expensive_session_id: Optional[str] = None
    sessions: list[UsageSessionSpec] = []
