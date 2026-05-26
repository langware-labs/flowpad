"""Unit tests for flow_sdk.fs_records._claude_projects.

Tests cover:
- _real_path_from_jsonl: reads 'cwd' from a session JSONL file
- iter_claude_project_paths: yields real paths, deduplicates, handles hyphens
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_records._claude_projects import (
    _real_path_from_jsonl,
    iter_claude_project_paths,
)


# ---------------------------------------------------------------------------
# _real_path_from_jsonl
# ---------------------------------------------------------------------------


def test_reads_cwd_from_jsonl(tmp_path: Path) -> None:
    """Returns the Path from the first 'cwd' field found in a JSONL file."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(
        json.dumps({"type": "user", "cwd": "/Users/foo/my-project"}) + "\n"
    )
    result = _real_path_from_jsonl(tmp_path)
    assert result == Path("/Users/foo/my-project")


def test_skips_lines_without_cwd(tmp_path: Path) -> None:
    """Returns the first line that has 'cwd', skipping earlier lines without it."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(
        json.dumps({"type": "assistant", "text": "hello"}) + "\n"
        + json.dumps({"type": "user", "cwd": "/Users/foo/real-path"}) + "\n"
    )
    result = _real_path_from_jsonl(tmp_path)
    assert result == Path("/Users/foo/real-path")


def test_returns_none_when_no_jsonl(tmp_path: Path) -> None:
    """Returns None when there are no JSONL files."""
    result = _real_path_from_jsonl(tmp_path)
    assert result is None


def test_returns_none_when_no_cwd_field(tmp_path: Path) -> None:
    """Returns None when JSONL files exist but none contain 'cwd'."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(json.dumps({"type": "assistant", "text": "hi"}) + "\n")
    result = _real_path_from_jsonl(tmp_path)
    assert result is None


def test_handles_malformed_lines(tmp_path: Path) -> None:
    """Skips malformed JSON lines and continues to valid ones."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(
        "not json at all\n"
        + json.dumps({"cwd": "/Users/foo/ok"}) + "\n"
    )
    result = _real_path_from_jsonl(tmp_path)
    assert result == Path("/Users/foo/ok")


# ---------------------------------------------------------------------------
# iter_claude_project_paths
# ---------------------------------------------------------------------------


def _make_project_dir(
    base: Path,
    encoded_name: str,
    real_cwd: str | None = None,
) -> Path:
    """Create a fake ~/.claude/projects/<encoded> directory."""
    project_dir = base / encoded_name
    project_dir.mkdir(parents=True)
    if real_cwd is not None:
        jsonl = project_dir / "session.jsonl"
        jsonl.write_text(json.dumps({"type": "user", "cwd": real_cwd}) + "\n")
    return project_dir


def test_yields_real_path_from_jsonl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Yields the path decoded from JSONL cwd, not from the encoded name."""
    projects_root = tmp_path / ".claude" / "projects"
    real_dir = tmp_path / "my-project"
    real_dir.mkdir()
    _make_project_dir(projects_root, "-Users-foo-my-project", real_cwd=str(real_dir))

    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert result == [real_dir]


def test_falls_back_to_decode_when_no_jsonl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Falls back to hyphen-decode when _real_path_from_jsonl returns None.

    Uses Path.home() as the target because it round-trips through the naive
    hyphen-decode (only ``/`` and ``_`` segments — no embedded ``-``). Under
    the conftest HOME sandbox, ``Path.home()`` resolves inside
    ``tempfile.gettempdir()``, so ``include_temp=True`` is required to keep
    ``is_temp_path`` from filtering the decoded path out.

    ``_INVALID_PROJECT_ROOTS`` is emptied for this test so the fallback path is
    what we actually exercise, not the safety filter that drops ``/`` / ``$HOME``.
    """
    projects_root = tmp_path / ".claude" / "projects"
    real_dir = Path.home().resolve()
    encoded = "-" + str(real_dir).lstrip("/").replace("/", "-")
    _make_project_dir(projects_root, encoded, real_cwd=None)  # no JSONL

    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    # Patch _real_path_from_jsonl to return None (simulate empty project dir)
    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._real_path_from_jsonl",
        lambda _: None,
    )
    # Neutralize the `/` / `$HOME` safety filter so the decode fallback is
    # what the assertion measures.
    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._invalid_project_roots",
        lambda: set(),
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert result == [real_dir]


def test_deduplicates_same_real_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Does not yield the same real path twice even if two encoded dirs point to it."""
    projects_root = tmp_path / ".claude" / "projects"
    real_dir = tmp_path / "project"
    real_dir.mkdir()
    _make_project_dir(projects_root, "-a", real_cwd=str(real_dir))
    _make_project_dir(projects_root, "-b", real_cwd=str(real_dir))

    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert len(result) == 1
    assert result[0] == real_dir


def test_skips_nonexistent_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Does not yield paths that don't exist on disk."""
    projects_root = tmp_path / ".claude" / "projects"
    _make_project_dir(
        projects_root, "-Users-ghost-nowhere", real_cwd="/Users/ghost/nowhere"
    )  # path does not exist

    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths())
    assert result == []


def test_hyphenated_project_name_resolved_correctly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A project path with hyphens (e.g. flow-cli) is resolved via JSONL, not decode."""
    projects_root = tmp_path / ".claude" / "projects"
    # Real path has a hyphen — naive decode would give wrong result
    real_dir = tmp_path / "flow-cli"
    real_dir.mkdir()
    _make_project_dir(
        projects_root, "-Users-foo-flow-cli", real_cwd=str(real_dir)
    )

    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert result == [real_dir]


def test_empty_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Returns empty list when projects dir exists but is empty."""
    projects_root = tmp_path / ".claude" / "projects"
    projects_root.mkdir(parents=True)

    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    assert list(iter_claude_project_paths()) == []


def test_missing_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Returns empty list when ~/.claude/projects doesn't exist."""
    monkeypatch.setattr(
        "flow_sdk.fs_records._claude_projects._claude_projects_dir",
        lambda: tmp_path / "nonexistent",
    )
    assert list(iter_claude_project_paths()) == []
