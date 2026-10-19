"""Indexer tests for the CHART type.

Chart is a REPO asset: it lives at ``<root>/agentic-assets/chart/<name>/``
and is discovered by the generic ``repo_assets_fn``, not a bespoke walker.

Covers:
- ``repo_assets_fn`` emits one FSRef per chart folder carrying CHART.md.
- ``markdown_in_folder_fn`` does NOT double-index CHART.md as a
  MARKDOWN record (excluded via the ``agentic-assets`` ancestor check).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import (
    _has_typed_ancestor,
    markdown_in_folder_fn,
)
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType


def _seed_board(folder: Path, name: str, *, with_board_json: bool = True) -> Path:
    board = folder / "agentic-assets" / "chart" / name
    board.mkdir(parents=True)
    (board / "CHART.md").write_text(
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
async def test_repo_walker_emits_one_ref_per_chart_folder(tmp_path: Path) -> None:
    """A user-home-style root containing two chart folders → 2 refs."""
    home = tmp_path / "home"
    home.mkdir()
    _seed_board(home, "Board A")
    _seed_board(home, "Board B")
    # A bare folder without CHART.md must be skipped (main_file gate).
    skip = home / "agentic-assets" / "chart" / "no-doc"
    skip.mkdir(parents=True)

    indexer = FSIndexer(
        roots=[FSRef(home, record_type=RecordType.USER_HOME_FOLDER)],
    )
    indexer.add_function(RecordType.USER_HOME_FOLDER, repo_assets_fn)

    nodes = await indexer.scan(IndexerOptions(verbose=False))

    wb_nodes = [n for n in nodes if n.record_type == RecordType.CHART]
    assert len(wb_nodes) == 2
    paths = sorted(n.path for n in wb_nodes)
    assert paths[0].endswith("/Board A")
    assert paths[1].endswith("/Board B")


def test_typed_ancestor_covers_every_claimed_family() -> None:
    """Both halves of the typed-dir check are derived, so neither can rot.

    ``agentic-assets`` covers every REPO type at any depth, and the harness
    families come from the registry — which is how ``rules`` is covered at all.
    Hand-listing had missed it, so ``.claude/rules/*.md`` was double-indexed as
    both CLAUDE_RULES and MARKDOWN.
    """
    from flow_sdk.fs_store.indexer.functions.markdown import _typed_record_dirs

    typed = _typed_record_dirs()
    assert {"skills", "agents", "commands", "rules", "workflows"} <= typed
    assert "agentic-assets" in typed
    # Repo families are covered by the container segment, not by name.
    assert "chart" not in typed and "task" not in typed

    repo_root = Path("/r/agentic-assets")
    assert _has_typed_ancestor(repo_root / "chart" / "Board A")
    assert _has_typed_ancestor(repo_root / "spec" / "s" / "nested" / "deep")
    assert _has_typed_ancestor(Path("/r/.claude/rules/style.md").parent)
    assert not _has_typed_ancestor(Path("/r/docs/notes"))


def test_has_typed_ancestor_blocks_chart_paths(tmp_path: Path) -> None:
    """A CHART.md sitting under ``.../agentic-assets/chart/<name>/``
    must be recognised as living under a typed-record dir, so the generic
    markdown indexer skips its folder."""
    folder = tmp_path / "proj" / "agentic-assets" / "chart" / "My Board"
    folder.mkdir(parents=True)
    assert _has_typed_ancestor(folder) is True


@pytest.mark.asyncio
async def test_markdown_in_folder_skips_chart_md(tmp_path: Path) -> None:
    """Drive ``markdown_in_folder_fn`` directly with a FOLDER ref pointing
    at a chart folder; the function must return no MARKDOWN refs."""
    home = tmp_path / "home"
    home.mkdir()
    board_folder = _seed_board(home, "Board")

    folder_ref = FSRef(
        board_folder,
        record_type=RecordType.FOLDER,
    )
    refs = markdown_in_folder_fn([folder_ref], IndexerOptions(verbose=False))
    md_refs = [r for r in refs if r.record_type == RecordType.MARKDOWN]
    assert md_refs == [], (
        "CHART.md must not be double-indexed as MARKDOWN "
        f"(got {[r.path for r in md_refs]})"
    )


@pytest.mark.parametrize(
    ("frontmatter", "expected"),
    [("format: sequence\n", "sequence"), ("format: excalidraw\n", "excalidraw"),
     ("format: mermaid\n", "mermaid"), ("", "excalidraw"), ("format: bogus\n", "excalidraw")],
)
def test_extract_chart_records_the_format(tmp_path: Path, frontmatter: str, expected: str) -> None:
    """``format`` reaches the record metadata; a legacy (format-less) chart is excalidraw."""
    from flow_sdk.assets.types.chart import extract_chart

    folder = tmp_path / "agentic-assets" / "chart" / "c"
    folder.mkdir(parents=True)
    (folder / "CHART.md").write_text(f"---\nname: C\ndescription: d\n{frontmatter}---\n\nbody\n", encoding="utf-8")
    [rec] = extract_chart(FSRef(folder), "00000000-0000-4000-8000-000000000001")
    assert rec.type == RecordType.CHART
    assert rec.name == "C" and rec.description == "d"
    assert rec.metadata["format"] == expected


def test_extract_sequence_chart_never_writes(tmp_path: Path) -> None:
    """The indexer only reads: a stale mirror is left for the editor to regenerate."""
    from flow_sdk.assets.types.chart import extract_chart

    folder = tmp_path / "agentic-assets" / "chart" / "seq"
    folder.mkdir(parents=True)
    doc = "---\nname: Seq\nformat: sequence\nsession: proc-1\n---\n\n"
    (folder / "CHART.md").write_text(doc, encoding="utf-8")
    (folder / "chart.json").write_text(
        '{"participants":[{"id":"a","label":"A"}],"messages":[{"id":"1","from":"a","to":"a","label":"ping"}]}',
        encoding="utf-8",
    )
    [rec] = extract_chart(FSRef(folder), "00000000-0000-4000-8000-000000000002")
    assert (folder / "CHART.md").read_text(encoding="utf-8") == doc
    assert rec.metadata["session"] == "proc-1"


def _seed_docs_chart(project: Path) -> Path:
    chart = project / "docs" / "network" / "x"
    chart.mkdir(parents=True)
    (chart / "CHART.md").write_text("---\nname: x\n---\n\n# x\n", encoding="utf-8")
    (chart / "notes.md").write_text("# chart notes\n", encoding="utf-8")
    (project / "docs" / "network" / "readme.md").write_text("# network\n", encoding="utf-8")
    return chart


@pytest.mark.asyncio
async def test_docs_chart_indexes_once_as_chart_not_markdown(tmp_path: Path) -> None:
    """A folder with CHART.md under ``docs/**`` is a chart; the markdown walk
    fences it, so neither its CHART.md nor its sibling .md is a MARKDOWN doc —
    while ``agentic-assets/chart/`` keeps indexing and plain docs stay markdown."""
    from flow_sdk.fs_store.indexer import build_default_indexer

    project = tmp_path / "proj"
    chart = _seed_docs_chart(project)
    repo_chart = _seed_board(project, "Repo Board")

    refs = await build_default_indexer().scan(IndexerOptions(
        verbose=False,
        roots=(FSRef(project, record_type=RecordType.REAL_PROJECT_CWD, scope="project"),),
        gitignore=True,
    ))

    charts = sorted(Path(r.path).resolve() for r in refs if r.record_type == RecordType.CHART)
    assert charts == sorted([chart.resolve(), repo_chart.resolve()])
    markdown = {Path(r.path).resolve() for r in refs if r.record_type == RecordType.MARKDOWN}
    assert (project / "docs" / "network" / "readme.md").resolve() in markdown
    assert not any(p.is_relative_to(chart.resolve()) for p in markdown)
