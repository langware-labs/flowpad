"""Shared JSON-load / id-mint plumbing for the ``report.json``-folder
record families (``usage_report``, ``asset_cleanup_report``).

Both live at ``<scope>/agentic-assets/<type>/<name>/report.json`` — one folder per
generated report — and differ only in the RecordType and the headline fields
their extractor lifts into the record. Discovery is the generic ``repo_assets_fn``.
"""
from __future__ import annotations

import json
from pathlib import Path


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
