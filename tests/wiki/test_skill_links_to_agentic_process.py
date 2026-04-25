"""North-star test — a markdown-backed source wikilinks to an agentic process.

Exercises the full wiki layer through production code paths:
  - real record classes (MarkdownRecord, AgenticProcessRecord)
  - real .save() + .sync_to_db()
  - wiki.index hook fires inside sync_to_db
  - resolver hits the entities table
  - LinkStore writes; get_links / get_backlinks read
  - Entity surface mirrors Record surface

No FakeRecord, no insert_entity — just the same APIs callers use.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
from flow_sdk.fs_records.markdown_record import MarkdownRecord
from flow_sdk.fs_records.task import TaskResource


pytestmark = pytest.mark.asyncio


def _write_md(path: Path, body: str, asset_type: str = "doc") -> Path:
    """Write a markdown file with frontmatter to path. Returns the path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nasset_type: {asset_type}\n---\n{body}",
        encoding="utf-8",
    )
    return path


async def test_markdown_source_wikilinks_to_agentic_process(tmp_path):
    # Given: a real agentic process record saved + indexed
    process = AgenticProcessRecord(name="my-process")
    process.save()
    await process.sync_to_db()

    # And: a real markdown record whose body wikilinks to it
    md_path = _write_md(
        tmp_path / "docs" / "my-skill.md",
        "See [[my-process]] for details.",
    )
    source = MarkdownRecord.from_file(md_path)
    source.save()
    await source.sync_to_db()

    # When: outgoing links of the source are queried
    outgoing = source.get_links()

    # Then: one resolved edge to the agentic process
    assert len(outgoing) == 1
    edge = outgoing[0]
    assert edge.src_type == source.type
    assert edge.src_id == source.id
    assert edge.target_type == "agentic_process"
    assert edge.target_id == process.id
    assert edge.raw == "my-process"
    assert edge.line == 1

    # And: backlinks of the agentic process see the same edge in reverse
    backlinks = process.get_backlinks()
    assert len(backlinks) == 1
    back = backlinks[0]
    assert back.src_type == source.type
    assert back.src_id == source.id
    assert back.target_type == "agentic_process"
    assert back.target_id == process.id


async def test_entity_surface_matches_record_surface(tmp_path):
    """Entity.get_links / get_backlinks delegate to the same wiki layer."""
    from flow_sdk.core.entity.entity_model import Entity

    process = AgenticProcessRecord(name="my-process")
    process.save()
    await process.sync_to_db()

    md_path = _write_md(
        tmp_path / "docs" / "ref.md",
        "See [[my-process]].",
    )
    source = MarkdownRecord.from_file(md_path)
    source.save()
    await source.sync_to_db()

    # Entity rows for both records
    source_entity = await Entity.from_record(source)
    process_entity = await Entity.from_record(process)

    # Surface parity
    assert source_entity.get_links() == source.get_links()
    assert process_entity.get_backlinks() == process.get_backlinks()


async def test_record_with_none_wiki_body_is_skipped():
    """A record whose wiki_body() returns None (default Record) must not produce edges."""
    task = TaskResource(id="lifecycle-skip", title="Skip Me", status="To Do")
    task.save()
    await task.sync_to_db()

    # No body → no outgoing edges, no inbound edges
    assert task.get_links() == []
    assert task.get_backlinks() == []


async def test_unresolved_link_stays_in_table(tmp_path):
    """A wikilink to a non-existent target still produces an unresolved row."""
    md_path = _write_md(
        tmp_path / "docs" / "ghost-ref.md",
        "Pointing to [[ghost-target]].",
    )
    source = MarkdownRecord.from_file(md_path)
    source.save()
    await source.sync_to_db()

    outgoing = source.get_links()
    assert len(outgoing) == 1
    assert outgoing[0].raw == "ghost-target"
    assert outgoing[0].target_type is None
    assert outgoing[0].target_id is None
