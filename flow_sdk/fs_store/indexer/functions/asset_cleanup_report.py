"""Extractor for ASSET_CLEANUP_REPORT records.

Cleanup reports live at ``<scope>/agentic-assets/asset_cleanup_report/<name>/report.json``
— one folder per generated scan. The serializer reads the headline keys
(``AssetCleanupReportSpec``); the five counts are derived from the payload's
findings here (``derive_cleanup``); the payload itself is deliberately excluded
from FTS and from the record.
"""
from __future__ import annotations

from pathlib import Path


def derive_cleanup(data: dict, root: Path, header_raw: dict) -> None:
    """The counts the document implies — facts about the findings, never authored."""
    doc = data.get("report") or {}
    findings = doc.get("findings") if isinstance(doc.get("findings"), list) else []
    counts = {"garbage": 0, "keep": 0, "unsure": 0}
    for f in findings:
        verdict = f.get("verdict") if isinstance(f, dict) else None
        if verdict in counts:
            counts[verdict] += 1
    data["root_count"] = len(doc.get("roots") or [])
    data["finding_count"] = len(findings)
    data["garbage_count"] = counts["garbage"]
    data["keep_count"] = counts["keep"]
    data["unsure_count"] = counts["unsure"]
