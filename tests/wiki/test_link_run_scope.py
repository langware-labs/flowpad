"""Links resolved inside an index run come from per-run memory, with the same answers.

An index run holds the SQLite writer lock across a batch of records; resolving
each ``[[link]]`` against the database put a whole-project load inside that lock
per link (52 "database is locked" on prod). Inside ``link_scope`` the answers come
from maps built once per project — these tests pin that they match the database
answers exactly, follow records the run writes, and cost no reads per link.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import event

from flow_sdk import wiki
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.wiki.run_scope import link_scope
from flow_sdk.wiki.service import bind, ensure_default_wiki
from tests.wiki._seed import seed_doc, seed_wiki_project

pytestmark = pytest.mark.asyncio








async def _targets(source: Docs, body: str) -> list[tuple[str, str | None]]:
    await wiki.index("markdown", source.id, body)
    return sorted((link.raw, link.target_id) for link in await wiki.outgoing("markdown", source.id))


async def test_scoped_answers_match_the_database_answers(records_root, tmp_path):
    project = await seed_wiki_project(tmp_path)
    alpha = await seed_doc(project, tmp_path, "Alpha")
    await seed_doc(project, tmp_path, "Beta")
    folder = tmp_path / "beta-skill"
    folder.mkdir()
    await Skill(id=mint_uuid(), name="Beta", uname="Beta", asset_ref=str(folder), project_id=str(project.id)).save()
    await bind(await ensure_default_wiki(project), "Bound", alpha.typeid)
    source = await seed_doc(project, tmp_path, "Source")
    body = "[[Alpha]] [[Beta]] [[Gamma]] [[Bound]]"

    unscoped = await _targets(source, body)
    async with link_scope():
        scoped = await _targets(source, body)

    assert scoped == unscoped
    assert dict(scoped) == {"Alpha": alpha.id, "Beta": None, "Gamma": None, "Bound": alpha.id}


async def test_an_asset_written_earlier_in_the_run_resolves(records_root, tmp_path):
    project = await seed_wiki_project(tmp_path)
    source = await seed_doc(project, tmp_path, "Source")
    async with link_scope() as scope:
        assert dict(await _targets(source, "[[Late]]")) == {"Late": None}  # names now loaded
        late = await seed_doc(project, tmp_path, "Late")
        scope.note(late)
        assert dict(await _targets(source, "[[Late]]")) == {"Late": late.id}


async def test_a_rename_in_the_run_moves_the_word(records_root, tmp_path):
    project = await seed_wiki_project(tmp_path)
    doc = await seed_doc(project, tmp_path, "Old")
    source = await seed_doc(project, tmp_path, "Source")
    async with link_scope() as scope:
        assert dict(await _targets(source, "[[Old]] [[New]]")) == {"Old": doc.id, "New": None}
        doc.name = doc.uname = "New"
        await doc.save()
        scope.note(doc)
        assert dict(await _targets(source, "[[Old]] [[New]]")) == {"Old": None, "New": doc.id}


async def test_without_a_scope_links_resolve_against_the_database(records_root, tmp_path):
    project = await seed_wiki_project(tmp_path)
    source = await seed_doc(project, tmp_path, "Source")
    assert dict(await _targets(source, "[[Fresh]]")) == {"Fresh": None}
    fresh = await seed_doc(project, tmp_path, "Fresh")  # no note(): an editor save has no run
    assert dict(await _targets(source, "[[Fresh]]")) == {"Fresh": fresh.id}


def _count_selects(engine):
    seen = {"n": 0}

    def on_execute(conn, cursor, statement, *args):
        if statement.lstrip().upper().startswith("SELECT"):
            seen["n"] += 1

    event.listen(engine.sync_engine, "before_cursor_execute", on_execute)
    return seen, lambda: event.remove(engine.sync_engine, "before_cursor_execute", on_execute)


async def _index_doc_selects(root: Path, project: Project, links: int) -> int:
    """Index one markdown file with ``links`` links through the real indexer; the reads it costs."""
    (root / "docs").mkdir(parents=True)
    words = " ".join(f"[[asset-{i}]]" for i in range(links))
    (root / "docs" / "source.md").write_text(f"# Source\n\n{words}\n", encoding="utf-8")
    indexer = FSIndexer()
    indexer.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="project", project_id=str(project.id)))
    indexer.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
    seen, stop = _count_selects(get_db_driver().engine)
    try:
        await indexer.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], roots=None))
    finally:
        stop()
    return seen["n"]


async def test_an_index_run_reads_the_same_whether_a_doc_has_one_link_or_many(records_root, tmp_path):
    project = await seed_wiki_project(tmp_path)
    for i in range(30):
        await seed_doc(project, tmp_path, f"asset-{i}")

    one = await _index_doc_selects(tmp_path / "one", project, 1)
    many = await _index_doc_selects(tmp_path / "many", project, 25)

    sources = await Docs.get_all({"project_id": str(project.id), "name": "source"})
    assert len(sources) == 2
    resolved = {link.raw: link.target_id for s in sources for link in await wiki.outgoing("markdown", s.id)}
    assert all(resolved[f"asset-{i}"] for i in range(25))  # the run really resolved them
    assert many == one
