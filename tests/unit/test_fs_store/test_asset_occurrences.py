from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import flow_sdk.fs_store.asset_occurrences as occurrence_module
from flow_sdk.fs_store.asset_occurrences import (
    AssetOccurrence,
    resolve_asset_collisions,
    stored_asset_occurrences,
)

NOW = datetime(2026, 7, 20, 12, tzinfo=timezone.utc)
OLD = NOW - timedelta(days=10)


def _identity(candidate: tuple[str, str, str]):
    return candidate if not isinstance(candidate, str) else None


def _resolve(candidates, stored=None, git=None):
    return resolve_asset_collisions(
        candidates,
        stored or {},
        _identity,
        git or (lambda _path: None),
        NOW,
    )


def test_git_commit_and_earliest_introduction_win_independent_of_input_order(
    tmp_path: Path,
) -> None:
    a, b, c = (tmp_path / name for name in ("a.md", "b.md", "c.md"))
    introduced = {str(b): NOW - timedelta(days=2), str(c): NOW - timedelta(days=4)}
    candidates = [("markdown", "id", str(path)) for path in (a, b, c)]

    forward = _resolve(candidates, git=introduced.get)[0]
    reverse = _resolve(reversed(candidates), git=introduced.get)[0]

    assert forward == reverse
    assert forward.primary_path == str(c.resolve())
    assert forward.duplicate_paths == (str(b.resolve()), str(a.resolve()))


def test_birth_then_persisted_first_seen_then_path_are_fallbacks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    a, b = str((tmp_path / "a").resolve()), str((tmp_path / "b").resolve())
    births = {a: NOW - timedelta(days=1), b: NOW - timedelta(days=2)}
    monkeypatch.setattr(occurrence_module, "_trusted_birth_time", births.get)
    candidates = [("skill", "id", a), ("skill", "id", b)]
    assert _resolve(candidates)[0].primary_path == b

    monkeypatch.setattr(occurrence_module, "_trusted_birth_time", lambda _path: None)
    stored = {("skill", "id"): [AssetOccurrence(a, OLD)]}
    assert _resolve(candidates, stored)[0].primary_path == a
    assert _resolve(candidates)[0].primary_path == a


def test_legacy_incumbent_first_seen_beats_new_lexical_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(occurrence_module, "_trusted_birth_time", lambda _path: None)
    stored = {("markdown", "id"): [AssetOccurrence("/z/incumbent.md", OLD)]}
    candidates = [
        ("markdown", "id", "/a/new-copy.md"),
        ("markdown", "id", "/z/incumbent.md"),
    ]

    assert _resolve(candidates, stored)[0].primary_path == "/z/incumbent.md"


def test_legacy_db_row_seeds_incumbent_with_stable_first_seen() -> None:
    stored = stored_asset_occurrences(
        "markdown",
        {"id": ("/z/incumbent.md", "user", None)},
    )
    incumbent = stored[("markdown", "id")][0]

    assert incumbent.path == "/z/incumbent.md"
    assert incumbent.first_seen_at == datetime.min.replace(tzinfo=timezone.utc)
    assert ("markdown", "id") in stored.synthetic_keys


def test_persisted_empty_occurrences_are_not_reseeded_from_asset_ref() -> None:
    stored = stored_asset_occurrences(
        "markdown",
        {"id": ("/stale.md", "user", None, [], NOW)},
    )

    assert stored[("markdown", "id")] == ()
    assert stored.synthetic_keys == set()


def test_malformed_occurrences_fall_back_to_legacy_incumbent() -> None:
    stored = stored_asset_occurrences(
        "markdown",
        {"id": ("/incumbent.md", "user", None, [{"path": "/broken"}], NOW)},
    )

    assert stored[("markdown", "id")][0].path == "/incumbent.md"
    assert ("markdown", "id") in stored.synthetic_keys


def test_pruning_primary_swap_and_idempotence() -> None:
    stored = {
        ("markdown", "id"): [
            AssetOccurrence("/z/primary.md", OLD),
            AssetOccurrence("/a/copy.md", OLD + timedelta(days=1)),
        ]
    }

    swapped = _resolve([("markdown", "id", "/a/copy.md")], stored)[0]
    assert swapped.primary_path == str(Path("/a/copy.md").resolve())
    assert swapped.duplicate_paths == ()
    assert swapped.changed is True

    persisted = {(swapped.type_name, swapped.entity_id): swapped.occurrences}
    assert _resolve([("markdown", "id", "/a/copy.md")], persisted)[0].changed is False

    cleared = _resolve([], persisted)[0]
    assert cleared.primary_path is None and cleared.occurrences == ()
    assert cleared.changed is True


def test_type_id_isolation_validation_and_duplicate_candidate_collapse() -> None:
    candidates = [
        ("skill", "same", "/x"),
        ("skill", "same", "/x"),
        ("markdown", "same", "/x"),
        ("skill", "other", "/y"),
        ("", "bad", "/ignored"),
    ]
    decisions = _resolve(candidates)

    assert [(item.type_name, item.entity_id) for item in decisions] == [
        ("markdown", "same"),
        ("skill", "other"),
        ("skill", "same"),
    ]
    assert all(len(item.occurrences) == 1 for item in decisions)


def test_git_probe_is_collision_only_and_failure_is_best_effort() -> None:
    calls: list[str] = []

    def probe(path: str):
        calls.append(path)
        if path.endswith("b"):
            raise RuntimeError("git unavailable")
        return None

    _resolve([("skill", "one", "/single")], git=probe)
    assert calls == []

    decision = _resolve(
        [("skill", "many", "/a"), ("skill", "many", "/b")], git=probe
    )[0]
    assert calls == ["/a", "/b"]
    assert decision.primary_path == "/a"


def test_scoped_resolution_retains_live_stored_path_and_first_seen(
    tmp_path: Path,
) -> None:
    current = tmp_path / "scope" / "current.md"
    outside = tmp_path / "outside" / "copy.md"
    current.parent.mkdir()
    outside.parent.mkdir()
    current.write_text("current\n", encoding="utf-8")
    outside.write_text("copy\n", encoding="utf-8")
    stored_occurrence = AssetOccurrence(str(outside), OLD)

    def identity(candidate):
        path = candidate[2] if isinstance(candidate, tuple) else candidate
        return ("markdown", "same", path)

    decisions = resolve_asset_collisions(
        [("markdown", "same", str(current))],
        {("markdown", "same"): [stored_occurrence]},
        identity,
        lambda _path: None,
        NOW,
    )

    assert {item.path for item in decisions[0].occurrences} == {
        str(current.resolve()),
        str(outside.resolve()),
    }
    retained = next(item for item in decisions[0].occurrences if item.path == str(outside.resolve()))
    assert retained.first_seen_at == OLD


def test_stored_missing_and_rekeyed_paths_are_pruned(tmp_path: Path) -> None:
    missing = tmp_path / "missing.md"
    rekeyed = tmp_path / "rekeyed.md"
    rekeyed.write_text("new identity\n", encoding="utf-8")
    stored = {
        ("markdown", "old"): [
            AssetOccurrence(str(missing), OLD),
            AssetOccurrence(str(rekeyed), OLD),
        ]
    }

    def identity(candidate):
        path = candidate[2] if isinstance(candidate, tuple) else candidate
        return ("markdown", "new", path)

    decision = resolve_asset_collisions([], stored, identity, lambda _path: None, NOW)[0]
    assert decision.primary_path is None
    assert decision.occurrences == ()
    assert decision.changed is True
