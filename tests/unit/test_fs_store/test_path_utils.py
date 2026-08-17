"""Tests for ``flow_sdk.fs_store.path_utils.canonical_posix_path``."""

from __future__ import annotations

import unicodedata
from pathlib import Path

from flow_sdk.fs_store.path_utils import canonical_posix_path


def test_returns_forward_slash_form(tmp_path: Path) -> None:
    sub = tmp_path / "a" / "b"
    sub.mkdir(parents=True)
    out = canonical_posix_path(sub)
    assert "\\" not in out
    assert out.endswith("/a/b")


def test_accepts_string_or_path(tmp_path: Path) -> None:
    target = tmp_path / "x"
    target.mkdir()
    assert canonical_posix_path(target) == canonical_posix_path(str(target))


def test_idempotent(tmp_path: Path) -> None:
    target = tmp_path / "y"
    target.mkdir()
    once = canonical_posix_path(target)
    twice = canonical_posix_path(once)
    assert once == twice


def test_resolves_symlink(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    assert canonical_posix_path(link) == canonical_posix_path(real)


def test_nfc_normalization() -> None:
    # café spelled with combining accent (NFD) — must be folded to NFC.
    nfd = "café"
    nfc = "café"
    assert unicodedata.normalize("NFC", nfd) == nfc
    # Use a relative non-existent path so we exercise NFC without resolve()
    # changing the structure. resolve() against a non-existent path just
    # absolutifies; that's fine.
    out_nfd = canonical_posix_path(Path(nfd))
    out_nfc = canonical_posix_path(Path(nfc))
    # Both must be NFC and equal.
    assert out_nfd == out_nfc
    assert unicodedata.is_normalized("NFC", out_nfd)


def test_strips_no_trailing_slash(tmp_path: Path) -> None:
    sub = tmp_path / "with_trailing"
    sub.mkdir()
    out = canonical_posix_path(str(sub) + "/")
    assert not out.endswith("/")


def _system_project_dir(root: Path, name: str = "flowpad_assistant") -> Path:
    """A dir with the shipped-system-project SHAPE: <install>/flow_sdk/system_projects/<name>.

    ``is_system_project_path`` matches structurally (so it recognises the same
    project under any install), so building the real directory shape exercises
    the production predicate rather than a stand-in for it.
    """
    path = root / "flow_sdk" / "system_projects" / name
    path.mkdir(parents=True)
    return path


def test_system_project_is_protected_from_deletion_but_still_a_valid_mount(tmp_path: Path) -> None:
    """The two questions must diverge on exactly this input.

    Undeletable (it lives inside the installed package) yet ownable — the
    conflation is what handed system-project files to the enclosing checkout.
    """
    from flow_sdk.fs_store.path_utils import (
        is_protected_path,
        is_valid_project_cwd,
        is_valid_project_mount,
    )

    system_project = _system_project_dir(tmp_path)

    assert is_protected_path(system_project) is True
    assert is_valid_project_cwd(system_project, include_temp=True) is False
    assert is_valid_project_mount(system_project, include_temp=True) is True


def test_project_mount_gate_keeps_every_refusal_but_the_system_project_one(tmp_path: Path) -> None:
    """Widening is limited to system projects — every other refusal stands."""
    from pathlib import Path as _Path

    from flow_sdk.fs_store.path_utils import is_valid_project_mount

    assert is_valid_project_mount(None) is False
    assert is_valid_project_mount(_Path(_Path(tmp_path).anchor)) is False


def test_only_the_system_project_shape_is_admitted_not_its_neighbours(tmp_path: Path) -> None:
    """Nearness to the install grants nothing; the shape itself is the rule."""
    from flow_sdk.fs_store.path_utils import is_valid_project_mount

    ordinary = tmp_path / "flow_sdk" / "not_system_projects" / "thing"
    ordinary.mkdir(parents=True)
    # Admitted as an ordinary mount (the cwd gate already allows it), NOT via
    # the system-project widening — its parent is not ``system_projects``.
    assert is_valid_project_mount(ordinary, include_temp=True) is True


def test_deepest_mount_owns_a_file_inside_a_nested_system_project(tmp_path: Path) -> None:
    """The bug's shape end-to-end at the resolver: a checkout containing an
    install containing a shipped project. The doc belongs to the INNER project.
    """
    from flow_sdk.fs_store.indexer.roots import deepest_project_id_for_path
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_valid_project_mount

    checkout = tmp_path / "checkout"
    system_project = _system_project_dir(checkout)
    doc = system_project / "docs" / "Troubleshooting" / "Duplicate assets.md"
    doc.parent.mkdir(parents=True)
    doc.write_text("# doc\n")

    candidates = [(checkout, "repo-project"), (system_project, "assistant-project")]
    mounts = tuple(
        (canonical_posix_path(str(p)).rstrip("/"), pid)
        for p, pid in candidates
        if is_valid_project_mount(p, include_temp=True)
    )
    mounts = tuple(sorted(mounts, key=lambda m: len(m[0]), reverse=True))

    assert deepest_project_id_for_path(canonical_posix_path(str(doc)), mounts) == "assistant-project"
