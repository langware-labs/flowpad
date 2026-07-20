"""Walker + extractor + id mint for SPREADSHEET records.

A spreadsheet is a flat file — ``*.csv`` (plain text) or ``*.xlsx`` (Office Open
XML, a zip) discovered anywhere in a walked project, exactly like ``*.md``. This
mirrors the MARKDOWN per-FOLDER emitter (``markdown_in_folder_fn``), NOT the
DECK folder-marker walker.

The extractor denormalizes lightweight shape metadata (row/col counts for CSV,
sheet names for XLSX) and a bounded FTS ``content`` preview. XLSX sheet names are
read with stdlib ``zipfile``/xml only — no ``openpyxl``/``pandas`` dependency; the
real grid parse happens frontend-side in SheetJS.

Type metadata lives in
``flow_sdk/schema/type_info/spreadsheet_type_info.py``; this module provides the
walker + slot functions only.
"""
from __future__ import annotations

import csv
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

_EXTS: frozenset[str] = frozenset({".csv", ".xlsx"})
# Bound the FTS preview so a 50k-row CSV doesn't balloon the index.
_MAX_PREVIEW_ROWS = 50
_MAX_PREVIEW_CHARS = 8_000


def _is_appledouble(name: str) -> bool:
    """macOS AppleDouble sidecars (``._foo.csv``) — resource-fork binaries that
    share the extension but hold no tabular data."""
    return name.startswith("._")


# ── walker ────────────────────────────────────────────────────────────────────

def spreadsheet_in_folder_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """For each walked FOLDER, emit its direct ``*.csv`` / ``*.xlsx`` children.

    The folder walker already descended + gitignore-filtered every directory;
    this only emits (``glob``, not ``rglob``). Mirrors ``markdown_in_folder_fn``.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        try:
            entries = sorted(
                p for p in folder_path.iterdir()
                if p.suffix.lower() in _EXTS
            )
        except OSError:
            continue
        for entry in entries:
            if _is_appledouble(entry.name):
                continue
            try:
                if not entry.is_file():
                    continue
            except OSError:
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.SPREADSHEET, parent=node))
    return out


# ── id mint ───────────────────────────────────────────────────────────────────

def _spreadsheet_id_from_path(path: Path) -> str:
    """Stable uuid5 derived from the resolved file path.

    CSV/XLSX carry no frontmatter capsule to adopt an id from, so identity is
    the path-derived v5 (a valid entity id per the mint/adopt policy).
    """
    return mint_uuid(str(path.resolve()))


def spreadsheet_identity_key(ref: FSRef | Path) -> str:
    return str(Path(getattr(ref, "_path", ref)).resolve())


# ── extractor ─────────────────────────────────────────────────────────────────

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


# Office Open XML namespaces for workbook sheet enumeration.
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


def extract_spreadsheet(ref: FSRef) -> list[FSRecord]:
    """Parse a .csv/.xlsx file into a single FSRecord with shape metadata.

    Single-path index paths bypass the walker's suffix glob, so gate on the
    extension here (mirrors ``extract_markdown``'s ``.md`` gate) — otherwise any
    file handed to ``discover_record_by_path`` would mint as a spreadsheet.
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
        id=_spreadsheet_id_from_path(path),
        name=name,
        status="active",
        content=content,
        metadata=metadata,
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]


# ── asset hash (file freshness) ───────────────────────────────────────────────

def spreadsheet_asset_hash(ref: FSRef) -> float:
    """The backing file's mtime — a single flat file, so no folder-max needed."""
    try:
        return ref._path.stat().st_mtime
    except OSError:
        return 0.0
