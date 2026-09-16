"""The ``data_source`` type string becomes ``data_driver`` everywhere it is stored — and nowhere else."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from flow_sdk.migrations.migration_2026_09_data_driver_rename import migrate

pytestmark = pytest.mark.timeout(10)  # do not increase without approval

SRC = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b"
CURSOR = "4a2b3c4d-5e6f-4071-8b9c-0d1e2f3a4b5c"
ITEM = "5b3c4d5e-6f70-4182-9cad-1e2f3a4b5c6d"
SPEC = "6c4d5e6f-7081-4293-8dbe-2f3a4b5c6d7e"
TAB = "7d5e6f70-8192-43a4-9ecf-3a4b5c6d7e8f"


def _db(tmp_path: Path) -> Path:
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, uname TEXT, type_uname TEXT UNIQUE,
                               created_date TEXT, data TEXT, record_data_ref TEXT);
        CREATE TABLE relationships (id TEXT, type TEXT, from_id TEXT, from_type TEXT, to_id TEXT, to_type TEXT);
        CREATE TABLE links (id INTEGER PRIMARY KEY, src_type TEXT, src_id TEXT, target_raw TEXT, target_resolved_type TEXT);
        CREATE VIRTUAL TABLE entities_fts USING fts5(entity_id, type, name, title, description, content);
    """)
    put = "INSERT INTO entities (id, type, uname, type_uname, data, record_data_ref) VALUES (?, ?, ?, ?, ?, ?)"
    conn.execute(put, (SRC, "data_source", "gmail", "data_source:gmail",
                       json.dumps({"type": "data_source", "id": SRC, "provider": "gmail"}), f"data_source/{SRC}"))
    conn.execute(put, (CURSOR, "data_source_cursor", None, None,
                       json.dumps({"type": "data_source_cursor", "data_source_id": SRC}), None))
    conn.execute(put, (ITEM, "source_item", None, None,
                       json.dumps({"type": "source_item", "data_source_id": SRC}), None))
    conn.execute(put, (SPEC, "data_source_spec", "gmail", "data_source_spec:gmail",
                       json.dumps({"type": "data_source_spec", "asset_ref": "/x/agentic-assets/data_driver/gmail"}), None))
    conn.execute(put, (TAB, "tab", None, None,
                       json.dumps({"targets": [f"data_source-{SRC}", f"data_source:{SRC}"], "data_source_id": SRC,
                                   "note": "data_source-not-a-typeid"}), None))
    conn.execute("INSERT INTO relationships VALUES ('r1', 'child', ?, 'data_source', ?, 'source_item')", (SRC, ITEM))
    conn.execute("INSERT INTO relationships VALUES ('r2', 'owns', ?, 'agent', ?, 'data_source')", (TAB, SRC))
    conn.execute("INSERT INTO links (src_type, src_id, target_raw, target_resolved_type) VALUES ('data_source', ?, 'x', 'data_source')", (SRC,))
    conn.execute("INSERT INTO entities_fts (entity_id, type, name) VALUES (?, 'data_source', 'gmail')", (SRC,))
    conn.commit()
    conn.close()
    return db


def _row(db: Path, table: str, where: str, *args):
    conn = sqlite3.connect(db)
    try:
        return conn.execute(f"SELECT * FROM {table} WHERE {where}", args).fetchall()
    finally:
        conn.close()


def _shadow(root: Path, entity_id: str, type_name: str = "data_source") -> Path:
    folder = root / type_name / entity_id
    folder.mkdir(parents=True)
    (folder / "metadata.json").write_text(json.dumps({"type": type_name, "id": entity_id}))
    return folder


def test_rows_edges_links_fts_and_refs_flip(tmp_path):
    db = _db(tmp_path)
    report = migrate(dry_run=False, db=db, shadow_roots=[])
    c = report.counts
    assert (c["entities.type"], c["entities.type_uname"], c["entities.$type"], c["entities.record_data_ref"]) == (1, 1, 1, 1)
    assert (c["relationships"], c["links"], c["entities_fts"]) == (2, 1, 1)

    [(_, type_, _, type_uname, _, data, ref)] = _row(db, "entities", "id = ?", SRC)
    assert (type_, type_uname, ref, json.loads(data)["type"]) == ("data_driver", "data_driver:gmail", f"data_driver/{SRC}", "data_driver")
    assert {r[3] for r in _row(db, "relationships", "id = 'r1'")} == {"data_driver"}
    assert {r[5] for r in _row(db, "relationships", "id = 'r2'")} == {"data_driver"}
    assert _row(db, "links", "src_type = 'data_driver' AND target_resolved_type = 'data_driver'")
    assert _row(db, "entities_fts", "type = 'data_driver'")


def test_neighbour_types_and_the_data_source_id_field_are_untouched(tmp_path):
    db = _db(tmp_path)
    before = {r[0]: r for r in _row(db, "entities", "id IN (?, ?, ?)", CURSOR, ITEM, SPEC)}
    migrate(dry_run=False, db=db, shadow_roots=[])
    after = {r[0]: r for r in _row(db, "entities", "id IN (?, ?, ?)", CURSOR, ITEM, SPEC)}
    assert after == before, "cursor, source_item and spec rows are byte-identical"


def test_typeid_surgery_rewrites_only_values_that_are_typeids(tmp_path):
    db = _db(tmp_path)
    report = migrate(dry_run=False, db=db, shadow_roots=[])
    [(_, _, _, _, _, data, _)] = _row(db, "entities", "id = ?", TAB)
    blob = json.loads(data)
    assert report.counts["entities.typeids"] == 2
    assert blob["targets"] == [f"data_driver-{SRC}", f"data_driver:{SRC}"]
    assert blob["data_source_id"] == SRC and blob["note"] == "data_source-not-a-typeid"


def test_shadows_move_under_every_root_and_a_taken_destination_is_left(tmp_path):
    records, data = tmp_path / "records", tmp_path / "records_data"
    _shadow(records, SRC)
    _shadow(data, SRC)
    kept = _shadow(records, CURSOR)
    _shadow(records, CURSOR, type_name="data_driver")  # already present: a conflict
    report = migrate(dry_run=False, db=tmp_path / "absent.db", shadow_roots=[records, data])

    assert report.shadows_moved == 2 and report.shadow_conflicts == [str(kept)]
    for root in (records, data):
        meta = json.loads((root / "data_driver" / SRC / "metadata.json").read_text())
        assert meta["type"] == "data_driver"
    assert (kept / "metadata.json").is_file(), "a conflict is never overwritten"


def test_dry_run_writes_nothing_and_a_second_run_changes_nothing(tmp_path):
    db = _db(tmp_path)
    records = tmp_path / "records"
    _shadow(records, SRC)

    dry = migrate(dry_run=True, db=db, shadow_roots=[records])
    assert dry.rows == 1 and dry.shadows_moved == 1 and not dry.changed
    assert _row(db, "entities", "type = 'data_source'") and (records / "data_source" / SRC).is_dir()

    first = migrate(dry_run=False, db=db, shadow_roots=[records])
    assert first.changed and (db.with_name(db.name + ".pre-data_driver.bak")).is_file()
    second = migrate(dry_run=False, db=db, shadow_roots=[records])
    assert not second.changed
    assert sum(second.counts.values()) == 0 and second.shadows_moved == 0


def test_a_uname_already_held_under_the_new_type_keeps_its_claim(tmp_path):
    db = _db(tmp_path)
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO entities (id, type, uname, type_uname, data) VALUES ('held', 'data_driver', 'gmail', 'data_driver:gmail', '{}')")
    conn.commit()
    conn.close()
    report = migrate(dry_run=False, db=db, shadow_roots=[])
    assert report.counts["entities.uname_collisions"] == 1
    [(_, type_, _, type_uname, *_)] = _row(db, "entities", "id = ?", SRC)
    assert (type_, type_uname) == ("data_driver", None), "the row survives; only its uname claim yields"
