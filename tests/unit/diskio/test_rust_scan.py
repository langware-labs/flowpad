"""The Rust scanner's adapter and the one switch.

A stream that cannot be trusted is refused (never a shorter result), a refused
stream is re-run on Python, a missing or mismatched binary fails open, and an
indexer scan gives the same refs whichever backend the switch names.
"""
from __future__ import annotations

import json
import stat
import sys
from pathlib import Path

import pytest

from flow_sdk.diskio import contract, select, stage1
from flow_sdk.diskio.contract import ScanRequest, ScanRoot, ShapeSpec, TypeScanSpec, WalkSpec
from flow_sdk.diskio.python.scanner import PyScanner
from flow_sdk.diskio.python.tree_walker import walk_policy
from flow_sdk.diskio.rust import scan as rust_scan
from flow_sdk.diskio.rust.scan import RustScanner, scan_binary_path
from flow_sdk.diskio.stage1 import StreamFailure
from tests.unit.diskio._backends import touch

HAS_BINARY = scan_binary_path() is not None
needs_binary = pytest.mark.skipif(not HAS_BINARY, reason="no flowpad-diskio-scan binary on this machine")

SPECS = (
    TypeScanSpec(type_name="kit", shape=ShapeSpec(kind="folder", main="KIT.md"),
                 walks=(WalkSpec(roots=("folder",), mounts=(), anywhere=True),)),
)


def _request(root: Path) -> ScanRequest:
    return ScanRequest(roots=(ScanRoot(path=str(root.resolve()), kind="real_project_cwd"),),
                       policy=walk_policy(file_exts=()), specs=SPECS)


def _tree(tmp_path: Path) -> Path:
    touch(tmp_path / "a" / "KIT.md")
    touch(tmp_path / "b" / "c" / "KIT.md")
    touch(tmp_path / "node_modules" / "x" / "KIT.md")
    return tmp_path


def _stub(tmp_path: Path, body: str, version: int = contract.CONTRACT_VERSION) -> Path:
    """A fake scan binary: answers --contract-version, else runs ``body``."""
    path = tmp_path / "stub-scan"
    path.write_text(
        f"#!{sys.executable}\nimport json, sys\n"
        f"if sys.argv[1:] == ['--contract-version']:\n    print({version}); sys.exit(0)\n"
        f"sys.stdin.read()\n{body}\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


ENTRY = json.dumps({"spec_kind": "diskio.walk_entry", "dir": "/x", "subdirs": [], "files": [], "error": None})


@pytest.mark.parametrize("body, why", [
    (f"print('{ENTRY}')", "no terminal StreamEnd"),
    (f"print('{ENTRY}'); print(json.dumps({{'spec_kind': 'diskio.stream_end', 'counts': {{'diskio.walk_entry': 2}}}}))", "terminal says"),
    (f"print('{ENTRY}'); sys.exit(3)", "exited 3"),
    ("print('not json')", "unreadable stream line"),
    (f"print(json.dumps({{'spec_kind': 'diskio.stream_end', 'counts': {{}}}})); print('{ENTRY}')", "follows the terminal"),
])
def test_an_untrustworthy_stream_is_refused(tmp_path, body, why):
    scanner = RustScanner(_stub(tmp_path, body))
    with pytest.raises(StreamFailure, match=why):
        stage1._collect(scanner, _request(tmp_path))


@pytest.fixture
def switch(selector):
    selector.setenv(select.ENV_DISKIO_BACKEND, "rust")
    return selector


def _python_items(request):
    return stage1._collect(PyScanner(), request)


def test_a_refused_stream_is_rerun_on_python_complete(tmp_path, switch):
    tree = _tree(tmp_path / "tree")
    stub = _stub(tmp_path, f"print('{ENTRY}')")           # dies before the terminal
    select.register(contract.Scanner, "rust", lambda: RustScanner(stub))
    request = _request(tree)
    assert stage1.scan_stage1(request) == _python_items(request)


def test_a_binary_built_for_another_contract_fails_open(tmp_path, switch):
    stub = _stub(tmp_path, "sys.exit(0)", version=contract.CONTRACT_VERSION + 1)
    select.register(contract.Scanner, "rust", lambda: RustScanner(stub))
    assert isinstance(select.kernel(contract.Scanner), PyScanner)


def test_no_binary_fails_open_without_spawning(tmp_path, switch):
    switch.setenv(rust_scan.ENV_SCAN_BIN, str(tmp_path / "absent"))
    spawned: list = []
    switch.setattr(rust_scan.subprocess, "run", lambda *a, **k: spawned.append(a))
    assert scan_binary_path() is None
    assert isinstance(select.kernel(contract.Scanner), PyScanner)
    assert spawned == []


@needs_binary
def test_the_real_binary_answers_what_python_answers(tmp_path, switch):
    request = _request(_tree(tmp_path))
    assert isinstance(select.kernel(contract.Scanner), RustScanner)
    assert stage1.scan_stage1(request) == _python_items(request)


# ── the switch, end to end through the indexer ──────────────────────────────

def _project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    touch(root / ".claude" / "skills" / "one" / "SKILL.md", "---\nname: one\n---\nbody\n")
    touch(root / "tools" / "two" / "SKILL.md", "---\nname: two\n---\nbody\n")
    touch(root / "docs" / "guide.md", "# Guide\n")
    touch(root / "docs" / "deep" / "more.md", "# More\n")
    touch(root / "node_modules" / "dep" / "SKILL.md", "x")
    touch(root / ".gitignore", "ignored/\n")
    touch(root / "ignored" / "three" / "SKILL.md", "x")
    return root


async def _scan_refs(root: Path) -> list[tuple]:
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.auto_index import ScanMode
    from flow_sdk.fs_store.indexer.builtin import build_default_indexer
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.fs_store.record_types import RecordType

    indexer = build_default_indexer(scan_mode=ScanMode.THREAD)
    roots = (FSRef(root, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id="p-1"),)
    refs = await indexer.scan(IndexerOptions(roots=roots))
    return [
        (ref.path, str(ref.record_type), ref.json_path, ref._parent.path if ref._parent else None,
         ref.scope, ref.project_id,
         (ref.layout.kind.value, str(ref.layout.root), str(ref.layout.body)) if ref.layout else None)
        for ref in refs
    ]


@needs_binary
async def test_one_line_switches_the_indexer_scan_and_the_refs_are_the_same(tmp_path, monkeypatch):
    root = _project(tmp_path)
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "python")
    python_refs = await _scan_refs(root)
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    used: list = []
    real = stage1.scan_stage1
    monkeypatch.setattr(stage1, "scan_stage1", lambda request: used.append(1) or real(request))
    rust_refs = await _scan_refs(root)
    assert used, "the rust backend was never asked"
    assert rust_refs == python_refs
    assert any(kind == "skill" for _p, kind, *_ in rust_refs)


async def test_a_broken_binary_still_gives_the_full_python_scan(tmp_path, switch):
    root = _project(tmp_path / "t")
    switch.setenv(select.ENV_DISKIO_BACKEND, "python")
    expected = await _scan_refs(root)
    switch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    stub = _stub(tmp_path, f"print('{ENTRY}')")
    select.register(contract.Scanner, "rust", lambda: RustScanner(stub))
    assert await _scan_refs(root) == expected


# ── the shared walk follows the same switch ─────────────────────────────────

def _walked(root: Path, **kw) -> list[tuple]:
    from flow_sdk.fs_store.indexer.walk import gitignore_walk

    return [(str(d), [str(s) for s in subs], [str(f) for f in files]) for d, subs, files in gitignore_walk(root, **kw)]


@needs_binary
@pytest.mark.parametrize("kw", [{}, {"include_files": False}, {"gitignore": False},
                                {"gitignore": False, "denylist": False}])
def test_gitignore_walk_is_the_same_walk_on_both_backends(tmp_path, monkeypatch, kw):
    root = _project(tmp_path)
    touch(root / ".claude" / "worktrees" / "wt" / "x.md")
    touch(root / "build" / "out.js")
    (root / "linked").symlink_to(root / "docs", target_is_directory=True)
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "python")
    expected = _walked(root, **kw)
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    asked: list = []
    real = stage1.scan_stage1
    monkeypatch.setattr(stage1, "scan_stage1", lambda request: asked.append(1) or real(request))
    assert _walked(root, **kw) == expected
    # Rust is asked only where .gitignore matching is the cost; the rest stays in-process.
    assert bool(asked) is kw.get("gitignore", True)


def test_gitignore_walk_survives_a_broken_binary(tmp_path, switch):
    root = _project(tmp_path / "t")
    switch.setenv(select.ENV_DISKIO_BACKEND, "python")
    expected = _walked(root)
    switch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    stub = _stub(tmp_path, "sys.exit(7)")
    select.register(contract.Scanner, "rust", lambda: RustScanner(stub))
    assert _walked(root) == expected


def test_a_missing_root_walks_nothing_on_either_backend(tmp_path, monkeypatch):
    for backend in ("python", "rust"):
        monkeypatch.setenv(select.ENV_DISKIO_BACKEND, backend)
        assert _walked(tmp_path / "absent") == []
