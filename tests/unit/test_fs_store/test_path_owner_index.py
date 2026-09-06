"""``PathOwnerIndex`` — who already owns a path, answered without a query.

The index walk resolves identity for every asset it touches. If answering "who
owns this path?" cost a query per asset, owner-first identity would be
unaffordable and the fork would stay. So the map is built from the preload the
walk already does, keyed lexically, and must survive the spellings a real
filesystem produces.
"""
from __future__ import annotations

import unicodedata

from flow_sdk.fs_store.path_owners import PathOwnerIndex

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"


def _index(rows: dict[str, str], type_name: str = "markdown", **kw) -> PathOwnerIndex:
    return PathOwnerIndex.from_preload({type_name: rows}, exclude_types=(), **kw)


def test_maps_a_stored_path_to_its_owner() -> None:
    idx = _index({A: "/w/docs/a.md"})
    assert idx.owner_for("markdown", "/w/docs/a.md") == A
    assert idx.owner_for("markdown", "/w/docs/other.md") is None
    assert idx.owner_for("skill", "/w/docs/a.md") is None


def test_nfd_and_nfc_spellings_resolve_to_one_owner() -> None:
    """macOS hands back NFD; the DB stores NFC. Same file either way."""
    nfc = unicodedata.normalize("NFC", "/w/docs/café.md")
    nfd = unicodedata.normalize("NFD", "/w/docs/café.md")
    assert nfc != nfd

    idx = _index({A: nfc})
    assert idx.owner_for("markdown", nfd, nfc) == A


def test_lookup_falls_back_to_the_canonical_key() -> None:
    idx = _index({A: "/w/docs/a.md"})
    assert idx.owner_for("markdown", "/other/spelling.md", "/w/docs/a.md") == A


def test_multiple_owners_pick_a_deterministic_winner_and_expose_the_losers() -> None:
    """A dirty DB must converge, not oscillate — every walk picks the same row."""
    rows = {C: "/w/docs/a.md", A: "/w/docs/a.md", B: "/w/docs/a.md"}
    dates = {"markdown": {A: "2026-03-01", B: "2026-01-01", C: "2026-02-01"}}

    idx = PathOwnerIndex.from_preload({"markdown": rows}, created_dates=dates, exclude_types=())
    assert idx.owner_for("markdown", "/w/docs/a.md") == B, "oldest created_date wins"

    again = PathOwnerIndex.from_preload({"markdown": rows}, created_dates=dates, exclude_types=())
    assert again.owner_for("markdown", "/w/docs/a.md") == B, "and it is stable across builds"


def test_winner_is_stable_without_created_dates() -> None:
    idx = _index({C: "/w/a.md", A: "/w/a.md"})
    assert idx.owner_for("markdown", "/w/a.md") == A


def test_rows_without_a_path_are_skipped() -> None:
    assert not _index({A: "", B: None})  # type: ignore[dict-item]


def test_empty_preload_yields_no_owners() -> None:
    """A failed/first-run preload must degrade, never invent an owner."""
    assert not PathOwnerIndex.from_preload({})
    assert not PathOwnerIndex.from_preload({"markdown": {}})
    assert PathOwnerIndex.from_preload({}).owner_for("markdown", "/w/a.md") is None


def test_non_owner_types_are_excluded() -> None:
    """``Artifact`` shadows a real asset's path — it must never answer."""
    rows = {"markdown": {A: "/w/docs/a.md"}, "artifact": {B: "/w/docs/a.md"}}
    idx = PathOwnerIndex.from_preload(rows, exclude_types=("artifact",))
    assert idx.owner_for("markdown", "/w/docs/a.md") == A
    assert idx.owner_for("artifact", "/w/docs/a.md") is None


def test_build_issues_no_queries() -> None:
    """The zero-extra-query claim, enforced rather than asserted in prose."""

    class ExplodingDriver:
        def __getattr__(self, name):  # pragma: no cover - must never be reached
            raise AssertionError(f"PathOwnerIndex must not touch the driver (called {name!r})")

    import flow_sdk.db as db

    original = db.get_db_driver
    db.get_db_driver = lambda *a, **k: ExplodingDriver()  # type: ignore[assignment]
    try:
        idx = _index({A: "/w/docs/a.md"})
        assert idx.owner_for("markdown", "/w/docs/a.md") == A
    finally:
        db.get_db_driver = original  # type: ignore[assignment]
