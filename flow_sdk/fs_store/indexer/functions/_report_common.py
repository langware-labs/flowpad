"""Shared JSON-load / id-mint plumbing for the flat-JSON report families
(``agent_trace``, ``usage_report``, ``asset_cleanup_report``): one folder per
generated report under ``<scope>/agentic-assets/<type>/<name>/``. Parsing is the
generic ``spec_extractor``; this module is only the cheap id path."""
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
