"""Walker + extractor + id mint for ASSET_CLEANUP_REPORT records.

Cleanup reports live at ``<scope>/.claude/cleanup_reports/<name>/report.json``
— one folder per generated scan. ``report.json`` carries the full payload
(per-finding verdicts + rendered ``markdown``); the extractor reads only the
small headline counts into the record (the payload is deliberately excluded
from FTS). Shares the walk/load/mint plumbing with ``usage_report`` via
``_report_common``.
"""
from __future__ import annotations

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions._report_common import (
    load_report,
    walk_report_dirs,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def asset_cleanup_report_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    return walk_report_dirs(nodes, "cleanup_reports", RecordType.ASSET_CLEANUP_REPORT)


def extract_asset_cleanup_report(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a report.json into a Record — headline fields only."""
    path = ref._path
    doc = load_report(path)
    findings = doc.get("findings") if isinstance(doc.get("findings"), list) else []
    counts = {"garbage": 0, "keep": 0, "unsure": 0}
    for f in findings:
        verdict = f.get("verdict") if isinstance(f, dict) else None
        if verdict in counts:
            counts[verdict] += 1
    name = str(doc.get("name") or path.parent.name)

    rec = FSRecord(
        type=RecordType.ASSET_CLEANUP_REPORT,
        id=resolved_id,
        name=name,
        generated_at=doc.get("generated_at"),
        root_count=len(doc.get("roots") or []),
        finding_count=len(findings),
        garbage_count=counts["garbage"],
        keep_count=counts["keep"],
        unsure_count=counts["unsure"],
        session_id=doc.get("session_id"),
        content=name,
    )
    rec.source_file = str(path)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
