"""Indexer tests for the SPREADSHEET type (flat CSV/XLSX file asset).

Covers the slot functions end-to-end:
- ``spreadsheet_in_folder_fn`` emits one FSRef per direct ``*.csv``/``*.xlsx``
  child of a walked FOLDER (mirrors ``markdown_in_folder_fn``).
- ``extract_spreadsheet`` denormalizes format + row/col counts (CSV) and sheet
  names (XLSX) and gates on the extension.
- ``TypeInfo.mint_id`` produces a stable, valid (v5) entity id.
- ``spreadsheet_asset_hash`` tracks the file's mtime.

Pure-sync; the walker/slot functions are called directly. Modeled on
``test_indexer_deck.py``.
"""
from __future__ import annotations

import os
import zipfile
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.functions.spreadsheet import (
    extract_spreadsheet,
    spreadsheet_asset_hash,
    spreadsheet_in_folder_fn,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)

_WORKBOOK_XML = (
    '<?xml version="1.0"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets>'
    '<sheet name="Revenue" sheetId="1" r:id="rId1"/>'
    '<sheet name="Costs" sheetId="2" r:id="rId2"/>'
    '</sheets></workbook>'
)


def _seed_csv(folder: Path, name: str, text: str = "name,age\nalice,30\nbob,25\n") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / name
    p.write_text(text, encoding="utf-8")
    return p


def _seed_xlsx(folder: Path, name: str, workbook_xml: str = _WORKBOOK_XML) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / name
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("xl/workbook.xml", workbook_xml)
    return p


def _folder_node(path: Path) -> FSRef:
    return FSRef(path, record_type=RecordType.FOLDER)


# ── walker ────────────────────────────────────────────────────────────────────

def test_walker_emits_one_ref_per_tabular_file(tmp_path: Path) -> None:
    _seed_csv(tmp_path, "a.csv")
    _seed_xlsx(tmp_path, "b.xlsx")
    (tmp_path / "notes.md").write_text("# not tabular", encoding="utf-8")  # skipped

    refs = spreadsheet_in_folder_fn([_folder_node(tmp_path)], IndexerOptions(verbose=False))

    assert all(r.record_type == RecordType.SPREADSHEET for r in refs)
    assert sorted(Path(r.path).name for r in refs) == ["a.csv", "b.xlsx"]


def test_walker_ignores_non_folder_nodes(tmp_path: Path) -> None:
    _seed_csv(tmp_path, "a.csv")
    # A non-FOLDER node must not emit (only project_folder_walker FOLDER refs feed us).
    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    assert spreadsheet_in_folder_fn([node], IndexerOptions(verbose=False)) == []


def test_walker_skips_appledouble(tmp_path: Path) -> None:
    _seed_csv(tmp_path, "._resource.csv")
    assert spreadsheet_in_folder_fn([_folder_node(tmp_path)], IndexerOptions(verbose=False)) == []


def test_walker_is_not_recursive(tmp_path: Path) -> None:
    # A csv in a SUBfolder is emitted when THAT folder is walked, not the parent's.
    _seed_csv(tmp_path / "sub", "deep.csv")
    refs = spreadsheet_in_folder_fn([_folder_node(tmp_path)], IndexerOptions(verbose=False))
    assert refs == []


# ── extractor: CSV ──────────────────────────────────────────────────────────

def test_extract_csv_counts_rows_and_cols(tmp_path: Path) -> None:
    p = _seed_csv(tmp_path, "d.csv")
    rec = extract_spreadsheet(FSRef(p))[0]
    assert rec.type == RecordType.SPREADSHEET
    assert rec.name == "d.csv"
    assert rec.metadata["format"] == "csv"
    assert rec.metadata["num_rows"] == 3
    assert rec.metadata["num_cols"] == 2
    assert rec.metadata["sheet_names"] == []
    # asset_ref points at the file itself (file-layout, not a folder).
    assert Path(rec._asset_ref.path).resolve() == p.resolve()


def test_extract_csv_ragged_rows_use_max_cols(tmp_path: Path) -> None:
    p = _seed_csv(tmp_path, "ragged.csv", text="a,b,c\n1,2\n3,4,5,6\n")
    rec = extract_spreadsheet(FSRef(p))[0]
    assert rec.metadata["num_cols"] == 4
    assert rec.metadata["num_rows"] == 3


# ── extractor: XLSX ─────────────────────────────────────────────────────────

def test_extract_xlsx_reads_sheet_names(tmp_path: Path) -> None:
    p = _seed_xlsx(tmp_path, "book.xlsx")
    rec = extract_spreadsheet(FSRef(p))[0]
    assert rec.metadata["format"] == "xlsx"
    assert rec.metadata["sheet_names"] == ["Revenue", "Costs"]


def test_extract_xlsx_bad_zip_is_tolerated(tmp_path: Path) -> None:
    p = tmp_path / "corrupt.xlsx"
    p.write_text("not really a zip", encoding="utf-8")
    rec = extract_spreadsheet(FSRef(p))[0]
    assert rec.metadata["format"] == "xlsx"
    assert rec.metadata["sheet_names"] == []


def test_extract_gates_on_extension(tmp_path: Path) -> None:
    # A single-path index of a non-tabular file must NOT mint a spreadsheet.
    other = tmp_path / "readme.txt"
    other.write_text("hi", encoding="utf-8")
    assert extract_spreadsheet(FSRef(other)) == []


# ── id + freshness ──────────────────────────────────────────────────────────

def test_gen_id_is_stable_and_valid(tmp_path: Path) -> None:
    p = _seed_csv(tmp_path, "d.csv")
    ref = FSRef(p)
    first = SchemaRegistry.get("spreadsheet").mint_id(ref)
    assert first == SchemaRegistry.get("spreadsheet").mint_id(ref)
    assert is_valid_entity_id(first)  # v4/v5 mint policy
    # The extractor stamps the same id.
    assert extract_spreadsheet(ref)[0].id == first


def test_asset_hash_tracks_mtime(tmp_path: Path) -> None:
    p = _seed_csv(tmp_path, "d.csv")
    ref = FSRef(p)
    h1 = spreadsheet_asset_hash(ref)
    future = h1 + 100
    os.utime(p, (future, future))
    assert spreadsheet_asset_hash(ref) == pytest.approx(future)
