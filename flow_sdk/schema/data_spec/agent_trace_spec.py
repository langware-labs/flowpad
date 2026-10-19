"""Filesystem contracts independent of application entities."""
from typing import ClassVar, Optional

from flow_sdk.schema.data_spec import SectionedHeader
from flow_sdk.schema.data_spec.io.native import FreeForm


class AgentTraceSpec(SectionedHeader):
    """``trace.json`` — a FLAT document: the payload IS the file, and the
    summary fields the row needs live under its ``summary`` key. ``name`` comes
    from the folder when the file carries none."""

    main_file: ClassVar[str | None] = "trace.json"
    manifest_layout: ClassVar[str | None] = "flat"

    _section: ClassVar[str | None] = "summary"
    _section_fields: ClassVar[frozenset[str]] = frozenset(
        {"verdict", "verdict_reason", "duration_ms", "cost_usd", "issue_count", "divergence_count", "lane_count"}
    )

    name: Optional[str] = None
    session_id: Optional[str] = None
    worker_type: Optional[str] = None
    analyzed_process_id: Optional[str] = None
    verdict: Optional[str] = None
    verdict_reason: Optional[str] = None
    duration_ms: Optional[int] = None
    cost_usd: Optional[float] = None
    issue_count: Optional[int] = None
    divergence_count: Optional[int] = None
    lane_count: Optional[int] = None
    trace: Optional[FreeForm] = None
