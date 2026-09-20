"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import Optional

from flow_sdk.schema.data_spec import FrontMatter
from flow_sdk.schema.data_spec.io.native import FreeForm


class AssetCleanupReportSpec(FrontMatter):
    """``report.json`` — a FLAT document: three headline keys beside the
    payload (``roots``, ``findings``, ``summary``, ``markdown``). The five
    counts are DERIVED from the findings (``derive_cleanup``), never authored."""

    name: Optional[str] = None
    generated_at: Optional[str] = None
    session_id: Optional[str] = None
    report: Optional[FreeForm] = None
