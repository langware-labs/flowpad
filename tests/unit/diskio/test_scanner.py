"""Scanner conformance — stage 1, the walk and the declared scan as one stream (spec §13)."""
from __future__ import annotations

import os

import pytest

from flow_sdk.diskio.contract import (
    ScanCandidate,
    Scanner,
    ScanRequest,
    ScanRoot,
    ShapeSpec,
    TypeScanSpec,
    WalkEntry,
    WalkSpec,
)
from flow_sdk.diskio.python.declared_scanner import PyDeclaredScanner
from flow_sdk.diskio.python.tree_walker import walk_policy
from tests.unit.diskio._backends import backends, drain, touch


@pytest.fixture(params=backends(Scanner))
def scanner(request):
    return request.param()


SPECS = (
    TypeScanSpec(type_name="note", shape=ShapeSpec(kind="file", ext=".md"),
                 walks=(WalkSpec(roots=("real_project_cwd",), mounts=("notes",)),)),
    TypeScanSpec(type_name="kit", shape=ShapeSpec(kind="folder", main="KIT.md"),
                 walks=(WalkSpec(roots=("folder",), mounts=(), anywhere=True),)),
)


def test_each_directorys_candidates_follow_its_entry(scanner, tmp_path):
    touch(tmp_path / "notes" / "a.md")
    touch(tmp_path / "src" / "pkg" / "KIT.md")
    touch(tmp_path / "node_modules" / "dep" / "KIT.md")
    request = ScanRequest(
        roots=(ScanRoot(path=str(tmp_path), kind="real_project_cwd"),),
        policy=walk_policy(file_exts=(".md",)), specs=SPECS,
    )
    body, end = drain(scanner.scan(request))
    seen = [
        ("dir", os.path.relpath(item.dir, tmp_path)) if isinstance(item, WalkEntry)
        else (item.type_name, os.path.relpath(item.path, tmp_path))
        for item in body
    ]
    assert seen == [
        ("note", "notes/a.md"), ("dir", "."),
        ("dir", "notes"),
        ("dir", "src"),
        ("dir", "src/pkg"), ("kit", "src/pkg"),
    ]
    assert end.counts == {"diskio.walk_entry": 4, "diskio.scan_candidate": 2, "diskio.scan_problem": 0}
    kit = next(item for item in body if isinstance(item, ScanCandidate) and item.type_name == "kit")
    assert kit.parent == str(tmp_path / "src" / "pkg") and kit.layout == "folder"


def test_no_roots_is_an_empty_stream(scanner):
    body, end = drain(scanner.scan(ScanRequest(roots=(), policy=walk_policy(), specs=SPECS)))
    assert body == [] and end.counts == {"diskio.walk_entry": 0, "diskio.scan_candidate": 0, "diskio.scan_problem": 0}


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="needs POSIX permissions and a non-root user")
def test_a_directory_that_cannot_be_entered_reads_as_no_asset_and_the_stream_goes_on(scanner, tmp_path):
    touch(tmp_path / "locked" / "KIT.md")
    touch(tmp_path / "open" / "KIT.md")
    request = ScanRequest(roots=(ScanRoot(path=str(tmp_path), kind="real_project_cwd"),),
                          policy=walk_policy(file_exts=()), specs=SPECS)
    (tmp_path / "locked").chmod(0o000)
    try:
        with pytest.raises(PermissionError):  # what the declared scan does on its own today
            PyDeclaredScanner().scan(str(tmp_path / "locked"), "folder", SPECS[1:])
        body, end = drain(scanner.scan(request))
    finally:
        (tmp_path / "locked").chmod(0o755)
    locked = next(item for item in body if isinstance(item, WalkEntry) and item.dir.endswith("locked"))
    assert locked.error is not None and locked.error.detail == "EACCES"
    assert [os.path.relpath(c.path, tmp_path) for c in body if isinstance(c, ScanCandidate)] == ["open"]
    assert end.counts["diskio.scan_problem"] == 0
