"""Per-type post-sync operations for markdown records.

These are the free-function replacements for what used to live on
``MarkdownRecord``: folder-doc parent/child edge reconciliation.

Wired in via ``TypeInfo.post_sync_fn`` so base ``Record.sync_to_db``
runs it after the standard entity/FTS/wiki writes.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord


async def reconcile_folder_doc_edges(rec: FSRecord) -> None:
    """Wire ``<Folder>/<folder>.md`` as the parent of its sibling .md files.

    For a directory whose basename matches a markdown stem (case-insensitive),
    that markdown file is the "folder doc" and adopts every other .md in the
    same directory as a child entity. attach_child is idempotent so this is
    safe to call on each save regardless of index order.
    """
    parent_path = getattr(rec, "parent_path", None) or ""
    ar = getattr(rec, "_asset_ref", None)
    if not parent_path or ar is None:
        return

    folder = Path(parent_path)
    folder_basename = folder.name
    if not folder_basename:
        return

    try:
        on_disk = list(folder.glob("*.md"))
    except OSError:
        return

    target = folder_basename.lower()
    folder_doc_path = next(
        (p for p in on_disk if p.is_file() and p.stem.lower() == target),
        None,
    )
    if folder_doc_path is None:
        return

    from flow_sdk.builtin.claude_memory_entities import Docs

    siblings = await Docs.get_all({"parent_path": parent_path})
    if not siblings:
        return

    folder_doc = next(
        (d for d in siblings if Path(d.asset_ref) == folder_doc_path),
        None,
    )
    if folder_doc is None:
        return

    if folder_doc.id == rec.id:
        for sib in siblings:
            if sib.id == folder_doc.id:
                continue
            await folder_doc.attach_child(sib.typeid)
        return

    self_entity = next((d for d in siblings if d.id == rec.id), None)
    if self_entity is None:
        return
    await folder_doc.attach_child(self_entity.typeid)
