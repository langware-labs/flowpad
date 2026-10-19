"""No ad-hoc writes to hard-coded ``/tmp`` paths in the backend.

Two leftovers shipped this way: a per-request timing log in ``handle_request``
that grew ``/tmp/bench_open.log`` to 228MB (six writes per API call, on the
event loop), and a macOS open-terminal debug dump that wrote the full command —
env exports included — to a world-readable ``/tmp`` file. Use a logger or
``tempfile`` instead. String literals are frozen per file and may only shrink
(AST walk, so comments and docstrings never count).
"""

from __future__ import annotations

import ast
from collections import Counter
from functools import cache
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk"
SKIP = ("server/static/", "rust/tests/")

#: file → ``/tmp/…`` literals it may carry, with the reason.
ALLOWED = {
    # Paths inside the docker container the enrol command drives, not this host.
    "cli/commands/_docker_enroll.py": 5,
    # A prefix in the list of scratch locations excluded from worker history.
    "builtin/worker_history.py": 1,
}


def _docstrings(tree: ast.AST) -> set[int]:
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                ids.add(id(first.value))
    return ids


@cache
def _tmp_literals() -> Counter:
    found: Counter = Counter()
    for path in ROOT.rglob("*.py"):
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith(SKIP):
            continue
        source = path.read_text(encoding="utf-8")
        if "/tmp/" not in source:
            continue
        tree = ast.parse(source)
        docs = _docstrings(tree)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                    and node.value.startswith("/tmp/") and id(node) not in docs):
                found[rel] += 1
    return found


def test_no_new_hardcoded_tmp_paths():
    found = _tmp_literals()
    over = {f: n for f, n in found.items() if n > ALLOWED.get(f, 0)}
    assert not over, f"hard-coded /tmp paths (use a logger or tempfile): {over}"


def test_allowlist_only_shrinks():
    found = _tmp_literals()
    stale = {f: (n, found.get(f, 0)) for f, n in ALLOWED.items() if found.get(f, 0) < n}
    assert not stale, f"lower these ALLOWED counts to what the files now carry: {stale}"
