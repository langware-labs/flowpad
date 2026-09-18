"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import csv
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

_EXTS: frozenset[str] = frozenset({".csv", ".xlsx"})


_MAX_PREVIEW_ROWS = 50


_MAX_PREVIEW_CHARS = 8_000


def spreadsheet_identity_key(ref: FSRef | Path) -> str:
    return str(Path(getattr(ref, "_path", ref)).resolve())


def _extract_csv(path: Path) -> tuple[int, int, str]:
    """(num_rows, num_cols, preview_text) for a CSV. Tolerant of malformed rows."""
    num_rows = 0
    num_cols = 0
    preview: list[str] = []
    try:
        with path.open("r", encoding="utf-8", newline="", errors="replace") as fh:
            reader = csv.reader(fh)
            for row in reader:
                num_rows += 1
                if len(row) > num_cols:
                    num_cols = len(row)
                if len(preview) < _MAX_PREVIEW_ROWS:
                    preview.append(" ".join(cell for cell in row if cell))
    except OSError:
        return 0, 0, ""
    text = "\n".join(p for p in preview if p)
    return num_rows, num_cols, text[:_MAX_PREVIEW_CHARS]


_XLSX_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
}


def _extract_xlsx_sheets(path: Path) -> list[str]:
    """Sheet names of an .xlsx via stdlib zip+xml (no openpyxl). ``[]`` on error."""
    try:
        with zipfile.ZipFile(path) as zf:
            with zf.open("xl/workbook.xml") as wf:
                tree = ET.parse(wf)
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError):
        return []
    names: list[str] = []
    for sheet in tree.getroot().iterfind(".//main:sheets/main:sheet", _XLSX_NS):
        name = sheet.get("name")
        if name:
            names.append(name)
    return names


def extract_spreadsheet(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a .csv/.xlsx file into a single FSRecord with shape metadata.

    Single-path index paths bypass the walker's suffix glob, so gate on the
    extension here (mirrors ``extract_markdown``'s ``.md`` gate) — otherwise any
    file handed to ``resolve_asset`` would mint as a spreadsheet.
    """
    path = ref._path
    suffix = path.suffix.lower()
    if suffix not in _EXTS:
        return []
    try:
        if not path.is_file():
            return []
    except OSError:
        return []

    fmt = "xlsx" if suffix == ".xlsx" else "csv"
    sheet_names: list[str] = []
    num_rows = 0
    num_cols = 0

    if fmt == "csv":
        num_rows, num_cols, preview = _extract_csv(path)
        content = "\n".join(p for p in (path.stem, preview) if p)
    else:
        sheet_names = _extract_xlsx_sheets(path)
        content = "\n".join(p for p in (path.stem, " ".join(sheet_names)) if p)

    name = path.name
    metadata = {
        "format": fmt,
        "num_rows": num_rows,
        "num_cols": num_cols,
        "sheet_names": sheet_names,
    }

    rec = FSRecord(
        type=RecordType.SPREADSHEET,
        id=resolved_id,
        name=name,
        status="active",
        content=content,
        metadata=metadata,
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]


def spreadsheet_asset_hash(ref: FSRef) -> float:
    """The backing file's mtime — a single flat file, so no folder-max needed."""
    try:
        return ref._path.stat().st_mtime
    except OSError:
        return 0.0
