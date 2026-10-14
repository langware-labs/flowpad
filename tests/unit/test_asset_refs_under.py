"""``asset_refs_under`` — the LIKE patterns for "an asset stored under this folder".

A project's mount is kept in POSIX form (``C:/Users/x``); the ``asset_ref`` of what the indexer finds
there is the resolved path, which on Windows is backslashed. One ``<root>/%`` pattern matched nothing
on Windows, so no declared ``asset_setup`` node ever attached to a project's setup tree there."""
from __future__ import annotations

from flow_sdk.fs_store import path_utils


def test_every_spelling_gets_its_own_separator(monkeypatch):
    monkeypatch.setattr(path_utils, "asset_ref_spellings", lambda _root: ["C:/Users/f/acme", "C:\\Users\\f\\acme"])

    assert path_utils.asset_refs_under("C:/Users/f/acme") == ["C:/Users/f/acme/%", "C:\\Users\\f\\acme\\%"]


def test_a_trailing_separator_does_not_double(tmp_path):
    patterns = path_utils.asset_refs_under(f"{tmp_path}/")

    assert f"{tmp_path}/%" in patterns and not any("//" in p for p in patterns)
