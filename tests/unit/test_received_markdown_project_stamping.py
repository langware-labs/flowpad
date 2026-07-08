"""Bug #1 — a markdown shared in a conversation and installed locally must be
stamped with the chosen project's project_id, but wasn't.

Drives exactly the install sequence ``handle_attachment_install`` runs for a
staged file-backed markdown entry:

  1. Resolve the target project's mount root + id (the explicit project_id the
     user picked in the review modal — ``Project.fs_storage_mount_path``).
  2. ``_restore_file_backed_entry`` — copies the staged ``docs/<leaf>.md``
     into the project root.
  3. ``_reindex_received_assets(project_root, {MARKDOWN}, project_id=...)`` —
     the project_id MUST be threaded onto the reindex root, or the markdown row
     lands with ``project_id=None`` instead of the chosen project's.

No mocks: real test DB + real FSIndexer + real Project rows, exercising the
same functions the install action calls in sequence.
"""
from __future__ import annotations

from pathlib import Path

import pytest

# Ensure MARKDOWN TypeInfo (main_subdir/extractor/owns) is registered.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.flow_message_bundle import (
    _reindex_received_assets,
    _restore_file_backed_entry,
)
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MD_ID = "d4e5f6a7-3333-4ddd-8eee-bbccddeeff00"
BODY = "SENTINEL-shared-from-conversation"


def _markdown_bundle_entry_dir(tmp_path: Path) -> Path:
    """A single-file markdown bundle attachment entry, as the unified packer
    lays it out: ``attachment/markdown-@<id>/docs/<leaf>.md`` with the id pinned
    into frontmatter."""
    entry_dir = tmp_path / "attachment" / f"markdown-@{MD_ID}"
    leaf = entry_dir / "docs" / "shared-note.md"
    leaf.parent.mkdir(parents=True, exist_ok=True)
    leaf.write_text(
        f'---\nid: {MD_ID}\ntitle: "Shared Note"\n---\n# Shared Note\n\n{BODY}\n',
        encoding="utf-8",
    )
    return entry_dir


async def test_received_markdown_inherits_chosen_project_id(tmp_path: Path) -> None:
    # A real project — the install target the user picked in the review modal.
    project_root = tmp_path / "ziv-shared-project"
    project_root.mkdir(parents=True)
    pid = Project.derive_id_for_path(str(project_root))
    proj = Project(id=pid, name="ziv-shared-project", fs_storage_mount_path=str(project_root))
    await proj.save()

    # 1. The install action resolves the explicit project's mount root + id.
    resolved_root = Path(proj.fs_storage_mount_path)
    assert resolved_root == project_root

    # 2. Restore the staged markdown into the project, exactly as install does.
    assert _restore_file_backed_entry(_markdown_bundle_entry_dir(tmp_path), resolved_root, overwrite=False)
    assert (project_root / "docs" / "shared-note.md").exists()

    # 3. Reindex the installed asset, threading the chosen project_id — the
    #    exact call handle_attachment_install makes.
    await _reindex_received_assets(resolved_root, (RecordType.MARKDOWN,), project_id=pid)

    md_cls = SchemaRegistry.get_entity_cls("markdown")
    assert md_cls is not None, "markdown entity class not registered"
    md = await md_cls.get_one({"id": MD_ID})
    assert md is not None, "reindex did not materialize the received markdown row"

    # THE BUG: the installed markdown must carry the chosen project_id, so
    # opening it lands in that project. Without the project_id threading it is
    # stamped None instead (the FSRef would carry none).
    assert md.project_id == pid, (
        f"installed markdown not stamped with chosen project_id: "
        f"got {md.project_id!r}, expected {pid!r}"
    )
