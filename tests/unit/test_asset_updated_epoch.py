"""``updated_date`` follows the newest edit INSIDE a folder asset, not only the folder's own mtime.

A directory's mtime does not move when a file in it is edited, so ``_asset_updated_epoch`` folds in
the type's freshness fingerprint. That fingerprint is integer nanoseconds; this pins the unit.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers the types
from flow_sdk.core.entity.entity_model import _asset_updated_epoch

NS = 1_000_000_000


def _skill(tmp_path: Path) -> Path:
    folder = tmp_path / "skills" / "lint"
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text("---\nname: lint\n---\nbody\n")
    return folder


def test_an_inner_file_edit_advances_the_epoch(tmp_path: Path) -> None:
    folder = _skill(tmp_path)
    old = 1_700_000_000
    os.utime(folder / "SKILL.md", ns=(old * NS, old * NS))
    os.utime(folder, ns=(old * NS, old * NS))
    assert _asset_updated_epoch("skill", str(folder)) == pytest.approx(old)

    edited = old + 3600
    os.utime(folder / "SKILL.md", ns=(edited * NS, edited * NS))   # the folder's own mtime stays
    assert os.path.getmtime(folder) == pytest.approx(old)
    assert _asset_updated_epoch("skill", str(folder)) == pytest.approx(edited)


def test_a_fingerprint_that_is_not_a_time_is_ignored(tmp_path: Path) -> None:
    """A manifest-style fingerprint SUMS several mtimes and sizes — decades ahead of now."""
    folder = tmp_path / "cred"
    folder.mkdir()
    (folder / "credential.json").write_text("{}")
    assert _asset_updated_epoch("credential", str(folder)) == pytest.approx(os.path.getmtime(folder))
