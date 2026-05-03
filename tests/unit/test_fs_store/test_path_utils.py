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
