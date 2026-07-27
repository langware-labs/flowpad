"""Deterministic primary-source selection for filesystem-backed entities.

The resolver is intentionally storage-neutral. Callers adapt their own candidate
objects through ``identity_reader`` and persist/refelect the returned decisions.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar

from flow_sdk.fs_store.path_utils import canonical_posix_path

CandidateT = TypeVar("CandidateT")
Identity = tuple[str, str, str]
StoredOccurrences = Mapping[tuple[str, str], Sequence["AssetOccurrence | Mapping[str, Any]"]]


class StoredOccurrenceMap(dict[tuple[str, str], tuple["AssetOccurrence", ...]]):
    """Resolver state with keys synthesized from legacy ``asset_ref`` rows."""

    def __init__(self) -> None:
        super().__init__()
        self.synthetic_keys: set[tuple[str, str]] = set()


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True, slots=True)
class AssetOccurrence:
    path: str
    first_seen_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", canonical_posix_path(self.path))
        object.__setattr__(self, "first_seen_at", _utc(self.first_seen_at))


@dataclass(frozen=True, slots=True)
class AssetCollision:
    type_name: str
    entity_id: str
    primary_path: str | None
    occurrences: tuple[AssetOccurrence, ...]
    duplicate_paths: tuple[str, ...]
    changed: bool


def asset_occurrence_dicts(
    occurrences: Sequence[AssetOccurrence],
) -> list[dict[str, str]]:
    """Serialize the canonical occurrence projection for DB/API boundaries."""
    return [
        {"path": occurrence.path, "first_seen_at": occurrence.first_seen_at.isoformat()}
        for occurrence in occurrences
    ]


def stored_asset_occurrences(
    type_name: str,
    rows: Mapping[str, Sequence[Any]],
) -> dict[tuple[str, str], tuple[AssetOccurrence, ...]]:
    """Adapt DB source rows into resolver state, including legacy incumbents.

    Current rows carry occurrences at index 3 and ``created_date`` at index 4.
    Older/fake drivers may expose only ``(asset_ref, scope, project_id)``; their
    live incumbent is seeded with its creation time or a stable UTC minimum so a
    new lexical path cannot silently displace it on filesystems without birth time.
    """
    stored = StoredOccurrenceMap()
    stable_legacy_time = datetime.min.replace(tzinfo=timezone.utc)
    for entity_id, source in rows.items():
        values = source[3] if len(source) > 3 else None
        if isinstance(values, Sequence) and not isinstance(values, (str, bytes)):
            try:
                occurrences = tuple(_coerce_occurrence(value) for value in values)
            except (TypeError, ValueError):
                pass
            else:
                stored[(str(type_name), str(entity_id))] = occurrences
                continue
        incumbent = source[0] if source else None
        if not incumbent:
            continue
        created_at = source[4] if len(source) > 4 else None
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                created_at = None
        key = (str(type_name), str(entity_id))
        stored[key] = (
            AssetOccurrence(
                path=str(incumbent),
                first_seen_at=created_at if isinstance(created_at, datetime) else stable_legacy_time,
            ),
        )
        stored.synthetic_keys.add(key)
    return stored


def _coerce_occurrence(value: AssetOccurrence | Mapping[str, Any]) -> AssetOccurrence:
    if isinstance(value, AssetOccurrence):
        return value
    first_seen = value.get("first_seen_at")
    if isinstance(first_seen, str):
        first_seen = datetime.fromisoformat(first_seen.replace("Z", "+00:00"))
    if not isinstance(first_seen, datetime):
        raise ValueError("asset occurrence first_seen_at must be a datetime")
    return AssetOccurrence(path=str(value.get("path") or ""), first_seen_at=first_seen)


def _trusted_birth_time(path: str) -> datetime | None:
    """Return a real filesystem birth time; ctime is not a creation-time proxy."""
    try:
        raw = getattr(Path(path).stat(), "st_birthtime", None)
        if raw is None or raw <= 0:
            return None
        return datetime.fromtimestamp(raw, tz=timezone.utc)
    except (OSError, ValueError, OverflowError):
        return None


def _rank_time(value: datetime | None) -> tuple[int, datetime]:
    return (0, _utc(value)) if value is not None else (1, datetime.max.replace(tzinfo=timezone.utc))


def resolve_asset_collisions(
    candidates: Iterable[CandidateT],
    stored: StoredOccurrences,
    identity_reader: Callable[[CandidateT | str], Identity | None],
    git_probe: Callable[[str], datetime | None],
    now: datetime,
) -> tuple[AssetCollision, ...]:
    """Resolve one primary path per ``(type, id)`` group.

    ``identity_reader`` returns ``(type_name, entity_id, path)`` for a live
    candidate or stored path, or ``None`` when it cannot be validated. Stored
    validation must be read-only. Candidate order never affects the result. Git
    is probed only for groups with multiple live paths.
    """
    observed_at = _utc(now)
    live: dict[tuple[str, str], set[str]] = {}
    for candidate in candidates:
        try:
            identity = identity_reader(candidate)
            if identity is None:
                continue
            type_name, entity_id, path = identity
            if not type_name or not entity_id or not path:
                continue
            canonical_path = canonical_posix_path(path)
        except (OSError, TypeError, ValueError):
            continue
        live.setdefault((str(type_name), str(entity_id)), set()).add(
            canonical_path
        )

    previous: dict[tuple[str, str], tuple[AssetOccurrence, ...]] = {}
    for key, values in stored.items():
        try:
            previous[(str(key[0]), str(key[1]))] = tuple(
                _coerce_occurrence(value) for value in values
            )
        except (TypeError, ValueError):
            previous[(str(key[0]), str(key[1]))] = ()

    # A narrowed scan may not rediscover every persisted occurrence. Retain an
    # out-of-scope path only when it still exists and its carrier still resolves
    # to the same type+id. Missing and re-keyed occurrences are pruned.
    for key, occurrences in previous.items():
        for occurrence in occurrences:
            if occurrence.path in live.get(key, set()):
                continue
            try:
                if not Path(occurrence.path).exists():
                    continue
                identity = identity_reader(occurrence.path)
                if identity is None:
                    continue
                type_name, entity_id, path = identity
                if (str(type_name), str(entity_id)) != key:
                    continue
                if canonical_posix_path(path) != occurrence.path:
                    continue
            except (OSError, TypeError, ValueError):
                continue
            live.setdefault(key, set()).add(occurrence.path)

    decisions: list[AssetCollision] = []
    for type_name, entity_id in sorted(set(live) | set(previous)):
        key = (type_name, entity_id)
        paths = live.get(key, set())
        prior = previous.get(key, ())
        first_seen = {item.path: item.first_seen_at for item in prior}

        git_introduced: dict[str, datetime | None] = {}
        if len(paths) > 1:
            for path in sorted(paths):
                try:
                    introduced = git_probe(path)
                except Exception:
                    introduced = None
                git_introduced[path] = _utc(introduced) if introduced is not None else None

        def rank(path: str) -> tuple[Any, ...]:
            introduced = git_introduced.get(path)
            return (
                *_rank_time(introduced),
                *_rank_time(_trusted_birth_time(path)),
                *_rank_time(first_seen.get(path)),
                path,
            )

        ranked_paths = sorted(paths, key=rank)
        occurrences = tuple(
            AssetOccurrence(path=path, first_seen_at=first_seen.get(path, observed_at))
            for path in ranked_paths
        )
        primary_path = ranked_paths[0] if ranked_paths else None
        duplicate_paths = tuple(ranked_paths[1:])
        decisions.append(
            AssetCollision(
                type_name=type_name,
                entity_id=entity_id,
                primary_path=primary_path,
                occurrences=occurrences,
                duplicate_paths=duplicate_paths,
                changed=(
                    occurrences != prior
                    or key in getattr(stored, "synthetic_keys", ())
                ),
            )
        )
    return tuple(decisions)
