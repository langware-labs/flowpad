"""Shared walker / JSON-load / id-mint plumbing for the ``report.json``-folder
record families (``usage_report``, ``asset_cleanup_report``).

Both live at ``<scope>/.claude/<subdir>/<name>/report.json`` — one folder per
generated report — and differ only in the subdir, the RecordType, and the
headline fields their extractor lifts into the record.
"""
from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

REPORT_JSON = "report.json"


def walk_report_dirs(nodes: list[FSRef], subdir: str, record_type: RecordType) -> list[FSRef]:
    """One FSRef per ``<node>/.claude/<subdir>/<name>/report.json``."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        reports_root = Path(node.path) / ".claude" / subdir
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
            out.append(FSRef(doc, record_type=record_type, parent=node))
    return out


def load_report(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def report_id_from_path(path: Path) -> str:
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))


def adopt_doc_id(data: dict) -> str | None:
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(data.get("id"))


def report_gen_id(ref: FSRef) -> str:
    """Mint+write a stable id into report.json (idempotent)."""
    data = load_report(ref._path)
    existing = adopt_doc_id(data)
    if existing:
        return existing
    new_id = report_id_from_path(ref._path)
    if data:
        data["id"] = new_id
        try:
            ref._path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass
    return new_id
