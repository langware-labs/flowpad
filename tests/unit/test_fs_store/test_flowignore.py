"""A path a ``.flowignore`` excludes is never indexed, scanned or minted.

The walk itself is proven against git in ``tests/unit/diskio/test_ignore_files.py``. Here are the
seams a walk does not cover: the point check for a single path, the indexer's emitted refs (walkers
that list files themselves), the live resolve, the id write, and the orphan rule for rows indexed
before the line was added.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.gitignore import FlowIgnore
from flow_sdk.fs_store.indexer import IndexerOptions, build_default_indexer
from flow_sdk.fs_store.indexer.index_function import _source_gone_orphans
from flow_sdk.fs_store.indexer.reconcile import reconcile
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.resolve import NotAnAsset, resolve_asset
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.diskio._backends import touch


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    touch(root / ".flowignore", "docs/secret.md\n.claude/skills/hidden/\nprivate/\nbuild2/\n")
    touch(root / "docs" / "a.md", "# hi\n")
    touch(root / "docs" / "secret.md", "# hi\n")
    touch(root / ".claude" / "skills" / "shown" / "SKILL.md", "---\nname: shown\n---\nx\n")
    touch(root / ".claude" / "skills" / "hidden" / "SKILL.md", "---\nname: hidden\n---\nx\n")
    touch(root / "private" / ".flowignore", "!*\n")  # never read: its folder is excluded
    touch(root / "private" / "docs" / "p.md", "# hi\n")
    touch(root / "build2")  # a FILE: the folder-only rule does not reach it
    return root


def test_the_point_check_follows_git(project: Path, tmp_path: Path) -> None:
    flowignore = FlowIgnore()
    assert flowignore.excludes(project / "docs" / "secret.md")
    assert not flowignore.excludes(project / "docs" / "a.md")
    assert flowignore.excludes(project / "private" / "docs" / "p.md")
    assert not flowignore.excludes(project / "build2")
    # A .flowignore above the project applies inside it.
    touch(tmp_path / ".flowignore", "proj/docs/a.md\n")
    assert FlowIgnore().excludes(project / "docs" / "a.md")


async def test_the_index_never_emits_a_flowignored_file(project: Path) -> None:
    root = FSRef(project, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id="p")
    refs = await build_default_indexer().scan(IndexerOptions(verbose=False, roots=(root,)))
    found = {Path(r.path).relative_to(project).as_posix() for r in refs
             if r.record_type in (RecordType.MARKDOWN, RecordType.SKILL)}
    assert found == {"docs/a.md", ".claude/skills/shown"}


async def test_a_flowignored_path_does_not_resolve(project: Path) -> None:
    with pytest.raises(NotAnAsset, match="flowignore"):
        await resolve_asset(project / "docs" / "secret.md", write=True)


def test_no_id_is_written_into_a_flowignored_file(project: Path) -> None:
    info = SchemaRegistry.get("markdown")
    secret, shown = project / "docs" / "secret.md", project / "docs" / "a.md"
    reconcile(info, info.layout_of(secret, verify=True), None, None, write=True)
    assert secret.read_text(encoding="utf-8") == "# hi\n"
    reconcile(info, info.layout_of(shown, verify=True), None, None, write=True)
    assert shown.read_text(encoding="utf-8").startswith("---\nid: ")


def test_a_row_whose_file_a_flowignore_now_excludes_is_an_orphan(project: Path) -> None:
    rows = {"gone": (str(project / "docs" / "secret.md"),), "live": (str(project / "docs" / "a.md"),)}
    assert _source_gone_orphans("markdown", set(rows), rows) == {"gone"}
