"""Tests for ``Spreadsheet.from_fs_ref`` — the generic, DB-free on-disk loader.

Asserts the typed ``Spreadsheet`` loaded via ``from_fs_ref`` matches the indexer
cold path (id, format, counts, sheet_names, asset_ref) for both CSV and XLSX.
Modeled on ``test_deck_from_fs_ref.py``.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from flow_sdk.builtin.spreadsheet import Spreadsheet
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.indexer.functions.spreadsheet import (
    extract_spreadsheet,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)

_WORKBOOK_XML = (
    '<?xml version="1.0"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
)


def _seed_csv(tmp_path: Path) -> Path:
    p = tmp_path / "data.csv"
    p.write_text("a,b,c\n1,2,3\n4,5,6\n", encoding="utf-8")
    return p


def _seed_xlsx(tmp_path: Path) -> Path:
    p = tmp_path / "book.xlsx"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("xl/workbook.xml", _WORKBOOK_XML)
    return p


def _ref(path: Path) -> FSRef:
    return FSRef(path, record_type=RecordType.SPREADSHEET)


def test_returns_typed_spreadsheet(tmp_path: Path) -> None:
    loaded = Spreadsheet.from_fs_ref(_ref(_seed_csv(tmp_path)))
    assert type(loaded) is Spreadsheet


def test_non_tabular_file_returns_none(tmp_path: Path) -> None:
    other = tmp_path / "notes.txt"
    other.write_text("hi", encoding="utf-8")
    assert Spreadsheet.from_fs_ref(_ref(other)) is None


def test_csv_indexer_compatible_all_fields(tmp_path: Path) -> None:
    ref = _ref(_seed_csv(tmp_path))
    loaded = Spreadsheet.from_fs_ref(ref)
    resolved_id = SchemaRegistry.get("spreadsheet").mint_entity_id(ref)
    rec = extract_spreadsheet(ref, resolved_id)[0]

    assert loaded.type == "spreadsheet"
    assert loaded.id == rec.id == SchemaRegistry.get("spreadsheet").mint_entity_id(ref)
    assert is_valid_entity_id(loaded.id)
    assert loaded.format == "csv"
    assert loaded.num_rows == 3
    assert loaded.num_cols == 3
    assert loaded.sheet_names == []
    assert Path(loaded.asset_ref).resolve() == (tmp_path / "data.csv").resolve()


def test_xlsx_indexer_compatible_all_fields(tmp_path: Path) -> None:
    ref = _ref(_seed_xlsx(tmp_path))
    loaded = Spreadsheet.from_fs_ref(ref)

    assert loaded.format == "xlsx"
    assert loaded.sheet_names == ["Sheet1"]
    assert is_valid_entity_id(loaded.id)
    assert Path(loaded.asset_ref).resolve() == (tmp_path / "book.xlsx").resolve()
