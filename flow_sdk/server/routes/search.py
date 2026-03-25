"""
Search route for the local server.

Uses FTS5 full-text search via Entity.search().
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter()


async def _reindex_all() -> int:
    """Discover all indexable record types and submit them for indexing via Record.sync_to_db().

    Returns the count of records indexed.
    """
    from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415

    _, index_results = await SchemaRecord.discover(trigger="reindex")
    total = sum(r.indexed for r in index_results)
    logger.info("reindex: indexed %d records", total)
    return total


def _entity_source_path(ent) -> str:
    """Resolve source_path for an entity: check common fields, then fall back to its record."""
    path = (
        getattr(ent, "source_path", None)
        or getattr(ent, "source_vfs_path", None)
        or getattr(ent, "fs_storage_mount_path", None)
        or getattr(ent, "file_path", None)
        or getattr(ent, "work_dir", None)
    )
    if path:
        return path
    try:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        record_cls = SchemaRegistry.get_record_cls(ent.type or ent.get_type())
        if record_cls:
            rec = record_cls.discover_one(ent.id)
            # For record types where entity ID (UUID) differs from record ID (name),
            # fall back to looking up by name (e.g. agent records keyed by agent name).
            if rec is None:
                ent_name = getattr(ent, "name", None) or getattr(ent, "uname", None)
                if ent_name:
                    rec = record_cls.discover_one(ent_name)
            if rec:
                return getattr(rec, "source_path", None) or ""
    except Exception:
        pass
    return ""


def _apply_scope_filter(entities: list, scope: str | None, project_ids: str | None) -> list:
    """Filter entities by scope and optional project IDs."""
    if not scope:
        return entities
    if scope == "user":
        return [e for e in entities if (getattr(e, "scope", None) or "") == "user"]
    if scope == "project":
        pid_list = [p.strip() for p in project_ids.split(",") if p.strip()] if project_ids else []
        if pid_list:
            pid_set = set(pid_list)
            return [
                e for e in entities
                if (getattr(e, "scope", None) or "") == "project"
                and (getattr(e, "project_encoded", None) or getattr(e, "id", "")) in pid_set
            ]
        return [e for e in entities if (getattr(e, "scope", None) or "") == "project"]
    return entities


def _entity_to_result(ent) -> dict:
    name = (
        getattr(ent, "name", None)
        or getattr(ent, "uname", None)
        or getattr(ent, "title", None)
        or ""
    )
    result = {
        "record_id": ent.id,
        "record_type": ent.type or ent.get_type(),
        "name": name,
        "snippet": getattr(ent, "_fts_snippet", None),
        "status": getattr(ent, "status", None) or "",
        "scope": getattr(ent, "scope", "") or "",
        "source_path": _entity_source_path(ent) or name or ent.id,
        "created_at": str(getattr(ent, "created_date", "") or ""),
        "modified_at": str(getattr(ent, "updated_date", "") or ""),
    }
    # Extra fields for per-type column rendering
    for field in ("uname", "title", "description", "file_path", "filename", "work_dir", "project_encoded", "project_encoded_name", "worker_session_id", "asset_type"):
        val = getattr(ent, field, None)
        if val:
            result[field] = val
    return result


@router.get("/api/v1/search")
async def search_records(
    q: str = Query(default="", description="Search query"),
    limit: int = Query(default=10, ge=1, description="Maximum results to return"),
    offset: int = Query(default=0, ge=0, description="Offset for pagination"),
    record_type: Optional[str] = Query(default=None, description="Filter by record type"),
    status: Optional[str] = Query(default=None, description="Filter by record status"),
    scope: Optional[str] = Query(default=None, description="Filter by scope (user, project)"),
    tags: Optional[str] = Query(default=None, description="Comma-separated tags to filter by"),
    project_ids: Optional[str] = Query(default=None, description="Comma-separated project entity IDs (used when scope=project)"),
    col_weights: Optional[str] = Query(default=None, description="Comma-separated BM25 column weights (6 values)"),
    recency_boost: Optional[float] = Query(default=None, description="SQL-side additive recency penalty per day"),
    recency_factor: Optional[float] = Query(default=None, description="Python-side multiplicative recency decay per day (k in bm25/(1+days*k))"),
    overfetch: Optional[int] = Query(default=None, ge=0, description="Extra rows to fetch beyond limit for recency blend"),
    type_scores: Optional[str] = Query(default=None, description="JSON object of type→score adjustments"),
):
    """Search indexed records using FTS5 full-text search, or browse all when query is empty."""
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
    from flow_sdk.db.drivers.sqlite.sqlite_driver import SearchCalibration  # noqa: PLC0415
    import json as _json  # noqa: PLC0415

    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []

    # Build calibration from query params
    cal_col_weights = None
    if col_weights:
        try:
            parsed = [float(x) for x in col_weights.split(",")]
            if len(parsed) == 6:
                cal_col_weights = parsed
        except (ValueError, AttributeError):
            pass
    cal_type_scores = None
    if type_scores:
        try:
            cal_type_scores = _json.loads(type_scores)
        except Exception:
            pass
    calibration = SearchCalibration(
        col_weights=cal_col_weights,
        recency_boost=recency_boost,
        recency_factor=recency_factor,
        overfetch=overfetch,
        type_scores=cal_type_scores,
    )

    if not q:
        # Browse mode: return all entities matching filters, paginated
        # Must use QueryFilter directly — passing a dict routes through QueryFilter.parse(d, cls.get_type())
        # which overwrites QueryFilter.type with "entity" (base class name), breaking the SQL type filter.
        qf = QueryFilter(type=record_type or "entity")
        if status:
            from flow_sdk.db.drivers.query import ExpressionNode  # noqa: PLC0415
            qf.match = ExpressionNode(**{"status": status})
        qf.order_by = {"updated_date": "desc"}
        all_entities = await Entity.get_all(qf)

        # Apply scope + project_ids filtering
        all_entities = _apply_scope_filter(all_entities, scope, project_ids)

        # Apply tags filter
        if tag_list:
            all_entities = [
                e for e in all_entities
                if all(t in (getattr(e, "tags", None) or []) for t in tag_list)
            ]

        total_count = len(all_entities)
        page = all_entities[offset:offset + limit]
        results = [_entity_to_result(e) for e in page]
        return JSONResponse(content={
            "status": "SUCCESS",
            "data": {"results": results, "query": "", "total": total_count, "indexer_ready": True},
        })

    try:
        entities = await Entity.search(query=q, limit=limit + offset, record_type=record_type, status=status, calibration=calibration)
    except Exception:
        logger.warning("FTS search failed (index may not be ready), returning empty results", exc_info=True)
        return JSONResponse(content={
            "status": "SUCCESS",
            "data": {"results": [], "query": q, "total": 0, "indexer_ready": False},
        })

    # Apply scope + project_ids filtering
    entities = _apply_scope_filter(entities, scope, project_ids)

    # Apply tags filter
    if tag_list:
        entities = [
            e for e in entities
            if all(t in (getattr(e, "tags", None) or []) for t in tag_list)
        ]

    # Apply offset slice
    entities = entities[offset:]

    results = [_entity_to_result(e) for e in entities]

    return JSONResponse(content={
        "status": "SUCCESS",
        "data": {"results": results, "query": q, "total": len(results), "indexer_ready": True},
    })


@router.post("/api/v1/search/reindex")
async def reindex_records():
    """Re-index all discoverable records via Record.sync_to_db()."""
    indexed = await _reindex_all()
    return JSONResponse(content={
        "status": "SUCCESS",
        "data": {"indexed": indexed},
    })


@router.post("/api/v1/search/reindex/{record_type}")
async def reindex_records_by_type(record_type: str):
    """Re-index all records of a specific type via Record.sync_to_db()."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if SchemaRegistry.get_record_cls(record_type) is None:
        return JSONResponse(
            status_code=404,
            content={"status": "FAIL", "message": f"Unknown record type: {record_type}", "data": None},
        )

    from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415

    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    record_cls = SchemaRegistry.get_record_cls(record_type)
    count = 0
    live_ids: set[str] = set()
    for rec in RecordList(record_class=record_cls):
        try:
            await rec.sync_to_db()
            live_ids.add(rec.id)
            count += 1
        except Exception:
            logger.exception("reindex: failed to index %s %s", record_type, rec.id)

    # Delete entities whose records no longer exist on disk
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
    stale = await Entity.get_all(QueryFilter(type=record_type))
    deleted = 0
    for ent in stale:
        if ent.id not in live_ids:
            try:
                await ent.delete()
                deleted += 1
            except Exception:
                pass

    return JSONResponse(content={
        "status": "SUCCESS",
        "data": {"indexed": count, "deleted": deleted, "record_type": record_type},
    })
