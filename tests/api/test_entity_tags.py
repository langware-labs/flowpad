"""An entity's ``tags`` — the one classification field, for every type.

The write door (``POST|DELETE <type>/<id>/tags/<name>``) converts what it is given,
and a tag stays where its type keeps it: the file header for a doc, the record shadow
for a type whose file carries no ``tags``.
"""

import pytest

from flow_sdk.builtin.usage_report import UsageReport
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.server.search_filters import apply_tag_filter, wanted_tags

pytestmark = pytest.mark.asyncio


async def _index(root, type_name: str, *, force: bool = False):
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for(type_name))
    await idx.index(IndexerOptions(verbose=False, types=[RecordType(type_name)], force=force))
    cls = SchemaRegistry.get_entity_cls(type_name)
    return [row for row in await cls.get_all() if str(root.resolve()) in str(getattr(row, "asset_ref", ""))]


async def test_the_action_converts_adds_and_removes(client):
    report = await UsageReport(name="tagged", period="day").save()
    url = f"/api/v1/graph/usage_report/{report.id}/tags"

    added = await client.post(f"{url}/Hot Lead")
    assert added.json()["data"]["tags"] == ["hot-lead"], added.text
    await client.post(f"{url}/crm.lead")
    again = await client.post(f"{url}/hot-lead")
    assert again.json()["data"]["tags"] == ["hot-lead", "crm.lead"]

    removed = await client.delete(f"{url}/hot-lead")
    assert removed.json()["data"]["tags"] == ["crm.lead"]
    assert (await UsageReport.get_by_id(report.id)).tags == ["crm.lead"]
    assert (await client.post(f"{url}/!!!")).status_code == 400


async def test_a_doc_keeps_its_tags_in_the_file(tmp_path):
    root = tmp_path / "proj"
    (root / "docs").mkdir(parents=True)
    doc = root / "docs" / "plan.md"
    doc.write_text('---\ntitle: Plan\ntags: "[Meeting Notes, q4]"\n---\n# Plan\n', encoding="utf-8")
    await get_db_driver().delete_entities_by_type("markdown")

    (entity,) = await _index(root, "markdown")
    assert entity.tags == ["meeting-notes", "q4"]

    await entity.add_tag("crm.lead")
    assert "crm.lead" in doc.read_text(encoding="utf-8") and "# Plan" in doc.read_text(encoding="utf-8")
    (entity,) = await _index(root, "markdown", force=True)
    assert entity.tags == ["meeting-notes", "q4", "crm.lead"]


async def test_a_tag_on_a_type_without_header_tags_survives_a_rebuild(tmp_path):
    root = tmp_path / "proj"
    (root / ".claude" / "agents").mkdir(parents=True)
    source = root / ".claude" / "agents" / "helper.md"
    source.write_text("---\nname: helper\ndescription: helps\n---\nYou help.\n", encoding="utf-8")
    driver = get_db_driver()
    await driver.delete_entities_by_type("subagent")

    (entity,) = await _index(root, "subagent")
    await entity.add_tag("team.support")
    before = source.read_text(encoding="utf-8")

    (entity,) = await _index(root, "subagent", force=True)
    assert entity.tags == ["team.support"]

    await driver.delete_entities_by_type("subagent")  # the index is gone; the shadow is not
    (entity,) = await _index(root, "subagent", force=True)
    assert entity.tags == ["team.support"]
    assert source.read_text(encoding="utf-8") == before, "the tag never enters a file that does not carry tags"


async def test_search_filters_by_a_parent_tag_inside_the_query(tmp_path):
    root = tmp_path / "proj"
    (root / "docs").mkdir(parents=True)
    for name, tags in (("one", ""), ("two", ""), ("three", "tags: [crm.lead]\n")):
        (root / "docs" / f"{name}.md").write_text(f"---\ntitle: budget {name}\n{tags}---\nbudget\n", encoding="utf-8")
    await get_db_driver().delete_entities_by_type("markdown")
    docs = await _index(root, "markdown")

    found = await Entity.search("budget", limit=1, tags=["crm"])  # the tagged doc, wherever it ranks
    assert [e.title for e in found] == ["budget three"]
    assert [e.title for e in apply_tag_filter(docs, wanted_tags("CRM"))] == ["budget three"]
    assert apply_tag_filter(docs, ["crm.lead.hot"]) == []


async def test_a_skill_header_carries_its_tags(tmp_path):
    root = tmp_path / "proj"
    skill = root / ".claude" / "skills" / "tagged-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: tagged-skill\ndescription: d\ntags: [Team Favorite]\n---\nDo it.\n", encoding="utf-8")
    await get_db_driver().delete_entities_by_type("skill")

    (entity,) = await _index(root, "skill")
    assert entity.tags == ["team-favorite"]
    await entity.add_tag("crm")
    assert "crm" in (skill / "SKILL.md").read_text(encoding="utf-8")
