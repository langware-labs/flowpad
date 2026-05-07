"""FsRecordsActionsMixin — fs-records CRUD gateway and indexing for ComputeNode.

Mixed into ComputeNode. Accesses self.typeid, self.id,
self._start_activity(), self._complete_activity() via normal
Python attribute lookup — no dependency injection needed.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.core.entity.entity_model import DEFAULT_BROWSE_LIMIT



class FsRecordsActionsMixin:
    """fs-records CRUD gateway and indexing implementation for ComputeNode.

    All methods here are plain implementations — no @action decorators.
    ComputeNode keeps the @action stub and delegates to _fs_records_action().
    """

    # -- fs-records search helper ------------------------------------------------

    @staticmethod
    def _entity_display_name(ent) -> str:
        """Return the best human-readable name for a search result card."""
        display_name = getattr(ent, "display_name", None)
        if display_name:
            return str(display_name)
        return getattr(ent, "name", None) or getattr(ent, "title", "") or ""

    @staticmethod
    async def _resolve_asset_ref(ent) -> str:
        """Resolve the on-disk asset_ref for an entity, with a record-level fallback."""
        path = getattr(ent, "asset_ref", None) or getattr(ent, "source_file", None)
        if path:
            return path
        try:
            from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
            rec = await ent.get_record()
            if rec is None:
                record_cls = SchemaRegistry.get_record_cls(ent.type or ent.get_type())
                if record_cls:
                    ent_name = getattr(ent, "name", None) or getattr(ent, "uname", None)
                    if ent_name:
                        rec = record_cls.get(ent_name)
            if rec:
                ar = getattr(rec, "_asset_ref", None)
                if ar is not None:
                    return getattr(ar, "path", None) or ""
        except Exception:
            pass
        return ""

    async def _handle_fs_records_search(self, request_info) -> ApiResponse:
        from flow_sdk.core.entity.entity_model import Entity

        qp = request_info.request.query_params
        q = qp.get("q", "").strip()
        limit = max(1, int(qp.get("limit", DEFAULT_BROWSE_LIMIT)))
        record_type = qp.get("record_type", "") or None
        status = qp.get("status", "") or None

        if not q:
            # Filter-only browse: query DB with FTS join so fts_title is populated
            if record_type:
                entities = await Entity.browse(record_type=record_type, limit=limit, status=status)
                results = []
                for ent in entities:
                    ent_status = getattr(ent, "status", None) or ""
                    row = {
                            "record_id": ent.id,
                            "record_type": ent.type or record_type,
                            "name": self._entity_display_name(ent),
                            "snippet": None,
                            "fts_title": getattr(ent, "_fts_title", None),
                            "fts_description": getattr(ent, "_fts_description", None),
                            "status": ent_status,
                            "scope": getattr(ent, "scope", "") or "",
                            "created_at": (d.isoformat() if (d := getattr(ent, "created_date", None)) else ""),
                            "modified_at": (d.isoformat() if (d := getattr(ent, "updated_date", None)) else ""),
                            "asset_ref": await self._resolve_asset_ref(ent),
                            "labels": getattr(ent, "labels", None) or [],
                        }
                    for extra_field in ("session_id", "worker_session_id"):
                        val = getattr(ent, extra_field, None)
                        if val:
                            row[extra_field] = val
                    results.append(row)
                return ApiSuccessResponse(
                    data={"results": results, "query": "", "total": len(results), "indexer_ready": True}
                )
            return ApiSuccessResponse(data={"results": [], "query": q, "total": 0, "indexer_ready": True})

        # Parse optional calibration params
        from flow_sdk.db.drivers.sqlite.sqlite_driver import SearchCalibration

        col_weights_raw = qp.get("col_weights")
        recency_boost_raw = qp.get("recency_boost")
        type_scores_raw = qp.get("type_scores")
        cal = None
        if col_weights_raw or recency_boost_raw or type_scores_raw:
            cal = SearchCalibration(
                col_weights=[float(x) for x in col_weights_raw.split(",")] if col_weights_raw else None,
                recency_boost=float(recency_boost_raw) if recency_boost_raw else None,
                type_scores=json.loads(type_scores_raw) if type_scores_raw else None,
            )

        # FTS5 search
        entities = await Entity.search(query=q, limit=limit, record_type=record_type, calibration=cal)
        results = []
        for ent in entities:
            ent_status = getattr(ent, "status", None) or ""
            if status and ent_status != status:
                continue
            row = {
                    "record_id": ent.id,
                    "record_type": ent.type or ent.get_type(),
                    "name": self._entity_display_name(ent),
                    "snippet": getattr(ent, "_fts_snippet", None),
                    "fts_title": getattr(ent, "_fts_title", None),
                    "fts_description": getattr(ent, "_fts_description", None),
                    "status": ent_status,
                    "scope": getattr(ent, "scope", "") or "",
                    "created_at": (d.isoformat() if (d := getattr(ent, "created_date", None)) else ""),
                    "modified_at": (d.isoformat() if (d := getattr(ent, "updated_date", None)) else ""),
                    "asset_ref": await self._resolve_asset_ref(ent),
                    "labels": getattr(ent, "labels", None) or [],
                }
            for extra_field in ("session_id", "worker_session_id"):
                val = getattr(ent, extra_field, None)
                if val:
                    row[extra_field] = val
            results.append(row)
        return ApiSuccessResponse(data={"results": results, "query": q, "total": len(results), "indexer_ready": True})

    async def _handle_fs_records_scan(self, request_info) -> ApiResponse:
        """Scan fs_records for stats.

        GET /fs-records/scan           → aggregate stats for all registered types
        GET /fs-records/scan?type=X    → per-type stats + record list

        Backed by ``FSIndexer.scan()``. Emits ``progress_report`` FlowData
        events per type via the shared indexer's ``on_progress`` callback.
        """
        import time

        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            INDEXABLE_TYPES,
            IndexerOptions,
            ProgressEvent,
            get_shared_indexer,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        trigger = qp.get("trigger", "auto").strip() or "auto"
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None
        limit_per_type_raw = qp.get("limit_per_type", "").strip()
        limit_per_type = int(limit_per_type_raw) if limit_per_type_raw.isdigit() else None

        # Type filter + validation
        types_filter: list[RecordType] | None = None
        if filter_type:
            try:
                types_filter = [RecordType(filter_type)]
            except ValueError:
                return ApiFailResponse(
                    message=f"Unknown record type '{filter_type}'",
                    status_code=400,
                )
        elif limit_types is not None:
            types_filter = list(INDEXABLE_TYPES)[:limit_types]

        # Activity tracking for duplicate-prevention + UI progress
        total = 1 if filter_type else (
            len(types_filter) if types_filter is not None else len(INDEXABLE_TYPES)
        )
        try:
            activity = self._start_activity("scan", total=total, timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        # Translate ProgressEvent → activity updates → WebSocket broadcast.
        # Scaffolding types (USER_HOME_FOLDER, SYSTEM_ROOT, REAL_PROJECT_CWD,
        # CWD_ROOT, PROJECT) are DFS waypoints the walker touches to reach the
        # leaf record types; they should not show up in user-facing progress.
        _SCAFFOLD_TYPES = {
            RecordType.USER_HOME_FOLDER,
            RecordType.SYSTEM_ROOT,
            RecordType.REAL_PROJECT_CWD,
            RecordType.CWD_ROOT,
            RecordType.PROJECT,
            RecordType.FOLDER,
        }

        async def emit(ev: ProgressEvent) -> None:
            if ev.stage == "type_complete":
                if ev.record_type in _SCAFFOLD_TYPES:
                    return
                if types_filter and ev.record_type not in types_filter:
                    return
                activity.sub_activity_name = str(ev.record_type)
                activity.sub_done = ev.count
                activity.sub_total = ev.count
                activity.sub_skipped = 0
                activity.sub_errors = ev.errors
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(str(ev.record_type)),
                )
                activity.done = min(activity.done + 1, activity.total)
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
            elif ev.stage == "scan_end":
                # Authoritative scan-completion event; mirrors index_end.
                activity.done = activity.total
                activity.sub_activity_name = None
                activity.sub_done = 0
                activity.sub_total = 0
                activity.text = "complete"
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )

        try:
            t0 = time.perf_counter()
            nodes = await get_shared_indexer().scan(IndexerOptions(
                types=types_filter,
                limit_per_type=limit_per_type,
                on_progress=emit,
                verbose=False,
            ))
            scan_ms = round((time.perf_counter() - t0) * 1000, 1)
        finally:
            self._complete_activity("scan")

        # Bucket FSRefs by record_type; compute count / total_bytes per type.
        # For single-type calls, also collect a per-record list.
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR_rec  # noqa: PLC0415
        by_type: dict[str, dict] = {}
        for n in nodes:
            if n.record_type is None:
                continue
            key = str(n.record_type)
            b = by_type.setdefault(key, {
                "type": key, "count": 0, "total_bytes": 0, "_records": [],
            })
            b["count"] += 1
            try:
                st = n._path.stat()
                b["total_bytes"] += st.st_size
                if filter_type:
                    # Use the record class's own id resolution so the returned
                    # `id` is a valid record id (not a filesystem path).
                    _info = _SR_rec.get(key)
                    if _info is not None and _info.record_cls is not None:
                        try:
                            rec_id = _info.record_cls.getId(n)
                        except Exception:
                            rec_id = str(n._path)
                    else:
                        rec_id = str(n._path)
                    b["_records"].append({
                        "id": rec_id,
                        "name": n._path.stem,
                        "size_bytes": st.st_size,
                        "modified_at": st.st_mtime,
                    })
            except OSError:
                pass

        for b in by_type.values():
            b["avg_bytes"] = b["total_bytes"] // b["count"] if b["count"] else 0
            # Per-type scan_ms is not tracked — the unified walk shares work across
            # types. Total scan_ms (below) is the meaningful number.
            b["scan_ms"] = 0.0

        per_type = list(by_type.values())
        grand_total = sum(b["count"] for b in per_type)
        grand_bytes = sum(b["total_bytes"] for b in per_type)

        # Strip internal _records key from aggregate response
        types_for_log = [
            {k: v for k, v in b.items() if k != "_records"} for b in per_type
        ]

        last_scan_at = SchemaRecord.append_scan(
            trigger=trigger,
            duration_ms=scan_ms,
            total_records=grand_total,
            total_bytes=grand_bytes,
            types=types_for_log if not filter_type else [],
            type_name=filter_type or None,
        )

        if filter_type:
            # Pull the exact bucket for the filtered type — DFS walker visits
            # scaffold types first (USER_HOME_FOLDER, etc.), so `per_type[0]`
            # is typically the wrong bucket.
            b = by_type.get(filter_type)
            if b is None:
                return ApiSuccessResponse(data={
                    "type": filter_type, "count": 0, "total_bytes": 0,
                    "avg_bytes": 0, "scan_ms": scan_ms, "records": [],
                    "min_bytes": 0, "max_bytes": 0, "last_scan_at": last_scan_at,
                })
            records = b["_records"]
            sizes = [r["size_bytes"] for r in records] if records else [0]
            return ApiSuccessResponse(data={
                "type": filter_type,
                "count": b["count"],
                "total_bytes": b["total_bytes"],
                "avg_bytes": b["avg_bytes"],
                "scan_ms": scan_ms,
                "records": records,
                "min_bytes": min(sizes),
                "max_bytes": max(sizes),
                "last_scan_at": last_scan_at,
            })

        return ApiSuccessResponse(data={
            "types": types_for_log,
            "grand_total": grand_total,
            "scan_ms": scan_ms,
        })

    async def _handle_fs_records_index_status(self, request_info) -> ApiResponse:
        """Return index freshness info.

        GET /fs-records/index-status
        """
        from dataclasses import asdict  # noqa: PLC0415

        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415

        status = await SchemaRecord.get_index_status()
        return ApiSuccessResponse(
            data={
                "never_indexed": status.never_indexed,
                "last_indexed_at": status.last_indexed_at,
                "stale": status.stale,
                "default_types": status.default_types,
                "per_type": [asdict(t) for t in status.per_type],
            }
        )

    async def _handle_fs_records_index_clear(self, request_info) -> ApiResponse:
        """Clear all FTS index data and reset index logs.

        DELETE /fs-records/index
        """
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        types = [filter_type] if filter_type else None
        result = await SchemaRecord.clear_index(types)
        return ApiSuccessResponse(
            data={
                "fts_cleared": result.fts_cleared,
                "entities_cleared": result.entities_cleared,
            }
        )

    async def _handle_fs_records_index(self, request_info) -> ApiResponse:
        """Index fs_records into the Entity DB via Record.sync_to_db().

        POST /fs-records/index                       → index all registered types
        POST /fs-records/index?type=X                → index one type
        POST /fs-records/index?rebuild=true          → clear + re-index
        POST /fs-records/index?project_id=<id>       → scope to a single project's
                                                       fs_storage_mount_path subtree
                                                       (one REAL_PROJECT_CWD root).

        Backed by ``FSIndexer.index()``. Emits ``progress_report`` FlowData
        events per type via the shared indexer's ``on_progress`` callback.
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            INDEXABLE_TYPES,
            IndexerOptions,
            OrphanAction,
            ProgressEvent,
            get_shared_indexer,
        )
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        trigger = qp.get("trigger", "manual").strip() or "manual"
        rebuild = qp.get("rebuild", "").strip().lower() in ("true", "1")
        force = qp.get("force", "").strip().lower() in ("true", "1")
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None
        limit_per_type_raw = qp.get("limit_per_type", "").strip()
        limit_per_type = int(limit_per_type_raw) if limit_per_type_raw.isdigit() else None
        project_id = qp.get("project_id", "").strip() or None
        orphan_action_raw = qp.get("orphan_action", "").strip().lower()
        try:
            orphan_action = (
                OrphanAction(orphan_action_raw) if orphan_action_raw else OrphanAction.INDEX
            )
        except ValueError:
            return ApiFailResponse(
                message=(
                    f"Invalid orphan_action '{orphan_action_raw}'. "
                    f"Valid: {[a.value for a in OrphanAction]}"
                ),
                status_code=400,
            )

        # Resolve project_id → single REAL_PROJECT_CWD root via the project's
        # fs_storage_mount_path. This restricts the walker to that subtree only.
        custom_roots: tuple[FSRef, ...] | None = None
        if project_id:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415
            from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
            from pathlib import Path as _Path  # noqa: PLC0415
            proj = await Project.get_one(QueryFilter.parse({"id": project_id}))
            if proj is None:
                return ApiFailResponse(
                    message=f"Project '{project_id}' not found",
                    status_code=404,
                )
            mount = getattr(proj, "fs_storage_mount_path", None)
            if not mount:
                return ApiFailResponse(
                    message=f"Project '{project_id}' has no fs_storage_mount_path",
                    status_code=400,
                )
            mount_path = _Path(str(mount))
            if not mount_path.is_dir():
                return ApiFailResponse(
                    message=f"Project mount path '{mount}' is not a directory",
                    status_code=400,
                )
            custom_roots = (
                FSRef(
                    mount_path,
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="project",
                    project_id=project_id,
                ),
            )

        # Type filter + validation
        types_filter: list[RecordType] | None = None
        if filter_type:
            try:
                types_filter = [RecordType(filter_type)]
            except ValueError:
                return ApiFailResponse(
                    message=f"Unknown record type '{filter_type}'",
                    status_code=400,
                )
        elif limit_types is not None:
            types_filter = list(INDEXABLE_TYPES)[:limit_types]

        driver = get_db_driver()

        # Rebuild mode: clear DB + FTS for target types first
        if rebuild:
            targets = types_filter or INDEXABLE_TYPES
            for t in targets:
                await driver.delete_entities_by_type(str(t))
            if not filter_type:
                # Only full-clear FTS on aggregate rebuild; per-type rebuild
                # already cleared matching FTS rows via delete_entities_by_type
                await driver.fts_clear()

        # Activity tracking for duplicate-prevention + UI progress
        total = 1 if filter_type else (
            len(types_filter) if types_filter is not None else len(INDEXABLE_TYPES)
        )
        try:
            activity = self._start_activity("index", total=total, timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        # Scaffolding types the walker traverses but the user didn't request.
        _SCAFFOLD_TYPES_IDX = {
            RecordType.USER_HOME_FOLDER,
            RecordType.SYSTEM_ROOT,
            RecordType.REAL_PROJECT_CWD,
            RecordType.CWD_ROOT,
            RecordType.PROJECT,
            RecordType.FOLDER,
        }

        def _skip(ev: ProgressEvent) -> bool:
            if ev.record_type in _SCAFFOLD_TYPES_IDX:
                return True
            if types_filter and ev.record_type not in types_filter:
                return True
            return False

        async def emit(ev: ProgressEvent) -> None:
            if ev.stage == "type_start":
                if _skip(ev):
                    return
                activity.sub_activity_name = str(ev.record_type)
                activity.sub_done = 0
                activity.sub_total = ev.sub_total
                activity.sub_errors = 0
                activity.sub_skipped = 0
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(str(ev.record_type)),
                )
            elif ev.stage == "type_progress":
                if _skip(ev):
                    return
                activity.sub_activity_name = str(ev.record_type)
                activity.sub_done = ev.sub_done
                activity.sub_total = ev.sub_total
                activity.sub_errors = ev.errors
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(str(ev.record_type)),
                )
            elif ev.stage == "type_complete":
                if _skip(ev):
                    return
                activity.sub_activity_name = str(ev.record_type)
                activity.sub_done = ev.sub_done or ev.indexed
                activity.sub_total = ev.sub_total or ev.indexed
                activity.sub_errors = ev.errors
                activity.sub_skipped = 0
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(str(ev.record_type)),
                )
                activity.done = min(activity.done + 1, activity.total)
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
            elif ev.stage == "index_end":
                # Authoritative job-completion: settles UI state regardless of
                # how the per-type events landed. Frontend's done>=total path
                # treats this as the definitive "I'm done" signal.
                activity.done = activity.total
                activity.sub_activity_name = None
                activity.sub_done = 0
                activity.sub_total = 0
                activity.text = "complete"
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )

        try:
            result = await get_shared_indexer().index(IndexerOptions(
                types=types_filter,
                limit_per_type=limit_per_type,
                on_progress=emit,
                verbose=False,
                roots=custom_roots,
                force=force,
                project_id=project_id,
                orphan_action=orphan_action,
            ))
        finally:
            self._complete_activity("index")

        types_out = [
            {
                "type": str(rt),
                "indexed": pt.indexed,
                "errors": pt.errors,
                "duration_ms": pt.duration_ms,
                "orphans_found": pt.orphans_found,
                "orphans_db_removed": pt.orphans_db_removed,
                "orphans_disk_removed": pt.orphans_disk_removed,
            }
            for rt, pt in result.per_type.items()
        ]

        SchemaRecord.append_index(
            trigger=trigger,
            duration_ms=result.duration_ms,
            total_indexed=result.total_indexed,
            types=types_out if not filter_type else [],
            type_name=filter_type or None,
        )

        if filter_type:
            if not types_out:
                return ApiSuccessResponse(data={
                    "type": filter_type,
                    "indexed": 0,
                    "errors": 0,
                    "orphans_found": 0,
                    "orphans_db_removed": 0,
                    "orphans_disk_removed": 0,
                })
            one = types_out[0]
            return ApiSuccessResponse(data={
                "type": one["type"],
                "indexed": one["indexed"],
                "errors": one["errors"],
                "orphans_found": one["orphans_found"],
                "orphans_db_removed": one["orphans_db_removed"],
                "orphans_disk_removed": one["orphans_disk_removed"],
            })

        return ApiSuccessResponse(data={
            "indexed": result.total_indexed,
            "errors": result.total_errors,
            "orphans_found": result.total_orphans_found,
            "orphans_db_removed": result.total_orphans_db_removed,
            "orphans_disk_removed": result.total_orphans_disk_removed,
            "types": types_out,
            "duration_ms": result.duration_ms,
        })

    async def _handle_fs_records_discover_by_path(
        self,
        record_type: str,
        request_info,
    ) -> ApiResponse:
        """POST /fs-records/{type}/discover?path=<P>

        Find-or-recover a single record by absolute path. Scans the file on
        disk, syncs the resulting record to the entity DB, and returns its
        metadata. Idempotent: a second call hits the cache.

        Used by the frontend's `useEntityByPath` hook to recover a record
        when the bulk list query misses (e.g. just-created workflow file).

        Returns 404 if the file doesn't exist on disk OR doesn't match the
        requested type's discovery rules.
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415
        from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415

        qp = request_info.request.query_params
        raw_path = (qp.get("path") or "").strip()
        if not raw_path:
            return ApiFailResponse(
                message="Missing required 'path' query parameter",
                status_code=400,
            )

        record_cls = _SR.get_record_cls(record_type)
        if record_cls is None:
            return ApiFailResponse(
                message=f"Unknown record type '{record_type}'. Available: {_SR.get_all_record_types()}",
                status_code=400,
            )

        # Expand ~ and resolve to a Path. Don't require the file to exist yet —
        # we'll let the discovery layer decide.
        expanded = str(Path(raw_path).expanduser())
        target_norm = _normalize_asset_path(expanded)

        # Inline match helper — looks up the record list by asset_ref
        # equivalence. Returns the matched record even if its source is
        # missing on disk: the caller now reads ``entity.orphan`` to
        # distinguish stale-but-known-rows from never-existed paths.
        # 404 is reserved for "no record at all"; orphans are SUCCESS.
        def _find_in(record_list: "RecordList") -> "Record | None":  # type: ignore[name-defined]
            for rec in record_list:
                ref = getattr(rec, "asset_ref", None) or getattr(rec, "_asset_ref", None)
                ref_path = getattr(ref, "path", None) if ref is not None else None
                if ref_path is None:
                    ref_path = str(ref) if ref else ""
                if _normalize_asset_path(ref_path) == target_norm:
                    return rec
            return None

        # Pass 1: try the existing index (shadow tree). Fast path.
        record_list = RecordList(record_class=record_cls)
        try:
            found = _find_in(record_list)
        except Exception as e:
            return ApiFailResponse(
                message=f"Failed to scan {record_type}: {e}",
                status_code=500,
            )

        # Pass 2: on miss, force a fresh FSIndexer scan of the user's
        # workflow / agent / skill / plan directories. The base
        # ``Record.discover()`` walks ``records_root / <type> /`` (the
        # **shadow** tree), so a brand-new file on disk is invisible
        # until the indexer materialises it. This is the recovery path
        # for ``useEntityByPath``: file exists on disk, isn't yet in
        # the index → re-index this single type, then look again.
        if found is None:
            try:
                from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
                    IndexerOptions,
                    get_shared_indexer,
                )
                from flow_sdk.fs_store.record_types import RecordType as _RT  # noqa: PLC0415
                rt = _RT(record_type)
                indexer = get_shared_indexer()
                await indexer.index(IndexerOptions(types=[rt]))
            except Exception as e:
                return ApiFailResponse(
                    message=f"Re-index failed for {record_type}: {e}",
                    status_code=500,
                )
            # Fresh RecordList — `RecordList(MUTABLE)` re-discovers per call,
            # but instantiating a new one is the cleanest reset.
            record_list = RecordList(record_class=record_cls)
            try:
                found = _find_in(record_list)
            except Exception as e:
                return ApiFailResponse(
                    message=f"Failed to scan {record_type} after reindex: {e}",
                    status_code=500,
                )

        if found is None:
            return ApiFailResponse(
                message=f"No {record_type} found at path: {raw_path}",
                status_code=404,
            )

        # Sync to DB so future bulk queries pick it up. Idempotent.
        # Skip when the source is missing on disk — `sync_to_db` rebuilds
        # the entity row from the Record's fields, which would clobber the
        # `orphan` / `orphan_since` flags the FSIndexer set on this row.
        # Orphan state is the indexer's responsibility; discover just reads.
        _ar_for_sync = getattr(found, "asset_ref", None)
        _ar_path_for_sync = getattr(_ar_for_sync, "path", None) if _ar_for_sync is not None else None
        _alive_on_disk = bool(_ar_path_for_sync and Path(str(_ar_path_for_sync)).expanduser().exists())
        if _alive_on_disk:
            try:
                await found.sync_to_db()
            except Exception as e:
                # Log but don't fail — sync may legitimately fail for read-only sources.
                logging.debug(f"[fs-records] sync_to_db on discover skipped for {record_type}: {e}")

        data = found.meta_dict()
        _ar = getattr(found, "asset_ref", None)
        _ar_path = getattr(_ar, "path", None) if _ar is not None else None
        if _ar_path:
            data["asset_ref"] = _ar_path

        # Merge entity-level fields the Record's meta_dict doesn't know about
        # (orphan / orphan_since live on the Entity row, not the Record).
        # The frontend's `<MissingAssetCard>` reads these to differentiate
        # stale-but-known rows from never-existed paths.
        try:
            from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415
            _ent_cls = _SR.get_entity_cls(record_type)
            if _ent_cls is not None:
                _ent = await _ent_cls.get_by_id(found.id)  # type: ignore[attr-defined]
                if _ent is not None:
                    data["orphan"] = bool(getattr(_ent, "orphan", False))
                    _since = getattr(_ent, "orphan_since", None)
                    if _since is not None:
                        # datetime → ISO 8601 string for the wire
                        data["orphan_since"] = _since.isoformat() if hasattr(_since, "isoformat") else str(_since)
                    else:
                        data["orphan_since"] = None
        except Exception as e:
            logging.debug(f"[fs-records] merge entity orphan fields skipped for {record_type}: {e}")
        return ApiSuccessResponse(data=data)


    async def _handle_fs_records_activity_status(self, request_info) -> ApiResponse:
        """Return the currently-running scan/index activity for this compute node, if any.

        Used by the UI to re-seed progress state after a page refresh so the
        "Rebuild index" progress modal can reopen mid-job.
        """
        from flow_sdk.builtin.faas.compute_node import _COMPUTE_ACTIVITIES  # noqa: PLC0415

        prefix = f"{self.typeid}:"
        for key, activity in _COMPUTE_ACTIVITIES.items():
            if not key.startswith(prefix):
                continue
            if activity is None or activity.is_timed_out or activity.is_complete:
                continue
            return ApiSuccessResponse(data={
                "job_name": activity.job_name,
                "done": activity.done,
                "skipped": activity.skipped,
                "errors": activity.errors,
                "total": activity.total,
                "text": activity.text,
                "sub_activity_name": activity.sub_activity_name,
                "sub_done": activity.sub_done,
                "sub_skipped": activity.sub_skipped,
                "sub_errors": activity.sub_errors,
                "sub_total": activity.sub_total,
                "started_at": activity.started_at.isoformat(),
            })
        return ApiSuccessResponse(data=None)


    # -- fs-records CRUD action --------------------------------------------------

    async def _fs_records_action(self) -> ApiResponse:
        """CRUD gateway for filesystem-backed typed records.

        Uses ``RecordList`` for all record types — delegates discovery to
        ``record_class.discover()`` and persistence to ``record.persist()``.

        Routing (via sub_path):
            GET    /fs-records                   → list registered types
            GET    /fs-records/{type}             → list records of type
            GET    /fs-records/{type}/{uid}       → get one record
            POST   /fs-records/{type}             → create record
            PUT    /fs-records/{type}/{uid}       → update record
            DELETE /fs-records/{type}/{uid}       → delete record
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.fs_store.exceptions import ReadOnlyRecordError  # noqa: PLC0415
        from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            return ApiFailResponse(message="No request info available")

        segments = [s for s in (request_info.sub_path or "").strip("/").split("/") if s]
        method = request_info.method  # lowercase string

        # Path-based source file API: /fs-records/file?path=...
        if segments and segments[0] == "file":
            return await self._handle_path_based_source_file(method, request_info)

        # Semantic search: GET /fs-records/search?q=...
        if segments and segments[0] == "search" and method == "get":
            return await self._handle_fs_records_search(request_info)

        # Scan stats: GET /fs-records/scan or /fs-records/scan?type=X
        if segments and segments[0] == "scan" and method == "get":
            return await self._handle_fs_records_scan(request_info)

        # Index: POST /fs-records/index or /fs-records/index?type=X
        if segments and segments[0] == "index" and method == "post":
            return await self._handle_fs_records_index(request_info)

        # Index status: GET /fs-records/index-status
        if segments and segments[0] == "index-status" and method == "get":
            return await self._handle_fs_records_index_status(request_info)

        # Activity status: GET /fs-records/activity-status
        if segments and segments[0] == "activity-status" and method == "get":
            return await self._handle_fs_records_activity_status(request_info)

        # Clear index: DELETE /fs-records/index
        if segments and segments[0] == "index" and method == "delete":
            return await self._handle_fs_records_index_clear(request_info)

        # No type segment + GET → list registered type names
        if not segments and method == "get":
            return ApiSuccessResponse(data={"types": _SR.get_all_record_types()})

        if not segments:
            return ApiFailResponse(message="Record type is required in URL path", status_code=400)

        # Discover-or-recover by path: POST /fs-records/{type}/discover?path=...
        if len(segments) == 2 and segments[1] == "discover" and method == "post":
            return await self._handle_fs_records_discover_by_path(
                record_type=segments[0],
                request_info=request_info,
            )

        record_type = segments[0]
        uid = segments[1] if len(segments) > 1 else None

        record_cls = _SR.get_record_cls(record_type)
        if record_cls is None:
            return ApiFailResponse(
                message=f"Unknown record type '{record_type}'. Available types: {_SR.get_all_record_types()}",
                status_code=400,
            )

        record_list = RecordList(record_class=record_cls)

        # For write operations, check read-only status via a probe instance.
        # from_dict() bypasses __init__ (which sets _asset_ref), so we must
        # probe with a proper constructor call to get accurate read-only state.
        if method in ("post", "put", "delete"):
            from flow_sdk.fs_store.exceptions import ReadOnlyRecordError

            try:
                probe = record_cls()
                if probe._is_read_only():
                    return ApiFailResponse(
                        message=f"Record type '{record_type}' is read-only",
                        status_code=403,
                    )
            except Exception:
                pass  # if probe fails, fall through and let the real call raise

        try:
            if method == "get":
                # Parse query params into RecordQuery
                qp = request_info.request.query_params
                query = self._parse_record_query(qp)
                include_set = {s.strip() for s in qp.get("include", "").split(",") if s.strip()}

                if uid:
                    rec = await asyncio.to_thread(record_list.get, uid)
                    if rec is None:
                        return ApiFailResponse(message=f"Record '{uid}' not found", status_code=404)
                    item = rec.meta_dict()
                    if include_set:
                        self._embed_includes(item, rec, include_set)
                    return ApiSuccessResponse(data=item)

                if query is not None:
                    results = await asyncio.to_thread(record_list.query, query)
                else:
                    results = await asyncio.to_thread(list, record_list)

                data_list = [r.meta_dict() for r in results]
                if include_set:
                    cache: dict = {}
                    for item, rec in zip(data_list, results):
                        self._embed_includes(item, rec, include_set, cache)
                return ApiSuccessResponse(data=data_list)

            if method == "post":
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(message="Invalid request body (expected JSON object)")
                try:
                    rec = await asyncio.to_thread(record_list.create, body)
                except ValueError as e:
                    return ApiFailResponse(message=str(e), status_code=409)
                try:
                    await rec.sync_to_db()
                except Exception as e:
                    logging.debug(f"[fs-records] sync_to_db skipped on create: {e}")
                await self._broadcast_fs_record_op("create", record_type, rec.id, rec.meta_dict())
                return ApiSuccessResponse(data=rec.meta_dict())

            if method == "put":
                if not uid:
                    return ApiFailResponse(message="Record uid is required for update", status_code=400)
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(message="Invalid request body (expected JSON object)")
                try:
                    rec = await asyncio.to_thread(record_list.update, uid, body)
                except KeyError as e:
                    return ApiFailResponse(message=str(e), status_code=404)
                try:
                    await rec.sync_to_db()
                except Exception as e:
                    logging.debug(f"[fs-records] sync_to_db skipped on update: {e}")
                await self._broadcast_fs_record_op("update", record_type, uid, rec.meta_dict())
                return ApiSuccessResponse(data=rec.meta_dict())

            if method == "delete":
                if not uid:
                    return ApiFailResponse(message="Record uid is required for delete", status_code=400)
                # Remove Entity + FTS before deleting from disk
                from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
                from flow_sdk.db import get_db_driver  # noqa: PLC0415
                from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

                entity = await Entity.get_one(QueryFilter.parse({"id": uid}))
                if entity is not None:
                    driver = get_db_driver()
                    if hasattr(driver, "fts_delete"):
                        await driver.fts_delete(entity.id)
                    await entity.delete()
                # Remove from disk
                deleted = await record_list.delete(uid)
                if not deleted:
                    return ApiFailResponse(message=f"Record '{uid}' not found", status_code=404)
                await self._broadcast_fs_record_op("delete", record_type, uid)
                return ApiSuccessResponse(data={"deleted": uid})

            return ApiFailResponse(message=f"Unsupported method: {method}")

        except ReadOnlyRecordError as e:
            return ApiFailResponse(message=f"Record is read-only: {e}", status_code=403)
        except Exception as e:
            logging.exception(f"fs-records error: {e}")
            return ApiFailResponse(message=str(e))


    @staticmethod
    def _embed_includes(
        item: dict,
        rec: "Record",  # noqa: F821
        include_set: set[str],
        cache: dict | None = None,
    ) -> None:
        """Embed related records into a serialized dict based on ?include=... params.

        *cache* deduplicates session lookups when embedding across a list.
        """
        if "claude_session" in include_set:
            ref = rec.session_ref if hasattr(rec, "session_ref") else None
            if ref and ref.id:
                if cache is not None and ref.id in cache:
                    session_dict = cache[ref.id]
                else:
                    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

                    project = rec.data.get("project", "") if rec.data else ""
                    session = ClaudeSessionRecord.get(ref.id, project=project)
                    session_dict = session.meta_dict() if session else None
                    if cache is not None:
                        cache[ref.id] = session_dict
                if session_dict:
                    item["_session"] = session_dict

    @staticmethod
    def _parse_record_query(qp) -> "RecordQuery | None":  # noqa: F821
        """Parse query string parameters into a RecordQuery, or None if no filters."""
        from datetime import datetime

        from flow_sdk.fs_store.record_query import RecordQuery

        ids_raw = qp.get("ids")
        modified_after_raw = qp.get("modified_after")
        parent_id = qp.get("parent_id")
        status = qp.get("status")
        limit_raw = qp.get("limit")
        offset_raw = qp.get("offset")
        sort_by = qp.get("sort_by")
        sort_desc_raw = qp.get("sort_desc")

        if not any([ids_raw, modified_after_raw, parent_id, status, limit_raw, offset_raw, sort_by]):
            return None

        sort_desc = True
        if sort_desc_raw is not None:
            sort_desc = sort_desc_raw.lower() not in ("false", "0", "no")

        return RecordQuery(
            ids=ids_raw.split(",") if ids_raw else None,
            modified_after=datetime.fromisoformat(modified_after_raw) if modified_after_raw else None,
            parent_id=parent_id,
            status=status,
            limit=int(limit_raw) if limit_raw else None,
            offset=int(offset_raw) if offset_raw else 0,
            sort_by=sort_by,
            sort_desc=sort_desc,
        )

    async def _handle_path_based_source_file(
        self,
        method: str,
        request_info,
    ) -> ApiResponse:
        """Handle path-based source file CRUD: /fs-records/file?path=...&json_path=..."""
        from flow_sdk.fs_store.exceptions import ReadOnlyRecordError
        from flow_sdk.fs_store.source_file_registry import (
            is_allowed_source_path,
            resolve_list_class,
        )

        qp = request_info.request.query_params
        source_path = qp.get("path", "")
        json_path = qp.get("json_path")  # None means "all records"

        if not source_path:
            return ApiFailResponse(
                message="Missing required 'path' query parameter",
                status_code=400,
            )

        if not is_allowed_source_path(source_path):
            return ApiFailResponse(
                message=f"Access denied for path: {source_path}",
                status_code=403,
            )

        # Expand ~ to home dir
        expanded_path = str(Path(source_path).expanduser())

        list_class = resolve_list_class(expanded_path)
        if list_class is None:
            return ApiFailResponse(
                message=f"Unknown source file type: {Path(expanded_path).name}",
                status_code=400,
            )

        record_list = list_class(source_file=expanded_path)

        try:
            if method == "get":
                if json_path is not None:
                    rec = self._find_record_by_json_path(record_list, json_path)
                    if rec is None:
                        return ApiFailResponse(
                            message=f"No record at json_path '{json_path}'",
                            status_code=404,
                        )
                    d = rec.meta_dict()
                    d["source_file"] = expanded_path
                    d["json_path"] = rec.json_path
                    return ApiSuccessResponse(data=d)
                # List all records from the file
                results = []
                for rec in record_list:
                    d = rec.meta_dict()
                    d["source_file"] = expanded_path
                    d["json_path"] = rec.json_path
                    results.append(d)
                return ApiSuccessResponse(data=results)

            if method == "put":
                if json_path is None:
                    return ApiFailResponse(
                        message="'json_path' query parameter is required for update",
                        status_code=400,
                    )
                rec = self._find_record_by_json_path(record_list, json_path)
                if rec is None:
                    return ApiFailResponse(
                        message=f"No record at json_path '{json_path}'",
                        status_code=404,
                    )
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(
                        message="Invalid request body (expected JSON object)",
                    )
                updated = record_list.update(rec.type, rec.id, body)
                try:
                    await updated.sync_to_db()
                except Exception as e:
                    logging.debug(f"[fs-records] sync_to_db skipped on source-file update: {e}")
                result_data = updated.meta_dict()
                result_data["source_file"] = expanded_path
                result_data["json_path"] = updated.json_path
                await self._broadcast_fs_record_op(
                    "update",
                    rec.type,
                    rec.id,
                    result_data,
                    source_file=expanded_path,
                )
                return ApiSuccessResponse(data=result_data)

            if method == "delete":
                if json_path is None:
                    return ApiFailResponse(
                        message="'json_path' query parameter is required for delete",
                        status_code=400,
                    )
                rec = self._find_record_by_json_path(record_list, json_path)
                if rec is None:
                    return ApiFailResponse(
                        message=f"No record at json_path '{json_path}'",
                        status_code=404,
                    )
                deleted = record_list.delete_record(rec.type, rec.id)
                if not deleted:
                    return ApiFailResponse(
                        message=f"Failed to delete record at json_path '{json_path}'",
                        status_code=404,
                    )
                await self._broadcast_fs_record_op(
                    "delete",
                    rec.type,
                    rec.id,
                    source_file=expanded_path,
                )
                return ApiSuccessResponse(data={"deleted": json_path})

            return ApiFailResponse(message=f"Unsupported method: {method}")

        except ReadOnlyRecordError as e:
            return ApiFailResponse(message=f"Record is read-only: {e}", status_code=403)
        except Exception as e:
            logging.exception(f"fs-records path-based error: {e}")
            return ApiFailResponse(message=str(e))

    @staticmethod
    def _find_record_by_json_path(record_list, json_path: str):
        """Find a record by its json_path within a JsonFileRecordStore.

        Handles root record matching: json_path="" or "/" both match the root.
        """
        for rec in record_list:
            rec_jp = getattr(rec, "json_path", None)
            if rec_jp is None:
                continue
            # Root record: both "" and "/" should match
            if json_path in ("", "/") and rec_jp in ("", "/"):
                return rec
            if rec_jp == json_path:
                return rec
        return None

    async def _broadcast_fs_record_op(
        self,
        op: str,
        record_type: str,
        uid: str,
        data: dict | None = None,
        *,
        source_file: str | None = None,
    ) -> None:
        """Broadcast a WebSocket DataOp notification for an fs-record CRUD operation.

        This is notification-only — Entity/FTS sync is done by the caller via
        ``rec.sync_to_db()`` on the real saved record before this is called.
        """
        try:
            from flow_sdk.api.messages import DataOpMessage, OperationType
            from flow_sdk.api.type_id import TypeId
            from flow_sdk.core.network.resource_tracker import handle_entity_op

            op_enum = OperationType(op)
            broadcast_data = dict(data) if data else {}
            if source_file:
                broadcast_data["_source_file"] = source_file
            data_op_msg = DataOpMessage(
                op=op_enum,
                to_entity=TypeId(type=record_type, id=uid),
                data=broadcast_data or None,
            )
            await handle_entity_op(data_op_msg)
        except Exception as e:
            logging.warning(f"[fs-records] Failed to broadcast DataOp: {e}")


def _normalize_asset_path(p: str) -> str:
    """Lower-precision path comparison. Strips trailing slash + leading slash
    so file/folder shapes match consistently."""
    if not p:
        return ""
    p = p.rstrip("/")
    if p.startswith("/"):
        p = p[1:]
    return p
