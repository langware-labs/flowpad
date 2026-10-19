"""``Spreadsheet`` — a flat-file-backed tabular asset (CSV or XLSX).

Unlike the folder-backed ``Deck``, a spreadsheet is a single file discovered
anywhere in a project (like ``Markdown``):

    <project>/**/*.csv     — plain text, editable
    <project>/**/*.xlsx    — binary (Office Open XML), viewed read-only

The file itself is the entity; the frontend grid (RevoGrid) reads/edits the
bytes. CSV round-trips through the plain text FS write path; XLSX is parsed
frontend-side (SheetJS) and shown read-only.

The walker + extractor + id-mint live in
``flow_sdk/fs_store/indexer/functions/spreadsheet.py``; the type registration
lives in ``flow_sdk/schema/type_info/spreadsheet_type_info.py``. Modeled on the
MARKDOWN (flat-file) indexer, not the DECK (folder-marker) one.
"""
from __future__ import annotations

from typing import List, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity


class Spreadsheet(Entity):
    type: str = APIField(default="spreadsheet")
    title: str = APIField("")
    description: Optional[str] = APIField(None, blob=True)

    # "csv" | "xlsx" — the on-disk format, denormalized by the extractor from the
    # file suffix. Drives the frontend editor branch (editable grid vs read-only).
    format: str = APIField("")
    num_rows: int = APIField(0)
    num_cols: int = APIField(0)
    # XLSX only — the workbook's sheet names (empty for CSV, a single logical sheet).
    sheet_names: List[str] = APIField(default_factory=list)

    # Absolute path of the backing file on disk, stamped by the indexer /
    # ``Entity.from_fs_ref``. A plain string, mirrors MARKDOWN.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
