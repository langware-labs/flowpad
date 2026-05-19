"""Unit tests for WhiteboardRecord.

Mirrors the SkillRecord folder-record contract:
- Folder layout (WHITE_BOARD.md + board.json)
- Frontmatter parse / id minting (idempotent, writes back into the file)
- _asset_paths covers both inner files
- wiki_body returns WHITE_BOARD.md body
- discover() picks up boards under user + project .claude/whiteboards/
- default_body seeds a stub with BEGIN/END markers
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from flow_sdk.fs_records.whiteboard_record import (
    AUTO_BEGIN_MARKER,
    AUTO_END_MARKER,
    BOARD_JSON,
    WHITE_BOARD_MD,
    WhiteboardRecord,
    _whiteboard_id_from_name,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_whiteboard_folder(
    folder: Path,
    *,
    fm: str | None = None,
    body: str = "Body text.\n",
    write_board_json: bool = True,
) -> Path:
    """Materialise a whiteboard folder on disk.

    Returns the folder path. ``fm`` is the YAML frontmatter text (without
    the surrounding ``---`` delimiters); pass None to skip frontmatter.
    """
    folder.mkdir(parents=True, exist_ok=True)
    md = folder / WHITE_BOARD_MD
    if fm is None:
        md.write_text(body, encoding="utf-8")
    else:
        md.write_text(f"---\n{fm}\n---\n\n{body}", encoding="utf-8")
    if write_board_json:
        (folder / BOARD_JSON).write_text(
            '{"kind":"excalidraw","version":1,"data":{"type":"excalidraw","elements":[]}}',
            encoding="utf-8",
        )
    return folder


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFolderCreation:
    def test_load_record_from_live_dir(self, tmp_path: Path):
        """load_record() bootstraps from frontmatter when no metadata.json present."""
        folder = _seed_whiteboard_folder(
            tmp_path / "my-board",
            fm="id: abc-123\nname: My Board\ndescription: A test board",
        )
        rec = WhiteboardRecord.load_record(folder)
        assert rec.id == "abc-123"
        assert rec.name == "My Board"
        assert rec.type == RecordType.WHITEBOARD
        assert rec.asset_ref is not None
        assert Path(rec.asset_ref.path) == folder.resolve()

    def test_load_record_falls_back_to_folder_name(self, tmp_path: Path):
        """No frontmatter name → folder name becomes the record's name."""
        folder = _seed_whiteboard_folder(tmp_path / "bare-board", fm=None)
        rec = WhiteboardRecord.load_record(folder)
        assert rec.name == "bare-board"
        # id is derived from name via uuid5 — must be deterministic.
        assert rec.id == _whiteboard_id_from_name("bare-board")


class TestFrontmatterParse:
    def test_yaml_fields_reads_description(self, tmp_path: Path):
        folder = _seed_whiteboard_folder(
            tmp_path / "board",
            fm='id: x\nname: Board\ndescription: "Wide arch"\ntags: [a, b]',
        )
        rec = WhiteboardRecord.load_record(folder)
        fm = rec.yaml_fields
        assert fm.get("description") == "Wide arch"
        assert fm.get("tags") == ["a", "b"]


class TestGenIdIdempotent:
    def test_genid_writes_id_and_is_idempotent(self, tmp_path: Path):
        """First genId() mints + writes; second call returns same id, no rewrite."""
        folder = _seed_whiteboard_folder(
            tmp_path / "no-id-board",
            fm="name: No Id Board",
        )
        ref = FSRef(folder)
        id_1 = WhiteboardRecord.genId(ref)
        # Now the WHITE_BOARD.md should carry the id in its frontmatter.
        text = (folder / WHITE_BOARD_MD).read_text(encoding="utf-8")
        assert f"id: {id_1}" in text
        mtime_after_mint = (folder / WHITE_BOARD_MD).stat().st_mtime
        id_2 = WhiteboardRecord.genId(ref)
        assert id_2 == id_1
        # Idempotent: no rewrite on second call.
        assert (folder / WHITE_BOARD_MD).stat().st_mtime == mtime_after_mint

    def test_genid_preserves_existing_id(self, tmp_path: Path):
        folder = _seed_whiteboard_folder(
            tmp_path / "with-id-board",
            fm="id: stable-uuid-here\nname: Stable",
        )
        ref = FSRef(folder)
        assert WhiteboardRecord.genId(ref) == "stable-uuid-here"
        # ID still present after genId.
        text = (folder / WHITE_BOARD_MD).read_text(encoding="utf-8")
        assert "id: stable-uuid-here" in text


class TestAssetPaths:
    def test_returns_both_inner_files(self, tmp_path: Path):
        folder = _seed_whiteboard_folder(
            tmp_path / "board",
            fm="id: a\nname: Board",
            write_board_json=True,
        )
        rec = WhiteboardRecord.load_record(folder)
        paths = rec._asset_paths()
        names = {p.name for p in paths}
        assert WHITE_BOARD_MD in names
        assert BOARD_JSON in names

    def test_returns_only_existing_files(self, tmp_path: Path):
        folder = _seed_whiteboard_folder(
            tmp_path / "no-json-board",
            fm="id: a\nname: Board",
            write_board_json=False,
        )
        rec = WhiteboardRecord.load_record(folder)
        paths = rec._asset_paths()
        names = {p.name for p in paths}
        assert WHITE_BOARD_MD in names
        assert BOARD_JSON not in names


class TestWikiBody:
    def test_returns_body_text(self, tmp_path: Path):
        folder = _seed_whiteboard_folder(
            tmp_path / "board",
            fm="id: a\nname: Board",
            body="# Heading\n\nProse with [[a wiki link]].\n",
        )
        rec = WhiteboardRecord.load_record(folder)
        body = rec.wiki_body()
        assert body is not None
        assert "[[a wiki link]]" in body


class TestDefaultBody:
    def test_stamps_frontmatter_and_markers(self):
        rec = WhiteboardRecord()

        class _E:
            id = "test-id"
            name = "Sketch"
            description = "Top-level sketch"

        body = rec.default_body(_E())
        assert body is not None
        assert "id: test-id" in body
        assert "name: Sketch" in body
        assert "# Sketch" in body
        assert AUTO_BEGIN_MARKER in body
        assert AUTO_END_MARKER in body
        # Mermaid block must exist and be non-empty.
        assert "```mermaid" in body
        # Non-empty stub keeps mermaid parsers from choking.
        assert "flowchart TD" in body

    def test_returns_none_for_empty_name(self):
        rec = WhiteboardRecord()

        class _E:
            id = "x"
            name = ""
            description = ""

        assert rec.default_body(_E()) is None


class TestDiscover:
    def test_discovers_user_and_project_boards(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    ):
        """``discover()`` walks user + project .claude/whiteboards trees."""
        # Two distinct .claude/whiteboards roots wired via FLOWPAD_WHITEBOARD_DIRS.
        user_root = tmp_path / "user" / ".claude" / "whiteboards"
        proj_root = tmp_path / "proj" / ".claude" / "whiteboards"
        user_root.mkdir(parents=True)
        proj_root.mkdir(parents=True)

        _seed_whiteboard_folder(user_root / "user-board", fm="id: u\nname: User Board")
        _seed_whiteboard_folder(proj_root / "proj-board", fm="id: p\nname: Proj Board")

        monkeypatch.setenv(
            "FLOWPAD_WHITEBOARD_DIRS", f"{user_root}:{proj_root}",
        )
        # Point cwd at a directory with no .claude/whiteboards so the cwd
        # scan doesn't pick up unrelated trees.
        monkeypatch.chdir(tmp_path)

        recs = WhiteboardRecord.discover()
        names = {r.name for r in recs}
        assert "User Board" in names
        assert "Proj Board" in names


# ---------------------------------------------------------------------------
# Search content excludes board.json
# ---------------------------------------------------------------------------


class TestSearchContent:
    def test_includes_md_excludes_json(self, tmp_path: Path):
        folder = _seed_whiteboard_folder(
            tmp_path / "board",
            fm="id: a\nname: Board\ndescription: 'Pithy desc'",
            body="Body content lives here.\n",
        )
        # Add a recognizable string in board.json that must NOT appear in search.
        (folder / BOARD_JSON).write_text(
            '{"kind":"excalidraw","data":{"files":{"abc":"NEEDLE_IN_JSON"}}}',
            encoding="utf-8",
        )
        rec = WhiteboardRecord.load_record(folder)
        sc = rec.search_content
        assert sc is not None
        assert "Board" in sc
        assert "Pithy desc" in sc
        assert "Body content lives here" in sc
        assert "NEEDLE_IN_JSON" not in sc
