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
    async def _resolve_source_path(ent) -> str:
        """Resolve the on-disk path for an entity, with a record-level fallback."""
        path = (
            getattr(ent, "source_file", None)
            or (ent.asset_ref.path if getattr(ent, "asset_ref", None) else None)
            or getattr(ent, "source_path", None)
        )
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
                        rec = record_cls.discover_one(ent_name)
            if rec:
                return getattr(rec, "source_path", None) or ""
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
                            "source_path": await self._resolve_source_path(ent),
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
                    "source_path": self._resolve_source_path(ent),
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

        Both paths broadcast ``progress_report`` FlowData events:
        - sub_activity_name=<type>  → per-record progress within that type
        - sub_activity_name=None    → job-level progress (types completed / total)
        """
        import time

        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None
        trigger = qp.get("trigger", "auto").strip() or "auto"

        # Sync claude_error records from debug logs before scanning.
        from flow_sdk.fs_records.claude.claude_error import sync_from_debug_logs  # noqa: PLC0415
        from flow_sdk.fs_store.record import get_default_records_root  # noqa: PLC0415

        await asyncio.to_thread(sync_from_debug_logs, get_default_records_root() / "claude_error")

        if filter_type:
            record_cls = _SR.get_record_cls(filter_type)
            if record_cls is None:
                return ApiFailResponse(
                    message=f"Unknown record type '{filter_type}'. Available: {_SR.get_all_record_types()}",
                    status_code=400,
                )
            try:
                activity = self._start_activity("scan", total=1, timeout_seconds=60)
            except RuntimeError as e:
                return ApiFailResponse(message=str(e), status_code=409)

            try:
                activity.sub_activity_name = filter_type
                sr = await asyncio.to_thread(SchemaRecord._scan_type, record_cls, True)
                # Emit sub-activity completion event
                activity.sub_done = sr.count
                activity.sub_total = sr.count
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(filter_type),
                )
                # Emit job-level completion event
                activity.done = 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
            finally:
                self._complete_activity("scan")

            last_scan_at = SchemaRecord.append_scan(
                trigger=trigger,
                duration_ms=sr.scan_ms,
                total_records=sr.count,
                total_bytes=sr.total_bytes,
                types=[],
                type_name=filter_type,
            )
            return ApiSuccessResponse(
                data={
                    "type": filter_type,
                    "count": sr.count,
                    "total_bytes": sr.total_bytes,
                    "avg_bytes": sr.avg_bytes,
                    "scan_ms": sr.scan_ms,
                    "records": sr.records,
                    "min_bytes": sr.min_bytes,
                    "max_bytes": sr.max_bytes,
                    "last_scan_at": last_scan_at,
                }
            )

        # Aggregate scan across indexed-by-default types only
        all_types = list(_SR.get_default_index_types())
        if limit_types is not None:
            all_types = all_types[:limit_types]

        valid_types = [(tn, _SR.get_record_cls(tn)) for tn in all_types]
        valid_types = [(tn, cls) for tn, cls in valid_types if cls is not None]

        try:
            activity = self._start_activity("scan", total=len(valid_types), timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        t_grand = time.perf_counter()
        type_results = []
        grand_total = 0
        grand_bytes = 0

        try:
            for i, (type_name, record_cls) in enumerate(valid_types):
                activity.sub_activity_name = type_name
                activity.sub_done = 0
                activity.sub_skipped = 0
                activity.sub_errors = 0
                activity.sub_total = 0

                last_progress = None
                total_bytes_for_type = 0
                t0_type = time.perf_counter()

                async for progress in SchemaRecord.scan_type_progress(record_cls):
                    last_progress = progress
                    total_bytes_for_type += progress.size_bytes
                    activity.sub_done = progress.done
                    activity.sub_total = progress.total
                    await broadcast_progress(
                        to_entity=str(self.typeid),
                        flow_data=activity.make_flow_data(type_name),
                    )

                count = last_progress.done if last_progress else 0
                scan_ms_type = round((time.perf_counter() - t0_type) * 1000, 1)
                type_results.append(
                    {
                        "type": type_name,
                        "count": count,
                        "total_bytes": total_bytes_for_type,
                        "avg_bytes": total_bytes_for_type // count if count else 0,
                        "scan_ms": scan_ms_type,
                    }
                )
                grand_total += count
                grand_bytes += total_bytes_for_type

                # Job-level event after each type completes
                activity.done = i + 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
        finally:
            self._complete_activity("scan")

        scan_ms = round((time.perf_counter() - t_grand) * 1000, 1)
        SchemaRecord.append_scan(
            trigger=trigger,
            duration_ms=scan_ms,
            total_records=grand_total,
            total_bytes=grand_bytes,
            types=type_results,
        )
        return ApiSuccessResponse(
            data={
                "types": type_results,
                "grand_total": grand_total,
                "scan_ms": scan_ms,
            }
        )

    async def _handle_fs_records_index_status(self, request_info) -> ApiResponse:
        """Return index freshness info.

        GET /fs-records/index-status
        """
        from dataclasses import asdict  # noqa: PLC0415

        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415

        status = SchemaRecord.get_index_status()
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

    # ------------------------------------------------------------------
    # DataManager phase endpoints
    # ------------------------------------------------------------------

    def _parse_dm_opts(self, request_info) -> dict:
        """Parse common DataManager options from query params / request body."""
        params = request_info.query_params or {}
        body = request_info.body or {}
        types_raw = params.get("types") or body.get("types")
        if isinstance(types_raw, str):
            types_raw = [t.strip() for t in types_raw.split(",") if t.strip()]
        limit_raw = params.get("limit") or body.get("limit")
        limit = int(limit_raw) if limit_raw is not None else None
        skip_fresh_raw = params.get("skip_fresh") or body.get("skip_fresh", False)
        skip_fresh = str(skip_fresh_raw).lower() in ("true", "1", "yes")
        return {"types": types_raw or None, "limit": limit, "skip_fresh": skip_fresh}

    async def _handle_fs_records_index_scan(self, request_info) -> ApiResponse:
        """POST /fs-records/index/scan — filesystem discovery only, no DB writes."""
        from flow_sdk.fs_store.data_manager import DataManager, ScanOptions  # noqa: PLC0415

        opts_kwargs = self._parse_dm_opts(request_info)
        opts = ScanOptions(types=opts_kwargs["types"], limit=opts_kwargs["limit"])
        dm = DataManager()
        result = await dm.scan(opts)
        by_type_counts = {t: len(recs) for t, recs in result.by_type.items()}
        return ApiSuccessResponse(data={
            "total": result.total,
            "by_type": by_type_counts,
            "duration_ms": result.duration_ms,
        })

    async def _handle_fs_records_index_meta(self, request_info) -> ApiResponse:
        """POST /fs-records/index/meta — scan then write Entity rows."""
        from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexMetaOptions  # noqa: PLC0415

        opts_kwargs = self._parse_dm_opts(request_info)
        dm = DataManager()
        discovery = await dm.scan(ScanOptions(types=opts_kwargs["types"], limit=opts_kwargs["limit"]))
        result = await dm.index_meta(
            discovery.records,
            IndexMetaOptions(skip_fresh=opts_kwargs["skip_fresh"]),
        )
        return ApiSuccessResponse(data={
            "indexed": result.indexed,
            "skipped": result.skipped,
            "errors": result.errors,
            "duration_ms": result.duration_ms,
        })

    async def _handle_fs_records_index_search(self, request_info) -> ApiResponse:
        """POST /fs-records/index/search — scan then write FTS entries."""
        from flow_sdk.fs_store.data_manager import DataManager, ScanOptions, IndexSearchOptions  # noqa: PLC0415

        opts_kwargs = self._parse_dm_opts(request_info)
        dm = DataManager()
        discovery = await dm.scan(ScanOptions(types=opts_kwargs["types"], limit=opts_kwargs["limit"]))
        result = await dm.index_search(
            discovery.records,
            IndexSearchOptions(),
        )
        return ApiSuccessResponse(data={
            "indexed": result.indexed,
            "errors": result.errors,
            "duration_ms": result.duration_ms,
        })

    async def _handle_fs_records_index_all(self, request_info) -> ApiResponse:
        """POST /fs-records/index/all — full scan → meta → search pipeline."""
        from flow_sdk.fs_store.data_manager import DataManager, IndexAllOptions  # noqa: PLC0415

        opts_kwargs = self._parse_dm_opts(request_info)
        opts = IndexAllOptions(
            types=opts_kwargs["types"],
            limit=opts_kwargs["limit"],
            skip_fresh=opts_kwargs["skip_fresh"],
        )
        dm = DataManager()
        result = await dm.index_all(opts)
        return ApiSuccessResponse(data={
            "total_discovered": result.discovery.total,
            "indexed": result.meta.indexed,
            "skipped": result.meta.skipped,
            "fts_indexed": result.search.indexed,
            "errors": result.meta.errors + result.search.errors,
            "duration_ms": result.duration_ms,
        })

    async def _handle_fs_records_index(self, request_info) -> ApiResponse:
        """Index fs_records into the Entity DB via Record.sync_to_db().

        POST /fs-records/index                       → index all registered types
        POST /fs-records/index?type=X                → index one type
        POST /fs-records/index?rebuild=true          → clear + re-index
        POST /fs-records/index?limit_per_type=N      → limit records per type
        POST /fs-records/index?limit_types=N         → limit number of types to index

        Broadcasts ``progress_report`` FlowData events during indexing:
        - sub_activity_name=<type>  → per-record progress within that type
        - sub_activity_name=None    → job-level progress (types indexed / total)
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        trigger = qp.get("trigger", "manual").strip() or "manual"
        rebuild = qp.get("rebuild", "").strip().lower() in ("true", "1")
        limit_per_type_raw = qp.get("limit_per_type", "").strip()
        limit_per_type = int(limit_per_type_raw) if limit_per_type_raw.isdigit() else None
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None

        if rebuild:
            types = [filter_type] if filter_type else None
            clear_result, index_results = await SchemaRecord.rebuild_index(types=types, trigger=trigger)
            return ApiSuccessResponse(
                data={
                    "cleared": clear_result.fts_cleared,
                    "indexed": sum(r.indexed for r in index_results),
                    "errors": sum(r.errors for r in index_results),
                    "types": [{"type": r.type_name, "indexed": r.indexed, "errors": r.errors} for r in index_results],
                }
            )

        if filter_type:
            record_cls = _SR.get_record_cls(filter_type)
            if record_cls is None:
                return ApiFailResponse(
                    message=f"Unknown record type '{filter_type}'",
                    status_code=400,
                )
            try:
                activity = self._start_activity("index", total=1, timeout_seconds=60)
            except RuntimeError as e:
                return ApiFailResponse(message=str(e), status_code=409)

            try:
                activity.sub_activity_name = filter_type
                last_progress = None
                async for progress in SchemaRecord.index_type_progress(record_cls, limit=limit_per_type):
                    last_progress = progress
                    activity.sub_done = progress.done
                    activity.sub_total = progress.total
                    activity.sub_skipped = progress.skipped
                    activity.sub_errors = progress.errors
                    await broadcast_progress(
                        to_entity=str(self.typeid),
                        flow_data=activity.make_flow_data(filter_type),
                    )
                activity.done = 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
            finally:
                self._complete_activity("index")

            indexed = last_progress.indexed if last_progress else 0
            errors = last_progress.errors if last_progress else 0
            _SR.append_index(
                trigger=trigger,
                duration_ms=0.0,
                total_indexed=indexed,
                types=[],
                type_name=filter_type,
            )
            return ApiSuccessResponse(data={"type": filter_type, "indexed": indexed, "errors": errors})

        # No type, no rebuild: additive index across indexed-by-default types only
        all_types = list(_SR.get_default_index_types())
        if limit_types is not None:
            all_types = all_types[:limit_types]

        valid_types = [(tn, _SR.get_record_cls(tn)) for tn in all_types]
        valid_types = [(tn, cls) for tn, cls in valid_types if cls is not None]

        try:
            activity = self._start_activity("index", total=len(valid_types), timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        total_indexed = 0
        results = []

        try:
            for i, (type_name, record_cls) in enumerate(valid_types):
                activity.sub_activity_name = type_name
                activity.sub_done = 0
                activity.sub_skipped = 0
                activity.sub_errors = 0
                activity.sub_total = 0

                last_progress = None
                async for progress in SchemaRecord.index_type_progress(record_cls, limit=limit_per_type):
                    last_progress = progress
                    activity.sub_done = progress.done
                    activity.sub_total = progress.total
                    activity.sub_skipped = progress.skipped
                    activity.sub_errors = progress.errors
                    await broadcast_progress(
                        to_entity=str(self.typeid),
                        flow_data=activity.make_flow_data(type_name),
                    )

                if last_progress is not None:
                    total_indexed += last_progress.indexed
                    results.append(
                        {
                            "type": type_name,
                            "indexed": last_progress.indexed,
                            "errors": last_progress.errors,
                        }
                    )

                # Job-level event after each type completes
                activity.done = i + 1
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(None),
                )
        finally:
            self._complete_activity("index")

        _SR.append_index(
            trigger=trigger,
            duration_ms=0.0,
            total_indexed=total_indexed,
            types=results,
        )
        return ApiSuccessResponse(data={"indexed": total_indexed, "types": results})


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

        # Phase-specific index endpoints (DataManager): POST /fs-records/index/{phase}
        if len(segments) >= 2 and segments[0] == "index" and method == "post":
            phase = segments[1]
            if phase == "scan":
                return await self._handle_fs_records_index_scan(request_info)
            if phase == "meta":
                return await self._handle_fs_records_index_meta(request_info)
            if phase == "search":
                return await self._handle_fs_records_index_search(request_info)
            if phase == "all":
                return await self._handle_fs_records_index_all(request_info)

        # Index: POST /fs-records/index or /fs-records/index?type=X (backward compat)
        if segments and segments[0] == "index" and method == "post":
            return await self._handle_fs_records_index(request_info)

        # Index status: GET /fs-records/index-status
        if segments and segments[0] == "index-status" and method == "get":
            return await self._handle_fs_records_index_status(request_info)

        # Clear index: DELETE /fs-records/index
        if segments and segments[0] == "index" and method == "delete":
            return await self._handle_fs_records_index_clear(request_info)

        # No type segment + GET → list registered type names
        if not segments and method == "get":
            return ApiSuccessResponse(data={"types": _SR.get_all_record_types()})

        if not segments:
            return ApiFailResponse(message="Record type is required in URL path", status_code=400)

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
                    session = ClaudeSessionRecord.discover_one(ref.id, project=project)
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

