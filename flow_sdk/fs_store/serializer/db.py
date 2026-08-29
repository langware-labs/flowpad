"""``DbSerializer`` — the ``"db"`` origin kind: an entity's ``data`` column.

Non-lossy: a Pydantic dump of the persisted field set (``model_fields`` minus
the base record's columns, blob fields, and ``db_exclude``). A field whose
declared persistence is BYTES — a ``FileRef``, a ``FolderSpec``, a sub-asset,
rows — cannot live in a row and RAISES; it is never dropped or stringified.

**Identity on this medium is the row's natural key**, when the type declares
one (``TypeInfo.natural_key``): ``resolve`` finds the row a spec already names,
the way the disk serializer observes a carrier. **The no-op is the digest**
(``TypeInfo.digest_fields``): ``upsert`` answers "unchanged" without a write,
the way an identical file is never rewritten. Both are pure functions of the
class; the driver still writes the row.
"""

from __future__ import annotations

from functools import cache
from typing import Any, ClassVar, Iterable, Literal, Optional, Sequence

from flow_sdk.fs_store.origin.fs_origin import FSOrigin
from flow_sdk.fs_store.serializer.fields import DISK_ONLY, field_kinds
from flow_sdk.fs_store.serializer.protocol import UnsupportedFieldError


@cache
def db_persisted_fields(cls: type) -> tuple[str, ...]:
    """The fields that ride the ``data`` column — a pure function of the class."""
    from flow_sdk.db.drivers.db_base_record import DBBaseRecord  # noqa: PLC0415

    base = set(DBBaseRecord.model_fields)
    blobs = set(cls.get_blob_fields_names()) if hasattr(cls, "get_blob_fields_names") else set()
    excluded = cls.is_db_excluded if hasattr(cls, "is_db_excluded") else (lambda name: False)
    names = tuple(name for name in cls.model_fields if name not in base and name not in blobs and not excluded(name))
    refuse_disk_only(cls, names, "a DB row")  # once per class, not per save
    return names


def refuse_disk_only(cls: type, names: tuple[str, ...], medium: str) -> None:
    """Raise on any field whose declared persistence this medium cannot honor."""
    wanted = set(names)
    for name, kind in field_kinds(cls):
        if name in wanted and kind in DISK_ONLY:
            raise UnsupportedFieldError(
                f"{cls.__name__}.{name} is declared {kind.value} — bytes on disk — and cannot be stored in {medium}"
            )


def digest_over(obj: Any, fields: Iterable[str]) -> str:
    """Stable sha256 over ``fields`` of ``obj`` — a spec before save or a row
    after, read by name so both shapes digest identically. Canonicalised
    through ``canonical_entity_bytes``, which already owns that contract."""
    from flow_sdk.llm_index.core import sha256_bytes  # noqa: PLC0415
    from flow_sdk.semantic_lock.targets import canonical_entity_bytes  # noqa: PLC0415

    payload = {name: getattr(obj, name, None) for name in fields}
    return sha256_bytes(canonical_entity_bytes(payload))


UpsertStatus = Literal["created", "updated", "unchanged"]


def _info(cls: type) -> Any:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    return SchemaRegistry.get(cls.get_type())


def _key(obj: Any, names: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(str(getattr(obj, name)) for name in names)


class DbSerializer:
    kind: ClassVar[str] = "db"

    # ── identity: the natural key ─────────────────────────────────────────

    def natural_key_of(self, cls: type, spec: Any) -> tuple[str, ...]:
        """The key tuple a spec (or row) names. ``TypeError`` for a type with none."""
        names = _info(cls).natural_key
        if not names:
            raise TypeError(f"{cls.__name__} declares no natural_key")
        return _key(spec, names)

    async def resolve_key(self, cls: type, key: tuple[str, ...]) -> Any | None:
        """The row this key names, or None — the single-row lookup."""
        names = _info(cls).natural_key or ()
        return await cls.get_one(dict(zip(names, key)))

    async def resolve(self, cls: type, spec: Any) -> Any | None:
        return await self.resolve_key(cls, self.natural_key_of(cls, spec))

    async def resolve_many(self, cls: type, specs: Sequence[Any]) -> dict[tuple[str, ...], Any]:
        """A page's existing rows, keyed by the full natural key.

        One query per prefix group (every key component but the last), which is
        ONE query for every real page — a poll fetches a single segment of a
        single source. The full key is in the query AND in the map key: an
        external id is only unique within a segment (a Slack ``ts`` repeats
        across channels), so a partial key would hand the gate the wrong row.
        """
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        names = _info(cls).natural_key or ()
        if not specs or not names:
            return {}
        *prefix, last = names
        groups: dict[tuple[str, ...], set[str]] = {}
        for spec in specs:
            key = _key(spec, names)
            groups.setdefault(key[:-1], set()).add(key[-1])
        known: dict[tuple[str, ...], Any] = {}
        for head, tails in groups.items():
            operands = [ExpressionNode(op=QueryOp.EQ, operands=[n, v]) for n, v in zip(prefix, head)]
            operands.append(ExpressionNode(op=QueryOp.IN, operands=[last, list(tails)]))
            rows = await cls.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.AND, operands=operands)))
            for row in rows:
                known[_key(row, names)] = row
        return known

    # ── the no-op gate + the write ────────────────────────────────────────

    def digest_of(self, cls: type, spec: Any) -> str:
        fields = _info(cls).digest_fields
        return digest_over(spec, fields) if fields else ""

    def upsert(self, cls: type, spec: Any, *, existing: Any = None) -> tuple[Any | None, UpsertStatus]:
        """The row to save, or ``(None, "unchanged")``.

        Pure and synchronous: copies ONLY the header's fields (``type(spec)
        .model_fields``) onto ``existing`` or a fresh row — everything else on
        the row (``read``, ``starred``) is local state and survives by not
        being named — and stamps ``content_digest``. The caller saves and emits,
        in that order.
        """
        info = _info(cls)
        digest = self.digest_of(cls, spec)
        if existing is not None and digest and getattr(existing, info.digest_field, None) == digest:
            return None, "unchanged"
        row = existing if existing is not None else cls()
        for name in type(spec).model_fields:
            setattr(row, name, getattr(spec, name))
        if digest:
            setattr(row, info.digest_field, digest)
        return row, ("created" if existing is None else "updated")

    def store(self, obj: Any, origin: FSOrigin) -> FSOrigin:
        """The ``data`` dict for the row. The driver writes the row; this decides
        what is in it. Returns the origin carrying the row key."""
        return origin.model_copy(update={"id": str(getattr(obj, "id", "") or "")})

    def data(self, obj: Any) -> dict[str, Any]:
        cls = type(obj)
        names = db_persisted_fields(cls)
        # The row holds every persisted field, not the API projection — the
        # wrap serializer would drop non-API fields such as ``env_vars``.
        return obj.model_dump(
            mode="json", include=set(names), exclude_none=True, context={"skip_api_serializer": True}
        )

    def load(self, cls: type, origin: FSOrigin, *, entity_id: Optional[str] = None) -> Any:
        """The driver composes a row from its columns + ``data``; there is no
        origin-addressed load on this medium."""
        raise NotImplementedError("the driver composes the row")
