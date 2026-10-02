"""Collapsing duplicated `flow show` auto-bookmark trees.

Builds the two real shapes over a real sqlite file: the race fork (two roots,
two same-type subfolders, two leaves on one target, all inside ONE project) and
the cross-bucket pair observed on the `oss` instance (a pre-stamping unscoped
tree beside a project-scoped one).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from flow_sdk.migrations import migration_2026_09_auto_favorite_duplicate_roots as mig

OWNER = "56cb3eae-77ff-5727-8d01-08fce10852e0"
PROJECT = "ec073acc-f7bb-4292-a2b4-b5fcb5c34659"
OTHER_PROJECT = "1d1e2710-2320-443f-bae0-7818d306922d"


def _schema(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE entities (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50) NOT NULL, "
        "created_by VARCHAR(50), created_date DATETIME, updated_date DATETIME, data TEXT)"
    )
    conn.execute(
        "CREATE TABLE relationships (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50), "
        "from_id VARCHAR(36), from_type VARCHAR(50), to_id VARCHAR(36), to_type VARCHAR(50))"
    )
    conn.commit()
    return conn


def _bm(
    conn: sqlite3.Connection,
    *,
    rid: str,
    created: str,
    title: str,
    payload: dict,
    parent: str = "",
    project: str | None = PROJECT,
    bookmark_type: str = "favorite_folder",
    source: str = "auto",
    owner: str = OWNER,
) -> str:
    data = {
        "bookmark_type": bookmark_type,
        "source": source,
        "title": title,
        "parent_id": parent,
        "data": payload,
    }
    if project is not None:
        data["project_id"] = project
    conn.execute(
        "INSERT INTO entities (id, type, created_by, created_date, updated_date, data)"
        " VALUES (?,?,?,?,?,?)",
        (rid, "bookmark", owner, created, created, json.dumps(data)),
    )
    # Every bookmark carries the owner edge `save(owner)` writes.
    conn.execute(
        "INSERT INTO relationships (id, type, from_id, from_type, to_id, to_type)"
        " VALUES (?,?,?,?,?,?)",
        (f"rel-{rid}", "role", owner, "user", rid, "bookmark"),
    )
    return rid


def _id(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _rows(db: Path) -> dict[str, dict]:
    """Surviving bookmarks by id, with the fields the tree is made of."""
    conn = sqlite3.connect(db)
    try:
        out = {}
        for rid, blob in conn.execute("SELECT id, data FROM entities WHERE type='bookmark'"):
            d = json.loads(blob)
            out[rid] = {
                "title": d.get("title"),
                "parent": d.get("parent_id") or "",
                "project": d.get("project_id") or "",
                "payload": d.get("data") or {},
            }
        return out
    finally:
        conn.close()


def _forked_race(tmp_path: Path) -> Path:
    """One project, two concurrent shows: forked root, forked `Files` subfolder,
    and the same target filed twice."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _bm(conn, rid=_id(1), created="2026-08-24 08:57:14.500", title="Auto", payload={"auto_root": True})
    _bm(conn, rid=_id(2), created="2026-08-24 08:57:14.900", title="Auto", payload={"auto_root": True})
    _bm(conn, rid=_id(3), created="2026-08-24 08:57:14.510", title="Files",
        payload={"auto_type": "file"}, parent=_id(1))
    _bm(conn, rid=_id(4), created="2026-08-24 08:57:14.910", title="Files",
        payload={"auto_type": "file"}, parent=_id(2))
    for n, created in ((5, "2026-08-24 08:57:14.520"), (6, "2026-08-24 08:57:14.920")):
        _bm(conn, rid=_id(n), created=created, title="index",
            payload={"entity_type": "vfs", "entity_id": "/w/index.html"},
            parent=_id(3) if n == 5 else _id(4), bookmark_type="favorite")
    # A second, genuinely distinct target under the losing subfolder — it must
    # survive, re-filed onto the keeper.
    _bm(conn, rid=_id(7), created="2026-08-24 08:57:15.000", title="notes",
        payload={"entity_type": "vfs", "entity_id": "/w/notes.md"},
        parent=_id(4), bookmark_type="favorite")
    # A hand-starred favorite on the same target: not source="auto", never touched.
    _bm(conn, rid=_id(8), created="2026-08-24 09:00:00.000", title="index",
        payload={"entity_type": "vfs", "entity_id": "/w/index.html"},
        bookmark_type="favorite", source="")
    conn.commit()
    conn.close()
    return db


def test_race_forked_tree_collapses_to_one_root_subfolder_and_leaf(tmp_path: Path) -> None:
    db = _forked_race(tmp_path)
    assert len(_rows(db)) == 8, "the bug's shape: every level forked"

    report = mig.dedupe(dry_run=False, db=db)

    rows = _rows(db)
    # The three losers are gone; the oldest of each pair survived.
    assert set(rows) == {_id(1), _id(3), _id(5), _id(7), _id(8)}
    assert report.rows_deleted == 3
    # The surviving distinct leaf was re-filed off the deleted subfolder.
    assert rows[_id(7)]["parent"] == _id(3)
    assert report.rows_reparented == 1
    # The manual star is untouched, even though it points at the same target.
    assert rows[_id(8)]["parent"] == ""


def test_children_of_a_dropped_root_are_refiled_not_stranded(tmp_path: Path) -> None:
    """A subfolder whose type is unique to the losing root moves to the keeper."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _bm(conn, rid=_id(1), created="2026-08-24 08:00:00", title="Auto", payload={"auto_root": True})
    _bm(conn, rid=_id(2), created="2026-08-24 09:00:00", title="Auto", payload={"auto_root": True})
    _bm(conn, rid=_id(3), created="2026-08-24 09:00:01", title="Decks",
        payload={"auto_type": "deck"}, parent=_id(2))
    _bm(conn, rid=_id(4), created="2026-08-24 09:00:02", title="a deck",
        payload={"entity_type": "deck", "entity_id": "d1"}, parent=_id(3),
        bookmark_type="favorite")
    conn.commit()
    conn.close()

    mig.dedupe(dry_run=False, db=db)

    rows = _rows(db)
    assert _id(2) not in rows
    assert rows[_id(3)]["parent"] == _id(1), "Decks moved under the surviving root"
    assert rows[_id(4)]["parent"] == _id(3), "its leaf rode along"


def _unscoped_beside_scoped(tmp_path: Path) -> Path:
    """The `oss` shape: a pre-stamping tree with no project_id, plus the tree a
    later show minted inside a real project."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _bm(conn, rid=_id(1), created="2026-07-15 12:16:42", title="Auto",
        payload={"auto_root": True}, project=None)
    _bm(conn, rid=_id(2), created="2026-07-15 12:16:43", title="Files",
        payload={"auto_type": "file"}, parent=_id(1), project=None)
    _bm(conn, rid=_id(3), created="2026-08-24 08:57:14", title="Auto",
        payload={"auto_root": True}, project=PROJECT)
    _bm(conn, rid=_id(4), created="2026-08-31 16:34:59", title="Auto",
        payload={"auto_root": True}, project=OTHER_PROJECT)
    conn.commit()
    conn.close()
    return db


def test_distinct_projects_keep_their_own_roots(tmp_path: Path) -> None:
    """One root per project is the design — never merged across buckets."""
    db = _unscoped_beside_scoped(tmp_path)

    report = mig.dedupe(dry_run=False, db=db)

    assert set(_rows(db)) == {_id(1), _id(2), _id(3), _id(4)}
    assert report.rows_deleted == 0
    # The legacy unscoped tree is reported, so the operator knows it is there.
    assert report.unscoped_trees and "kept" in report.unscoped_trees[0]


def test_drop_unscoped_removes_the_legacy_tree_only_when_asked(tmp_path: Path) -> None:
    db = _unscoped_beside_scoped(tmp_path)

    report = mig.dedupe(dry_run=False, db=db, drop_unscoped=True)

    assert set(_rows(db)) == {_id(3), _id(4)}, "only the unscoped rows go"
    assert report.rows_deleted == 2
    # Its owner edges go with it rather than dangling.
    conn = sqlite3.connect(db)
    try:
        left = {r for (r,) in conn.execute("SELECT to_id FROM relationships")}
    finally:
        conn.close()
    assert left == {_id(3), _id(4)}


def test_an_owner_with_only_an_unscoped_tree_is_left_alone(tmp_path: Path) -> None:
    """Nothing to be duplicated against — a project-less install keeps its tree
    even under --drop-unscoped."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _bm(conn, rid=_id(1), created="2026-07-15 12:16:42", title="Auto",
        payload={"auto_root": True}, project=None)
    conn.commit()
    conn.close()

    report = mig.dedupe(dry_run=False, db=db, drop_unscoped=True)

    assert set(_rows(db)) == {_id(1)}
    assert report.unscoped_trees == []


def test_two_owners_never_merge(tmp_path: Path) -> None:
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _bm(conn, rid=_id(1), created="2026-08-24 08:00:00", title="Auto", payload={"auto_root": True})
    _bm(conn, rid=_id(2), created="2026-08-24 09:00:00", title="Auto",
        payload={"auto_root": True}, owner="11111111-1111-4111-8111-111111111111")
    conn.commit()
    conn.close()

    report = mig.dedupe(dry_run=False, db=db)

    assert set(_rows(db)) == {_id(1), _id(2)}
    assert report.rows_deleted == 0


def test_dedupe_is_idempotent(tmp_path: Path) -> None:
    db = _forked_race(tmp_path)
    mig.dedupe(dry_run=False, db=db)
    after_first = _rows(db)

    second = mig.dedupe(dry_run=False, db=db)

    assert second.groups == [], "a collapsed instance has nothing left to do"
    assert second.rows_deleted == 0 and second.rows_reparented == 0
    assert _rows(db) == after_first


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    db = _forked_race(tmp_path)
    before = _rows(db)

    report = mig.dedupe(dry_run=True, db=db)

    assert report.groups, "the plan still reports the forks"
    assert report.rows_deleted == 0 and report.rows_reparented == 0
    assert _rows(db) == before


def test_missing_entities_table_is_a_no_op(tmp_path: Path) -> None:
    """A fresh instance runs migrations before the server creates its schema."""
    db = tmp_path / "empty.db"
    sqlite3.connect(db).close()

    assert mig.dedupe(dry_run=False, db=db).groups == []
