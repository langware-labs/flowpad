"""Which entity row already owns a filesystem path.

``asset_ref`` is globally unique — one entity per file path across all types
(see ``Entity.get_by_asset_ref``). Identity resolution has to be able to ask
"who owns this path?" cheaply, or a source whose identity carrier was wiped
looks like a brand-new asset and gets a fresh id, forking the entity.

Two shapes, for the two callers:

* :class:`PathOwnerIndex` — built from the index walk's EXISTING per-type
  preload, so the walk answers the question with zero extra queries.
* :func:`owner_id_for` — the single-path async lookup for targeted discovery.
"""
from __future__ import annotations

import functools
import logging
import unicodedata
from collections.abc import Iterable, Mapping

from flow_sdk.fs_store.exceptions import AssetRefLookupError


def _posix_key(raw: str) -> str | None:
    """NFC/posix form of an ALREADY-RESOLVED stored path — no syscalls.

    ``FSRef.__init__`` resolves before storing, so a stored ``asset_ref`` only
    differs from ``canonical_posix_path`` output by NFC normalization and
    separator flavour. Kept purely lexical — no ``Path`` construction, no
    ``resolve()`` — because this runs per row of every type on every index,
    matching the deliberate deferral in ``_same_path_dupe_groups``.
    """
    if not raw:
        return None
    # A Windows drive letter is the only case needing separator folding.
    text = raw.replace("\\", "/") if (len(raw) > 1 and raw[1] == ":") else raw
    return unicodedata.normalize("NFC", text)


@functools.lru_cache(maxsize=1)
def _non_owner_types() -> frozenset[str]:
    """Types that merely REFERENCE a path instead of owning it.

    Cached: the answer walks the whole type registry and cannot change at
    runtime, while callers rebuild an index per type per request.

    A type with ``owns_asset_ref = False`` (``Artifact``) carries the same
    ``asset_ref`` as the entity it points at, so letting it answer "who owns
    this path" would shadow the real owner — the same exclusion
    ``Entity.get_by_asset_ref`` applies to its candidate set.

    Deliberately an EXCLUDE set, not an allow set. The entity-class registry is
    populated later than the type registry, so an allow set built too early
    would silently exclude every real type and quietly disable owner-first
    identity. Excluding only the known non-owners degrades to "everything owns
    its path", which is the correct default.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    out: set[str] = set()
    try:
        for name in SchemaRegistry.get_all_record_types():
            cls = SchemaRegistry.get_entity_cls(name)
            if cls is not None and not getattr(cls, "owns_asset_ref", True):
                out.add(str(name))
    except Exception:
        return frozenset()
    return frozenset(out)


class PathOwnerIndex:
    """``{type: {path_key: owner_id}}`` over the rows that already exist.

    Deliberately tolerant: an unparseable stored path is skipped rather than
    raised, because a single bad legacy row must not abort a whole index run.
    """

    __slots__ = ("_by_type",)

    def __init__(self, by_type: dict[str, dict[str, str]]) -> None:
        self._by_type = by_type

    @classmethod
    def from_preload(
        cls,
        existing_db_paths: Mapping[str, Mapping[str, str]],
        *,
        created_dates: Mapping[str, Mapping[str, object]] | None = None,
        exclude_types: Iterable[str] | None = None,
    ) -> "PathOwnerIndex":
        """Build from the walk's ``{type: {id: asset_ref}}`` preload.

        When a path is already claimed by several rows — the damage this whole
        mechanism exists to stop compounding — a deterministic winner is chosen
        (oldest ``created_date``, then lexicographic id) so every walk converges
        on the SAME row and the existing same-path sweep can retire the rest.
        Ranking matches the ``type_uname`` dedupe rule.
        """
        excluded = frozenset(exclude_types) if exclude_types is not None else _non_owner_types()
        by_type: dict[str, dict[str, str]] = {}

        for type_name, by_id in (existing_db_paths or {}).items():
            if type_name in excluded:
                continue
            dates = (created_dates or {}).get(type_name) or {}
            owners: dict[str, str] = {}
            for entity_id, raw in (by_id or {}).items():
                key = _posix_key(raw) if raw else None
                if not key:
                    continue
                incumbent = owners.get(key)
                # Already-forked path: pick deterministically so every walk
                # converges on the SAME row and the same-path sweep retires the
                # rest. Oldest created_date then lexicographic — the rule the
                # `type_uname` dedupe and the collapse migration also use.
                if incumbent is None or (str(dates.get(entity_id) or "~"), str(entity_id)) < (
                    str(dates.get(incumbent) or "~"),
                    str(incumbent),
                ):
                    owners[key] = str(entity_id)
            if owners:
                by_type[type_name] = owners

        return cls(by_type)

    def owner_for(self, type_name: str, raw_path: str | None, canon_path: str | None = None) -> str | None:
        """The id owning ``raw_path``/``canon_path`` for ``type_name``."""
        owners = self._by_type.get(str(type_name))
        if not owners:
            return None
        for candidate in (canon_path, raw_path):
            if candidate and (hit := owners.get(_posix_key(candidate) or "")):
                return hit
        return None

    def __bool__(self) -> bool:
        return bool(self._by_type)


async def owner_id_for(type_name: str, path: str, *, strict: bool = False) -> str | None:
    """Single-path owner lookup for targeted discovery (``discover_record_by_path``).

    Queries the ONE type asked for rather than going through
    ``Entity.get_by_asset_ref``, which fans out a query per asset-owning class
    (~30) and then discards every result of another type. This runs on the
    watcher path, once per changed file.

    ``strict`` raises :class:`~flow_sdk.core.entity.entity_model.AssetRefLookupError`
    when a spelling probe ERRORED rather than genuinely missing. Callers that MINT
    on a miss must pass it: a swallowed ``database is locked`` here reads as "no
    owner", and the mint then rewrites the file's on-disk identity capsule with a
    fresh id, permanently orphaning the existing row.
    """
    from flow_sdk.fs_store.path_utils import asset_ref_spellings  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(str(type_name))
    if cls is None or not getattr(cls, "owns_asset_ref", True):
        return None

    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    failed = False
    spellings = asset_ref_spellings(path)
    try:
        entity = await cls.get_one(
            QueryFilter(type=cls.get_type(), match=ExpressionNode(op=QueryOp.IN, operands=["asset_ref", spellings]))
        )
    except Exception:
        failed = True
        entity = None
    entity_id = getattr(entity, "id", None) if entity is not None else None
    if entity_id:
        return str(entity_id)

    if failed:
        logging.getLogger(__name__).warning("owner lookup failed for %s at %s", type_name, path)
    if strict and failed:
        raise AssetRefLookupError(f"owner lookup incomplete for {type_name} at {path}")
    return None
