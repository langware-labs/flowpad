"""End-to-end folder-doc + entity subtree + wiki backlinks scenario.

Single scenario, single test. Walks a real temp vault through the production
FSIndexer + MarkdownRecord pipeline + the entity parent/child API + the
existing async wiki layer.

Vault on disk::

    tmp_path/
        Parent/
            parent.md     # frontmatter title=Parent, body links to [[Child]]
            child.md      # frontmatter title=Child

Folder-doc rule:
    ``<Folder>/<folder>.md`` (case-insensitive basename match) is the folder's
    canonical entity. Its siblings in that folder are wired into the entity
    parent/child graph as its children — so ``parent_md.get_children()``
    returns ``[child.md]`` and ``parent_md.get_children_sub_tree()`` returns
    the full descendant set. parent.md itself is the folder; it does NOT
    appear as a sibling of child.md anywhere.

Expectations:
    1. The indexer discovers both ``.md`` files (2 MARKDOWN refs).
    2. After ``sync_to_db`` on each, two ``Docs`` entities exist in the DB.
    3. ``parent_md.get_children()`` returns exactly one EntityChild whose
       value is child.md. ``child_md.get_children()`` is empty.
    4. ``wiki.backlinks(type='markdown', id=<child.md id>)`` returns exactly
       one edge whose ``src_id`` is parent.md's id.

Failing today: the indexer does not yet wire folder-doc parent/child edges
(step 3 will fail). Approve the test, then we add the wiring.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.wiki as wiki
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.fs_store.indexer.functions.markdown import (
    extract_markdown,
    markdown_gen_id as _markdown_gen_id,
)
from flow_sdk.fs_store.fs_ref import FSRef as _FSRef


class MarkdownRecord:
    @staticmethod
    def from_file(p):
        return extract_markdown(_FSRef(p))[0]

    @staticmethod
    def from_fsref(ref):
        # async-compat: the real indexer awaits this; the test will too.
        async def _aw():
            return extract_markdown(ref)
        return _aw()

    @staticmethod
    def asset_hash_for_ref(ref):
        from flow_sdk.fs_store.fs_record import FSRecord as _FSR
        return _FSR.asset_hash_for_ref(ref)

    @staticmethod
    def genId(ref):
        return _markdown_gen_id(ref)
  # alias for tests; uses extract_markdown for parsing
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions, build_default_indexer
from flow_sdk.fs_store.record_types import RecordType


pytestmark = pytest.mark.asyncio


def prep_mock_project_docs(root: Path) -> None:
    """Lay down the test vault on disk:

        root/
            Parent/
                parent.md   # title=Parent, body links to [[Child]]
                child.md    # title=Child
    """
    parent_dir = root / "Parent"
    parent_dir.mkdir()
    (parent_dir / "parent.md").write_text(
        "---\ntitle: Parent\n---\n\n# Parent\n\nLinks to [[Child]].\n",
        encoding="utf-8",
    )
    (parent_dir / "child.md").write_text(
        "---\ntitle: Child\n---\n\n# Child\n",
        encoding="utf-8",
    )


async def test_folder_doc_subtree_and_backlinks(tmp_path: Path) -> None:
    # ── 1. Vault on disk ──────────────────────────────────────────────────────
    prep_mock_project_docs(tmp_path)

    # ── 2. Index the temp tree ────────────────────────────────────────────────
    custom_root = FSRef(
        tmp_path,
        record_type=RecordType.CWD_ROOT,
        scope="project",
    )
    indexer = build_default_indexer()
    refs = await indexer.scan(IndexerOptions(
        verbose=False,
        roots=(custom_root,),
        gitignore=False,
    ))
    md_refs = [r for r in refs if r.record_type == RecordType.MARKDOWN]

    md_basenames = sorted(Path(r.path).name for r in md_refs)
    assert md_basenames == ["child.md", "parent.md"]

    for r in md_refs:
        for rec in await MarkdownRecord.from_fsref(r):
            await rec.sync_to_db()

    by_basename = {Path(d.asset_ref).name: d for d in await Docs.get_all({})}
    assert set(by_basename) == {"parent.md", "child.md"}
    parent_md = by_basename["parent.md"]
    child_md = by_basename["child.md"]

    # ── 3. Folder-doc subtree via entity API ──────────────────────────────────
    children = await parent_md.get_children()
    assert len(children) == 1
    assert children[0].value.typeid == child_md.typeid

    assert await child_md.get_children() == []

    # ── 4. Wiki backlinks ─────────────────────────────────────────────────────
    incoming = await wiki.backlinks(type="markdown", id=child_md.id)
    assert len(incoming) == 1
    edge = incoming[0]
    assert edge.src_type == "markdown"
    assert edge.src_id == parent_md.id
    assert edge.target_type == "markdown"
    assert edge.target_id == child_md.id
