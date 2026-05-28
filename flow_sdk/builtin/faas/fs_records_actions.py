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

    async def _resolve_scoped_roots(self, sf):
        """Translate a ``ScopeFilter`` into a narrowed indexer ``roots`` tuple
        (or ``None`` to use the indexer's default roots).

        Mapping:
          - sf is None                         → None (default_roots())
          - {user=True,  projects=[]}          → (USER_HOME_FOLDER,)
          - {user=False, projects=[ids]}       → one REAL_PROJECT_CWD per id
          - {user=True,  projects=[ids]}       → USER_HOME + per-project roots
          - {user=False, projects=[]}          → None (degenerate; default_roots())

        Per-project resolution policy:
          - 404 ApiFailResponse when the Project entity does not exist
            (caller-supplied id is unknown).
          - silently skip with ``logging.debug`` when the entity exists but
            its ``fs_storage_mount_path`` is missing or no longer a directory
            (stale entity from a moved/deleted project — surfaces zero results
            for that project instead of 4xx-ing the whole request).

        If every requested project gets skipped AND ``sf.user`` is False (so
        the only requested roots are now empty), returns an empty tuple — the
        indexer walks NOTHING. This preserves the narrowing intent: a caller
        who explicitly asked for a project list shouldn't silently widen to
        ``default_roots()`` just because the projects are all stale.
        """
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
        from flow_sdk.fs_store.indexer.roots import default_roots  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        if sf is None or (not sf.user and not sf.projects):
            return None

        roots: list[FSRef] = []

        if sf.user:
            for r in default_roots():
                if r.record_type == RecordType.USER_HOME_FOLDER:
                    roots.append(r)
                    break

        if sf.projects:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415
            from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
            from pathlib import Path as _Path  # noqa: PLC0415
            for pid in sf.projects:
                proj = await Project.get_one(QueryFilter.parse({"id": pid}))
                if proj is None:
                    return ApiFailResponse(
                        message=f"Project '{pid}' not found",
                        status_code=404,
                    )
                mount = getattr(proj, "fs_storage_mount_path", None)
                if not mount:
                    # Stale entity with no mount — skip silently (matches the
                    # legacy ``project_folder_walker_fn`` skip-on-missing
                    # behaviour). Erroring out 400s every scan whenever a
                    # single stale project entity has a missing mount.
                    logging.debug(
                        "fs-records/_resolve_scoped_roots: skipping project %s — no fs_storage_mount_path",
                        pid,
                    )
                    continue
                mount_path = _Path(str(mount))
                if not mount_path.is_dir():
                    logging.debug(
                        "fs-records/_resolve_scoped_roots: skipping project %s — mount %r is not a directory",
                        pid,
                        mount,
                    )
                    continue
                roots.append(
                    FSRef(
                        mount_path,
                        record_type=RecordType.REAL_PROJECT_CWD,
                        scope="project",
                        project_id=pid,
                    )
                )

        if not roots:
            # Distinguish two empty-result cases. When the caller passed a
            # narrowing filter that we managed to consume (sf had user or
            # projects set) but every entry got skipped, we MUST return an
            # empty tuple — returning None would let the indexer fall back to
            # ``default_roots()`` and walk a wider tree than the caller asked
            # for. The degenerate {user=False, projects=()} input does fall
            # back to None (matches the documented mapping).
            if sf.user or sf.projects:
                return tuple()
            return None
        return tuple(roots)

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
        from flow_sdk.server.search_filters import (  # noqa: PLC0415
            ScopeFilter,
            apply_folder_filter,
            apply_scope_filter,
            apply_system_filter,
            apply_tag_filter,
        )

        qp = request_info.request.query_params
        q = qp.get("q", "").strip()
        limit = max(1, int(qp.get("limit", DEFAULT_BROWSE_LIMIT)))
        record_type = qp.get("record_type", "") or None
        status = qp.get("status", "") or None
        # Unified ScopeFilter wire format: `?user=true&projects=A,B`. Absent
        # both params means no filter applied (legacy callers).
        scope_filter = (
            ScopeFilter.from_query_params(qp)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else None
        )
        parent_path = qp.get("parent_path") or None
        vault_root = qp.get("vault_root") or None
        include_system = (qp.get("include_system", "").strip().lower() in ("true", "1"))
        tags_raw = qp.get("tags") or ""
        tag_list = [t.strip() for t in tags_raw.split(",") if t.strip()]

        def _row(ent, *, snippet=None) -> dict:
            ent_status = getattr(ent, "status", None) or ""
            row = {
                "record_id": ent.id,
                "record_type": ent.type or ent.get_type(),
                "name": self._entity_display_name(ent),
                "snippet": snippet,
                "fts_title": getattr(ent, "_fts_title", None),
                "fts_description": getattr(ent, "_fts_description", None),
                "status": ent_status,
                "scope": getattr(ent, "scope", "") or "",
                "created_at": (d.isoformat() if (d := getattr(ent, "created_date", None)) else ""),
                "modified_at": (d.isoformat() if (d := getattr(ent, "updated_date", None)) else ""),
                "asset_ref": "",  # filled below; awaitable
                "labels": getattr(ent, "labels", None) or [],
            }
            for extra_field in ("session_id", "worker_session_id"):
                val = getattr(ent, extra_field, None)
                if val:
                    row[extra_field] = val
            return row

        async def _rows(entities, *, with_snippet: bool) -> list[dict]:
            out: list[dict] = []
            for ent in entities:
                snip = getattr(ent, "_fts_snippet", None) if with_snippet else None
                row = _row(ent, snippet=snip)
                row["asset_ref"] = await self._resolve_asset_ref(ent)
                out.append(row)
            return out

        if not q:
            # Filter-only browse: query DB with FTS join so fts_title is populated
            if not record_type:
                return ApiSuccessResponse(data={"results": [], "query": q, "total": 0, "indexer_ready": True})
            entities = await Entity.browse(record_type=record_type, limit=limit, status=status)
            entities = apply_scope_filter(entities, scope_filter)
            entities = apply_folder_filter(entities, parent_path, vault_root)
            entities = apply_system_filter(entities, include_system)
            entities = apply_tag_filter(entities, tag_list)
            results = await _rows(entities, with_snippet=False)
            return ApiSuccessResponse(
                data={"results": results, "query": "", "total": len(results), "indexer_ready": True}
            )

        # Parse optional calibration params
        from flow_sdk.db.drivers.sqlite.sqlite_driver import SearchCalibration

        col_weights_raw = qp.get("col_weights")
        recency_boost_raw = qp.get("recency_boost")
        recency_factor_raw = qp.get("recency_factor")
        overfetch_raw = qp.get("overfetch")
        type_scores_raw = qp.get("type_scores")
        cal = None
        if col_weights_raw or recency_boost_raw or recency_factor_raw or overfetch_raw or type_scores_raw:
            cal = SearchCalibration(
                col_weights=[float(x) for x in col_weights_raw.split(",")] if col_weights_raw else None,
                recency_boost=float(recency_boost_raw) if recency_boost_raw else None,
                recency_factor=float(recency_factor_raw) if recency_factor_raw else None,
                overfetch=int(overfetch_raw) if overfetch_raw else None,
                type_scores=json.loads(type_scores_raw) if type_scores_raw else None,
            )

        # FTS5 search
        entities = await Entity.search(query=q, limit=limit, record_type=record_type, calibration=cal)
        if status:
            entities = [e for e in entities if (getattr(e, "status", None) or "") == status]
        entities = apply_scope_filter(entities, scope_filter)
        entities = apply_folder_filter(entities, parent_path, vault_root)
        entities = apply_system_filter(entities, include_system)
        entities = apply_tag_filter(entities, tag_list)
        results = await _rows(entities, with_snippet=True)
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
            IndexProgressTable,
            IndexerOptions,
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

        # Unified ScopeFilter from wire format `?user=true&projects=A,B`.
        # Absent params → explicit "everything known" filter built from
        # get_all_projects(), so the walk fans out via _resolve_scoped_roots
        # instead of the silent USER_HOME_FOLDER → real_project_cwd_fn
        # expander discovery.
        from flow_sdk.fs_records.all_projects import get_all_scope_filter  # noqa: PLC0415
        from flow_sdk.server.search_filters import ScopeFilter  # noqa: PLC0415
        scope_explicit = qp.get("user") is not None or qp.get("projects") is not None
        # ``create_missing=True`` matches the legacy behaviour of the silent
        # ``real_project_cwd_fn`` expander (which also called
        # ``get_all_projects(create_missing=True)`` on every walk). It also
        # avoids 404s in ``_resolve_scoped_roots`` for cwds whose Project
        # entity hasn't been materialised yet: with ``create_missing=False``
        # ``get_all_projects`` still returns a synthetic UUID5 project_id via
        # ``Project.derive_id_for_path`` but the entity row doesn't exist, so
        # ``Project.get_one`` would 404 the whole scan. The materialisation
        # side-effect is pre-existing; this change only makes it explicit at
        # the route boundary instead of implicit during the walk.
        scope_filter = (
            ScopeFilter.from_query_params(qp)
            if scope_explicit
            else await get_all_scope_filter()
        )
        scoped_roots = await self._resolve_scoped_roots(scope_filter)
        if isinstance(scoped_roots, ApiFailResponse):
            return scoped_roots

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

        try:
            activity = self._start_activity("scan", timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        async def emit(table: IndexProgressTable) -> None:
            activity.latest_table = table
            await broadcast_progress(
                to_entity=str(self.typeid),
                flow_data=activity.make_flow_data(),
            )

        try:
            t0 = time.perf_counter()
            nodes = await get_shared_indexer().scan(IndexerOptions(
                types=types_filter,
                limit_per_type=limit_per_type,
                on_progress=emit,
                verbose=False,
                roots=scoped_roots,
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

        # ----- Diff classification (cheap, no writes) -----
        # For every indexable type, compare each FSRef against the DB state map
        # to bucket as new / stale / mis_scoped / fresh, then derive orphans via
        # (db_ids ∪ shadow_dir_ids) − seen_ids. Skipped when scope-filtered
        # because seen_ids is incomplete for a partial walk. ~16% overhead on
        # top of scan() — measured at ~360 ms on a 7660-FSRef tree.
        from flow_sdk.db import get_db_driver as _get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.indexer.index_function import (  # noqa: PLC0415
            FSIndexer as _FSIndexer,
            _load_entity_state_map,
        )

        # Diff classification needs ``seen_ids`` to cover every relevant root,
        # so it only runs on a full-coverage scan. Pre-fix, that was signalled
        # by ``scope_filter is None`` (the "no scope = walk default_roots()"
        # branch). After the route now resolves the no-scope case to an
        # explicit ``get_all_scope_filter()``, the predicate is "the caller
        # did not pass an explicit scope param" (``not scope_explicit``).
        do_diff = not scope_explicit
        if do_diff:
            _driver = _get_db_driver()
            _indexable_names = {str(t) for t in INDEXABLE_TYPES}
            _state_map: dict[str, dict[str, tuple[float, str, str]]] = {}
            for _tn in _indexable_names:
                try:
                    _state_map[_tn] = await _load_entity_state_map(_driver, _tn)
                except Exception:
                    _state_map[_tn] = {}

            _seen_ids: dict[str, set[str]] = {tn: set() for tn in _indexable_names}
            _diff: dict[str, dict[str, int]] = {
                tn: {"new": 0, "stale": 0, "mis_scoped": 0, "fresh": 0}
                for tn in _indexable_names
            }
            for ref in nodes:
                rt = ref.record_type
                if rt is None:
                    continue
                rt_name = str(rt)
                if rt_name not in _indexable_names:
                    continue
                _info = _SR_rec.get(rt_name)
                _record_cls = getattr(_info, "record_cls", None) if _info else None
                if _record_cls is None or not hasattr(_record_cls, "from_fsref"):
                    continue
                try:
                    ref_id = _record_cls.genId(ref)
                except Exception:
                    continue
                if not ref_id:
                    continue
                _seen_ids[rt_name].add(ref_id)
                db_state = _state_map[rt_name].get(ref_id)
                if db_state is None:
                    _diff[rt_name]["new"] += 1
                    continue
                db_mtime, db_scope, db_pid = db_state
                try:
                    file_mtime = _record_cls.asset_hash_for_ref(ref)
                except Exception:
                    file_mtime = 0.0
                walk_scope = ref.scope or ""
                walk_pid = ref.project_id or ""
                scope_ok = walk_scope == "" or db_scope == walk_scope
                pid_ok = walk_pid == "" or db_pid == walk_pid
                if file_mtime and file_mtime <= db_mtime and scope_ok and pid_ok:
                    _diff[rt_name]["fresh"] += 1
                elif not (scope_ok and pid_ok):
                    _diff[rt_name]["mis_scoped"] += 1
                else:
                    _diff[rt_name]["stale"] += 1

            _disk_ids = _FSIndexer._discover_records_dir_ids(_indexable_names)
            for _tn in _indexable_names:
                _db_ids = set(_state_map[_tn].keys())
                _all_ids = _db_ids | _disk_ids.get(_tn, set())
                _diff[_tn]["orphan"] = len(_all_ids - _seen_ids[_tn])
                _diff[_tn]["in_index"] = len(_db_ids)
                _diff[_tn]["pending"] = (
                    _diff[_tn]["new"] + _diff[_tn]["stale"] + _diff[_tn]["mis_scoped"]
                )

            # Merge diff fields into existing per-type buckets; create empty
            # buckets for types that have no on-disk refs but DO have orphans
            # or in_index rows (otherwise the UI loses visibility of them).
            for _tn, _d in _diff.items():
                if not any(_d.values()):
                    continue
                _b = by_type.get(_tn)
                if _b is None:
                    _b = by_type.setdefault(_tn, {
                        "type": _tn, "count": 0, "total_bytes": 0,
                        "avg_bytes": 0, "scan_ms": 0.0, "_records": [],
                    })
                _b.update(_d)

            # Ensure every bucket has the diff keys (zero-fill non-indexable
            # types so the response shape is uniform).
            for _b in by_type.values():
                for _k in ("new", "stale", "mis_scoped", "fresh", "orphan", "in_index", "pending"):
                    _b.setdefault(_k, 0)

        per_type = list(by_type.values())
        grand_total = sum(b["count"] for b in per_type)
        grand_bytes = sum(b["total_bytes"] for b in per_type)
        grand_pending = sum(b.get("pending", 0) for b in per_type) if do_diff else 0
        grand_orphan = sum(b.get("orphan", 0) for b in per_type) if do_diff else 0

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
                "new": b.get("new", 0),
                "stale": b.get("stale", 0),
                "mis_scoped": b.get("mis_scoped", 0),
                "orphan": b.get("orphan", 0),
                "fresh": b.get("fresh", 0),
                "in_index": b.get("in_index", 0),
                "pending": b.get("pending", 0),
            })

        return ApiSuccessResponse(data={
            "types": types_for_log,
            "grand_total": grand_total,
            "scan_ms": scan_ms,
            "grand_pending": grand_pending,
            "grand_orphan": grand_orphan,
            "diff_included": do_diff,
        })

    async def _handle_fs_records_index_status(self, request_info) -> ApiResponse:
        """Return index freshness info.

        GET /fs-records/index-status[?user=&projects=]

        When the unified ScopeFilter (?user=&projects=) is present, per-type
        ``entity_count`` and ``orphan_count`` (and the rolled-up
        ``total_orphans``) shrink to the scoped subset. The freshness fields
        (``last_indexed_at``, ``stale``) are unaffected — those derive from
        per-type indexer-run timestamps, not from row counts.
        """
        from dataclasses import asdict  # noqa: PLC0415

        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.server.search_filters import ScopeFilter  # noqa: PLC0415

        qp = request_info.request.query_params
        scope_filter = (
            ScopeFilter.from_query_params(qp)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else None
        )

        status = await SchemaRecord.get_index_status(scope=scope_filter)
        return ApiSuccessResponse(
            data={
                "never_indexed": status.never_indexed,
                "last_indexed_at": status.last_indexed_at,
                "stale": status.stale,
                "default_types": status.default_types,
                "per_type": [asdict(t) for t in status.per_type],
                "total_orphans": status.total_orphans,
            }
        )

    async def _handle_fs_records_index_clear(self, request_info) -> ApiResponse:
        """Clear all FTS index data and reset index logs.

        DELETE /fs-records/index

        Emits per-type ``progress_report`` events so the footer pill and the
        scanner page can show per-type progress while the clear runs. Mirrors
        the index handler's event shape (``job_name='clear'``, ``rows[]`` with
        ``done``/``total``, terminal ``text='complete'``).
        """
        from datetime import datetime, timezone  # noqa: PLC0415

        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_records.record_error import RecordError  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import IndexProgressTable, TypeProgressRow  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry, _sanitize_type_name, _schema_dir  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        target_types = [filter_type] if filter_type else SchemaRegistry.get_all_record_types()

        # Optional ScopeFilter narrows the delete to a subset of rows per type
        # (e.g. only one project's markdown). Without these params the clear
        # is full per type, matching legacy behaviour.
        from flow_sdk.server.search_filters import ScopeFilter  # noqa: PLC0415
        scope_filter = (
            ScopeFilter.from_query_params(qp)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else None
        )

        try:
            activity = self._start_activity("clear", timeout_seconds=120)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        driver = get_db_driver()
        per_type_done: dict[str, int] = {t: 0 for t in target_types}
        per_type_total: dict[str, int] = {t: 1 for t in target_types}  # 1 step each
        fts_cleared = 0
        entities_cleared = 0
        current_type: str | None = None

        def make_table(text: str | None = None) -> IndexProgressTable:
            rows = tuple(
                TypeProgressRow(
                    type_name=t,
                    done=per_type_done[t],
                    total=per_type_total[t],
                    errors=0,
                    skipped=0,
                )
                for t in target_types
            )
            return IndexProgressTable(
                job_name="clear",
                rows=rows,
                current=current_type,
                done=sum(per_type_done.values()),
                total=sum(per_type_total.values()),
                text=text,
                ts=datetime.now(timezone.utc).isoformat(),
            )

        async def emit(text: str | None = None) -> None:
            table = make_table(text=text)
            activity.latest_table = table
            await broadcast_progress(
                to_entity=str(self.typeid),
                flow_data=activity.make_flow_data(),
            )

        try:
            await emit()  # initial snapshot — totals known, done=0
            for type_name in target_types:
                current_type = type_name
                await emit()
                if hasattr(driver, "delete_entities_by_type"):
                    try:
                        n = await driver.delete_entities_by_type(type_name, scope=scope_filter)
                    except TypeError:
                        # Driver predates the scope kwarg — fall back to unscoped delete
                        # (only happens when scope_filter is None).
                        n = await driver.delete_entities_by_type(type_name)
                    entities_cleared += n
                # The per-type index_log is a wall-clock record of indexer runs;
                # only unlink it on a full (unscoped) clear of that type so a
                # scoped clear doesn't lose history about the OTHER scope.
                if scope_filter is None:
                    sanitized = _sanitize_type_name(type_name)
                    log_file = _schema_dir() / "types" / sanitized / "index_log.jsonl"
                    if log_file.exists():
                        log_file.unlink()
                    await RecordError.clear_for_type(type_name)
                per_type_done[type_name] = 1
                await emit()

            # When clearing everything, also clear the FTS index and the global log.
            # Skip on scoped clears — FTS clear is all-or-nothing and would wipe
            # rows that are still alive in the un-targeted scope.
            if not filter_type and scope_filter is None and hasattr(driver, "fts_clear"):
                fts_cleared = await driver.fts_clear()
                global_log = _schema_dir() / "index_log.jsonl"
                if global_log.exists():
                    global_log.unlink()
                await RecordError.clear_all()

            current_type = None
            await emit(text="complete")
        finally:
            self._complete_activity("clear")

        return ApiSuccessResponse(
            data={
                "fts_cleared": fts_cleared,
                "entities_cleared": entities_cleared,
                "types_cleared": target_types,
            }
        )

    async def _handle_fs_records_index(self, request_info) -> ApiResponse:
        """Index fs_records into the Entity DB via Record.sync_to_db().

        POST /fs-records/index                       → index all registered types
        POST /fs-records/index?type=X                → index one type
        POST /fs-records/index?rebuild=true          → clear + re-index
        POST /fs-records/index?user=&projects=A,B    → narrow to a ScopeFilter
                                                       (canonical wire format —
                                                       matches search, scan,
                                                       index-status, clear).

        Backed by ``FSIndexer.index()``. Emits ``progress_report`` FlowData
        events per type via the shared indexer's ``on_progress`` callback.
        """
        import flow_sdk.fs_records  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_records.schema_record import SchemaRecord  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            INDEXABLE_TYPES,
            IndexProgressTable,
            IndexerOptions,
            OrphanAction,
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
        # Unified ScopeFilter from canonical wire format `?user=…&projects=A,B`.
        from flow_sdk.server.search_filters import ScopeFilter  # noqa: PLC0415
        # Surface stale callers still using the legacy `?project_id=<id>` shim
        # — it now silently triggers a full-tree walk (scope_filter=None).
        # Logging the hit lets us debug runaway scans without re-introducing
        # the shim and undoing the canonical-wire-format standardisation.
        legacy_project_id = qp.get("project_id", "").strip() or None
        if legacy_project_id and qp.get("user") is None and qp.get("projects") is None:
            logging.warning(
                "fs-records/index received legacy ?project_id=%s — ignored. "
                "Callers must use canonical ?user=&projects= ScopeFilter format.",
                legacy_project_id,
            )
        from flow_sdk.fs_records.all_projects import get_all_scope_filter  # noqa: PLC0415
        scope_filter = (
            ScopeFilter.from_query_params(qp)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else await get_all_scope_filter()
        )
        # Single-project narrowing — derived from the ScopeFilter, used below
        # to short-circuit non-project indexer work paths.
        project_id = (
            scope_filter.projects[0]
            if (scope_filter and len(scope_filter.projects) == 1)
            else None
        )
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

        # Resolve ScopeFilter → narrowed roots. When the filter is None,
        # fall back to the indexer's default_roots() (full walk).
        #
        # Orphan-aware runs (orphan_action != INDEX) intentionally walk the
        # full root set even when a scope is selected: orphan-ness is defined
        # globally (a record is orphan iff its source is missing anywhere),
        # so ``seen_ids`` must cover all references. The scope filter is then
        # re-applied inside the indexer to narrow which orphans get reported
        # and acted on. Without this, a record physically inside project A
        # but referenced from project B would be falsely flagged as orphan
        # when the user picks scope=A.
        if orphan_action != OrphanAction.INDEX:
            custom_roots = None
        else:
            custom_roots = await self._resolve_scoped_roots(scope_filter)
            if isinstance(custom_roots, ApiFailResponse):
                return custom_roots

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

        try:
            activity = self._start_activity("index", timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        async def emit(table: IndexProgressTable) -> None:
            activity.latest_table = table
            await broadcast_progress(
                to_entity=str(self.typeid),
                flow_data=activity.make_flow_data(),
            )

        # Single-project shortcut: when narrowed to exactly one project,
        # also pass project_id so the indexer can short-circuit non-project
        # work paths. Derived from the ScopeFilter above.
        effective_project_id = project_id

        try:
            result = await get_shared_indexer().index(IndexerOptions(
                types=types_filter,
                limit_per_type=limit_per_type,
                on_progress=emit,
                verbose=False,
                roots=custom_roots,
                force=force,
                project_id=effective_project_id,
                orphan_action=orphan_action,
                scope_filter=scope_filter,
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
        #
        # default_roots() no longer auto-expands USER_HOME → REAL_PROJECT_CWD
        # (the silent ``real_project_cwd_fn`` fanout was removed). We
        # therefore have to enumerate project roots explicitly via the new
        # scope filter so project-rooted record types (TASK, SPEC, project-
        # root SKILL/AGENT/WORKFLOW/CLAUDE_MD/CLAUDE_RULES) are reachable
        # from this recovery path.
        if found is None:
            try:
                from flow_sdk.fs_records.all_projects import get_all_scope_filter  # noqa: PLC0415
                from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
                    IndexerOptions,
                    get_shared_indexer,
                )
                from flow_sdk.fs_store.record_types import RecordType as _RT  # noqa: PLC0415
                rt = _RT(record_type)
                indexer = get_shared_indexer()
                discover_sf = await get_all_scope_filter()
                discover_roots = await self._resolve_scoped_roots(discover_sf)
                if isinstance(discover_roots, ApiFailResponse):
                    discover_roots = None  # fall back to default_roots()
                await indexer.index(
                    IndexerOptions(types=[rt], roots=discover_roots),
                )
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
        progress modal can reopen mid-job. Returns the latest
        ``IndexProgressTable`` plus ``started_at`` metadata, or null when
        no activity is running.
        """
        from flow_sdk.builtin.faas.compute_node import _COMPUTE_ACTIVITIES  # noqa: PLC0415

        prefix = f"{self.typeid}:"
        for key, activity in _COMPUTE_ACTIVITIES.items():
            if not key.startswith(prefix):
                continue
            if activity is None or activity.is_timed_out or activity.is_complete:
                continue
            payload = activity.make_flow_data()["attributes"]
            payload["started_at"] = activity.started_at.isoformat()
            return ApiSuccessResponse(data=payload)
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
                # Stamp scope from the resolved asset path so HTTP-created
                # records match indexer-discovered ones; otherwise the entity
                # is born scope=None and search_filters treats it as
                # unscoped (cluster #4 regression). asset_ref is populated
                # only after sync_to_db (via Entity._prepare_for_storage),
                # so this fires post-sync and patches the entity in place.
                try:
                    from flow_sdk.fs_store.indexer.roots import classify_path  # noqa: PLC0415
                    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
                    info = SchemaRegistry.get(str(record_type))
                    entity_cls = info.entity_cls if info is not None else None
                    if entity_cls is not None:
                        entity = await entity_cls.get_one({"id": rec.id})
                        if entity is not None and getattr(entity, "scope", None) in (None, ""):
                            asset_path = getattr(entity, "asset_ref", None)
                            inferred = classify_path(asset_path) if asset_path else None
                            if inferred:
                                entity.scope = inferred
                                await entity.save(notify=False)
                except Exception as e:
                    logging.debug(f"[fs-records] scope-stamp skipped on create: {e}")
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

                entity = await Entity.get_one(QueryFilter.parse({"id": uid}, record_type))
                if entity is not None:
                    driver = get_db_driver()
                    if hasattr(driver, "fts_delete"):
                        await driver.fts_delete(entity.id)
                    await entity.delete()
                # Remove from disk — including the live asset_ref folder so
                # records like Skill don't re-surface via discover() after delete.
                record = await asyncio.to_thread(record_list.get, uid)
                if record is None:
                    return ApiFailResponse(message=f"Record '{uid}' not found", status_code=404)
                await record.delete(delete_ref=True)
                record_list.invalidate()
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



