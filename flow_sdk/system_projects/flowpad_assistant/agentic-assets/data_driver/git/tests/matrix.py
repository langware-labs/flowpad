"""The ``git`` source's case in the data source matrix: a committed repository of two files."""
from __future__ import annotations

from contextlib import contextmanager

from .test_git_source import _repo


@contextmanager
def case(monkeypatch, tmp_path):
    repo = _repo(tmp_path / "repo", {"a.md": "a", "docs/b.md": "b"})
    yield {"config": {"repo": str(repo), "branch": "main"}, "fields": {"reflect": "none"}}
