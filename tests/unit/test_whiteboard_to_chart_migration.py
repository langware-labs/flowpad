"""Guards for the 0.2.217 migration that turns every whiteboard into a chart.

Real filesystem, no mocks: ``agentic-assets/whiteboard/<n>/`` →
``agentic-assets/chart/<n>/`` with ``WHITE_BOARD.md`` → ``CHART.md`` carrying
``format: excalidraw``. Ids untouched, idempotent, never overwrites.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/migrations/0.2.217/scripts/migrate.py"
)
_ID = "1f6a7c2e-5b1d-4e0a-9c3f-2d8b7e6a5c41"
_BOARD = '{"kind":"excalidraw","version":1,"data":{"elements":[{"id":"e1"}]}}'


def _load_migration():
    """Load the script the way the runner does (sys.modules first — see 0.2.112's test)."""
    name = "_whiteboard_to_chart_migration"
    spec = importlib.util.spec_from_file_location(name, _SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(name, None)
    return mod


def _seed(root: Path, name: str, doc: str | None = None) -> Path:
    folder = root / "agentic-assets" / "whiteboard" / name
    folder.mkdir(parents=True)
    (folder / "WHITE_BOARD.md").write_text(
        doc if doc is not None else f"---\nid: {_ID}\nname: {name}\ndescription: ''\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    (folder / "board.json").write_text(_BOARD, encoding="utf-8")
    return folder


def test_moves_whiteboard_to_chart_with_format_and_same_id(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, "Board")
    report = m._migrate_root(tmp_path, "project")

    chart = tmp_path / "agentic-assets/chart/Board"
    assert report.moved == [("agentic-assets/whiteboard/Board", "agentic-assets/chart/Board")]
    assert not (tmp_path / "agentic-assets/whiteboard").exists()
    assert not (chart / "WHITE_BOARD.md").exists()
    assert (chart / "CHART.md").read_text() == (
        f"---\nid: {_ID}\nname: Board\ndescription: ''\nformat: excalidraw\n---\n\n# Board\n"
    )
    assert (chart / "board.json").read_text() == _BOARD


def test_document_without_frontmatter_gets_one(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, "Bare", doc="# just prose\n")
    m._migrate_root(tmp_path, "user")
    text = (tmp_path / "agentic-assets/chart/Bare/CHART.md").read_text()
    assert text == "---\nformat: excalidraw\n---\n\n# just prose\n"


def test_auto_block_markers_become_chart_markers(tmp_path: Path):
    m = _load_migration()
    block = "<!-- BEGIN whiteboard:auto -->\n```mermaid\nflowchart TD\n```\n<!-- END whiteboard:auto -->\n"
    _seed(tmp_path, "M", doc=f"---\nname: M\n---\n\n{block}")
    m._migrate_root(tmp_path, "user")
    text = (tmp_path / "agentic-assets/chart/M/CHART.md").read_text()
    assert "whiteboard:auto" not in text
    assert "<!-- BEGIN chart:auto -->\n```mermaid\nflowchart TD\n```\n<!-- END chart:auto -->" in text


def test_existing_format_is_kept(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, "F", doc="---\nname: F\nformat: excalidraw\n---\n")
    m._migrate_root(tmp_path, "user")
    assert (tmp_path / "agentic-assets/chart/F/CHART.md").read_text().count("format:") == 1


def test_never_overwrites_an_existing_chart(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, "Dup", doc="LEGACY")
    existing = tmp_path / "agentic-assets/chart/Dup"
    existing.mkdir(parents=True)
    (existing / "CHART.md").write_text("CURRENT")

    report = m._migrate_root(tmp_path, "project")
    assert report.collisions == ["agentic-assets/whiteboard/Dup"]
    assert report.moved == []
    assert (existing / "CHART.md").read_text() == "CURRENT"
    assert (tmp_path / "agentic-assets/whiteboard/Dup/WHITE_BOARD.md").read_text() == "LEGACY"


def test_idempotent_and_finishes_an_interrupted_run(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, "A")
    m._migrate_root(tmp_path, "project")
    after_first = (tmp_path / "agentic-assets/chart/A/CHART.md").read_bytes()
    assert not m._migrate_root(tmp_path, "project").touched
    assert (tmp_path / "agentic-assets/chart/A/CHART.md").read_bytes() == after_first

    # A chart folder still holding the legacy main doc (moved, not converted).
    half = tmp_path / "agentic-assets/chart/Half"
    half.mkdir()
    (half / "WHITE_BOARD.md").write_text("---\nname: Half\n---\n")
    m._migrate_root(tmp_path, "project")
    assert (half / "CHART.md").read_text() == "---\nname: Half\nformat: excalidraw\n---\n"
    assert not (half / "WHITE_BOARD.md").exists()


def test_run_with_no_roots_is_a_noop(tmp_path: Path, monkeypatch):
    m = _load_migration()
    monkeypatch.setattr(m, "_project_mounts", lambda: [])

    class _Settings:
        user_asset_root = tmp_path / "missing"

    import flow_sdk.instance_settings as settings

    monkeypatch.setattr(settings, "get_instance_settings", lambda: _Settings())
    assert m.run() == []
