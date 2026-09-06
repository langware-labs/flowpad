"""``asset_ref`` is the folder for every folder type. A row written while
agent, spec and the reports pointed it at the inner main file
(``<folder>/agent.md``) is rewritten to the folder by the migration — id
unchanged."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.migrations import migration_2026_09_identity_live_forms as mig
from flow_sdk.schema.layout import Folder

pytestmark = pytest.mark.timeout(30)

AGENT_ID = "11111111-1111-4111-8111-111111111111"


def _db(tmp_path: Path) -> Path:
    path = tmp_path / "entities.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, data TEXT, created_date TEXT, updated_date TEXT)"
    )
    conn.commit()
    conn.close()
    return path


def _row(db: Path, eid: str, type_name: str, data: dict) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO entities (id, type, data, created_date, updated_date) VALUES (?,?,?,?,?)",
        (eid, type_name, json.dumps(data), "2026-01-01", "2026-01-01"),
    )
    conn.commit()
    conn.close()


def _asset_ref(db: Path, eid: str) -> str:
    conn = sqlite3.connect(db)
    try:
        return json.loads(conn.execute("SELECT data FROM entities WHERE id = ?", (eid,)).fetchone()[0])["asset_ref"]
    finally:
        conn.close()


def _agent(home: Path, name: str, entity_id: str) -> Path:
    folder = home / "agentic-assets" / "agent" / name
    folder.mkdir(parents=True)
    (folder / "agent.md").write_text(f"---\nid: {entity_id}\nname: {name}\n---\n\nprompt\n", encoding="utf-8")
    return folder


def test_every_folder_type_refs_its_folder() -> None:
    for name in ("agent", "spec", "agent_trace", "usage_report", "asset_cleanup_report", "skill", "task"):
        info = SchemaRegistry.get(name)
        folder = Path("/w/x")
        assert info.layout_of(folder).ref == folder, name
        assert isinstance(info.shape, Folder), name
        assert info.layout_of(folder / info.shape.main).ref == folder, name


@pytest.mark.asyncio
async def test_migration_rewrites_the_row_to_the_folder_and_keeps_the_id(tmp_path: Path) -> None:
    home = tmp_path / "home"
    folder = _agent(home, "a", AGENT_ID)
    db = _db(tmp_path)
    _row(db, AGENT_ID, "agent", {"name": "a", "asset_ref": str(folder / "agent.md")})
    roots = [FSRef(home, record_type=RecordType.USER_HOME_FOLDER, scope="user")]

    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path / "schema"):
        planned = await mig.migrate(dry_run=True, db=db, roots=roots)
        assert [(m.type_name, m.entity_id, m.new) for m in planned.rows] == [("agent", AGENT_ID, str(folder))]
        assert _asset_ref(db, AGENT_ID) == str(folder / "agent.md"), "dry-run writes nothing"

        applied = await mig.migrate(dry_run=False, db=db, roots=roots)
        assert applied.rows_rewritten == 1
        assert _asset_ref(db, AGENT_ID) == str(folder)
        assert (folder / "agent.md").read_text(encoding="utf-8").startswith(f"---\nid: {AGENT_ID}\n")

        again = await mig.migrate(dry_run=False, db=db, roots=roots)
    assert again.rows == [] and again.rows_rewritten == 0 and not again.converted
