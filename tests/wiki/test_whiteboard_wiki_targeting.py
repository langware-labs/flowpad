"""Wiki targeting from markdown → whiteboard.

A markdown doc with body ``[[<board-name>]]`` should produce a wiki edge
pointing to the WhiteboardRecord. Confirms that:

  1. The indexer discovers whiteboard folders (skips MARKDOWN double-index).
  2. WhiteboardRecord.sync_to_db lands the entity in the EntitySchema.
  3. MarkdownRecord.sync_to_db extracts ``[[name]]`` via wiki.index and
     the resolver resolves to the whiteboard's ``(type, id)``.
  4. ``wiki.backlinks(type='whiteboard', id=<board.id>)`` returns one edge
     whose ``src_type='markdown'`` and ``src_id=<doc.id>``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.wiki as wiki
from flow_sdk.fs_records.markdown_record import MarkdownRecord
from flow_sdk.fs_records.whiteboard_record import WhiteboardRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions, build_default_indexer
from flow_sdk.fs_store.record_types import RecordType


pytestmark = pytest.mark.asyncio


def _prepare_vault(root: Path, board_name: str, doc_name: str) -> None:
    """Lay down a markdown doc that links to a whiteboard by name.

        root/
            <doc_name>.md         # body: links to [[<board_name>]]
            <board_name>/
                WHITE_BOARD.md
                board.json
    """
    (root / f"{doc_name}.md").write_text(
        f"---\ntitle: {doc_name}\n---\n\n# {doc_name}\n\nSee [[{board_name}]].\n",
        encoding="utf-8",
    )
    board_dir = root / ".claude" / "whiteboards" / board_name
    board_dir.mkdir(parents=True, exist_ok=True)
    (board_dir / "WHITE_BOARD.md").write_text(
        f"---\nname: {board_name}\ndescription: \"\"\n---\n\n# {board_name}\n",
        encoding="utf-8",
    )
    (board_dir / "board.json").write_text(
        '{"kind":"excalidraw","version":1,"data":{"elements":[],"appState":{},"files":{}}}',
        encoding="utf-8",
    )


async def test_markdown_doc_links_to_whiteboard(tmp_path: Path) -> None:
    # ── 1. Vault on disk ──────────────────────────────────────────────────────
    board_name = "the-cloud-architecture"
    doc_name = "design-notes"
    _prepare_vault(tmp_path, board_name=board_name, doc_name=doc_name)

    # ── 2. Index the temp tree ────────────────────────────────────────────────
    custom_root = FSRef(tmp_path, record_type=RecordType.CWD_ROOT, scope="project")
    indexer = build_default_indexer()
    refs = await indexer.scan(IndexerOptions(
        verbose=False,
        roots=(custom_root,),
        gitignore=False,
    ))

    md_refs = [r for r in refs if r.record_type == RecordType.MARKDOWN]
    wb_refs = [r for r in refs if r.record_type == RecordType.WHITEBOARD]

    # Exactly one markdown file (the .md inside the whiteboard folder must NOT
    # be picked up as MARKDOWN — the _TYPED_RECORD_DIRS exclusion handles this).
    md_basenames = sorted(Path(r.path).name for r in md_refs)
    assert md_basenames == [f"{doc_name}.md"], (
        f"WHITE_BOARD.md leaked into MARKDOWN indexing: {md_basenames}"
    )
    assert len(wb_refs) == 1, f"expected 1 whiteboard, got {len(wb_refs)}"

    # ── 3. Sync both records ──────────────────────────────────────────────────
    # Order matters: whiteboards first, so the markdown's wiki link extraction
    # (run inside MarkdownRecord.sync_to_db) finds the target in the entity
    # table and stores an edge with a populated target_id/target_type. Mirrors
    # the existing tests/wiki/test_wiki_index.py ordering convention.
    wb_records = []
    for r in wb_refs:
        for rec in await WhiteboardRecord.from_fsref(r):
            await rec.sync_to_db()
            wb_records.append(rec)

    md_records = []
    for r in md_refs:
        for rec in await MarkdownRecord.from_fsref(r):
            await rec.sync_to_db()
            md_records.append(rec)

    assert len(md_records) == 1
    assert len(wb_records) == 1
    doc = md_records[0]
    board = wb_records[0]

    # ── 4. Wiki backlinks: doc → board ────────────────────────────────────────
    incoming = await wiki.backlinks(type="whiteboard", id=board.id)
    assert len(incoming) == 1, (
        f"expected 1 backlink to whiteboard {board.id}, got {len(incoming)}: {incoming}"
    )
    edge = incoming[0]
    assert edge.src_type == "markdown"
    assert edge.src_id == doc.id
    assert edge.target_type == "whiteboard"
    assert edge.target_id == board.id
