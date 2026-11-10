"""Saved auto-approve contact permissions are deleted — rows and shadow folders, on a real sqlite file."""
from __future__ import annotations

import sqlite3

from flow_sdk.migrations import migration_2026_11_drop_contact_permission as mig


def test_contact_permission_rows_and_folders_go_and_a_rerun_is_a_no_op(tmp_path):
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50) NOT NULL, data TEXT)")
    conn.executemany("INSERT INTO entities VALUES (?, ?, '{}')", [("g1", "contact_permission"), ("t1", "task")])
    conn.commit()
    conn.close()
    records = tmp_path / "records"
    (records / "contact_permission" / "g1").mkdir(parents=True)
    (records / "task" / "t1").mkdir(parents=True)

    assert mig.migrate(dry_run=True, db=db, records_root=records).rows == ["g1"]
    report = mig.migrate(dry_run=False, db=db, records_root=records)
    assert report.rows == ["g1"]

    conn = sqlite3.connect(db)
    assert [r[0] for r in conn.execute("SELECT id FROM entities")] == ["t1"]
    conn.close()
    assert not (records / "contact_permission").exists() and (records / "task" / "t1").is_dir()
    again = mig.migrate(dry_run=False, db=db, records_root=records)
    assert again.rows == [] and again.folder is None
