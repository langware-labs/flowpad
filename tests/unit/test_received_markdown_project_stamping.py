"""Bug #1 — a markdown shared in a conversation and received locally must be
stamped with the CONVERSATION's project_id, but isn't.

Drives exactly the receiver-side unpack sequence ``unpack_bundle`` runs for a
file-backed markdown entry, with the conversation→project resolution that the
stamp depends on:

  1. ``_resolve_project_root_for_conv(conv.id)`` — reads ``conv.project_id``,
     loads the Project, returns its ``fs_storage_mount_path`` (DISCARDS the id).
  2. ``_restore_file_backed_entry`` — copies the bundle's ``docs/<leaf>.md``
     into the project root.
  3. ``_reindex_received_assets(project_root, {MARKDOWN})`` — reindexes WITHOUT
     a project_id (the FSRef at flow_message_bundle.py:541 carries none), so the
     markdown row lands with ``project_id=None`` instead of the conversation's.

No mocks: real test DB + real FSIndexer + real Conversation/Project rows,
exercising the same functions unpack_bundle calls in sequence.
"""
from __future__ import annotations

from pathlib import Path

import pytest

# Ensure MARKDOWN TypeInfo (main_subdir/extractor/owns) is registered.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message_bundle import (
    _reindex_received_assets,
    _resolve_project_root_for_conv,
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


async def test_received_markdown_inherits_conversation_project_id(tmp_path: Path) -> None:
    # A real project — the conversation's owning project (the receiver maps one).
    project_root = tmp_path / "ziv-shared-project"
    project_root.mkdir(parents=True)
    pid = Project.derive_id_for_path(str(project_root))
    proj = Project(id=pid, name="ziv-shared-project", fs_storage_mount_path=str(project_root))
    await proj.save()

    # A real conversation scoped to that project (Ziv's shared-md conversation).
    conv = Conversation(project_id=pid)
    await conv.save()

    # 1. Receiver resolves the conversation's project root — the exact function
    #    unpack_bundle calls at flow_message_bundle.py:989.
    resolved = await _resolve_project_root_for_conv(conv.id)
    assert resolved is not None and Path(resolved[0]) == project_root and resolved[1] == pid, (
        "precondition: conversation resolves to its project root + id"
    )
    resolved_root = resolved[0]

    # 2. Restore the bundle's markdown into the project, exactly as unpack_bundle does.
    assert _restore_file_backed_entry(_markdown_bundle_entry_dir(tmp_path), resolved_root, overwrite=False)
    assert (project_root / "docs" / "shared-note.md").exists()

    # 3. Reindex the received asset — the exact call at flow_message_bundle.py:1199,
    #    threading the conversation's project_id (the half the receive path resolves).
    await _reindex_received_assets(resolved_root, (RecordType.MARKDOWN,), project_id=resolved[1])

    md_cls = SchemaRegistry.get_entity_cls("markdown")
    assert md_cls is not None, "markdown entity class not registered"
    md = await md_cls.get_one({"id": MD_ID})
    assert md is not None, "reindex did not materialize the received markdown row"

    # THE BUG: the received markdown must carry the conversation's project_id, so
    # opening it lands in the conversation's project. It is stamped None instead,
    # because the receive path discards the resolved project_id (the FSRef has none).
    assert md.project_id == pid, (
        f"received markdown not stamped with conversation project_id: "
        f"got {md.project_id!r}, expected {pid!r}"
    )
