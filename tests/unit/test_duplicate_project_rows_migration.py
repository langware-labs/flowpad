"""Merging Project rows that share one mount path.

Builds the shape observed on the `prod` instance over a real sqlite file: two
`flowpad-oss` rows for one folder, the older one carrying the tabs and sessions
and the newer one nothing but the default Wiki its own save created. Plus the
two shapes the merge must refuse — a hub-shared row, and a wiki with entries.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
from pathlib import Path

from flow_sdk.migrations import migration_2026_09_duplicate_project_rows as mig
from flow_sdk.wiki.service import default_wiki_id

MOUNT = "/Users/someone/Flowpad workspace/flowpad-oss"
OTHER_MOUNT = "/Users/someone/Documents/dev/flowpad-oss"
LIVE = "6b4fb358-0eb0-4417-bf71-2ec7e519d7c5"
STRAY = "1255c619-ebfb-4b1a-8649-caa5640f885e"


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


def _project(
    conn: sqlite3.Connection,
    *,
    rid: str,
    created: str,
    mount: str = MOUNT,
    remote: bool = False,
    active: bool = False,
) -> str:
    data: dict = {"name": "flowpad-oss", "fs_storage_mount_path": mount, "remote": remote}
    if active:
        data["last_active_at"] = 1788697327658
        data["last_mode"] = "advanced"
    conn.execute(
        "INSERT INTO entities (id, type, created_by, created_date, updated_date, data)"
        " VALUES (?,?,?,?,?,?)",
        (rid, "project", "owner", created, created, json.dumps(data)),
    )
    return rid


def _default_wiki(conn: sqlite3.Connection, project_id: str) -> str:
    """The deterministic Wiki every `Project.save` creates, with the child edge."""
    wid = str(default_wiki_id(project_id))
    conn.execute(
        "INSERT INTO entities (id, type, created_by, created_date, updated_date, data)"
        " VALUES (?,?,?,?,?,?)",
        (
            wid,
            "wiki",
            "owner",
            "2026-09-05 12:20:57",
            "2026-09-05 12:20:57",
            json.dumps(
                {
                    "name": "flowpad-oss Wiki",
                    "project_id": project_id,
                    "parent_type_id": f"project-{project_id}",
                }
            ),
        ),
    )
    conn.execute(
        "INSERT INTO relationships (id, type, from_id, from_type, to_id, to_type)"
        " VALUES (?,?,?,?,?,?)",
        (f"rel-{wid}", "role", project_id, "project", wid, "wiki"),
    )
    return wid


def _referrer(conn: sqlite3.Connection, rid: str, entity_type: str, project_id: str) -> str:
    """A row that names a project — a tab, a session, whatever carries the scope."""
    conn.execute(
        "INSERT INTO entities (id, type, created_by, created_date, updated_date, data)"
        " VALUES (?,?,?,?,?,?)",
        (
            rid,
            entity_type,
            "owner",
            "2026-09-05 13:00:00",
            "2026-09-05 13:00:00",
            json.dumps({"project_id": project_id, "name": "work"}),
        ),
    )
    return rid


def _blob(conn: sqlite3.Connection, rid: str) -> dict:
    row = conn.execute("SELECT data FROM entities WHERE id = ?", (rid,)).fetchone()
    return json.loads(row[0]) if row else {}


def _ids(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT id FROM entities")}


def _reopen(db: Path):
    """The migration owns its own connection, so every assertion reads the file
    back from disk. `closing` keeps that one line instead of a try/finally."""
    return contextlib.closing(sqlite3.connect(db))


def _duplicate_pair(db: Path) -> sqlite3.Connection:
    """The prod shape: the live row first, the stray five hours later."""
    conn = _schema(db)
    _project(conn, rid=LIVE, created="2026-09-05 12:20:57", active=True)
    _default_wiki(conn, LIVE)
    _referrer(conn, "tab-1", "tab", LIVE)
    _project(conn, rid=STRAY, created="2026-09-05 18:00:31")
    _default_wiki(conn, STRAY)
    conn.commit()
    return conn


def test_merges_the_stray_row_into_the_one_in_use(tmp_path: Path) -> None:
    db = tmp_path / "flowpad.db"
    conn = _duplicate_pair(db)
    conn.close()

    report = mig.dedupe(dry_run=False, db=db)

    assert report.projects_merged == 1
    with _reopen(db) as conn:
        # The stray project AND the wiki its own save minted are gone; the row
        # the instance actually works with is untouched.
        assert STRAY not in _ids(conn)
        assert str(default_wiki_id(STRAY)) not in _ids(conn)
        assert LIVE in _ids(conn)
        assert str(default_wiki_id(LIVE)) in _ids(conn)
        # Exactly one project remains for the folder.
        projects = [
            r[0] for r in conn.execute("SELECT id FROM entities WHERE type = 'project'")
        ]
        assert projects == [LIVE]
        # The stray's edges went with it.
        assert not conn.execute(
            "SELECT 1 FROM relationships WHERE from_id = ? OR to_id = ?", (STRAY, STRAY)
        ).fetchone()


def test_repoints_references_from_the_stray_onto_the_keeper(tmp_path: Path) -> None:
    db = tmp_path / "flowpad.db"
    conn = _duplicate_pair(db)
    # A session that got labelled with the stray id — the reason a scoped list
    # came back empty while the folder plainly had sessions.
    _referrer(conn, "process-1", "agentic_process", STRAY)
    conn.commit()
    conn.close()

    mig.dedupe(dry_run=False, db=db)

    with _reopen(db) as conn:
        assert _blob(conn, "process-1")["project_id"] == LIVE
        assert _blob(conn, "tab-1")["project_id"] == LIVE


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    db = tmp_path / "flowpad.db"
    conn = _duplicate_pair(db)
    conn.close()
    with _reopen(db) as before:
        ids_before = _ids(before)

    report = mig.dedupe(db=db)

    assert report.groups, "the duplicate is still reported"
    assert report.rows_deleted == 0
    with _reopen(db) as after:
        assert _ids(after) == ids_before


def test_rerun_is_a_no_op(tmp_path: Path) -> None:
    db = tmp_path / "flowpad.db"
    conn = _duplicate_pair(db)
    conn.close()
    mig.dedupe(dry_run=False, db=db)

    again = mig.dedupe(dry_run=False, db=db)

    assert again.groups == []
    assert again.rows_deleted == 0


def test_distinct_mount_paths_are_not_duplicates(tmp_path: Path) -> None:
    """Two checkouts of one repo are two projects; only the path decides."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _project(conn, rid=LIVE, created="2026-09-05 12:20:57", mount=MOUNT)
    _project(conn, rid=STRAY, created="2026-09-05 18:00:31", mount=OTHER_MOUNT)
    conn.commit()
    conn.close()

    report = mig.dedupe(dry_run=False, db=db)

    assert report.groups == []
    with _reopen(db) as conn:
        assert {LIVE, STRAY} <= _ids(conn)


def test_refuses_to_merge_a_hub_shared_row(tmp_path: Path) -> None:
    """A remote row's identity has to span both sides; a local row at the same
    path is not the same project."""
    db = tmp_path / "flowpad.db"
    conn = _schema(db)
    _project(conn, rid=LIVE, created="2026-09-05 12:20:57", active=True)
    _project(conn, rid=STRAY, created="2026-09-05 18:00:31", remote=True)
    conn.commit()
    conn.close()

    report = mig.dedupe(dry_run=False, db=db)

    assert report.groups == []
    assert any("remote" in line for line in report.skipped)
    with _reopen(db) as conn:
        assert STRAY in _ids(conn)


def test_refuses_to_drop_a_wiki_that_holds_entries(tmp_path: Path) -> None:
    db = tmp_path / "flowpad.db"
    conn = _duplicate_pair(db)
    stray_wiki = str(default_wiki_id(STRAY))
    conn.execute(
        "INSERT INTO entities (id, type, created_by, created_date, updated_date, data)"
        " VALUES (?,?,?,?,?,?)",
        (
            "entry-1",
            "wiki_entry",
            "owner",
            "2026-09-05 18:30:00",
            "2026-09-05 18:30:00",
            json.dumps({"wiki_id": stray_wiki, "word": "deploy"}),
        ),
    )
    conn.commit()
    conn.close()

    report = mig.dedupe(dry_run=False, db=db)

    assert report.groups == []
    assert any("holds entries" in line for line in report.skipped)
    with _reopen(db) as conn:
        assert STRAY in _ids(conn)
        assert "entry-1" in _ids(conn)
