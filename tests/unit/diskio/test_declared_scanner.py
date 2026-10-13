"""DeclaredScanner conformance — typed candidate discovery, spec §3.

Synthetic ``TypeScanSpec``s pin the rules; ``scan_declared`` over every
registered type is the oracle for the export + scan round trip.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
from flow_sdk.assets.scanning import scan_declared, scan_repo_tree
from flow_sdk.diskio.contract import DeclaredScanner, ScanCandidate, ShapeSpec, TypeScanSpec, WalkSpec
from flow_sdk.diskio.python.declared_scanner import type_scan_spec
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.diskio._backends import backends, touch

PROJECT = "real_project_cwd"
posix_user = pytest.mark.skipif(
    os.name == "nt" or os.geteuid() == 0, reason="needs POSIX permissions and a non-root user",
)


@pytest.fixture(params=backends(DeclaredScanner))
def scanner(request):
    return request.param()


def file_type(*mounts: str, recursive: bool = False) -> TypeScanSpec:
    return TypeScanSpec(
        type_name="note", shape=ShapeSpec(kind="file", ext=".md", also=(".mdx",)),
        walks=(WalkSpec(roots=(PROJECT,), mounts=mounts, recursive=recursive),),
    )


def folder_type(*mounts: str, recursive: bool = False) -> TypeScanSpec:
    return TypeScanSpec(
        type_name="kit", shape=ShapeSpec(kind="folder", main="KIT.md"),
        walks=(WalkSpec(roots=(PROJECT,), mounts=mounts, recursive=recursive),
               WalkSpec(roots=("folder",), mounts=mounts, anywhere=True)),
    )


def found(candidates: list[ScanCandidate], root: Path) -> list[tuple[str, str]]:
    return [(os.path.relpath(c.path, root), c.layout) for c in candidates]


def test_file_shape_lists_the_mount_by_extension(scanner, tmp_path):
    touch(tmp_path / "notes" / "b.md")
    touch(tmp_path / "notes" / "a.mdx")
    touch(tmp_path / "notes" / "c.txt")
    touch(tmp_path / "notes" / "deep" / "d.md")
    candidates, problems = scanner.scan(str(tmp_path), PROJECT, [file_type("notes")])
    assert found(candidates, tmp_path) == [("notes/a.mdx", "file"), ("notes/b.md", "file")]
    assert {c.type_name for c in candidates} == {"note"} and {c.parent for c in candidates} == {str(tmp_path)}
    assert problems == []


def test_a_fixed_name_file_shape_is_refused_by_the_exporter():
    from flow_sdk.assets.layout import File, Walk

    info = type("Info", (), {"type_name": "pinned", "shape": File(ext=".md", names=("PINNED.md",)),
                             "walk": (Walk(roots=(PROJECT,), mounts=("notes",)),),
                             "_resolved_layout": (None, None, None)})()
    with pytest.raises(ValueError):
        type_scan_spec(info)


def test_folder_shape_needs_its_main_and_reports_a_folder_without_it(scanner, tmp_path):
    touch(tmp_path / "kits" / "one" / "KIT.md")
    touch(tmp_path / "kits" / "two" / "README.md")
    touch(tmp_path / "kits" / ".hidden" / "x.md")
    touch(tmp_path / "kits" / "loose.md")
    candidates, problems = scanner.scan(str(tmp_path), PROJECT, [folder_type("kits")])
    assert found(candidates, tmp_path) == [("kits/one", "folder")]
    assert [(os.path.relpath(p.path, tmp_path), p.type_name, p.message) for p in problems] == [
        ("kits/two", "kit", "directory in kits/ without KIT.md"),
    ]


def test_a_star_mount_is_a_glob_over_directories(scanner, tmp_path):
    touch(tmp_path / "packs" / "a" / "kits" / "one" / "KIT.md")
    touch(tmp_path / "packs" / "b" / "kits" / "two" / "KIT.md")
    touch(tmp_path / "packs" / "c.md")
    candidates, _ = scanner.scan(str(tmp_path), PROJECT, [folder_type("packs/*/kits")])
    assert found(candidates, tmp_path) == [("packs/a/kits/one", "folder"), ("packs/b/kits/two", "folder")]


def test_recursive_walks_the_whole_mount(scanner, tmp_path):
    touch(tmp_path / "notes" / "a.md")
    touch(tmp_path / "notes" / "deep" / "er" / "b.md")
    touch(tmp_path / "notes" / "deep" / "c.txt")
    candidates, problems = scanner.scan(str(tmp_path), PROJECT, [file_type("notes", recursive=True)])
    assert found(candidates, tmp_path) == [("notes/a.md", "file"), ("notes/deep/er/b.md", "file")]
    assert problems == []


def test_anywhere_folder_shape_asks_whether_the_node_itself_is_the_asset(scanner, tmp_path):
    touch(tmp_path / "pkg" / "KIT.md")
    touch(tmp_path / "plain" / "a.md")
    spec = folder_type("kits")
    candidates, _ = scanner.scan(str(tmp_path / "pkg"), "folder", [spec])
    assert found(candidates, tmp_path) == [("pkg", "folder")]
    assert scanner.scan(str(tmp_path / "plain"), "folder", [spec]) == ([], [])


def test_anywhere_skips_an_entry_already_under_one_of_the_types_mounts(scanner, tmp_path):
    touch(tmp_path / "kits" / "one" / "KIT.md")
    assert scanner.scan(str(tmp_path / "kits" / "one"), "folder", [folder_type("kits")]) == ([], [])


def test_an_anywhere_walk_does_not_scan_its_mounts(scanner, tmp_path):
    touch(tmp_path / "kits" / "one" / "KIT.md")
    spec = TypeScanSpec(type_name="kit", shape=ShapeSpec(kind="folder", main="KIT.md"),
                        walks=(WalkSpec(roots=("folder",), mounts=("kits",), anywhere=True),))
    assert scanner.scan(str(tmp_path), "folder", [spec]) == ([], [])


def test_anywhere_file_shape_looks_at_direct_children(scanner, tmp_path):
    touch(tmp_path / "data" / "a.csv")
    touch(tmp_path / "data" / "b.txt")
    touch(tmp_path / "data" / "deep" / "c.csv")
    spec = TypeScanSpec(type_name="sheet", shape=ShapeSpec(kind="file", ext=".csv"),
                        walks=(WalkSpec(roots=("folder",), mounts=(), anywhere=True),))
    candidates, _ = scanner.scan(str(tmp_path / "data"), "folder", [spec])
    assert found(candidates, tmp_path) == [("data/a.csv", "file")]


def test_a_walk_runs_only_on_the_root_kinds_it_names(scanner, tmp_path):
    touch(tmp_path / "notes" / "a.md")
    assert scanner.scan(str(tmp_path), "user_home_folder", [file_type("notes")]) == ([], [])


def test_appledouble_sidecars_are_skipped(scanner, tmp_path):
    touch(tmp_path / "notes" / "a.md")
    touch(tmp_path / "notes" / "._a.md")
    touch(tmp_path / "kits" / "._junk" / "KIT.md")
    candidates, problems = scanner.scan(str(tmp_path), PROJECT, [file_type("notes"), folder_type("kits")])
    assert found(candidates, tmp_path) == [("notes/a.md", "file")]
    assert problems == []


def test_types_are_emitted_in_spec_order(scanner, tmp_path):
    touch(tmp_path / "notes" / "a.md")
    touch(tmp_path / "kits" / "one" / "KIT.md")
    candidates, _ = scanner.scan(str(tmp_path), PROJECT, [folder_type("kits"), file_type("notes")])
    assert [c.type_name for c in candidates] == ["kit", "note"]


def test_a_symlinked_mount_dedups_on_the_resolved_path(scanner, tmp_path):
    touch(tmp_path / "real" / "a.md")
    (tmp_path / "alias").symlink_to(tmp_path / "real", target_is_directory=True)
    candidates, _ = scanner.scan(str(tmp_path), PROJECT, [file_type("real", "alias")])
    assert found(candidates, tmp_path) == [("real/a.md", "file")]


@posix_user
def test_a_mount_that_cannot_be_listed_is_silently_empty(scanner, tmp_path):
    touch(tmp_path / "notes" / "a.md")
    (tmp_path / "notes").chmod(0o000)
    try:
        assert scanner.scan(str(tmp_path), PROJECT, [file_type("notes")]) == ([], [])
    finally:
        (tmp_path / "notes").chmod(0o755)


@posix_user
def test_a_mount_whose_parent_cannot_be_read_is_one_problem(scanner, tmp_path):
    touch(tmp_path / "vault" / "notes" / "a.md")
    (tmp_path / "vault").chmod(0o000)
    try:
        candidates, problems = scanner.scan(str(tmp_path), PROJECT, [file_type("vault/notes")])
    finally:
        (tmp_path / "vault").chmod(0o755)
    mount = tmp_path / "vault" / "notes"
    assert candidates == []
    assert [(p.path, p.type_name, p.message) for p in problems] == [
        (str(mount), "note", f"[Errno 13] Permission denied: '{mount}'"),
    ]


def _tree(root: Path) -> None:
    touch(root / ".claude" / "skills" / "one" / "SKILL.md")
    touch(root / ".claude" / "skills" / "broken" / "notes.md")
    touch(root / ".claude" / "skills" / "._junk" / "SKILL.md")
    touch(root / ".agents" / "skills" / "two" / "SKILL.md")
    touch(root / ".claude" / "agents" / "helper.md")
    touch(root / ".claude" / "commands" / "run.md")
    touch(root / "docs" / "guide.md")
    touch(root / "docs" / "deep" / "more.md")
    touch(root / "SKILL.md")
    touch(root / "table.csv")
    touch(root / "book.xlsx")


@pytest.mark.parametrize("root_type", ["real_project_cwd", "user_home_folder", "folder"])
def test_every_registered_walk_matches_scan_declared(scanner, tmp_path, root_type):
    _tree(tmp_path)
    infos = [info for info in map(SchemaRegistry.get, map(str, SchemaRegistry.get_all_types()))
             if info is not None and info.walk and info.shape is not None]
    assert {"skill", "subagent", "spreadsheet", "markdown"} <= {info.type_name for info in infos}
    total = 0
    for info in infos:
        oracle = scan_declared(info, tmp_path, root_type)
        candidates, problems = scanner.scan(str(tmp_path), root_type, [type_scan_spec(info)])
        assert [(c.path, c.type_name, c.layout, c.parent) for c in candidates] == [
            (str(c.path), c.type_name, c.layout.kind.value, str(c.traversal_parent)) for c in oracle.candidates
        ], info.type_name
        assert [(p.path, p.type_name, p.message) for p in problems] == [
            (str(i.path), i.type_name, i.message) for i in oracle.issues
        ], info.type_name
        total += len(candidates)
    assert total, "the fixture tree holds assets for this root kind"


def test_a_retired_main_is_still_reported_by_the_repo_tree_scan(tmp_path):
    """``scan_repo_tree`` stays above the kernel (spec §3): the retired-main
    diagnosis is its own and is not a ``ScanProblem``."""
    info = SchemaRegistry.get("agent")
    retired = info.retired_mains[0]
    touch(tmp_path / "agentic-assets" / info.family / "old" / retired)
    result = scan_repo_tree(tmp_path, {info.family: info})
    assert result.candidates == []
    assert [(issue.path, issue.retired) for issue in result.issues] == [
        (tmp_path / "agentic-assets" / info.family / "old", retired),
    ]
