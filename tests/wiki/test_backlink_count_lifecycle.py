"""Backlink-count lifecycle test.

Drives wiki cleanup-on-delete:
  1. Create one target + 3 markdown sources linking to it      → backlinks = 3
  2. Delete one source                                          → backlinks = 2
  3. Edit another source's body to remove the wikilink + sync   → backlinks = 1
  4. Delete the target                                          → outgoing edge
                                                                  on the
                                                                  surviving
                                                                  source is
                                                                  also cleaned

Steps 2 and 4 require `wiki.delete_for_id` to be wired into `Entity.delete()`
(and `Entity.delete_by_id`); step 3 already works via `replace_for_source`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
from flow_sdk.fs_records.markdown_record import MarkdownRecord


pytestmark = pytest.mark.asyncio


def _write_md(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nasset_type: doc\n---\n{body}", encoding="utf-8")
    return path


async def test_backlink_count_through_lifecycle(tmp_path):
    # ── 1. Create target + 3 sources linking to it ───────────────────────
    target = AgenticProcessRecord(name="bl-target")
    target.save()
    await target.sync_to_db()

    sources: list[MarkdownRecord] = []
    for i in range(3):
        path = _write_md(
            tmp_path / "docs" / f"src-{i}.md",
            f"See [[bl-target]] from {i}.",
        )
        rec = MarkdownRecord.from_file(path)
        rec.save()
        await rec.sync_to_db()
        sources.append(rec)

    # ── 2. Initial state: 3 backlinks ────────────────────────────────────
    assert len(target.get_backlinks()) == 3, "expected 3 backlinks after creating 3 sources"

    # ── 3. Delete one source: count drops to 2 ───────────────────────────
    await sources[0].unindex()
    assert len(target.get_backlinks()) == 2, (
        "expected 2 backlinks after deleting one source — "
        "wiki.delete_for_id must drop rows where src_id matches the deleted entity"
    )

    # ── 4. Strip wikilink from another source's body, re-sync ────────────
    sources[1].asset_ref._path.write_text(
        "---\nasset_type: doc\n---\nNo more wiki link here.",
        encoding="utf-8",
    )
    # Re-load + sync so wiki.index re-reads the updated body and runs
    # replace_for_source (wipes old edges, inserts none for this source).
    rec_reloaded = MarkdownRecord.from_file(sources[1].asset_ref._path)
    rec_reloaded.save()
    await rec_reloaded.sync_to_db()
    assert len(target.get_backlinks()) == 1, (
        "expected 1 backlink after editing another source's body — "
        "replace_for_source should clean rows whose link text is gone"
    )

    # ── 5. Delete the target: surviving source's outgoing edge cleaned ──
    surviving_source = sources[2]
    # Sanity: before deleting target, the surviving source has one outgoing edge.
    assert len(surviving_source.get_links()) == 1
    await target.unindex()
    # After target delete, the surviving source's outgoing edge to the
    # now-dead target must be hard-deleted from the links table.
    # (The wikilink TEXT in src-2.md still says [[bl-target]]; we don't
    # rewrite source files. But the row in `links` is gone.)
    assert surviving_source.get_links() == [], (
        "expected the last surviving source's outgoing edge to be cleaned — "
        "wiki.delete_for_id must drop rows where target_resolved_id matches the deleted entity"
    )
