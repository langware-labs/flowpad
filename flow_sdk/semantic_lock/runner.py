"""DB-aware SemanticLock runner — the impure boundary of the package.

Resolves entities/relationships into the plain shapes the pure core
(``checker.py``/``targets.py``/``copiers.py``) consumes, persists verdicts on
the ``DependsOnRelationship`` rows, and surfaces breaks as ``Annotation``
entities. Consumed by the ``/api/v1/semantic-checker`` route and the generic
``semantic-status`` / ``semantic-waive`` entity actions. Flag-only: targets
are never written.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.flowpad_types.enums.entity_enums import (
    BuiltInRelationshipTypes,
    SemanticStatus,
    ValidatedBy,
)
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.types import EntityType
from flow_sdk.semantic_lock.checker import check_relationship
from flow_sdk.semantic_lock.copiers import copier_for
from flow_sdk.semantic_lock.targets import BytesTarget, FileTarget, canonical_entity_bytes

logger = logging.getLogger(__name__)

LOCK_BREAK_FLAG = "lock_break"

# Audit/transport/marker fields excluded from the canonical content of
# asset-less entities — part of the validated-hash contract, change with care
# (a different set than Entity._hub_body's wire excludes: this one defines
# "semantic content", that one defines "what the hub schema accepts").
_VOLATILE_FIELDS = frozenset({
    "created_by", "updated_by", "created_date", "updated_date",
    "fetched_at", "remote", "system", "message_count", "tags",
    "env_vars", "visitor_role", "participants",
    # The lock marker itself and the share rail are not semantic content —
    # flipping semantic_lock or sharing the entity must not read as drift.
    "semantic_lock",
    "shared_context_entities",
    "private_context_entities", "private_context_entities_",
    "private_context_entity_data", "shared_context_entity_data",
})


def _dependson_filter() -> QueryFilter:
    return QueryFilter(type=BuiltInRelationshipTypes.DependsOn.value)


async def _load_entity(tid: TypeId | str | None):
    if not tid:
        return None
    tid = tid if isinstance(tid, TypeId) else TypeId(str(tid))
    try:
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        return await Entity.get_by_typeid(tid)
    except Exception:  # noqa: BLE001 — a broken row must not abort the sweep
        logger.warning("[semantic_lock] failed to load %s", tid, exc_info=True)
        return None


async def _entity_content_bytes(ent) -> Optional[bytes]:
    """An entity's semantic content: file bytes for file/asset-backed
    entities, the blob-expanded body when present, else canonical sorted-keys
    JSON of its persisted fields (volatile audit fields excluded)."""
    if ent.type == EntityType.FILE.value:
        return FileTarget(rel_path=ent.rel_path, abs_path=ent.abs_path).resolve()
    aref = getattr(ent, "asset_ref", None)
    if aref:
        path = Path(str(aref))
        if path.is_file():
            try:
                return path.read_bytes()
            except OSError:
                return None
    raw = getattr(ent, "raw_content", None)
    if isinstance(raw, str) and raw:
        return raw.encode("utf-8")
    fields = {
        k: v
        for k, v in ent.model_dump(mode="json", exclude_none=True).items()
        if k not in _VOLATILE_FIELDS
    }
    return canonical_entity_bytes(fields)


def _content_kind(ent) -> str:
    """Copier-registry kind for an entity: file extension for file targets
    and asset-backed entities, else the entity type value."""
    if ent.type == EntityType.FILE.value:
        suffix = Path(ent.rel_path or ent.abs_path or "").suffix
        return suffix or ent.type
    aref = getattr(ent, "asset_ref", None)
    if aref and Path(str(aref)).suffix:
        return Path(str(aref)).suffix
    return str(ent.type)


async def _target_adapter(target_ent):
    if target_ent is None:
        return BytesTarget(None)
    if target_ent.type == EntityType.FILE.value:
        return FileTarget(rel_path=target_ent.rel_path, abs_path=target_ent.abs_path)
    return BytesTarget(await _entity_content_bytes(target_ent))


async def _open_break_annotations(rel) -> list:
    """Open (unresolved) lock_break annotations for one relationship."""
    from flow_sdk.builtin.annotation import Annotation  # noqa: PLC0415

    to_tid = rel.to_typeid
    if not to_tid:
        return []
    rows = await Annotation.get_all(
        QueryFilter.parse({"target_type": to_tid.type, "target_id": to_tid.id}, "annotation")
    )
    return [
        a for a in rows
        if (a.data or {}).get("flag_type") == LOCK_BREAK_FLAG
        and (a.data or {}).get("relationship_id") == rel.id
        and not (a.data or {}).get("resolved")
    ]


async def _resolve_break_annotations(rel) -> int:
    resolved = 0
    for ann in await _open_break_annotations(rel):
        ann.data = {**(ann.data or {}), "resolved": True}
        await ann.save()
        resolved += 1
    return resolved


async def _flag_break(rel, lock, target_ent, detail: dict, target_hash: str) -> None:
    """Create one lock_break Annotation per (relationship, target content)."""
    from flow_sdk.builtin.annotation import Annotation  # noqa: PLC0415

    for ann in await _open_break_annotations(rel):
        if (ann.data or {}).get("target_hash") == target_hash:
            return  # already flagged for this exact content
    reason = str(detail.get("reason") or "semantic lock break")
    to_tid = rel.to_typeid
    ann = Annotation(
        target_type=to_tid.type if to_tid else "",
        target_id=to_tid.id if to_tid else "",
        content=reason[:50],
        labels=[LOCK_BREAK_FLAG],
        iso_timestamp=datetime.now(timezone.utc).isoformat(),
        data={
            "flag_type": LOCK_BREAK_FLAG,
            "lock_typeid": str(lock.typeid) if lock is not None else "",
            "relationship_id": rel.id,
            "reason": reason,
            "target_hash": target_hash,
            "resolved": False,
            **{k: v for k, v in detail.items() if k in ("start_line", "end_line", "drifted")},
        },
    )
    await ann.save()


def _rel_json(rel) -> dict:
    data = rel.model_dump(mode="json")
    data["from_typeid"] = str(rel.from_typeid) if rel.from_typeid else None
    data["to_typeid"] = str(rel.to_typeid) if rel.to_typeid else None
    return data


async def _relationships_for(ent) -> list:
    """The dependson rows a typeid contributes: outgoing when it is a lock,
    incoming (its governing locks) otherwise."""
    if getattr(ent, "semantic_lock", False):
        return await ent.get_outgoing_relationships(_dependson_filter())
    return await ent.get_incoming_relationships(_dependson_filter())


async def run_semantic_checker(
    type_ids: list[str], on_progress=None
) -> dict[str, Any]:
    """Check every dependson edge reachable from ``type_ids`` (mixed lock /
    target ids). Persists verdicts on the relationship rows, creates/resolves
    lock_break annotations, returns a summary. Flag-only."""
    rels: dict[str, Any] = {}
    for raw in type_ids or []:
        try:
            tid = TypeId(str(raw))
        except (ValueError, TypeError):
            continue
        ent = await _load_entity(tid)
        if ent is None:
            continue
        for rel in await _relationships_for(ent):
            if rel.id:
                rels[rel.id] = rel

    results: list[dict] = []
    counts = {s.value: 0 for s in SemanticStatus}
    now = datetime.now(timezone.utc).isoformat()
    # One lock typically governs many targets — load+read its content once.
    lock_cache: dict[str, tuple[Any, Optional[bytes]]] = {}

    async def _lock_with_bytes(tid) -> tuple[Any, Optional[bytes]]:
        key = str(tid)
        if key not in lock_cache:
            lock = await _load_entity(tid)
            data = await _entity_content_bytes(lock) if lock is not None else None
            lock_cache[key] = (lock, data)
        return lock_cache[key]

    for i, rel in enumerate(rels.values()):
        lock, lock_bytes = await _lock_with_bytes(rel.from_typeid)
        if lock is None or not getattr(lock, "semantic_lock", False):
            continue  # not a semantic edge — plain dependency, out of scope
        target_ent = await _load_entity(rel.to_typeid)
        adapter = (
            BytesTarget(None) if lock_bytes is None else await _target_adapter(target_ent)
        )
        copier = copier_for(
            _content_kind(lock), _content_kind(target_ent) if target_ent else "*"
        )
        verdict = check_relationship(
            lock_bytes or b"",
            {
                "kind": rel.kind,
                "validated_hashes": rel.validated_hashes,
                "status": rel.status,
                "break_detail": rel.break_detail,
            },
            adapter,
            copier,
        )

        prior_status = rel.status
        new_hashes = dict(rel.validated_hashes or {})
        if verdict.status in (SemanticStatus.OK.value, SemanticStatus.BREAK.value):
            # Verdict cache: advance the validated hashes so an unchanged
            # re-run is read-free; a standing break lives in status+annotation.
            new_hashes.update(verdict.current_hashes)
        new_break = dict(verdict.detail) if verdict.status == SemanticStatus.BREAK.value else {}
        changed = (
            verdict.status != prior_status
            or new_hashes != (rel.validated_hashes or {})
            or new_break != (rel.break_detail or {})
        )
        if changed:
            rel.status = verdict.status
            rel.validated_hashes = new_hashes
            rel.break_detail = new_break
            if verdict.status in (SemanticStatus.OK.value, SemanticStatus.BREAK.value):
                rel.validated_by = ValidatedBy.CHECKER.value
                rel.validated_at = now
            await rel.update()

        # Annotation I/O only on verdict transitions — a cache-hit sweep
        # (the steady state) issues zero annotation queries.
        if verdict.status == SemanticStatus.BREAK.value:
            if changed:
                await _flag_break(
                    rel, lock, target_ent, verdict.detail,
                    verdict.current_hashes.get("target", ""),
                )
        elif verdict.status == SemanticStatus.OK.value and prior_status == SemanticStatus.BREAK.value:
            await _resolve_break_annotations(rel)

        counts[verdict.status] += 1
        results.append({
            "relationship_id": rel.id,
            "lock": str(rel.from_typeid) if rel.from_typeid else None,
            "target": str(rel.to_typeid) if rel.to_typeid else None,
            "kind": rel.kind,
            "status": verdict.status,
            "detail": verdict.detail,
        })
        if on_progress is not None and ((i + 1) % 10 == 0 or i + 1 == len(rels)):
            await on_progress(i + 1, len(rels))

    return {"checked": len(results), "counts": counts, "results": results}


async def semantic_status(ent) -> dict[str, Any]:
    """This entity's dependson rows, both directions, serialized."""
    import asyncio  # noqa: PLC0415

    as_lock, as_target = await asyncio.gather(
        ent.get_outgoing_relationships(_dependson_filter()),
        ent.get_incoming_relationships(_dependson_filter()),
    )
    return {
        "semantic_lock": bool(getattr(ent, "semantic_lock", False)),
        "as_lock": [_rel_json(r) for r in as_lock],
        "as_target": [_rel_json(r) for r in as_target],
    }


async def waive_relationship(ent, relationship_id: str) -> dict[str, Any] | None:
    """User waive: align validated hashes to the CURRENT content, stamp
    ``validated_by=user`` / ``status=ok``, resolve open break annotations.
    Returns the updated row, or None when the id doesn't reference ``ent``."""
    from flow_sdk.db.relationship_model import DependsOnRelationship  # noqa: PLC0415

    rows = await DependsOnRelationship.get_all_relationships(
        QueryFilter.parse({"id": relationship_id}, BuiltInRelationshipTypes.DependsOn.value)
    )
    rel = rows[0] if rows else None
    if rel is None or str(ent.typeid) not in (
        str(rel.from_typeid) if rel.from_typeid else "",
        str(rel.to_typeid) if rel.to_typeid else "",
    ):
        return None
    lock = await _load_entity(rel.from_typeid)
    target_ent = await _load_entity(rel.to_typeid)
    lock_bytes = await _entity_content_bytes(lock) if lock is not None else None
    adapter = await _target_adapter(target_ent)
    target_hash = adapter.current_hash()
    hashes = dict(rel.validated_hashes or {})
    if lock_bytes is not None:
        from flow_sdk.llm_index.core import sha256_bytes  # noqa: PLC0415
        hashes["lock"] = sha256_bytes(lock_bytes)
    if target_hash is not None:
        hashes["target"] = target_hash
    rel.validated_hashes = hashes
    rel.status = SemanticStatus.OK.value
    rel.validated_by = ValidatedBy.USER.value
    rel.validated_at = datetime.now(timezone.utc).isoformat()
    rel.break_detail = {}
    await rel.update()
    resolved = await _resolve_break_annotations(rel)
    return {**_rel_json(rel), "annotations_resolved": resolved}
