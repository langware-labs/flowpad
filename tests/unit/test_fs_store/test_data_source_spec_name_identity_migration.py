"""The FLOWPAD-2070 collapse: one `data_source_spec` row per name.

Builds the real forked shape — the same shipped source indexed from three
coexisting install locations, each row carrying the id the OLD path-keyed minter
produced — and drives the migration over a real sqlite file.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.migrations import migration_2026_09_data_source_spec_name_identity as mig
from tests.fixtures.identity import resolve_id

#: The three roots one machine really carries — a uv tool dir, a python prefix,
#: and uv's own unpacked wheel cache.
INSTALLS = ("uv-tools-flowpad", "pythoncore-3.14-64", "uv-cache-archive-v0")


def _schema(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE entities (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50) NOT NULL, "
        "created_date DATETIME, updated_date DATETIME, data TEXT)"
    )
    conn.execute("CREATE TABLE relationships (from_id VARCHAR(36), to_id VARCHAR(36))")
    conn.commit()
    return conn


def _old_path_keyed_id(folder: Path) -> str:
    """What the seam produced before the fix: uuid5 of the abs path."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(folder.resolve())))


def _forked_instance(tmp_path: Path, names: tuple[str, ...]) -> tuple[Path, dict[str, list[str]]]:
    """A DB holding one row per (name, install root), plus the assets on disk."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    minted: dict[str, list[str]] = {}
    for install in INSTALLS:
        for name in names:
            folder = (
                tmp_path / install / "Lib" / "site-packages" / "flow_sdk" / "system_projects"
                / "flowpad_assistant" / "agentic-assets" / "data_source" / name
            )
            folder.mkdir(parents=True)
            (folder / "data_source.json").write_text(
                json.dumps({"schema": 1, "name": name, "title": name.upper()}), encoding="utf-8"
            )
            row_id = _old_path_keyed_id(folder)
            minted.setdefault(name, []).append(row_id)
            conn.execute(
                "INSERT INTO entities (id, type, created_date, updated_date, data) VALUES (?,?,?,?,?)",
                (
                    row_id,
                    "data_source_spec",
                    f"2026-08-{19 + INSTALLS.index(install):02d} 08:30:00",
                    "2026-08-25 09:00:00",
                    json.dumps({"name": name, "scope": "system", "asset_ref": str(folder)}),
                ),
            )
    conn.commit()
    conn.close()
    return db, minted


def _rows(db: Path) -> list[tuple[str, str]]:
    conn = sqlite3.connect(db)
    try:
        return [
            (rid, json.loads(blob)["name"])
            for rid, blob in conn.execute(
                "SELECT id, data FROM entities WHERE type='data_source_spec' ORDER BY id"
            )
        ]
    finally:
        conn.close()


def _expected_id(folder: Path) -> str:
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    info = SchemaRegistry.get("data_source_spec")
    assert info is not None
    return resolve_id(info, FSRef(folder, record_type=RecordType.DATA_SOURCE_SPEC, scope="system"))


def test_forked_specs_collapse_to_one_row_per_name(tmp_path: Path) -> None:
    names = ("rss", "slack", "gdrive")
    db, minted = _forked_instance(tmp_path, names)
    assert len(_rows(db)) == len(names) * len(INSTALLS), "the bug's shape: one row per install"

    report = mig.collapse(dry_run=False, db=db)

    surviving = _rows(db)
    assert sorted(name for _, name in surviving) == sorted(names)
    assert report.rows_deleted == len(names) * (len(INSTALLS) - 1)
    # Every survivor sits at the id the FIXED minter now produces, so the next
    # index updates it in place instead of adding a row beside it.
    live = tmp_path / INSTALLS[0] / "Lib" / "site-packages" / "flow_sdk" / "system_projects" / "flowpad_assistant" / "agentic-assets" / "data_source"
    assert {rid for rid, _ in surviving} == {_expected_id(live / name) for name in names}
    assert not ({rid for rid, _ in surviving} & {i for ids in minted.values() for i in ids[1:]})


def test_collapse_is_idempotent_and_clean_instances_are_untouched(tmp_path: Path) -> None:
    db, _ = _forked_instance(tmp_path, ("rss",))
    mig.collapse(dry_run=False, db=db)
    after_first = _rows(db)

    second = mig.collapse(dry_run=False, db=db)

    assert second.groups == [], "a collapsed instance has nothing left to do"
    assert second.rows_deleted == 0 and second.rows_rekeyed == 0
    assert _rows(db) == after_first


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    db, _ = _forked_instance(tmp_path, ("rss", "slack"))
    before = _rows(db)

    report = mig.collapse(dry_run=True, db=db)

    assert report.groups, "the plan still reports the forks"
    assert report.rows_deleted == 0 and report.rows_rekeyed == 0
    assert _rows(db) == before


def test_missing_entities_table_is_a_no_op(tmp_path: Path) -> None:
    """A fresh instance runs migrations before the server creates its schema."""
    db = tmp_path / "empty.db"
    sqlite3.connect(db).close()

    assert mig.collapse(dry_run=False, db=db).groups == []


@pytest.mark.parametrize("survivor_index", (0, 1, 2))
def test_the_row_whose_asset_is_still_on_disk_wins(tmp_path: Path, survivor_index: int) -> None:
    """Only the live install's folder survives an uninstall; that row is kept,
    whatever its created_date, so `asset_ref` keeps pointing at real bytes."""
    import shutil

    db, _ = _forked_instance(tmp_path, ("rss",))
    for i, install in enumerate(INSTALLS):
        if i != survivor_index:
            shutil.rmtree(tmp_path / install)

    mig.collapse(dry_run=False, db=db)

    conn = sqlite3.connect(db)
    try:
        rows = conn.execute("SELECT data FROM entities WHERE type='data_source_spec'").fetchall()
    finally:
        conn.close()
    assert len(rows) == 1
    assert INSTALLS[survivor_index] in json.loads(rows[0][0])["asset_ref"]
