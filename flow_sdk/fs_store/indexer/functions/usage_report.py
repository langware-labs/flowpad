"""Walker + extractor + id mint for USAGE_REPORT records.

Usage reports live at ``<scope>/.claude/usage_reports/<name>/report.json`` — one
folder per generated report. ``report.json`` carries the full payload (``data``
aggregates + per-session drill-down + rendered ``markdown``); the extractor reads
only the small headline fields into the record (the payload is deliberately
excluded from FTS).
"""
from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

REPORT_JSON = "report.json"


def usage_report_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        reports_root = Path(node.path) / ".claude" / "usage_reports"
        if not reports_root.is_dir():
            continue
        for report_dir in sorted(reports_root.iterdir()):
            doc = report_dir / REPORT_JSON
            if not doc.is_file():
                continue
            key = str(doc.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(doc, record_type=RecordType.USAGE_REPORT, parent=node))
    return out


def _load_report(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _report_id_from_path(path: Path) -> str:
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))


def _adopt_doc_id(data: dict) -> str | None:
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(data.get("id"))


def usage_report_gen_id(ref: FSRef) -> str:
    """Mint+write a stable id into report.json (idempotent)."""
    data = _load_report(ref._path)
    existing = _adopt_doc_id(data)
    if existing:
        return existing
    new_id = _report_id_from_path(ref._path)
    if data:
        data["id"] = new_id
        try:
            ref._path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass
    return new_id


def extract_usage_report(ref: FSRef) -> list[FSRecord]:
    """Parse a report.json into a Record — headline fields only."""
    path = ref._path
    doc = _load_report(path)
    payload = doc.get("data") if isinstance(doc.get("data"), dict) else {}
    name = str(doc.get("name") or path.parent.name)
    rec_id = _adopt_doc_id(doc) or _report_id_from_path(path)

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
