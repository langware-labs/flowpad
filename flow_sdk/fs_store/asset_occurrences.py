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
from flow_sdk.utils.serialization import iso_to_utc

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


#: Path classes that explain *why* a copy exists. Ordered most-specific first;
#: ``local`` is the default and means "a file the user put there".
ORIGIN_INSTALLED_PACKAGE = "installed_package"
ORIGIN_DEPENDENCY = "dependency"
ORIGIN_LOCAL = "local"

_INSTALLED_PACKAGE_SEGMENTS = frozenset({"site-packages", "dist-packages"})
_DEPENDENCY_SEGMENTS = frozenset({"node_modules", ".venv", "venv", ".tox", "vendor"})


def classify_origin(path: str) -> str:
    """Classify an already-canonical posix path into the origin classes above.

    Deliberately narrow: only path shapes that are unambiguously machine-made
    are labelled. Anything else stays ``local`` — a wrong "this is vendored"
    label is worse than no label, because it invites deleting a real file.
    """
    segments = set(path.split("/"))
    if segments & _INSTALLED_PACKAGE_SEGMENTS:
        return ORIGIN_INSTALLED_PACKAGE
    if segments & _DEPENDENCY_SEGMENTS:
        return ORIGIN_DEPENDENCY
    return ORIGIN_LOCAL



@dataclass(frozen=True, slots=True)
class AssetOccurrence:
    """One on-disk occurrence plus the evidence that ranked it.

    The evidence fields are populated only for collided groups (>1 live path):
    a lone occurrence has nothing to explain, and stamping it would rewrite
    every asset row in the corpus for no user-visible gain.
    """

    path: str
    first_seen_at: datetime
    introduced_at: datetime | None = None
    birth_time: datetime | None = None
    origin: str = ORIGIN_LOCAL
    rank_basis: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", canonical_posix_path(self.path))
        object.__setattr__(self, "first_seen_at", _utc(self.first_seen_at))
        if self.introduced_at is not None:
            object.__setattr__(self, "introduced_at", _utc(self.introduced_at))
        if self.birth_time is not None:
            object.__setattr__(self, "birth_time", _utc(self.birth_time))


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
    """Serialize the canonical occurrence projection for DB/API boundaries.

    Default-valued evidence is omitted so an uncollided asset serializes byte-
    identically to before this projection grew — ``reflect_asset_occurrences``
    compares against the stored list to decide whether to write, so emitting
    empty keys would dirty every row on the first index after an upgrade.
    """
    out: list[dict[str, str]] = []
    for occurrence in occurrences:
        item = {"path": occurrence.path, "first_seen_at": occurrence.first_seen_at.isoformat()}
        if occurrence.introduced_at is not None:
            item["introduced_at"] = occurrence.introduced_at.isoformat()
        if occurrence.birth_time is not None:
            item["birth_time"] = occurrence.birth_time.isoformat()
        if occurrence.origin and occurrence.origin != ORIGIN_LOCAL:
            item["origin"] = occurrence.origin
        if occurrence.rank_basis:
            item["rank_basis"] = occurrence.rank_basis
        out.append(item)
    return out


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
    first_seen = iso_to_utc(value.get("first_seen_at"))
    if first_seen is None:
        raise ValueError("asset occurrence first_seen_at must be a datetime")
    return AssetOccurrence(
        path=str(value.get("path") or ""),
        first_seen_at=first_seen,
        introduced_at=iso_to_utc(value.get("introduced_at")),
        birth_time=iso_to_utc(value.get("birth_time")),
        origin=str(value.get("origin") or ORIGIN_LOCAL),
        rank_basis=str(value.get("rank_basis") or ""),
    )


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
    # out-of-scope path only when it still exists, sits somewhere a walker would
    # actually go, and its carrier still resolves to the same type+id. Missing,
    # re-keyed and unwalkable occurrences are pruned.
    #
    # The denylist check is what keeps discovery and retention honest with each
    # other. Discovery prunes `.venv`, `node_modules`, … as it descends; without
    # the same test here, a path recorded by some earlier run re-admits itself
    # on every subsequent index — existence plus a matching id was enough — so a
    # single historical mistake became permanent and no later tightening of the
    # ignore rules could evict it. Live candidates are deliberately NOT filtered:
    # those come from a walk that already applied the policy, or from an explicit
    # "index this exact file" request, which outranks it.
    from flow_sdk.fs_store.indexer.gitignore import is_under_denylisted_dir  # noqa: PLC0415

    for key, occurrences in previous.items():
        for occurrence in occurrences:
            if occurrence.path in live.get(key, set()):
                continue
            try:
                if is_under_denylisted_dir(occurrence.path):
                    continue
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

        # Probed once per path rather than per comparison, so the evidence kept
        # on the occurrence is exactly what ranked it — the panel can never
        # explain the decision with a different number than the sort used.
        # Gated like the git probe above: a lone path is never compared and
        # never explained, so its stat() would buy nothing on every asset in
        # the corpus.
        birth_times = (
            {path: _trusted_birth_time(path) for path in sorted(paths)} if len(paths) > 1 else {}
        )

        def rank(path: str) -> tuple[Any, ...]:
            return (
                *_rank_time(git_introduced.get(path)),
                *_rank_time(birth_times.get(path)),
                *_rank_time(first_seen.get(path)),
                path,
            )

        ranked_paths = sorted(paths, key=rank)
        collided = len(ranked_paths) > 1
        # Name the signal that actually separated the primary from the
        # runner-up by walking the same cascade ``rank`` uses, in the same
        # order — one declaration, so a reorder can't leave the label behind.
        basis = ""
        if collided:
            top, second = ranked_paths[0], ranked_paths[1]
            basis = next(
                (
                    name
                    for name, probe in (
                        ("git", git_introduced),
                        ("created", birth_times),
                        ("first_seen", first_seen),
                    )
                    if _rank_time(probe.get(top)) != _rank_time(probe.get(second))
                ),
                "path",
            )
        occurrences = tuple(
            AssetOccurrence(
                path=path,
                first_seen_at=first_seen.get(path, observed_at),
                introduced_at=git_introduced.get(path) if collided else None,
                birth_time=birth_times.get(path) if collided else None,
                origin=classify_origin(path) if collided else ORIGIN_LOCAL,
                # Only the primary carries the basis: it answers "why is this
                # one live", which is a statement about the group, not the row.
                rank_basis=basis if collided and index == 0 else "",
            )
            for index, path in enumerate(ranked_paths)
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
