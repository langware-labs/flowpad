"""
Search route for the local server.

Uses FTS5 full-text search via Entity.search().
"""

import logging
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from flow_sdk.server.search_filters import (
    apply_containment_filter,
    apply_folder_filter,
    apply_scope_filter,
    apply_system_filter,
    apply_tag_filter,
    scope_record_project_ids,
)

logger = logging.getLogger(__name__)

router = APIRouter()


async def _entity_asset_ref(ent) -> str:
    """Resolve asset_ref for an entity: check asset_ref field, fall back to record/legacy mounts."""
    path = (
        getattr(ent, "asset_ref", None)
        or getattr(ent, "fs_storage_mount_path", None)
        or getattr(ent, "file_path", None)
        or getattr(ent, "work_dir", None)
    )
    if path:
        return path
    try:
        rec = await ent.get_record()
        if rec is None:
            from flow_sdk.fs_store.fs_record import FSRecord

            ent_name = getattr(ent, "name", None) or getattr(ent, "uname", None)
            if ent_name:
                rec = FSRecord.load_or_none(ent.type or ent.get_type(), ent_name)
        if rec:
            return rec.asset_path
    except Exception:
        pass
    return ""


async def _entity_to_result(ent) -> dict:
    name = getattr(ent, "name", None) or getattr(ent, "uname", None) or getattr(ent, "title", None) or ""
    result = {
        "record_id": ent.id,
        "record_type": ent.type or ent.get_type(),
        "name": name,
        "snippet": getattr(ent, "_fts_snippet", None),
        "status": getattr(ent, "status", None) or "",
        "scope": getattr(ent, "scope", "") or "",
        "remote": bool(getattr(ent, "remote", False)),
        "project_id": getattr(ent, "project_id", None) or None,
        "asset_ref": await _entity_asset_ref(ent) or "",
        "created_at": str(getattr(ent, "created_date", "") or ""),
        "modified_at": str(getattr(ent, "updated_date", "") or ""),
    }
    # Extra fields for per-type column rendering. ``parent_id`` lets the Assets
    # tree hide member tasks (group-task children live in the task editor's
    # Member tasks section, not the left pane). ``parent_type_id`` is the
    # CANONICAL containment pointer that supersedes it — without it on the wire
    # an asset nested under another asset (an Agent's own copy of an Mcp, say)
    # is indistinguishable from a project-level one, and the tree renders both
    # as top-level siblings of the same name.
    for field in (
        "uname",
        "title",
        "description",
        "file_path",
        "filename",
        "work_dir",
        "session_id",
        "asset_type",
        "parent_path",
        "vault_root",
        "parent_id",
        "parent_type_id",
    ):
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
    user: Optional[str] = Query(
        default=None, description="ScopeFilter.user: include user-scope records. 'true' (default if absent) or 'false'."
    ),
    projects: Optional[str] = Query(
        default=None, description="ScopeFilter.projects: comma-separated project entity IDs to include."
    ),
    tags: Optional[str] = Query(default=None, description="Comma-separated tags to filter by"),
    parent_path: Optional[str] = Query(
        default=None,
        description="Filter to records whose parent_path is exactly this absolute path (direct children only)",
    ),
    vault_root: Optional[str] = Query(
        default=None,
        description="Filter to records whose vault_root is exactly this absolute path (descendants at any depth)",
    ),
    top_level: bool = Query(
        default=False,
        description=(
            "Drop records nested inside another entity that has its own asset-tree root "
            "(e.g. an Agent's own copy of an Mcp). Records parented to a project are kept. "
            "Default off, so existing callers are unaffected."
        ),
    ),
    parent_type_id: Optional[str] = Query(
        default=None,
        description=(
            "Filter to the direct children of this '<type>-<uuid>'. Combine with no "
            "record_type to get one entity's children across every type."
        ),
    ),
    include_system: bool = Query(
        default=False, description="Include entities from SDK-shipped system projects. Default off."
    ),
    col_weights: Optional[str] = Query(default=None, description="Comma-separated BM25 column weights (6 values)"),
    recency_boost: Optional[float] = Query(default=None, description="SQL-side additive recency penalty per day"),
    recency_factor: Optional[float] = Query(
        default=None, description="Python-side multiplicative recency decay per day (k in bm25/(1+days*k))"
    ),
    overfetch: Optional[int] = Query(
        default=None, ge=0, description="Extra rows to fetch beyond limit for recency blend"
    ),
    type_scores: Optional[str] = Query(default=None, description="JSON object of type→score adjustments"),
):
    """Search indexed records using FTS5 full-text search, or browse all when query is empty."""
    import json as _json  # noqa: PLC0415

    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
    from flow_sdk.db.drivers.sqlite.sqlite_driver import SearchCalibration  # noqa: PLC0415
    from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

    # Build the unified ScopeFilter. If `user` param is absent (legacy
    # caller), pass None so the filter is disabled (back-compat for any
    # request that hasn't migrated to the new wire format yet).
    scope_filter = (
        ScopeFilter.from_query_params({"user": user, "projects": projects})
        if user is not None or projects is not None
        else None
    )
    # Resolve project *uname* tokens (e.g. ``@flowpad_assistant``) to entity
    # ids so the scope match stays symmetric with how records are stamped.
    scope_filter = await resolve_project_scope(scope_filter)
    # Projects explicitly in scope — system entities of these projects stay in
    # the list (the count clause already counts them), keeping list/count in sync.
    scoped_pids = scope_record_project_ids(scope_filter) if scope_filter else ()

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
        match_expr = None
        if status:
            from flow_sdk.db.drivers.query import ExpressionNode  # noqa: PLC0415

            match_expr = ExpressionNode(**{"status": status})

        def _qf(type_name: str | None) -> QueryFilter:
            f = QueryFilter(type=type_name or "entity")
            f.match = match_expr
            f.order_by = {"updated_date": "desc"}
            return f

        if parent_type_id and not record_type:
            # Cross-type containment: every child of one owner, whatever its type
            # (an Agent holds Mcps today and Skills the moment one is attached).
            # The driver's type clause is unconditional by design — an indexed
            # ``type = ?`` on the hottest query path — so "any type" is a loop
            # over the candidate types, the same shape ``assets_under_dirs`` uses.
            # The candidates are the REPO families, i.e. exactly the set the
            # ``repo_assets_fn`` walker can nest under another asset.
            from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

            all_entities = []
            for type_name in sorted({i.type_name for i in SchemaRegistry.repo_family_to_info().values()}):
                all_entities.extend(await Entity.get_all(_qf(type_name)))
        else:
            all_entities = await Entity.get_all(_qf(record_type))

        all_entities = apply_scope_filter(all_entities, scope_filter)
        all_entities = apply_folder_filter(all_entities, parent_path, vault_root)
        all_entities = apply_containment_filter(all_entities, top_level, parent_type_id)
        all_entities = apply_system_filter(all_entities, include_system, scoped_pids)
        all_entities = apply_tag_filter(all_entities, tag_list)

        total_count = len(all_entities)
        page = all_entities[offset : offset + limit]
        results = [await _entity_to_result(e) for e in page]
        return JSONResponse(
            content={
                "status": "SUCCESS",
                "data": {"results": results, "query": "", "total": total_count, "indexer_ready": True},
            }
        )

    # Sanitize the FTS query: the unicode61 tokenizer used for entities_fts
    # treats '-' as a word separator, AND FTS5 syntax interprets a hyphen
    # adjacent to a term as a NEGATION operator. A user query like
    # ``hello-flowpad`` therefore parses as ``hello NOT flowpad`` and
    # matches nothing. Replace operator-y punctuation with spaces so
    # callers can type hyphenated names directly. (Quotation marks left
    # alone — callers can still escape for phrase queries.)
    fts_q = q
    if fts_q:
        for ch in "-/_:":
            fts_q = fts_q.replace(ch, " ")
        fts_q = " ".join(fts_q.split())

    try:
        # Fetch (offset + limit) rows from FTS, then apply python-side
        # filters. NOTE: if filters drop more than `offset` rows here, page 2+
        # may be short. A correct fix needs offset pushed into the SQL — left
        # as a follow-up. `total` is the post-filter count BEFORE pagination,
        # so callers see a consistent "matches found" number.
        entities = await Entity.search(
            query=fts_q,
            limit=limit + offset,
            record_type=record_type,
            status=status,
            calibration=calibration,
        )
    except Exception:
        logger.warning("FTS search failed (index may not be ready), returning empty results", exc_info=True)
        return JSONResponse(
            content={
                "status": "SUCCESS",
                "data": {"results": [], "query": q, "total": 0, "indexer_ready": False},
            }
        )

    entities = apply_scope_filter(entities, scope_filter)
    entities = apply_folder_filter(entities, parent_path, vault_root)
    entities = apply_containment_filter(entities, top_level, parent_type_id)
    entities = apply_system_filter(entities, include_system, scoped_pids)
    entities = apply_tag_filter(entities, tag_list)

    total_count = len(entities)
    page = entities[offset : offset + limit]
    results = [await _entity_to_result(e) for e in page]

    # Resolve project_name for each unique project_id in one batched read so
    # the UI can label per-project tree groups without a second round-trip.
    pid_set = {r.get("project_id") for r in results if r.get("project_id")}
    if pid_set:
        try:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415

            projs = await Project.get_all()
            pid_to_name = {}
            for p in projs:
                name = getattr(p, "name", None) or p.id
                pid_to_name[p.id] = name
                legacy_pid = Project.derive_id_for_path(getattr(p, "fs_storage_mount_path", None))
                if legacy_pid:
                    pid_to_name[legacy_pid] = name
            for r in results:
                pid = r.get("project_id")
                if pid and pid in pid_to_name:
                    r["project_name"] = pid_to_name[pid]
        except Exception:
            logger.warning("project_name resolution failed", exc_info=True)

    return JSONResponse(
        content={
            "status": "SUCCESS",
            "data": {"results": results, "query": q, "total": total_count, "indexer_ready": True},
        }
    )
