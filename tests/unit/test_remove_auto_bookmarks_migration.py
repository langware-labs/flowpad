"""Removing the `flow show` auto-bookmark rows (and typeless test pollution).

Seeds a real sqlite file with every kind of bookmark an install carries and
asserts only the auto tree and the typeless rows go.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from flow_sdk.migrations import migration_2026_10_remove_auto_bookmarks as mig

PROJECT = "ec073acc-f7bb-4292-a2b4-b5fcb5c34659"


def _db(tmp_path: Path) -> Path:
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50) NOT NULL, data TEXT)")
    conn.execute(
        "CREATE TABLE relationships (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50), "
        "from_id VARCHAR(36), to_id VARCHAR(36))"
    )
    rows = {
        # The auto tree: root → subfolder → leaf, plus a leaf a folder delete promoted to root.
        "auto-root": {"bookmark_type": "favorite_folder", "source": "auto", "data": {"auto_root": True}},
        "auto-sub": {"bookmark_type": "favorite_folder", "source": "auto", "parent_id": "auto-root"},
        "auto-leaf": {"bookmark_type": "favorite", "source": "auto", "parent_id": "auto-sub"},
        "auto-stray": {"bookmark_type": "favorite", "source": "auto", "parent_id": ""},
        # Test pollution: no bookmark_type at all.
        "typeless": {"title": "Test Bookmark"},
        "typeless-empty": {"title": "test-bookmark-1", "bookmark_type": ""},
        # Everything the user (or another feature) made — must survive.
        "manual-folder": {"bookmark_type": "favorite_folder", "source": ""},
        "manual-empty-folder": {"bookmark_type": "favorite_folder", "source": ""},
        "manual-leaf": {"bookmark_type": "favorite", "source": "", "parent_id": "manual-folder"},
        "shared": {"bookmark_type": "favorite", "source": "shared"},
        "onboarding": {"bookmark_type": "favorite", "source": "onboarding"},
        "note": {"bookmark_type": "note", "source": ""},
    }
    for rid, data in rows.items():
        conn.execute(
            "INSERT INTO entities (id, type, data) VALUES (?,?,?)",
            (rid, "bookmark", json.dumps({"project_id": PROJECT, **data})),
        )
    # A non-bookmark entity with source "auto" is someone else's business.
    conn.execute("INSERT INTO entities (id, type, data) VALUES (?,?,?)", ("other", "task", json.dumps({"source": "auto"})))
    conn.execute("INSERT INTO relationships VALUES ('r1','owner','auto-leaf','user-1')")
    conn.execute("INSERT INTO relationships VALUES ('r2','owner','manual-leaf','user-1')")
    conn.commit()
    conn.close()
    return db


def _ids(db: Path, table: str = "entities") -> set[str]:
    conn = sqlite3.connect(db)
    try:
        return {r[0] for r in conn.execute(f"SELECT id FROM {table}")}
    finally:
        conn.close()


def test_removes_only_auto_and_typeless_rows(tmp_path):
    db = _db(tmp_path)
    report = mig.migrate(dry_run=False, db=db)

    assert sorted(report.auto) == ["auto-leaf", "auto-root", "auto-stray", "auto-sub"]
    assert sorted(report.typeless) == ["typeless", "typeless-empty"]
    assert _ids(db) == {
        "manual-folder",
        "manual-empty-folder",
        "manual-leaf",
        "shared",
        "onboarding",
        "note",
        "other",
    }
    # The deleted bookmark's owner edge goes with it; the survivor's stays.
    assert _ids(db, "relationships") == {"r2"}


def test_dry_run_writes_nothing(tmp_path):
    db = _db(tmp_path)
    before = _ids(db)
    report = mig.migrate(dry_run=True, db=db)
    assert len(report.doomed) == 6
    assert _ids(db) == before


def test_second_run_is_a_no_op(tmp_path):
    db = _db(tmp_path)
    mig.migrate(dry_run=False, db=db)
    report = mig.migrate(dry_run=False, db=db)
    assert report.doomed == []
    assert report.lines() == ["bookmarks: no auto or typeless rows left."]
