"""Collapsing forked asset rows must never strand a reference.

The migration repairs damage the owner-first identity fix stops producing:
several live rows claiming one path, and pointers (bookmarks, ``last_shown``,
``display_stack``, relationships) aimed at rows the same-path sweep reaped.

The load-bearing property is ORDER: references are repointed before losers are
deleted, so an interrupted run leaves pointers aimed at a live row.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from flow_sdk.migrations import migration_2026_08_asset_ref_collapse as mig

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"


def _db(tmp_path: Path) -> Path:
    """A minimal stand-in for the entities schema this migration reads."""
    path = tmp_path / "entities.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, data TEXT, "
        "created_date TEXT, updated_date TEXT)"
    )
    conn.execute("CREATE TABLE relationships (from_id TEXT, to_id TEXT, name TEXT)")
    conn.commit()
    conn.close()
    return path


def _row(db: Path, eid: str, type_name: str, data: dict, created="2026-01-01", updated="2026-01-01") -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO entities (id, type, data, created_date, updated_date) VALUES (?,?,?,?,?)",
        (eid, type_name, json.dumps(data), created, updated),
    )
    conn.commit()
    conn.close()


def _plan(db: Path) -> list[mig.Group]:
    conn = sqlite3.connect(db)
    try:
        return mig.plan(conn)
    finally:
        conn.close()


def _data(db: Path, eid: str) -> dict:
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT data FROM entities WHERE id = ?", (eid,)).fetchone()
        return json.loads(row[0]) if row else {}
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Planning
# --------------------------------------------------------------------------

def test_a_clean_db_has_nothing_to_collapse(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"})
    _row(db, B, "markdown", {"asset_ref": "/w/docs/b.md"})
    assert _plan(db) == []


def test_a_forked_path_is_grouped(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"})
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"})

    groups = _plan(db)
    assert len(groups) == 1
    assert {groups[0].winner, *groups[0].losers} == {A, B}


def test_the_referenced_row_survives(tmp_path: Path) -> None:
    """A bookmark is exactly what we are protecting — it decides the winner."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, updated="2026-05-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, updated="2026-09-01")
    _row(db, C, "bookmark", {"data": {"entity_id": A}})

    group = _plan(db)[0]
    assert group.winner == A, "most-referenced beats a newer updated_date"
    assert group.losers == [B]
    assert "referenced" in group.reason


def test_unreferenced_fork_falls_back_to_newest_then_oldest(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, updated="2026-05-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, updated="2026-09-01")
    assert _plan(db)[0].winner == B

    two = tmp_path / "two"
    two.mkdir()
    same = _db(two)
    _row(same, C, "markdown", {"asset_ref": "/w/a.md"}, created="2026-03-01", updated="2026-01-01")
    _row(same, A, "markdown", {"asset_ref": "/w/a.md"}, created="2026-01-01", updated="2026-01-01")
    assert _plan(same)[0].winner == A, "oldest created_date — same rule as PathOwnerIndex"


def test_non_owner_types_are_never_collapsed(tmp_path: Path, monkeypatch) -> None:
    """``Artifact`` legitimately shares an asset's path."""
    monkeypatch.setattr(mig, "_non_owner_types", lambda: frozenset({"artifact"}))
    db = _db(tmp_path)
    _row(db, A, "artifact", {"asset_ref": "/w/docs/a.md"})
    _row(db, B, "artifact", {"asset_ref": "/w/docs/a.md"})
    assert _plan(db) == []


# --------------------------------------------------------------------------
# Repointing
# --------------------------------------------------------------------------

def test_references_are_repointed_in_every_embedding_form(tmp_path: Path) -> None:
    """Both rows are referenced, so the tie falls through to created_date —
    and the loser's references must follow it to the survivor."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-01-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-02-01")
    # A and B end up equally referenced, so the tie falls to created_date.
    _row(db, str(uuid.uuid4()), "bookmark", {"data": {"entity_id": A}})
    _row(db, str(uuid.uuid4()), "bookmark", {"data": {"entity_id": A}})
    # bare id, `<type>-<id>` typeid, and a nested display stack — one pass.
    _row(db, C, "agentic_process", {
        "context_data": {
            "last_shown": {"typeid": f"markdown-{B}", "id": B},
            "display_stack": [{"typeid": f"markdown-{B}"}],
        },
        "private_context_entities_": [f"markdown-{B}"],
    })
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO relationships (from_id, to_id, name) VALUES (?,?,?)", (C, B, "shows"))
    conn.commit()
    conn.close()

    groups = _plan(db)
    assert groups[0].winner == A and groups[0].losers == [B]

    report = mig.Report()
    conn = sqlite3.connect(db)
    mig._repoint(conn, groups, report)
    conn.commit()
    conn.close()

    ctx = _data(db, C)["context_data"]
    assert ctx["last_shown"]["typeid"] == f"markdown-{A}"
    assert ctx["last_shown"]["id"] == A
    assert ctx["display_stack"][0]["typeid"] == f"markdown-{A}"
    assert _data(db, C)["private_context_entities_"] == [f"markdown-{A}"]
    assert report.relationships_repointed >= 1

    conn = sqlite3.connect(db)
    to_id = conn.execute("SELECT to_id FROM relationships").fetchone()[0]
    conn.close()
    assert to_id == A


def test_repointing_leaves_the_survivor_and_bystanders_alone(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-01-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-02-01")
    _row(db, C, "bookmark", {"data": {"entity_id": "unrelated-id"}, "title": "keep me"})

    conn = sqlite3.connect(db)
    mig._repoint(conn, _plan(db), mig.Report())
    conn.commit()
    conn.close()

    assert _data(db, A)["asset_ref"] == "/w/docs/a.md"
    assert _data(db, C) == {"data": {"entity_id": "unrelated-id"}, "title": "keep me"}


def test_repointing_is_idempotent(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-01-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-02-01")
    _row(db, str(uuid.uuid4()), "bookmark", {"data": {"entity_id": A}})
    _row(db, C, "bookmark", {"data": {"entity_id": B}})

    for _ in range(2):
        conn = sqlite3.connect(db)
        mig._repoint(conn, _plan(db), mig.Report())
        conn.commit()
        conn.close()

    assert _data(db, C)["data"]["entity_id"] == A


@pytest.mark.asyncio
async def test_dry_run_writes_nothing(tmp_path: Path, monkeypatch) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-01-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-02-01")
    _row(db, C, "bookmark", {"data": {"entity_id": B}})

    report = await mig.collapse(dry_run=True, db=db)

    assert report.forked_paths == 1 and report.losing_rows == 1
    assert report.rows_deleted == 0 and not report.rows_repointed
    assert _data(db, C)["data"]["entity_id"] == B, "dry-run must not touch a single byte"


# --------------------------------------------------------------------------
# Dangling references — the "Missing asset" damage
# --------------------------------------------------------------------------

def _dangling(db: Path) -> list[mig.Dangling]:
    conn = sqlite3.connect(db)
    try:
        return mig.plan_dangling(conn)
    finally:
        conn.close()


def test_a_bookmark_on_a_reaped_row_is_healed_by_its_path(tmp_path: Path) -> None:
    """The exact prod shape: the row was reaped, the file is still there."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/syllabus.md"})
    _row(db, C, "bookmark", {"data": {"entity_id": B, "nav": {"asset_ref": "/w/docs/syllabus.md"}}})

    found = _dangling(db)
    assert len(found) == 1
    assert found[0].dead_id == B and found[0].live_id == A

    conn = sqlite3.connect(db)
    mig._heal_dangling(conn, found, mig.Report())
    conn.commit()
    conn.close()
    assert _data(db, C)["data"]["entity_id"] == A


def test_a_display_pin_on_a_reaped_row_is_healed_by_its_path(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/syllabus.md"})
    _row(db, C, "agentic_process", {
        "context_data": {
            "last_shown": {"typeid": f"markdown-{B}", "id": B, "path": "/w/docs/syllabus.md"},
            "display_stack": [{"typeid": f"markdown-{B}", "id": B, "path": "/w/docs/syllabus.md"}],
        }
    })

    conn = sqlite3.connect(db)
    mig._heal_dangling(conn, _dangling(db), mig.Report())
    conn.commit()
    conn.close()

    ctx = _data(db, C)["context_data"]
    assert ctx["last_shown"]["typeid"] == f"markdown-{A}"
    assert ctx["display_stack"][0]["id"] == A


def test_a_typeid_prefixed_reference_is_healed_too(tmp_path: Path) -> None:
    """The same field appears both as a bare uuid and as `<type>-<uuid>`."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"})
    _row(db, C, "bookmark", {"data": {"entity_id": f"markdown-{B}", "nav": {"asset_ref": "/w/docs/a.md"}}})

    found = _dangling(db)
    assert len(found) == 1 and found[0].dead_id == B

    conn = sqlite3.connect(db)
    mig._heal_dangling(conn, found, mig.Report())
    conn.commit()
    conn.close()
    assert _data(db, C)["data"]["entity_id"] == f"markdown-{A}"


def test_a_live_reference_is_never_touched(tmp_path: Path) -> None:
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"})
    _row(db, C, "bookmark", {"data": {"entity_id": A, "nav": {"asset_ref": "/w/docs/a.md"}}})
    assert _dangling(db) == []


def test_a_dangling_reference_with_no_recoverable_path_is_left_alone(tmp_path: Path) -> None:
    """Guessing the target of a bare id would be worse than leaving it broken."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"})
    _row(db, C, "bookmark", {"data": {"entity_id": B}})
    assert _dangling(db) == []


def test_a_path_still_claimed_by_several_rows_is_not_used_for_healing(tmp_path: Path) -> None:
    """Ambiguous ownership must not be resolved by coin flip."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"})
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"})
    dead = str(uuid.uuid4())
    _row(db, C, "bookmark", {"data": {"entity_id": dead, "nav": {"asset_ref": "/w/docs/a.md"}}})
    assert _dangling(db) == []


@pytest.mark.asyncio
async def test_collapse_then_heal_end_to_end(tmp_path: Path) -> None:
    """A fork AND a pre-reaped reference in one DB — both repaired, idempotently."""
    db = _db(tmp_path)
    _row(db, A, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-01-01")
    _row(db, B, "markdown", {"asset_ref": "/w/docs/a.md"}, created="2026-02-01")
    dead = str(uuid.uuid4())
    _row(db, C, "bookmark", {"data": {"entity_id": dead, "nav": {"asset_ref": "/w/docs/a.md"}}})

    report = await mig.collapse(dry_run=False, db=db)
    assert report.forked_paths == 1
    assert _data(db, C)["data"]["entity_id"] == A, "the reaped reference now names the survivor"

    again = await mig.collapse(dry_run=False, db=db)
    assert again.forked_paths == 0 and again.dangling == []


def test_worst_case_many_rows_on_one_path_collapses_to_one(tmp_path: Path) -> None:
    """The measured prod worst case was 22 rows for one file."""
    db = _db(tmp_path)
    ids = [str(uuid.uuid4()) for _ in range(22)]
    for i, eid in enumerate(ids):
        _row(db, eid, "markdown", {"asset_ref": "/w/docs/a.md"}, created=f"2026-01-{i + 1:02d}")

    groups = _plan(db)
    assert len(groups) == 1
    assert len(groups[0].losers) == 21
    assert groups[0].winner not in groups[0].losers
