"""The ``folder`` source's case in the data source matrix: a watched directory of three files."""
from __future__ import annotations

from contextlib import contextmanager


@contextmanager
def case(monkeypatch, tmp_path):
    root = tmp_path / "watched"
    (root / "sub").mkdir(parents=True)
    for rel, body in (("a.md", "alpha"), ("b.md", "bravo"), ("sub/c.md", "charlie")):
        (root / rel).write_text(body)
    yield {"config": {"root": str(root)}, "fields": {"reflect": "none"}, "files": True}
