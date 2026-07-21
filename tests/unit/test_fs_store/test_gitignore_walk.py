"""Unit tests for ``gitignore_walk`` — the shared pre-order directory walk.

The full gitignore matcher contract (patterns, nesting, force-include) is
covered via ``tests/unit/test_walk_markdown_files.py``; here we pin the
generator's own contract: yield shape/order, the ``gitignore``/``denylist``
flag matrix, ``include_files=False``, and the flowpad state-dir denylist.

Real filesystem trees in ``tmp_path`` — no mocks. Fast.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.indexer.walk import gitignore_walk


def _touch(p: Path, text: str = "x") -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def _rel_dirs(root: Path, **kw) -> list[str]:
    return [
        "." if d == root else d.relative_to(root).as_posix()
        for d, _s, _f in gitignore_walk(root, **kw)
    ]


def test_preorder_yield_shape(tmp_path: Path) -> None:
    _touch(tmp_path / "a.md")
    _touch(tmp_path / "b" / "c" / "deep.md")
    _touch(tmp_path / "z" / "late.md")
    walked = list(gitignore_walk(tmp_path))
    assert [d for d, _s, _f in walked] == [
        tmp_path, tmp_path / "b", tmp_path / "b" / "c", tmp_path / "z",
    ]
    root_dir, root_subs, root_files = walked[0]
    assert root_subs == [tmp_path / "b", tmp_path / "z"]
    assert root_files == [tmp_path / "a.md"]
    # Yielded lists are already-filtered snapshots — sorted ascending.
    _, _, c_files = walked[2]
    assert c_files == [tmp_path / "b" / "c" / "deep.md"]


def test_root_always_yielded_even_when_everything_ignored(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "*\n")
    _touch(tmp_path / "drop.md")
    _touch(tmp_path / "sub" / "x.md")
    walked = list(gitignore_walk(tmp_path))
    assert len(walked) == 1
    d, subs, files = walked[0]
    assert d == tmp_path and subs == [] and files == []


def test_missing_or_file_root_yields_nothing(tmp_path: Path) -> None:
    assert list(gitignore_walk(tmp_path / "nope")) == []
    f = tmp_path / "a.md"
    _touch(f)
    assert list(gitignore_walk(f)) == []


def test_include_files_false_yields_empty_file_lists(tmp_path: Path) -> None:
    _touch(tmp_path / "a.md")
    _touch(tmp_path / "sub" / "b.md")
    walked = list(gitignore_walk(tmp_path, include_files=False))
    assert [d.name for d, _s, _f in walked] == [tmp_path.name, "sub"]
    assert all(files == [] for _d, _s, files in walked)


def test_gitignore_false_denylist_true_skips_only_denylist(tmp_path: Path) -> None:
    _touch(tmp_path / ".gitignore", "drafts/\n")
    _touch(tmp_path / "drafts" / "x.md")
    _touch(tmp_path / "node_modules" / "pkg" / "y.md")
    dirs = _rel_dirs(tmp_path, gitignore=False, denylist=True)
    assert "drafts" in dirs          # .gitignore NOT honored
    assert not any(d.startswith("node_modules") for d in dirs)


def test_gitignore_false_denylist_false_is_pass_through(tmp_path: Path) -> None:
    _touch(tmp_path / "node_modules" / "pkg" / "y.md")
    _touch(tmp_path / ".git" / "notes.md")
    dirs = _rel_dirs(tmp_path, gitignore=False, denylist=False)
    assert "node_modules" in dirs and ".git" in dirs


def test_gitignore_true_implies_denylist(tmp_path: Path) -> None:
    _touch(tmp_path / "node_modules" / "pkg" / "y.md")
    dirs = _rel_dirs(tmp_path, gitignore=True, denylist=False)
    assert not any(d.startswith("node_modules") for d in dirs)


def test_flowpad_state_dirs_denylisted(tmp_path: Path) -> None:
    _touch(tmp_path / "keep.md")
    _touch(tmp_path / ".flow" / "capsules" / "identity.json")
    _touch(tmp_path / ".llm_index" / "summaries" / "abc.summary.md")
    _touch(tmp_path / ".flowpad" / "state.md")
    _touch(tmp_path / ".markdown_index" / "x.md")
    walked = list(gitignore_walk(tmp_path))
    assert [d for d, _s, _f in walked] == [tmp_path]
    assert walked[0][2] == [tmp_path / "keep.md"]


def test_dot_dirs_are_walked(tmp_path: Path) -> None:
    _touch(tmp_path / ".github" / "workflows" / "notes.md")
    dirs = _rel_dirs(tmp_path)
    assert ".github" in dirs and ".github/workflows" in dirs


def test_nested_gitignore_popped_on_backtrack(tmp_path: Path) -> None:
    """A nested .gitignore's pattern must not leak into sibling trees."""
    _touch(tmp_path / "a" / ".gitignore", "secret.md\n")
    _touch(tmp_path / "a" / "secret.md")
    _touch(tmp_path / "b" / "secret.md")
    files = [f for _d, _s, fs in gitignore_walk(tmp_path) for f in fs]
    assert tmp_path / "a" / "secret.md" not in files
    assert tmp_path / "b" / "secret.md" in files
