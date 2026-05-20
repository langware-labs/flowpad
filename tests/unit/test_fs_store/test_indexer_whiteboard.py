"""Indexer tests for the WHITEBOARD type.

Covers:
- ``whiteboard_fn`` emits one FSRef per whiteboard folder under
  ``<root>/.claude/whiteboards/`` that contains WHITE_BOARD.md.
- ``markdown_in_folder_fn`` does NOT double-index WHITE_BOARD.md as a
  MARKDOWN record (excluded via ``_TYPED_RECORD_DIRS``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import (
    _TYPED_RECORD_DIRS,
    _has_typed_ancestor,
    markdown_in_folder_fn,
)
from flow_sdk.fs_store.indexer.functions.whiteboard import whiteboard_fn
from flow_sdk.fs_store.record_types import RecordType


def _seed_board(folder: Path, name: str, *, with_board_json: bool = True) -> Path:
    board = folder / ".claude" / "whiteboards" / name
    board.mkdir(parents=True)
    (board / "WHITE_BOARD.md").write_text(
        "---\nid: bid-" + name + "\nname: " + name + "\n---\n\n# " + name + "\n",
        encoding="utf-8",
    )
    if with_board_json:
        (board / "board.json").write_text(
            '{"kind":"excalidraw","version":1,"data":{"type":"excalidraw","elements":[]}}',
            encoding="utf-8",
        )
    return board


@pytest.mark.asyncio
async def test_whiteboard_fn_emits_one_ref_per_folder(tmp_path: Path) -> None:
    """A user-home-style root containing two whiteboard folders → 2 refs."""
    home = tmp_path / "home"
    home.mkdir()
    _seed_board(home, "Board A")
    _seed_board(home, "Board B")
    # A bare folder without WHITE_BOARD.md must be skipped.
    skip = home / ".claude" / "whiteboards" / "no-doc"
    skip.mkdir(parents=True)

    indexer = FSIndexer(
        roots=[FSRef(home, record_type=RecordType.USER_HOME_FOLDER)],
    )
    indexer.add_function(RecordType.USER_HOME_FOLDER, whiteboard_fn)

    nodes = await indexer.scan(IndexerOptions(verbose=False))

    wb_nodes = [n for n in nodes if n.record_type == RecordType.WHITEBOARD]
    assert len(wb_nodes) == 2
    paths = sorted(n.path for n in wb_nodes)
    assert paths[0].endswith("/Board A")
    assert paths[1].endswith("/Board B")


@pytest.mark.asyncio
async def test_whiteboard_fn_dedups_across_overlapping_roots(tmp_path: Path) -> None:
    """The same folder discovered via two roots is emitted only once."""
    home = tmp_path / "home"
    home.mkdir()
    _seed_board(home, "Single")

    indexer = FSIndexer(
        roots=[
            FSRef(home, record_type=RecordType.USER_HOME_FOLDER),
            FSRef(home, record_type=RecordType.USER_HOME_FOLDER),
        ],
    )
    indexer.add_function(RecordType.USER_HOME_FOLDER, whiteboard_fn)

    nodes = await indexer.scan(IndexerOptions(verbose=False))
    wb_nodes = [n for n in nodes if n.record_type == RecordType.WHITEBOARD]
    # Dedup happens inside whiteboard_fn via the ``seen`` set.
    assert len(wb_nodes) == 1


def test_typed_record_dirs_includes_whiteboards() -> None:
    """The MARKDOWN folder exclusion must list ``whiteboards``."""
    assert "whiteboards" in _TYPED_RECORD_DIRS


def test_has_typed_ancestor_blocks_whiteboard_paths(tmp_path: Path) -> None:
    """A WHITE_BOARD.md sitting under ``.../whiteboards/<name>/`` must be
    recognised as living under a typed-record dir, so the generic
    markdown indexer skips its folder."""
    folder = tmp_path / "proj" / ".claude" / "whiteboards" / "My Board"
    folder.mkdir(parents=True)
    assert _has_typed_ancestor(folder) is True


@pytest.mark.asyncio
async def test_markdown_in_folder_skips_whiteboard_md(tmp_path: Path) -> None:
    """Drive ``markdown_in_folder_fn`` directly with a FOLDER ref pointing
    at a whiteboard folder; the function must return no MARKDOWN refs."""
    home = tmp_path / "home"
    home.mkdir()
    board_folder = _seed_board(home, "Board")

    folder_ref = FSRef(
        board_folder,
        record_type=RecordType.FOLDER,
    )
    refs = await markdown_in_folder_fn([folder_ref], IndexerOptions(verbose=False))
    md_refs = [r for r in refs if r.record_type == RecordType.MARKDOWN]
    assert md_refs == [], (
        "WHITE_BOARD.md must not be double-indexed as MARKDOWN "
        f"(got {[r.path for r in md_refs]})"
    )
