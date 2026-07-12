"""Walker + extractor + id mint for USAGE_REPORT records.

Usage reports live at ``<scope>/.claude/usage_reports/<name>/report.json`` — one
folder per generated report. ``report.json`` carries the full payload (``data``
aggregates + per-session drill-down + rendered ``markdown``); the extractor reads
only the small headline fields into the record (the payload is deliberately
excluded from FTS). Shares the walk/load/mint plumbing with
``asset_cleanup_report`` via ``_report_common``.
"""
from __future__ import annotations

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._report_common import (
    adopt_doc_id,
    load_report,
    report_gen_id,
    report_id_from_path,
    walk_report_dirs,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def usage_report_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    return walk_report_dirs(nodes, "usage_reports", RecordType.USAGE_REPORT)


# Mint+write a stable id into report.json (idempotent).
usage_report_gen_id = report_gen_id


def extract_usage_report(ref: FSRef) -> list[FSRecord]:
    """Parse a report.json into a Record — headline fields only."""
    path = ref._path
    doc = load_report(path)
    payload = doc.get("data") if isinstance(doc.get("data"), dict) else {}
    name = str(doc.get("name") or path.parent.name)
    rec_id = adopt_doc_id(doc) or report_id_from_path(path)

    rec = FSRecord(
        type=RecordType.USAGE_REPORT,
        id=rec_id,
        name=name,
        period_start=payload.get("period_start"),
        period_end=payload.get("period_end"),
        period_kind=str(payload.get("period_kind") or "day"),
        generated_at=payload.get("generated_at"),
        total_cost_usd=float(payload.get("total_cost_usd") or 0.0),
        session_count=int(payload.get("session_count") or 0),
        total_duration_ms=int(payload.get("total_duration_ms") or 0),
        total_tokens=int(payload.get("total_tokens") or 0),
        prompt_count=int(payload.get("prompt_count") or 0),
        skill_invocations=int(payload.get("skill_invocations") or 0),
        agent_spawns=int(payload.get("agent_spawns") or 0),
        cache_hit_rate=float(payload.get("cache_hit_rate") or 0.0),
        content=name,
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
