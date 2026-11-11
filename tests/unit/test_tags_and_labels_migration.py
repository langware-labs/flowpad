"""``labels`` leaves every row and every stored tag becomes valid — on a real sqlite file."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from flow_sdk.migrations import migration_2026_11_tags_and_labels as mig

ROWS = {
    "note": ("annotation", {"labels": ["note:"], "content": "n"}),
    "quick": ("annotation", {"labels": ["note:", "quick-prompt:"]}),
    "me": ("user", {"labels": ["--user-type--.desktop", "--user--.name-overridden"], "name": "Me"}),
    "contact": ("user", {"labels": None, "name": "Them"}),
    "doc": ("markdown", {"tags": ["[terminal", "Meeting Notes", "smoke]"]}),
    "skill": ("skill", {"tags": [], "metadata": {"tags": ["Team Favorite"], "eval": 1}}),
    "clean": ("task", {"tags": ["crm.lead"], "title": "t"}),
}


def _db(tmp_path: Path) -> Path:
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id VARCHAR(36) NOT NULL PRIMARY KEY, type VARCHAR(50) NOT NULL, data TEXT)")
    conn.executemany("INSERT INTO entities VALUES (?, ?, ?)", [(i, t, json.dumps(d)) for i, (t, d) in ROWS.items()])
    conn.commit()
    conn.close()
    return db


def _rows(db: Path) -> dict[str, dict]:
    conn = sqlite3.connect(db)
    try:
        return {i: json.loads(d) for i, d in conn.execute("SELECT id, data FROM entities")}
    finally:
        conn.close()


def test_labels_move_to_their_fields_and_tags_become_valid(tmp_path):
    db = _db(tmp_path)

    assert set(mig.migrate(dry_run=True, db=db).rewritten) == set(ROWS) - {"clean"}
    assert _rows(db) == {i: d for i, (_t, d) in ROWS.items()}, "a dry run writes nothing"

    mig.migrate(dry_run=False, db=db)
    rows = _rows(db)
    assert not any("labels" in data for data in rows.values())
    assert rows["note"]["subkind"] == "note" and rows["quick"]["subkind"] == "quick_prompt"
    assert rows["me"]["desktop"] is True and rows["me"]["name_overridden"] is True
    assert rows["contact"]["desktop"] is False
    assert rows["doc"]["tags"] == ["terminal", "meeting-notes", "smoke"]
    assert rows["skill"]["tags"] == ["team-favorite"] and rows["skill"]["metadata"]["eval"] == 1
    assert rows["clean"] == ROWS["clean"][1]

    assert mig.migrate(dry_run=False, db=db).rewritten == {}, "a second run finds nothing"
