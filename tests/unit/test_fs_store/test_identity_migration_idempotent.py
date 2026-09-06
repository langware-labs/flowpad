"""The identity migration over a mixed tree: every retired form converted,
every inner-main-file row rewritten, the yaml-only skill reported — and the
second run converts nothing, rewrites nothing and changes no byte."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.migrations import migration_2026_09_identity_live_forms as mig

pytestmark = pytest.mark.timeout(30)

SKILL_ID = "11111111-1111-4111-8111-111111111111"
AGENT_ID = "22222222-2222-4222-8222-222222222222"
NOTE_ID = "33333333-3333-4333-8333-333333333333"
DECK_ID = "44444444-4444-4444-8444-444444444444"
SPEC_ID = "55555555-5555-4555-8555-555555555555"


def _fm(path: Path) -> dict:
    return _yaml_load(_extract_frontmatter(path.read_text(encoding="utf-8")) or "") or {}


def _snapshot(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _rows(db: Path) -> list[tuple[str, str, str]]:
    conn = sqlite3.connect(db)
    try:
        return sorted(
            (rid, rtype, json.loads(blob).get("asset_ref"))
            for rid, rtype, blob in conn.execute("SELECT id, type, data FROM entities")
        )
    finally:
        conn.close()


def _instance(tmp_path: Path) -> tuple[Path, Path]:
    """A home with one asset per retired form plus a yaml-only skill, and a DB
    with one spec row still keyed by its inner ``spec.md``."""
    home = tmp_path / "home"
    skill = home / ".claude" / "skills" / "deploy"
    (skill / ".flow").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: deploy\ndescription: d\n---\n\n# deploy\n", encoding="utf-8")
    (skill / ".flow" / "id").write_text(SKILL_ID + "\n", encoding="utf-8")

    yaml_only = home / ".claude" / "skills" / "yaml-only"
    yaml_only.mkdir()
    (yaml_only / "skill.yaml").write_text("name: yaml-only\n", encoding="utf-8")

    agent = home / ".claude" / "agents" / "helper.md"
    agent.parent.mkdir(parents=True)
    agent.write_text("---\nname: helper\ndescription: h\n---\n\nprompt\n", encoding="utf-8")
    AssetCapsule.from_path(agent).write("identity", CapsuleData(1, {"id": AGENT_ID}))
    AssetCapsule.from_path(agent).write("tag", CapsuleData(1, {"tags": ["keep"]}))

    note = home / "docs" / "note.md"
    note.parent.mkdir(parents=True)
    note.write_text(f"---\nasset_id: {NOTE_ID}\ntitle: Note\n---\n\nnote\n", encoding="utf-8")

    deck = home / "agentic-assets" / "deck" / "pitch"
    (deck / ".flow").mkdir(parents=True)
    (deck / "deck.json").write_text(json.dumps({"title": "pitch", "slides": []}), encoding="utf-8")
    (deck / "pitch.html").write_text("<html></html>", encoding="utf-8")
    (deck / ".flow" / "id").write_text(DECK_ID + "\n", encoding="utf-8")

    spec = home / "agentic-assets" / "spec" / "plan"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text(f"---\nid: {SPEC_ID}\nname: plan\n---\n\nspec\n", encoding="utf-8")

    db = tmp_path / "entities.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, data TEXT, created_date TEXT, updated_date TEXT)"
    )
    conn.execute(
        "INSERT INTO entities (id, type, data, created_date, updated_date) VALUES (?,?,?,?,?)",
        (SPEC_ID, "spec", json.dumps({"name": "plan", "asset_ref": str(spec / "spec.md")}), "2026-01-01", "2026-01-01"),
    )
    conn.commit()
    conn.close()
    return home, db


@pytest.mark.asyncio
async def test_first_run_converts_everything_and_the_second_run_is_a_no_op(tmp_path: Path) -> None:
    home, db = _instance(tmp_path)
    roots = [FSRef(home, record_type=RecordType.USER_HOME_FOLDER, scope="user")]
    schema = tmp_path / "schema"

    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: schema):
        first = await mig.migrate(dry_run=False, db=db, roots=roots)
        after_first = (_snapshot(home), _rows(db))
        second = await mig.migrate(dry_run=False, db=db, roots=roots)

    assert dict(first.converted) == {
        "folder_capsule_id": 2,          # the skill's and the deck's .flow/id
        "capsule": 1,                    # the subagent's comment capsule
        "frontmatter_asset_id": 1,       # the note's asset_id:
    }
    assert not first.unconverted and first.rows_rewritten == 1

    skill_md = home / ".claude" / "skills" / "deploy" / "SKILL.md"
    assert _fm(skill_md)["id"] == SKILL_ID and not (skill_md.parent / ".flow" / "id").exists()
    agent_md = home / ".claude" / "agents" / "helper.md"
    agent_text = agent_md.read_text(encoding="utf-8")
    assert _fm(agent_md)["id"] == AGENT_ID
    assert "flowpad:capsule identity" not in agent_text and "flowpad:capsule tag" in agent_text
    assert _fm(home / "docs" / "note.md") == {"id": NOTE_ID, "title": "Note"}
    deck = home / "agentic-assets" / "deck" / "pitch"
    assert AssetCapsule.from_path(deck).read("identity").data == {"id": DECK_ID}
    assert not (deck / ".flow" / "id").exists()
    assert _rows(db) == [(SPEC_ID, "spec", str(home / "agentic-assets" / "spec" / "plan"))]

    kinds = {(i.kind, Path(i.path).name) for i in first.issues}
    assert ("unclassified_in_family_dir", "yaml-only") in kinds, "a yaml-only skill is not a skill"
    assert {k for k, _ in kinds} <= {"unclassified_in_family_dir"}

    assert not second.converted and not second.unconverted and second.rows == [] and second.rows_rewritten == 0
    assert (_snapshot(home), _rows(db)) == after_first, "second run: zero byte changes, zero row changes"


@pytest.mark.asyncio
async def test_dry_run_reports_and_writes_nothing(tmp_path: Path) -> None:
    home, db = _instance(tmp_path)
    roots = [FSRef(home, record_type=RecordType.USER_HOME_FOLDER, scope="user")]
    before = (_snapshot(home), _rows(db))

    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path / "schema"):
        report = await mig.migrate(dry_run=True, db=db, roots=roots)

    assert dict(report.pending) == {"folder_capsule_id": 2, "capsule": 1, "frontmatter_asset_id": 1}
    assert not report.converted and len(report.rows) == 1 and report.rows_rewritten == 0
    assert (_snapshot(home), _rows(db)) == before
