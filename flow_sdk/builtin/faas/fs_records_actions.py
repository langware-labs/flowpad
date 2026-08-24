"""FsRecordsActionsMixin — fs-records CRUD gateway and indexing for ComputeNode.

Mixed into ComputeNode. Accesses self.typeid, self.id,
self._start_activity(), self._complete_activity() via normal
Python attribute lookup — no dependency injection needed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from flow_sdk.core.entity.entity_model import DEFAULT_BROWSE_LIMIT
from flow_sdk.fs_store.path_owners import owner_id_for
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


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

    async def _resolve_scoped_roots(self, sf, *, foreground: bool):
        """Translate a ``ScopeFilter`` into a narrowed indexer ``roots`` tuple
        (or ``None`` to use the indexer's default roots).

        ``foreground=True`` marks an explicit user-scoped request (the user
        opened these exact projects) — a project inside a macOS-protected folder
        is then walked (one expected OS prompt). Background/all-projects fanouts
        pass ``foreground=False`` so protected-folder projects are gated by the
        per-folder consent state instead of silently tripping a TCC popup.

        ``foreground`` is REQUIRED — deliberately no default. Auto-index (fired
        by merely selecting a project) must never pass True: the protected-folder
        design assumes the OS consent dialog only appears after the user clicked
        "Index". A default would let a future caller inherit the wrong intent
        silently, which is exactly how an unprompted TCC popup would ship.

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
        from flow_sdk.server.search_filters import resolve_project_scope  # noqa: PLC0415

        if sf is None or (not sf.user and not sf.projects):
            return None
        if sf.projects and not getattr(sf, "record_projects", ()):
            sf = await resolve_project_scope(sf)

        roots: list[FSRef] = []
        project_root_by_id = {str(pid): str(cwd) for pid, cwd in getattr(sf, "project_roots", ()) if pid and cwd}

        if sf.user:
            for r in default_roots():
                if r.record_type == RecordType.USER_HOME_FOLDER:
                    roots.append(r)
                    break

        if sf.projects:
            from pathlib import Path as _Path  # noqa: PLC0415

            from flow_sdk.builtin.folder import Folder  # noqa: PLC0415
            from flow_sdk.builtin.project import Project  # noqa: PLC0415
            from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
            from flow_sdk.fs_store.indexer.roots import is_home_or_ancestor  # noqa: PLC0415
            from flow_sdk.fs_store.indexer.special_folders import (  # noqa: PLC0415
                IndexDecision,
                gate_root,
            )
            from flow_sdk.fs_store.path_utils import (  # noqa: PLC0415
                canonical_posix_path as _canonical,
            )
            from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

            _home = get_instance_settings().user_home
            # Checkouts of somebody else's repo. A Project can own one without
            # ever having attached it — the workspace walk mints a Project for
            # any directory in the workspace, including a context-folder clone
            # sitting beside the user's own projects. Writing identity capsules
            # into one breaks the vendor's next pull, so the walk has to know.
            # Fetched ONCE per scan, not per root.
            _borrowed = await Folder.borrowed_checkout_paths()
            for pid in sf.projects:
                mount = project_root_by_id.get(str(pid))
                if mount is None:
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
                if is_home_or_ancestor(mount_path, _home):
                    # Walking $HOME (or an ancestor) recurses the whole home
                    # tree — see is_home_or_ancestor / the CWD_ROOT guard in roots.py.
                    logging.debug(
                        "fs-records/_resolve_scoped_roots: skipping project %s — "
                        "mount %r is $HOME or an ancestor (would walk the whole home tree)",
                        pid,
                        mount,
                    )
                    continue
                # macOS-TCC / cross-OS gate: a project inside a protected folder
                # (Documents/Desktop/Downloads/media) must not be walked by a
                # background scan — that first read pops an OS consent dialog.
                # foreground (explicit open) walks it; media is always skipped;
                # an un-decided folder queues an in-app consent request instead.
                decision = gate_root(mount_path, foreground=foreground)
                if decision is not IndexDecision.WALK:
                    logging.debug(
                        "fs-records/_resolve_scoped_roots: gating project %s — "
                        "mount %r is in a protected folder (decision=%s)",
                        pid,
                        mount,
                        decision.value,
                    )
                    continue
                roots.append(
                    FSRef(
                        mount_path,
                        record_type=RecordType.REAL_PROJECT_CWD,
                        scope="project",
                        project_id=pid,
                        # Read-only propagates to children, so flagging the root
                        # suppresses the write for the whole tree and `mint_id`
                        # falls back to its deterministic key.
                        read_only=_canonical(str(mount_path)) in _borrowed,
                    )
                )

        # Surface any consent requests queued by the gate above (deduped by
        # folder). Fire-and-forget WS event → the UI renders Index/Skip.
        from flow_sdk.fs_store.indexer.consent_notify import (  # noqa: PLC0415
            surface_pending_consent,
        )

        surface_pending_consent()

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

    async def _scoped_roots_from_query_params(self, qp, *, create_missing: bool = False):
        """Resolve indexer roots from the ``?user=&projects=`` wire params.

        Absent params → an explicit "everything known" filter
        (``get_all_scope_filter``) so the walk fans out via
        ``_resolve_scoped_roots`` rather than silent expander discovery. Returns
        the scoped roots, or an ``ApiFailResponse`` the caller forwards as-is.
        """
        from flow_sdk.fs_store.operations.all_projects import get_all_scope_filter  # noqa: PLC0415
        from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

        # An explicit ``?projects=`` is a foreground open of those exact projects
        # — walk them even inside a protected folder (one expected OS prompt).
        foreground = qp.get("projects") is not None
        if qp.get("user") is not None or qp.get("projects") is not None:
            scope_filter = await resolve_project_scope(ScopeFilter.from_query_params(qp))
        else:
            scope_filter = await get_all_scope_filter(create_missing=create_missing)
        return await self._resolve_scoped_roots(scope_filter, foreground=foreground)

    @staticmethod
    async def _resolve_asset_ref(ent) -> str:
        """Resolve the on-disk asset_ref for an entity, with a record-level fallback."""
        path = getattr(ent, "asset_ref", None) or getattr(ent, "source_file", None)
        if path:
            return path
        try:
            from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

            rec = await ent.get_record()
            if rec is None:
                ent_name = getattr(ent, "name", None) or getattr(ent, "uname", None)
                if ent_name:
                    rec = FSRecord.load_or_none(ent.type or ent.get_type(), ent_name)
            if rec:
                ar = getattr(rec, "_asset_ref", None)
                if ar is not None:
                    return getattr(ar, "path", None) or ""
        except Exception:
            pass
        return ""

    async def _handle_asset_usage(self, request_info) -> ApiResponse:
        """GET /asset-usage?skill=<name> — past sessions in which an asset was used.

        Pure FSIndexer scan of session transcripts (claude/codex) + the transcript
        analyzer: enumerate sessions, then for each, detect usage of the asset —
        skill assets via ``SKILL_CALL`` ``skill_name`` (doc assets by file-op path
        is a later follow-up). Returns rows newest-first. User-click only (no auto
        walk), and reports ``scan`` progress so the footer/panel show
        "Scanning <name> usage…".
        """
        from datetime import datetime, timezone  # noqa: PLC0415

        import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415
        from flow_sdk.builtin.worker_history import (  # noqa: PLC0415
            _build_agentic_process_index,
            _load_agentic_processes,
            _pick_last_prompt,
            _pick_name,
        )
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            PROGRESS_TEXT_COMPLETE,
            IndexerOptions,
            IndexProgressTable,
            TypeProgressRow,
            get_shared_indexer,
        )
        from flow_sdk.fs_store.indexer.functions.claude_sessions import (  # noqa: PLC0415
            extract_claude_session_from_path,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
        from flow_sdk.transcript_analyzer.entry import EntryKind  # noqa: PLC0415
        from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile  # noqa: PLC0415

        qp = request_info.request.query_params
        skill = (qp.get("skill") or "").strip()
        if not skill:
            return ApiFailResponse(message="asset-usage requires ?skill=<name>", status_code=400)

        session_types = [RecordType.CLAUDE_SESSION, RecordType.CODEX_SESSION]
        try:
            activity = self._start_activity("scan", timeout_seconds=600)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        def _table(done: int, total: int, text: str | None = None) -> IndexProgressTable:
            return IndexProgressTable(
                job_name="scan",
                rows=(TypeProgressRow(type_name=f"{skill} usage", done=done, total=total),),
                current=f"{skill} usage",
                done=done,
                total=total,
                text=text,
                ts=datetime.now(timezone.utc).isoformat(),
            )

        async def emit(done: int, total: int, text: str | None = None) -> None:
            activity.latest_table = _table(done, total, text)
            await broadcast_progress(to_entity=str(self.typeid), flow_data=activity.make_flow_data())

        # Friendly-name source, same priority history uses: AgenticProcess.name
        # (user/upsert-set) wins, else the session's own custom_title / slug.
        # One bulk fetch up front; the per-session title read is cheap (head+tail,
        # include_content=False) and only runs for sessions that matched the skill.
        try:
            ap_index = _build_agentic_process_index(await _load_agentic_processes())
        except Exception:
            logging.getLogger(__name__).debug("asset-usage: AgenticProcess index failed", exc_info=True)
            ap_index = {}

        rows: list[dict] = []

        def _scan_one(path: str, wk: str) -> dict | None:
            # Cheap pre-filter: skip the (expensive) full parse unless the raw
            # transcript even mentions the skill name. Most sessions never touched
            # this asset, so this avoids ~1000 parses per scan.
            try:
                if skill not in Path(path).read_text(encoding="utf-8", errors="ignore"):
                    return None
            except OSError:
                return None
            t = AgentTranscriptFile(wk, path)
            count = 0
            last_ts = ""
            for e in t.filter(kind=EntryKind.SKILL_CALL):
                if getattr(e, "skill_name", "") == skill:
                    count += 1
                    ts = getattr(e, "ts", "") or ""
                    if ts > last_ts:
                        last_ts = ts
            if not count:
                return None
            sid = t.session_id or Path(path).stem
            # Resolve a human-readable title the same way the history dropdown does.
            name: str | None = None
            last_prompt: str | None = None
            ap_name = ap_index.get(sid, (None, None, None))[1]
            if wk == "claude":
                try:
                    sess = extract_claude_session_from_path(path, include_content=False)
                    name = _pick_name(
                        custom_title=getattr(sess, "custom_title", None) or None,
                        slug=getattr(sess, "slug", None) or None,
                        display=None,
                        session_id=sid,
                    )
                    last_prompt = _pick_last_prompt(getattr(sess, "slug", None) or None)
                except Exception:
                    logging.getLogger(__name__).debug(
                        "asset-usage: title extract failed %s",
                        path,
                        exc_info=True,
                    )
            # AgenticProcess name (user rename) takes top priority, matching history.
            name = ap_name or name
            return {
                "sessionId": sid,
                "workerType": wk,
                "count": count,
                "lastTs": last_ts,
                "cwd": getattr(t, "cwd", None),
                "name": name,
                "lastPrompt": last_prompt,
            }

        try:
            nodes = await get_shared_indexer().scan(IndexerOptions(types=session_types, verbose=False))
            sessions = [n for n in nodes if n.record_type in session_types]
            total = len(sessions)
            await emit(0, total)
            for i, n in enumerate(sessions):
                worker = "codex" if n.record_type == RecordType.CODEX_SESSION else "claude"
                try:
                    row = await asyncio.to_thread(_scan_one, n.path, worker)
                    if row:
                        rows.append(row)
                except Exception:
                    logging.getLogger(__name__).debug("asset-usage: failed to scan %s", n.path, exc_info=True)
                if i % 5 == 0 or i == total - 1:
                    await emit(i + 1, total)
            await emit(total, total, text=PROGRESS_TEXT_COMPLETE)
        finally:
            self._complete_activity("scan")

        rows.sort(key=lambda r: r.get("lastTs") or "", reverse=True)
        return ApiSuccessResponse(data={"asset": skill, "sessions": rows})

    async def _handle_commit_asset(self, request_info) -> ApiResponse:
        """POST /commit-asset {workdir, file} — commit an asset edited on disk.

        The "commit" step of the improvement cycle: a skill-fixer worker edits a
        skill via its ``Edit`` tool (a raw disk write that bypasses the ``fs.write``
        autoversion hook), so the version bump + file-scoped commit are triggered
        here explicitly. Returns ``{hash, version}`` of the new revision, or
        ``{committed: False}`` when nothing changed.
        """
        import os  # noqa: PLC0415

        from flow_sdk.actions.fs.asset_versioning import commit_asset_change  # noqa: PLC0415

        body = await request_info.get_post_data() if request_info else {}
        params = {**(request_info.request_parameters or {}), **(body or {})} if request_info else {}
        workdir = (params.get("workdir") or "").strip()
        file_path = (params.get("file") or "").strip()
        if not workdir or not file_path:
            return ApiFailResponse(message="commit-asset requires workdir and file", status_code=400)
        real = file_path if os.path.isabs(file_path) else os.path.join(workdir, file_path)
        result = await commit_asset_change(real)
        if result is None:
            return ApiSuccessResponse(data={"committed": False})
        return ApiSuccessResponse(data={"committed": True, **result})

    async def _handle_fs_records_history(self, request_info) -> ApiResponse:
        """GET /fs-records/history_entry?limit=N — unified worker history.

        history_entry is a computed/aggregated view (deduplicated worker
        history across Claude/Codex/agentic processes), not a stored FSRecord
        type, so it's served from ``worker_history.get_worker_history`` rather
        than the generic RecordList path.
        """
        from flow_sdk.builtin.worker_history import get_worker_history  # noqa: PLC0415

        qp = request_info.request.query_params if request_info.request else {}
        try:
            limit = int(qp.get("limit", 20))
        except (TypeError, ValueError):
            limit = 20
        include_set = {s.strip() for s in (qp.get("include", "") or "").split(",") if s.strip()}
        entries = await get_worker_history(limit)
        # get_worker_history already sorts by last_active_time desc (== timestamp_ms
        # desc) and applies the limit, matching the frontend's sort_by/sort_desc.
        return ApiSuccessResponse(data=[self._history_entry_to_dict(e, include_set) for e in entries])

    @staticmethod
    def _history_entry_to_dict(entry, include_set: set[str]) -> dict:
        """Map a ``WorkerHistoryEntry`` to the ``history_entry`` wire contract
        consumed by ``useClaudeHistory`` / ``LiveStatus`` (id, display,
        timestamp_ms, session_id, session_ref, optional embedded _session).

        ``history_entry`` is a computed view, so this boundary owns the shape —
        the internal aggregation model intentionally carries richer fields.
        """
        worker_type = entry.worker_type.value if hasattr(entry.worker_type, "value") else str(entry.worker_type)
        sid = entry.worker_id
        ts_ms = int(entry.last_active_time.timestamp() * 1000) if entry.last_active_time else 0
        display = entry.last_prompt or entry.name or ""
        name = entry.name or display
        session_type = "claude_session" if worker_type == "claude" else f"{worker_type}_session"
        row: dict = {
            "id": sid,
            "type": "history_entry",
            "name": name,
            "display": display,
            "timestamp_ms": ts_ms,
            "project": entry.project_name or entry.project_id or "",
            "session_id": sid,
            "session_ref": {"id": sid, "type": session_type},
        }
        # Honor ?include=claude_session by embedding the session shape the UI
        # reads (cwd / message_count) directly from the aggregation entry —
        # no extra record load needed, since worker_history already gathered it.
        if "claude_session" in include_set and worker_type == "claude":
            row["_session"] = {
                "session_id": sid,
                "cwd": entry.project_cwd or "",
                "message_count": entry.message_count,
                "name": name,
            }
        return row

    async def _handle_fs_records_search(self, request_info) -> ApiResponse:
        from flow_sdk.core.entity.entity_model import Entity
        from flow_sdk.server.search_filters import (  # noqa: PLC0415
            ScopeFilter,
            apply_folder_filter,
            apply_scope_filter,
            apply_system_filter,
            apply_tag_filter,
            resolve_project_scope,
            scope_record_project_ids,
        )

        qp = request_info.request.query_params
        q = qp.get("q", "").strip()
        limit = max(1, int(qp.get("limit", DEFAULT_BROWSE_LIMIT)))
        offset = max(0, int(qp.get("offset", 0)))
        record_type = qp.get("record_type", "") or None
        sort_by = qp.get("sort_by", "") or None
        status = qp.get("status", "") or None
        # Unified ScopeFilter wire format: `?user=true&projects=A,B`. Absent
        # both params means no filter applied (legacy callers).
        scope_filter = await resolve_project_scope(
            ScopeFilter.from_query_params(qp)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else None
        )
        parent_path = qp.get("parent_path") or None
        vault_root = qp.get("vault_root") or None
        include_system = qp.get("include_system", "").strip().lower() in ("true", "1")
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
                "last_edited_at": getattr(ent, "last_edited_at", None),
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
            recent_activity = sort_by == "last_edited_at"
            if not record_type and not recent_activity:
                return ApiSuccessResponse(data={"results": [], "query": q, "total": 0, "indexer_ready": True})
            if sort_by not in (None, "updated_date", "last_edited_at"):
                return ApiFailResponse(message=f"Unsupported browse sort field: {sort_by}", status_code=400)

            # Marker presence is the explicit enrollment signal: only UI paths
            # that represent a real edit call markEdit(). Registry visibility
            # keeps the projection constructible by clients, while db_only
            # generically removes infrastructure rows (Tab/DataSourceCursor).
            eligible_types = None
            if recent_activity:
                from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

                eligible_types = [
                    type_name
                    for type_name in SchemaRegistry.get_public_entity_types()
                    if (info := SchemaRegistry.get(type_name)) is not None and not info.db_only
                ]

            if recent_activity:
                # Scope/system visibility is the common path and is pushed into
                # SQLite together with the edit-stamp filter, count, ordering,
                # offset and limit. Folder/tag filters are uncommon on this
                # projection and remain the canonical Python predicates; when
                # present, fetch the already scope-narrowed set before paging so
                # their total and page cannot underfill.
                post_filter = bool(parent_path or vault_root or tag_list)
                entities, total = await Entity.browse_page(
                    record_type,
                    limit=None if post_filter else limit,
                    offset=0 if post_filter else offset,
                    status=status,
                    sort_by="last_edited_at",
                    entity_types=eligible_types,
                    scope=scope_filter,
                    include_system=include_system,
                )
                if post_filter:
                    entities = apply_folder_filter(entities, parent_path, vault_root)
                    entities = apply_tag_filter(entities, tag_list)
                    total = len(entities)
                    entities = entities[offset : offset + limit]
            else:
                entities = await Entity.browse(
                    record_type=record_type,
                    limit=limit,
                    status=status,
                    offset=offset,
                )
                entities = apply_scope_filter(entities, scope_filter)
                entities = apply_folder_filter(entities, parent_path, vault_root)
                entities = apply_system_filter(
                    entities,
                    include_system,
                    scope_record_project_ids(scope_filter),
                )
                entities = apply_tag_filter(entities, tag_list)
                total = len(entities)
            results = await _rows(entities, with_snippet=False)
            return ApiSuccessResponse(
                data={"results": results, "query": "", "total": total, "indexer_ready": True}
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

    @staticmethod
    def _ref_id(ref) -> "str | None":
        """Extract or mint an FSRef id through its registered TypeInfo.

        Returns None when the type has no identity policy or resolution raises —
        callers decide the fallback (the scan list falls back to the path; the
        diff loop skips).
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(str(ref.record_type)) if ref.record_type is not None else None
        if info is None:
            return None
        try:
            return info.mint_entity_id(ref, derive=True, overwrite=True)
        except Exception:
            return None

    async def _handle_fs_records_mcp_reconcile(self, request_info) -> ApiResponse:
        """GET /fs-records/mcp-reconcile[?use_cli=true] — index vs disk vs CLI.

        Read-only diff of the indexed/disk MCP servers against the live
        ``claude mcp list`` output (when ``use_cli=true``). The CLI leg is the
        only view that reflects remote/cloud-connector live state. The CLI call
        lives in ``mcp_reconcile`` (an on-demand action), never the indexer.
        """
        import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — auto-register types
        from flow_sdk.builtin.faas.mcp_reconcile import reconcile_mcp_servers  # noqa: PLC0415

        qp = request_info.request.query_params
        use_cli = str(qp.get("use_cli", "")).strip().lower() in ("1", "true", "yes")

        scoped_roots = await self._scoped_roots_from_query_params(qp)
        if isinstance(scoped_roots, ApiFailResponse):
            return scoped_roots

        data = await reconcile_mcp_servers(scoped_roots, use_cli=use_cli)
        return ApiSuccessResponse(data=data)

    def _project_fs_records_scan(
        self,
        *,
        nodes,
        filter_type: str,
        types_filter,
        trigger: str,
        walk_ms: float,
        started_at: float,
        scope_explicit: bool,
    ) -> ApiResponse:
        """Project a completed walk into scan stats and persist its scan log.

        ``scan_ms`` is the WHOLE request (from ``started_at``, stamped on
        handler entry); ``walk_ms`` is the walk's share of it. It used to
        bracket only ``indexer.scan``, so a 34s request advertised 0.5s.
        """
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import INDEXABLE_TYPES  # noqa: PLC0415
        from flow_sdk.fs_store.indexer.index_function import FSIndexer  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        terminal_names = {str(record_type) for record_type in types_filter} if types_filter is not None else None
        all_indexable_names = {str(record_type) for record_type in INDEXABLE_TYPES}

        # Bucket only requested terminal types. The walk may also contain
        # scaffolds needed to reach them, but those are traversal details.
        by_type: dict[str, dict] = {}
        for node in nodes:
            if node.record_type is None:
                continue
            key = str(node.record_type)
            if terminal_names is not None and key not in terminal_names:
                continue
            bucket = by_type.setdefault(
                key,
                {
                    "type": key,
                    "count": 0,
                    "total_bytes": 0,
                    "scan_ms": 0.0,
                    "_records": [],
                },
            )
            bucket["count"] += 1
            # Per-type projection cost, actually measured. This used to be
            # assigned the literal 0.0 after the loop, so every row advertised
            # 0.0 while the aggregate carried the real number — the per-type
            # column was decoration. Timed here because this stat() per ref IS
            # the per-type share of the request: the walk that produced `nodes`
            # is untyped (its cost is `walk_ms`), and everything after this is
            # the diff, which reports itself.
            _t_type = time.perf_counter()
            try:
                stat = node._path.stat()
                bucket["total_bytes"] += stat.st_size
                if filter_type:
                    record_id = self._ref_id(node) or str(node._path)
                    bucket["_records"].append(
                        {
                            "id": record_id,
                            "name": node._path.stem,
                            "size_bytes": stat.st_size,
                            "modified_at": stat.st_mtime,
                        }
                    )
            except OSError:
                pass
            bucket["scan_ms"] += (time.perf_counter() - _t_type) * 1000

        for bucket in by_type.values():
            bucket["avg_bytes"] = bucket["total_bytes"] // bucket["count"] if bucket["count"] else 0
            bucket["scan_ms"] = round(bucket["scan_ms"], 2)

        # A full-coverage walk can classify freshness and orphans on disk.
        do_diff = not scope_explicit
        if do_diff:
            indexable_names = (
                terminal_names & all_indexable_names if terminal_names is not None else all_indexable_names
            )
            seen_ids: dict[str, set[str]] = {type_name: set() for type_name in indexable_names}
            diff: dict[str, dict[str, int]] = {
                type_name: {
                    "new": 0,
                    "stale": 0,
                    "mis_scoped": 0,
                    "fresh": 0,
                }
                for type_name in indexable_names
            }
            for ref in nodes:
                record_type = ref.record_type
                if record_type is None:
                    continue
                type_name = str(record_type)
                if type_name not in indexable_names:
                    continue
                record_id = self._ref_id(ref)
                if not record_id:
                    continue
                seen_ids[type_name].add(record_id)
                probe = FSRecord(type=type_name, id=record_id, asset_ref=ref)
                indexed_hash = probe.indexed_hash
                if indexed_hash is None:
                    diff[type_name]["new"] += 1
                elif probe.record_hash != indexed_hash:
                    diff[type_name]["stale"] += 1
                else:
                    diff[type_name]["fresh"] += 1

            disk_ids = FSIndexer._discover_records_dir_ids(indexable_names)
            for type_name in indexable_names:
                home_ids = disk_ids.get(type_name, set())
                diff[type_name]["orphan"] = len(home_ids - seen_ids[type_name])
                diff[type_name]["in_index"] = len(home_ids)
                diff[type_name]["pending"] = (
                    diff[type_name]["new"] + diff[type_name]["stale"] + diff[type_name]["mis_scoped"]
                )

            for type_name, type_diff in diff.items():
                if not any(type_diff.values()):
                    continue
                bucket = by_type.get(type_name)
                if bucket is None:
                    bucket = by_type.setdefault(
                        type_name,
                        {
                            "type": type_name,
                            "count": 0,
                            "total_bytes": 0,
                            "avg_bytes": 0,
                            # Genuinely zero: this bucket is minted by the DIFF
                            # for a type the walk produced no refs for, so no
                            # per-type projection work happened.
                            "scan_ms": 0.0,
                            "_records": [],
                        },
                    )
                bucket.update(type_diff)

            for bucket in by_type.values():
                for key in (
                    "new",
                    "stale",
                    "mis_scoped",
                    "fresh",
                    "orphan",
                    "in_index",
                    "pending",
                ):
                    bucket.setdefault(key, 0)

        # Everything above (the walk's projection, including per-record identity
        # resolution) is part of what the caller waited for.
        timing = {
            "scan_ms": round((time.perf_counter() - started_at) * 1000, 1),
            "walk_ms": walk_ms,
        }

        per_type = list(by_type.values())
        grand_total = sum(bucket["count"] for bucket in per_type)
        grand_bytes = sum(bucket["total_bytes"] for bucket in per_type)
        grand_pending = sum(bucket.get("pending", 0) for bucket in per_type) if do_diff else 0
        grand_orphan = sum(bucket.get("orphan", 0) for bucket in per_type) if do_diff else 0
        types_for_log = [{key: value for key, value in bucket.items() if key != "_records"} for bucket in per_type]

        last_scan_at = SchemaRegistry.append_scan(
            trigger=trigger,
            duration_ms=timing["scan_ms"],
            total_records=grand_total,
            total_bytes=grand_bytes,
            types=types_for_log if not filter_type else [],
            type_name=filter_type or None,
        )

        if filter_type:
            bucket = by_type.get(filter_type)
            if bucket is None:
                return ApiSuccessResponse(
                    data={
                        "type": filter_type,
                        "count": 0,
                        "total_bytes": 0,
                        "avg_bytes": 0,
                        **timing,
                        "records": [],
                        "min_bytes": 0,
                        "max_bytes": 0,
                        "last_scan_at": last_scan_at,
                    }
                )
            records = bucket["_records"]
            sizes = [record["size_bytes"] for record in records] if records else [0]
            return ApiSuccessResponse(
                data={
                    "type": filter_type,
                    "count": bucket["count"],
                    "total_bytes": bucket["total_bytes"],
                    "avg_bytes": bucket["avg_bytes"],
                    **timing,
                    "records": records,
                    "min_bytes": min(sizes),
                    "max_bytes": max(sizes),
                    "last_scan_at": last_scan_at,
                    "new": bucket.get("new", 0),
                    "stale": bucket.get("stale", 0),
                    "mis_scoped": bucket.get("mis_scoped", 0),
                    "orphan": bucket.get("orphan", 0),
                    "fresh": bucket.get("fresh", 0),
                    "in_index": bucket.get("in_index", 0),
                    "pending": bucket.get("pending", 0),
                }
            )

        return ApiSuccessResponse(
            data={
                "types": types_for_log,
                "grand_total": grand_total,
                **timing,
                "grand_pending": grand_pending,
                "grand_orphan": grand_orphan,
                "diff_included": do_diff,
            }
        )

    async def _handle_fs_records_scan(self, request_info) -> ApiResponse:
        """Scan fs_records for stats.

        GET /fs-records/scan           → aggregate stats for all registered types
        GET /fs-records/scan?type=X    → per-type stats + record list

        Backed by ``FSIndexer.scan()``. Emits ``progress_report`` FlowData
        events per type via the shared indexer's ``on_progress`` callback.
        """
        # First statement in the handler: the deferred imports below are real
        # wall time on a cold process, and `scan_ms` claims to be the caller's.
        started_at = time.perf_counter()

        import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — trigger auto-registration
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            INDEXABLE_TYPES,
            PROGRESS_TEXT_COMPLETE,
            IndexerOptions,
            IndexProgressTable,
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
        from flow_sdk.fs_store.operations.all_projects import get_all_scope_filter  # noqa: PLC0415
        from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

        scope_explicit = qp.get("user") is not None or qp.get("projects") is not None
        # ``?projects=`` = foreground open of those exact projects → walk even
        # inside a protected folder; ``?user=`` / all-projects fanout is gated.
        foreground = qp.get("projects") is not None
        if scope_explicit:
            scope_filter = await resolve_project_scope(ScopeFilter.from_query_params(qp))
        else:
            # GET scan does not materialise missing Project rows. Asset identity
            # is still resolved below, so a new writable asset receives its ID.
            # Carry the cwd metadata into
            # _resolve_scoped_roots so the helper is not scanned twice.
            scope_filter = await get_all_scope_filter(create_missing=False)
        scoped_roots = await self._resolve_scoped_roots(scope_filter, foreground=foreground)
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

        terminal_table: IndexProgressTable | None = None

        async def publish(table: IndexProgressTable) -> None:
            activity.latest_table = table
            await broadcast_progress(
                to_entity=str(self.typeid),
                flow_data=activity.make_flow_data(),
            )

        async def emit(table: IndexProgressTable) -> None:
            nonlocal terminal_table
            if table.text == PROGRESS_TEXT_COMPLETE:
                terminal_table = table
                return
            await publish(table)

        try:
            t0 = time.perf_counter()
            nodes = await get_shared_indexer().scan(
                IndexerOptions(
                    types=types_filter,
                    limit_per_type=limit_per_type,
                    on_progress=emit,
                    verbose=False,
                    roots=scoped_roots,
                )
            )
            walk_ms = round((time.perf_counter() - t0) * 1000, 1)
            response = self._project_fs_records_scan(
                nodes=nodes,
                filter_type=filter_type,
                types_filter=types_filter,
                trigger=trigger,
                walk_ms=walk_ms,
                started_at=started_at,
                scope_explicit=scope_explicit,
            )
            if terminal_table is not None:
                await publish(terminal_table)
            return response
        finally:
            self._complete_activity("scan")

    @staticmethod
    async def _scope_filter_from_query(request_info):
        """Resolve the unified ScopeFilter from ``?user=&projects=`` query params
        (None when neither is present). Shared by the index-status and
        asset-stats handlers so the scope-parsing path is defined once."""
        from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

        qp = request_info.request.query_params
        return await resolve_project_scope(
            ScopeFilter.from_query_params(qp)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else None
        )

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

        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        scope_filter = await self._scope_filter_from_query(request_info)
        status = await SchemaRegistry.get_index_status(scope=scope_filter)
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

    async def _handle_fs_records_asset_stats(self, request_info) -> ApiResponse:
        """Live per-type asset counts for a ScopeFilter — the single source the
        UI counter surfaces render from.

        GET /fs-records/asset-stats[?user=&projects=]

        Counts only (``{per_type, total}``); freshness/orphans stay on
        ``index-status``. Same scope-parsing path as that handler.
        """
        from dataclasses import asdict  # noqa: PLC0415

        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        scope_filter = await self._scope_filter_from_query(request_info)
        stats = await SchemaRegistry.get_asset_stats(scope=scope_filter)
        return ApiSuccessResponse(data=asdict(stats))

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
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            PROGRESS_TEXT_COMPLETE,
            IndexProgressTable,
            TypeProgressRow,
        )
        from flow_sdk.fs_store.operations.record_error import clear_all as _clear_all_errors  # noqa: PLC0415
        from flow_sdk.fs_store.operations.record_error import clear_for_type as _clear_errors_for_type
        from flow_sdk.fs_store.schema_registry import (  # noqa: PLC0415
            SchemaRegistry,  # noqa: PLC0415
            _sanitize_type_name,
            _schema_dir,
        )

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        target_types = [filter_type] if filter_type else SchemaRegistry.get_all_record_types()

        # Optional ScopeFilter narrows the delete to a subset of rows per type
        # (e.g. only one project's markdown). Without these params the clear
        # is full per type, matching legacy behaviour.
        from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

        scope_filter = await resolve_project_scope(
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
                    await _clear_errors_for_type(type_name)
                    # Drop every record's index sentinel for this type so cleared
                    # records read as never-indexed (no lie-after-clear).
                    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

                    FSRecord.clear_hashes_for_type(type_name)
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
                await _clear_all_errors()

            # Scoped clear of a single project: drop the project's own sentinel
            # so the project page reads never-indexed after the clear.
            _proj_ids = list(getattr(scope_filter, "projects", None) or []) if scope_filter else []
            if len(_proj_ids) == 1:
                from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

                _prec = FSRecord.load_or_none("project", _proj_ids[0])
                if _prec is not None:
                    _prec.clear_hash()

            current_type = None
            await emit(text=PROGRESS_TEXT_COMPLETE)
        finally:
            self._complete_activity("clear")

        return ApiSuccessResponse(
            data={
                "fts_cleared": fts_cleared,
                "entities_cleared": entities_cleared,
                "types_cleared": target_types,
            }
        )

    @asynccontextmanager
    async def _index_activity(self, job_name: str = "index", timeout_seconds: int = 600):
        """Hold the single-flight activity and yield ``(activity, emit)``.

        The acquire + progress-broadcast closure + ``finally: _complete_activity``
        scaffolding, in one place — it was verbatim-identical at three call sites.
        Raises ``RuntimeError`` when the job is already running; each caller decides
        what that means (409 for HTTP, silent skip for background passes).
        """
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415

        activity = self._start_activity(job_name, timeout_seconds=timeout_seconds)

        async def emit(table) -> None:
            activity.latest_table = table
            await broadcast_progress(
                to_entity=str(self.typeid),
                flow_data=activity.make_flow_data(),
            )

        try:
            yield activity, emit
        finally:
            self._complete_activity(job_name)

    async def _run_index_activity(
        self,
        *,
        roots,
        types,
        scope_filter,
        project_id: str | None,
        force: bool,
        trigger: str,
        limit_per_type: int | None = None,
        orphan_action,
        include_temp: bool = False,
        type_name: str | None = None,
        indexer=None,
        project_record=None,
        on_started=None,
    ):
        """Run one index under the single-flight activity guard.

        The shared tail of every index entry point: acquire the ``index``
        activity, stream progress to the footer, run ``FSIndexer.index()``,
        append the run to the index log, reconcile MCP capabilities, and stamp
        the project's own ``.hash`` sentinel. Returns ``(result, types_out)``.

        **Raises ``RuntimeError`` when an index is already running** rather than
        deciding what that means — the HTTP handler turns it into a 409, the auto
        path skips silently. This is why the guard lives here and the policy does
        not.

        The project sentinel stamp is inside this helper on purpose: it is what
        makes the project page's "last indexed / changes pending" correct, and
        an auto run must update it exactly like a manual one.
        """
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            IndexerOptions,
            get_shared_indexer,
        )
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        async with self._index_activity() as (_activity, emit):
            # Only now is the run definitely going ahead. Callers that must record
            # "this ran" (the auto-index marker) hook here rather than up front, so
            # a run skipped for contention leaves their bookkeeping untouched.
            if on_started is not None:
                on_started()
            result = await (indexer or get_shared_indexer()).index(
                IndexerOptions(
                    types=types,
                    limit_per_type=limit_per_type,
                    on_progress=emit,
                    verbose=False,
                    roots=roots,
                    force=force,
                    include_temp=include_temp,
                    project_id=project_id,
                    orphan_action=orphan_action,
                    scope_filter=scope_filter,
                )
            )

        types_out = [
            {
                "type": str(rt),
                "indexed": pt.indexed + pt.skipped,
                "new": pt.indexed,
                "skipped": pt.skipped,
                "errors": pt.errors,
                "duration_ms": pt.duration_ms,
                "orphans_found": pt.orphans_found,
                "orphans_db_removed": pt.orphans_db_removed,
                "orphans_disk_removed": pt.orphans_disk_removed,
            }
            for rt, pt in result.per_type.items()
        ]

        SchemaRegistry.append_index(
            trigger=trigger,
            duration_ms=result.duration_ms,
            total_indexed=result.total_indexed,
            types=types_out if not type_name else [],
            type_name=type_name,
        )

        # Indexing refreshes the MCP-server capability list: an MCP added/removed
        # in any agent's config becomes a <service>.mcp.<worker_type> capability
        # (or is pruned). Fire-and-forget — never block the index response.
        if not type_name or type_name == "mcp_server":
            try:
                from flow_sdk.core.capabilities.mcp import reconcile_mcp_capabilities  # noqa: PLC0415

                asyncio.create_task(reconcile_mcp_capabilities())
            except Exception as e:
                logging.debug(f"[fs-records] mcp capability reconcile skipped: {e}")

        # Stamp the project's own index sentinel after a project-scoped run, so
        # the project page reads "last indexed" / "changes pending" off the
        # project record itself (the project IS a record). Single chokepoint —
        # covers Fast and Full from the project page, manual and auto alike.
        if project_id:
            try:
                from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

                _prec = project_record or FSRecord.load_or_none("project", project_id)
                if _prec is not None:
                    _prec.ensure_asset_ref().write_hash()
            except Exception as e:
                logging.debug(f"[fs-records] project index sentinel write skipped: {e}")

        return result, types_out

    async def _auto_index_project(
        self,
        project_id: str,
        *,
        force: bool,
        trigger: str,
        scan_mode=None,
        project_record=None,
        on_started=None,
    ) -> bool:
        """Index one project because it was selected/created, not clicked.

        Returns True when a run actually happened, False when it was skipped.
        Never raises — the caller is a detached task hanging off an activation
        response.

        Three properties this path must keep:

        * **Never a 409.** A user-initiated index holding the activity means we
          skip silently (same as the startup system-assets pass). The user never
          caused this run and must never see it fail.
        * **Never sweeps.** ``orphan_action`` stays INDEX (count-only). An
          automatic run must not delete records — that caps the blast radius if
          the walk ever returns a short candidate list.
        * **Never foreground.** Protected-folder projects are gated, so a plain
          project switch cannot trip a macOS consent dialog.

        ``scan_mode`` applies ``preferences.auto_index.index_function`` to THIS run
        only — a manual index keeps the in-process walk, because that preference
        lives in the auto-index section and is hidden behind its enable toggle.

        ``on_started`` is forwarded to ``_run_index_activity``, which invokes it
        only after the activity is held — so a run skipped for contention does not
        burn a project's one First-Selection chance.
        """
        from flow_sdk.fs_store.indexer import OrphanAction, get_auto_scan_indexer  # noqa: PLC0415
        from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

        try:
            scope_filter = await resolve_project_scope(
                ScopeFilter(user=False, projects=(str(project_id),)), create_missing=False
            )
            roots = await self._resolve_scoped_roots(scope_filter, foreground=False)
            if isinstance(roots, ApiFailResponse) or not roots:
                logging.debug(
                    "[auto-index] project %s resolved no walkable roots (gated or unknown)",
                    project_id,
                )
                return False

            result, _ = await self._run_index_activity(
                roots=roots,
                types=None,
                scope_filter=scope_filter,
                project_id=str(project_id),
                force=force,
                trigger=trigger,
                # Count-only: an automatic run must never delete records.
                orphan_action=OrphanAction.INDEX,
                indexer=get_auto_scan_indexer() if scan_mode is not None else None,
                project_record=project_record,
                on_started=on_started,
            )
            logging.info(
                "[auto-index] project %s (%s): %d new, %d errors in %.0fms",
                project_id,
                trigger,
                result.total_indexed,
                result.total_errors,
                result.duration_ms,
            )
            return True
        except RuntimeError as e:
            # An index already holds the activity — a user-initiated run, or the
            # startup pass. Skip silently; the user never asked for this one.
            logging.debug("[auto-index] project %s skipped: %s", project_id, e)
            return False
        except Exception:
            logging.debug("[auto-index] project %s failed (non-fatal)", project_id, exc_info=True)
            return False

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
        import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — trigger auto-registration
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            INDEXABLE_TYPES,
            OrphanAction,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        qp = request_info.request.query_params
        filter_type = qp.get("type", "").strip()
        trigger = qp.get("trigger", "manual").strip() or "manual"
        rebuild = qp.get("rebuild", "").strip().lower() in ("true", "1")
        force = qp.get("force", "").strip().lower() in ("true", "1")
        limit_types_raw = qp.get("limit_types", "").strip()
        limit_types = int(limit_types_raw) if limit_types_raw.isdigit() else None
        limit_per_type_raw = qp.get("limit_per_type", "").strip()
        limit_per_type = int(limit_per_type_raw) if limit_per_type_raw.isdigit() else None
        # Single-path scoping: when the caller points at one file/dir it just
        # wrote ("open it" after a Write), index ONLY that subtree instead of
        # the full known-root set. Without this the walk fans out over every
        # root and hangs on a large workspace (proven RCA: 120s read timeout),
        # so the agent never gets a TypeId to navigate to. An explicit path is
        # explicit intent, so it also overrides the temp-path skip below.
        index_path = qp.get("path", "").strip()

        # Validate the type and resolve the explicit path before considering
        # the bounded single-file shortcut.
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

        from pathlib import Path as _Path  # noqa: PLC0415

        _p = _Path(index_path).expanduser().resolve() if index_path else None

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
        orphan_action_raw = qp.get("orphan_action", "").strip().lower()
        try:
            orphan_action = OrphanAction(orphan_action_raw) if orphan_action_raw else OrphanAction.INDEX
        except ValueError:
            return ApiFailResponse(
                message=(f"Invalid orphan_action '{orphan_action_raw}'. Valid: {[a.value for a in OrphanAction]}"),
                status_code=400,
            )

        # Direct non-force file lookup: resolve exactly the requested asset
        # before any global scope/project inventory or custom-root work.
        # ``discover_record_by_path`` still stamps an already-known owning
        # project through its targeted project-mount lookup.
        if _p is not None and filter_type and _p.is_file() and not rebuild and not force:
            _t_direct = time.perf_counter()
            try:
                found = await discover_record_by_path(filter_type, str(_p))
            except Exception as e:
                return ApiFailResponse(
                    message=f"Failed to index {filter_type} at {index_path}: {e}",
                    status_code=500,
                )
            indexed_typeid = f"{filter_type}-{found.id}" if found is not None and getattr(found, "id", None) else None
            indexed_typeids = [indexed_typeid] if indexed_typeid else []
            # Measured, not 0.0: this branch really does parse and sync the
            # file, so reporting zero made a single-file index look free and
            # left the endpoint's only SLO (< 1s) unobservable in its own payload.
            _direct_ms = round((time.perf_counter() - _t_direct) * 1000, 2)
            type_row = {
                "type": filter_type,
                "indexed": 1 if indexed_typeid else 0,
                "new": 1 if indexed_typeid else 0,
                "skipped": 0,
                "errors": 0,
                "duration_ms": _direct_ms,
                "orphans_found": 0,
                "orphans_db_removed": 0,
                "orphans_disk_removed": 0,
            }
            SchemaRegistry.append_index(
                trigger=trigger,
                duration_ms=_direct_ms,
                total_indexed=1 if indexed_typeid else 0,
                types=[],
                type_name=filter_type,
            )
            return ApiSuccessResponse(
                data={
                    "type": filter_type,
                    "indexed": type_row["indexed"],
                    "errors": type_row["errors"],
                    "orphans_found": 0,
                    "orphans_db_removed": 0,
                    "orphans_disk_removed": 0,
                    "typeid": indexed_typeid,
                    "typeids": indexed_typeids,
                    "types": [type_row],
                    "total_indexed": type_row["indexed"],
                    "total_errors": 0,
                }
            )

        # Unified ScopeFilter from canonical wire format `?user=…&projects=A,B`.
        from flow_sdk.fs_store.operations.all_projects import get_all_scope_filter  # noqa: PLC0415
        from flow_sdk.server.search_filters import ScopeFilter, resolve_project_scope  # noqa: PLC0415

        # `create_missing=False`: resolving the scope must NOT write entities.
        # The ScopeFilter is complete either way — an unmaterialized cwd still
        # yields `Project.derive_id_for_path(cwd)` — and the index run itself
        # materializes every missing project inside the job, via
        # `real_project_cwd_fn` -> `get_all_projects(create_missing=True)`.
        # Minting here was duplicate work done BEFORE the index single-flight
        # guard is taken: measured 38.854s on a cold DB (vs 1.4s warm) while
        # the index job itself is 2.4s, so a second request arriving in that
        # window died with `409 Job 'index' already running` and the api-tier
        # tests failed as either a 30s timeout or a 409 depending on warmth.
        scope_filter = (
            await resolve_project_scope(ScopeFilter.from_query_params(qp), create_missing=True)
            if (qp.get("user") is not None or qp.get("projects") is not None)
            else await get_all_scope_filter(create_missing=False)
        )
        # Single-project narrowing — derived from the ScopeFilter, used below
        # to short-circuit non-project indexer work paths.
        project_id = scope_filter.projects[0] if (scope_filter and len(scope_filter.projects) == 1) else None

        # Resolve ScopeFilter → indexer roots.
        #
        # Orphan-aware runs (orphan_action != INDEX) walk the FULL all-projects
        # root set even when a narrower scope is selected: orphan-ness is
        # defined globally (a record is orphan iff its source is missing
        # anywhere), so ``seen_ids`` must cover all references. The scope
        # filter is re-applied inside the indexer to narrow which orphans get
        # reported and acted on. Without the global walk, a record physically
        # inside project A but referenced from project B — or any project not
        # in the selected scope — would be falsely flagged as orphan.
        # Path-scoped run: a single explicit path short-circuits all root
        # resolution — walk just that file's directory. Cheap and bounded.
        if _p is not None:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415
            from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
            from flow_sdk.fs_store.scope import Scope  # noqa: PLC0415

            _root_dir = _p.parent if _p.is_file() else _p
            custom_roots = (
                FSRef(
                    _root_dir,
                    record_type=RecordType.CWD_ROOT,
                    scope=Scope.PROJECT.value,
                    project_id=Project.derive_id_for_path(_root_dir),
                ),
            )
        else:
            # Orphan-aware runs (orphan_action != INDEX) must walk EVERY source
            # so ``seen_ids`` is global — a record is orphan iff its source is
            # missing *anywhere*. ``default_roots()`` (the old
            # ``custom_roots = None``) only covers USER_HOME's targeted
            # expanders + the backend CWD + system; it does NOT descend the
            # registered project file trees, so every project record went
            # unseen and was mass-deleted as a false orphan. Resolve the FULL
            # all-projects root set for orphan runs; INDEX runs use the
            # requested scope. Either way ``scope_filter`` is still passed to
            # the indexer (opts.scope_filter) to narrow which orphans are acted on.
            roots_scope = (
                await get_all_scope_filter(create_missing=False)
                if orphan_action != OrphanAction.INDEX
                else scope_filter
            )
            # foreground=False even for an explicit ?projects=, unlike the scan
            # handler — see _resolve_scoped_roots on why an index never prompts.
            custom_roots = await self._resolve_scoped_roots(roots_scope, foreground=False)
            if isinstance(custom_roots, ApiFailResponse):
                return custom_roots

        driver = get_db_driver()

        # Rebuild mode: clear DB + FTS + on-disk .hash sentinels for target
        # types first. Clearing sentinels is essential: rebuild drops the DB
        # rows, and a leftover sentinel would let skip-fresh treat a now-missing
        # row as "fresh" and never re-create it (the same poisoning DELETE
        # avoids via clear_hashes_for_type). Mirrors the DELETE /index path.
        if rebuild:
            from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

            targets = types_filter or INDEXABLE_TYPES
            for t in targets:
                await driver.delete_entities_by_type(str(t))
                FSRecord.clear_hashes_for_type(str(t))
            if not filter_type:
                # Only full-clear FTS on aggregate rebuild; per-type rebuild
                # already cleared matching FTS rows via delete_entities_by_type
                await driver.fts_clear()

        # Single-project shortcut: when narrowed to exactly one project,
        # also pass project_id so the indexer can short-circuit non-project
        # work paths. Derived from the ScopeFilter above.
        effective_project_id = project_id

        try:
            result, types_out = await self._run_index_activity(
                roots=custom_roots,
                types=types_filter,
                scope_filter=scope_filter,
                project_id=effective_project_id,
                force=force,
                trigger=trigger,
                limit_per_type=limit_per_type,
                orphan_action=orphan_action,
                # An explicit path is explicit intent — index it even under a
                # temp root (/tmp, /var/folders), which the default walk skips.
                include_temp=bool(index_path),
                type_name=filter_type or None,
            )
        except RuntimeError as e:
            # An index is already running. HTTP surfaces the conflict; the auto
            # path silently skips instead (see _auto_index_project).
            return ApiFailResponse(message=str(e), status_code=409)

        # For a path-scoped run, resolve the TypeId(s) for the named file so the
        # caller (CLI / agent) can navigate straight to it — the whole point of
        # "index then open". It matches what the indexer just stored.
        indexed_typeids: list[str] = []
        indexed_typeid: str | None = None
        if index_path and _p.is_file():
            from flow_sdk.fs_store.type_id import type_id_str  # noqa: PLC0415

            _rtypes = types_filter or [RecordType(str(rt)) for rt in result.per_type]
            for _rt in _rtypes:
                try:
                    _id = self._ref_id(FSRef(_p, record_type=_rt))
                except Exception:
                    _id = None
                if _id:
                    indexed_typeids.append(type_id_str(str(_rt), _id))
            indexed_typeid = indexed_typeids[0] if indexed_typeids else None

        if filter_type:
            if not types_out:
                return ApiSuccessResponse(
                    data={
                        "type": filter_type,
                        "indexed": 0,
                        "new": 0,
                        "skipped": 0,
                        "errors": 0,
                        "orphans_found": 0,
                        "orphans_db_removed": 0,
                        "orphans_disk_removed": 0,
                        "typeid": indexed_typeid,
                        "typeids": indexed_typeids,
                    }
                )
            one = types_out[0]
            return ApiSuccessResponse(
                data={
                    "type": one["type"],
                    # Same three counters the aggregate payload carries, and the
                    # same meanings: `indexed` is everything PROCESSED, split into
                    # `new` (re-parsed) and `skipped` (fresh, left alone). Without
                    # the split a per-type caller sees "indexed: 2107" for a run
                    # that actually re-parsed nothing, and cannot tell a no-op
                    # re-index from a full one.
                    "indexed": one["indexed"],
                    "new": one["new"],
                    "skipped": one["skipped"],
                    "errors": one["errors"],
                    "orphans_found": one["orphans_found"],
                    "orphans_db_removed": one["orphans_db_removed"],
                    "orphans_disk_removed": one["orphans_disk_removed"],
                    "typeid": indexed_typeid,
                    "typeids": indexed_typeids,
                }
            )

        return ApiSuccessResponse(
            data={
                "indexed": sum(p.indexed + p.skipped for p in result.per_type.values()),
                "new": result.total_indexed,
                "skipped": sum(p.skipped for p in result.per_type.values()),
                "errors": result.total_errors,
                "orphans_found": result.total_orphans_found,
                "orphans_db_removed": result.total_orphans_db_removed,
                "orphans_disk_removed": result.total_orphans_disk_removed,
                "types": types_out,
                "duration_ms": result.duration_ms,
                "typeid": indexed_typeid,
                "typeids": indexed_typeids,
            }
        )

    async def _handle_fs_records_index_sessions(self, request_info) -> ApiResponse:
        """POST /fs-records/index-sessions?project_id=<id>

        Fast, scoped re-index of agent **sessions only**, for the "Recent
        Sessions" refresh button. Two passes under one ``index`` activity so
        the footer pill reports progress exactly like ``/fs-records/index``:

          1. Claude — precise: walk only the project's
             ``~/.claude/projects/<encoded-cwd>`` dir (skipped when the project
             has no Claude history dir yet).
          2. Codex + Copilot — their session storage is user-global (organized
             by date, not cwd), so there's no per-project dir to scope to. We
             walk the whole store; skip-fresh re-parses only changed files, so
             repeat refreshes stay cheap. The ``types`` filter gates
             ``claude_projects_fn`` out of this pass (its PROJECT output only
             reaches CLAUDE_SESSION, absent here), so it never re-walks every
             Claude project.

        ``project_id`` stamps the produced records (claude pass) but does not
        narrow Codex/Copilot — those surface in the list via the UI's own
        project filter.
        """
        from pathlib import Path  # noqa: PLC0415

        import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — auto-register
        from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
        from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
            IndexerOptions,
            IndexProgressTable,
            get_shared_indexer,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
        from flow_sdk.fs_store.scope import Scope  # noqa: PLC0415
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        qp = request_info.request.query_params
        project_id = qp.get("project_id", "").strip() or None

        # Resolve the project's cwd → its ~/.claude/projects/<encoded> dir.
        # The encoding is lossy, so match by decoded cwd rather than re-encoding.
        claude_root: FSRef | None = None
        if project_id:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415
            from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

            proj = await Project.get_one(QueryFilter.parse({"id": project_id}))
            if proj is None:
                return ApiFailResponse(message=f"Project '{project_id}' not found", status_code=404)
            project_cwd = getattr(proj, "fs_storage_mount_path", None)
            if project_cwd:
                from flow_sdk.fs_store.indexer.functions._claude_projects import (  # noqa: PLC0415
                    _claude_projects_dir,
                    decode_claude_project_dir,
                )

                try:
                    target = Path(project_cwd).resolve()
                except OSError:
                    target = None
                projects_dir = _claude_projects_dir()
                if target is not None and projects_dir.is_dir():
                    for d in projects_dir.iterdir():
                        if not d.is_dir():
                            continue
                        decoded = decode_claude_project_dir(d)
                        try:
                            if decoded is not None and decoded.resolve() == target:
                                claude_root = FSRef(
                                    d,
                                    record_type=RecordType.PROJECT,
                                    scope=Scope.USER.value,
                                    project_id=project_id,
                                )
                                break
                        except OSError:
                            continue

        home_root = FSRef(
            get_instance_settings().user_home,
            record_type=RecordType.USER_HOME_FOLDER,
            scope=Scope.USER.value,
        )

        try:
            activity = self._start_activity("index", timeout_seconds=300)
        except RuntimeError as e:
            return ApiFailResponse(message=str(e), status_code=409)

        async def emit(table: IndexProgressTable) -> None:
            activity.latest_table = table
            await broadcast_progress(
                to_entity=str(self.typeid),
                flow_data=activity.make_flow_data(),
            )

        indexer = get_shared_indexer()
        results = []
        try:
            if claude_root is not None:
                results.append(
                    await indexer.index(
                        IndexerOptions(
                            types=[RecordType.CLAUDE_SESSION],
                            roots=(claude_root,),
                            on_progress=emit,
                            verbose=False,
                            project_id=project_id,
                        )
                    )
                )
            results.append(
                await indexer.index(
                    IndexerOptions(
                        types=[RecordType.CODEX_SESSION, RecordType.COPILOT_SESSION],
                        roots=(home_root,),
                        on_progress=emit,
                        verbose=False,
                        project_id=project_id,
                    )
                )
            )
        finally:
            self._complete_activity("index")

        indexed = {str(rt): pt.indexed for result in results for rt, pt in result.per_type.items()}
        return ApiSuccessResponse(data={"indexed": indexed})

    async def _index_system_assets(self) -> None:
        """Startup pass: index the SDK-shipped Flowpad Assistant system project
        (docs/markdown, skills, agents, whiteboards) at the **live install
        location**, emitting progress to the footer like any index.

        Hash-gated, so it's near-instant after the first run; combined with
        path-aware freshness (``FSRecord.index_required``) it re-anchors any
        ``asset_ref`` left stale by an install relocation (editable ↔ wheel).
        Scoped to the system project only — never the user's workspace.
        Best-effort: never raises into the caller (spawned detached).
        """
        import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — trigger auto-registration

        try:
            from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415
            from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
                IndexerOptions,
                IndexProgressTable,
                get_shared_indexer,
            )
            from flow_sdk.fs_store.indexer.roots import flowpad_assistant_scoped_roots  # noqa: PLC0415

            scoped_roots = flowpad_assistant_scoped_roots()
            if not scoped_roots:
                return

            try:
                activity = self._start_activity("index", timeout_seconds=600)
            except RuntimeError:
                # Another index is already running (e.g. user-triggered); it will
                # cover the system assets too — skip the duplicate pass.
                return

            async def emit(table: "IndexProgressTable") -> None:
                activity.latest_table = table
                await broadcast_progress(
                    to_entity=str(self.typeid),
                    flow_data=activity.make_flow_data(),
                )

            try:
                result = await get_shared_indexer().index(
                    IndexerOptions(
                        roots=scoped_roots,
                        on_progress=emit,
                        verbose=False,
                        force=False,
                    )
                )
                logging.info(
                    "[fs-records] system-assets index complete: "
                    f"{result.total_indexed} new, {result.total_errors} errors"
                )
            finally:
                self._complete_activity("index")
        except Exception:
            logging.exception("[fs-records] system-assets index failed (non-fatal)")

    async def _handle_fs_records_invalidate(self, request_info) -> ApiResponse:
        """POST /fs-records/invalidate

        Body: ``{"paths": [...], "deleted_paths": [...]}``. Force-reindex each
        changed path (resolving inner files to their owning folder asset),
        mint type-inferred new files, and orphan/re-sync deleted ones — each
        with a ``notify=True`` broadcast. The push trigger for the
        ``file change → reindex → entity change → refresh`` loop; called by the
        agentic turn-end seam and any client with a changed-file set.
        """
        from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415

        try:
            body = await request_info.request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            return ApiFailResponse(message="Body must be a JSON object", status_code=400)
        paths = body.get("paths") or []
        deleted = body.get("deleted_paths") or []
        if not isinstance(paths, list) or not isinstance(deleted, list):
            return ApiFailResponse(message="'paths' and 'deleted_paths' must be lists", status_code=400)
        try:
            result = await reindex_paths(paths, deleted)
        except Exception as e:
            return ApiFailResponse(message=f"Invalidate failed: {e}", status_code=500)
        return ApiSuccessResponse(data=result.as_dict())

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
        from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

        qp = request_info.request.query_params
        raw_path = (qp.get("path") or "").strip()
        if not raw_path:
            return ApiFailResponse(
                message="Missing required 'path' query parameter",
                status_code=400,
            )

        if _SR.get(record_type) is None:
            return ApiFailResponse(
                message=f"Unknown record type '{record_type}'. Available: {_SR.get_all_record_types()}",
                status_code=400,
            )

        # Expand ~ and resolve to a Path. Don't require the file to exist yet —
        # we'll let the discovery layer decide.
        #
        # The frontend's VFS encoding strips the leading slash off a compute-node-
        # rooted path (``compute_node-@local/Users/…`` parses to entitySubPath
        # ``Users/…``), and ``useEntityByPath`` sends that relative form straight
        # here. Anchor a non-absolute path at the compute-node root ``/`` —
        # mirroring ``VFSPath.machinePath`` — so it resolves the SAME on-disk asset
        # as the absolute machinePath. Without this the path resolves against the
        # backend CWD, misses, and 404s: the "not available" MissingAssetCard bug
        # this route's regression guard covers.
        expanded = str(Path(raw_path).expanduser())
        if not Path(expanded).is_absolute():
            expanded = "/" + expanded

        # Pass 1 + fast recovery (targeted single-file parse + sync) live in
        # the shared ``discover_record_by_path`` helper — also used by
        # ``AgenticProcess.show``. This route adds the heavy scoped re-index
        # fallback and the orphan/404 semantics on top. The match returns a
        # record even if its source is missing on disk: the caller reads
        # ``entity.orphan``; 404 is reserved for "no record at all".
        try:
            found = await discover_record_by_path(record_type, expanded)
        except Exception as e:
            return ApiFailResponse(
                message=f"Failed to scan {record_type}: {e}",
                status_code=500,
            )

        # Pass 2b (fallback): targeted parse didn't surface the record (e.g. a
        # project-rooted type that needs the parent-chain scope, or a file the
        # bulk discover already removed). Fall back to the scoped re-index.
        #
        # default_roots() no longer auto-expands USER_HOME → REAL_PROJECT_CWD
        # (the silent ``real_project_cwd_fn`` fanout was removed). We therefore
        # enumerate project roots explicitly via the scope filter so project-
        # rooted record types (TASK, SPEC, project-root SKILL/AGENT/WORKFLOW/
        # CLAUDE_MD/CLAUDE_RULES) are reachable from this recovery path.
        if found is None:
            try:
                from flow_sdk.fs_store.indexer import (  # noqa: PLC0415
                    IndexerOptions,
                    get_shared_indexer,
                )
                from flow_sdk.fs_store.operations.all_projects import get_all_scope_filter  # noqa: PLC0415
                from flow_sdk.fs_store.record_types import RecordType as _RT  # noqa: PLC0415

                rt = _RT(record_type)
                indexer = get_shared_indexer()
                discover_sf = await get_all_scope_filter()
                # Background self-heal fanout — gate protected folders.
                discover_roots = await self._resolve_scoped_roots(discover_sf, foreground=False)
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
            # Re-run the shared lookup — the re-index materialised the row.
            try:
                found = await discover_record_by_path(record_type, expanded)
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

        # Orphan-ness is the dynamic ``FSRecord.orphan`` (source missing on
        # disk). Sync to DB only when the source is alive; discover just reads.
        is_orphan = found.orphan
        if not is_orphan:
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
        # The frontend's `<MissingAssetCard>` reads ``orphan`` to differentiate
        # a missing source from a present one. Computed live from the record.
        data["orphan"] = is_orphan
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

    async def _materialize_main_body(self, rec, record_type: str) -> None:
        """Write a just-created folder-asset's main body to disk (default_body →
        e.g. ``SKILL.md``) so the new asset is discoverable by a disk-walking
        scan. No-op for types without a ``default_body_fn``/``entity_cls`` or an
        unresolved ``asset_ref``, and idempotent (``upsert_main_ref`` skips an
        existing file). Bridges the gap that ``sync_to_db`` (DB row + metadata
        shadow only) leaves for the FSRecord create path."""
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(record_type)
        if info is None or info.default_body_fn is None or info.entity_cls is None:
            return
        entity = await info.entity_cls.get_one({"id": rec.id})
        ar = getattr(entity, "asset_ref", None) if entity is not None else None
        if not ar:
            return
        rec.asset_ref = FSRef(ar)
        await asyncio.to_thread(rec.upsert_main_ref, entity)

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
        import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — trigger auto-registration
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

        # Worker history: GET /fs-records/history_entry?limit=N
        # history_entry is an aggregated/computed view (unified worker history
        # across providers), not a stored FSRecord type, so it has its own
        # branch instead of the generic RecordList path.
        if segments and segments[0] == "history_entry" and method == "get":
            return await self._handle_fs_records_history(request_info)

        # Semantic search: GET /fs-records/search?q=...
        if segments and segments[0] == "search" and method == "get":
            return await self._handle_fs_records_search(request_info)

        # MCP reconcile: GET /fs-records/mcp-reconcile[?use_cli=true]
        if segments and segments[0] == "mcp-reconcile" and method == "get":
            return await self._handle_fs_records_mcp_reconcile(request_info)

        # Scan stats: GET /fs-records/scan or /fs-records/scan?type=X
        if segments and segments[0] == "scan" and method == "get":
            return await self._handle_fs_records_scan(request_info)

        # Index: POST /fs-records/index or /fs-records/index?type=X
        if segments and segments[0] == "index" and method == "post":
            return await self._handle_fs_records_index(request_info)

        # Invalidate a changed-file set (push reindex + broadcast):
        # POST /fs-records/invalidate  body: {paths: [...], deleted_paths: [...]}
        if segments and segments[0] == "invalidate" and method == "post":
            return await self._handle_fs_records_invalidate(request_info)

        # Index sessions (scoped to a project): POST /fs-records/index-sessions
        if segments and segments[0] == "index-sessions" and method == "post":
            return await self._handle_fs_records_index_sessions(request_info)

        # Index status: GET /fs-records/index-status
        if segments and segments[0] == "index-status" and method == "get":
            return await self._handle_fs_records_index_status(request_info)

        # Asset stats: GET /fs-records/asset-stats
        if segments and segments[0] == "asset-stats" and method == "get":
            return await self._handle_fs_records_asset_stats(request_info)

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

        if _SR.get(record_type) is None:
            return ApiFailResponse(
                message=f"Unknown record type '{record_type}'. Available types: {_SR.get_all_record_types()}",
                status_code=400,
            )

        record_list = RecordList(type_name=record_type)

        # Read-only checks moved off Record; the RecordList over FSRecord is
        # always mutable. ReadOnlyRecordError stays imported for the
        # except branch below.
        if method in ("post", "put", "delete"):
            from flow_sdk.fs_store.exceptions import ReadOnlyRecordError  # noqa: F401

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
                # Materialize the folder-asset's main body on disk (default_body
                # → e.g. SKILL.md) so an API-created asset is discoverable by a
                # disk-walking scan. sync_to_db writes the DB row + metadata
                # shadow but not the main body — that's the Entity.save→_store→
                # upsert_main_ref chokepoint this FSRecord create path bypasses.
                try:
                    await self._materialize_main_body(rec, record_type)
                except Exception as e:  # best-effort — never fail the create
                    logging.debug(f"[fs-records] main-body materialize skipped: {e}")
                # scope is stamped from the resolved asset path inside
                # Entity._prepare_for_storage (the single save chokepoint), so
                # HTTP-created records are born with a scope just like
                # indexer-discovered ones — no post-create patch needed here.
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
                # Remove the asset_ref source too (live file/folder under
                # ~/.claude/...) so re-discovery doesn't resurface it.
                ar = getattr(record, "_asset_ref", None)
                if ar is not None:
                    try:
                        import shutil as _shutil

                        ar_path = ar._path
                        if ar_path.is_dir():
                            _shutil.rmtree(ar_path, ignore_errors=True)
                        elif ar_path.exists():
                            ar_path.unlink()
                    except OSError:
                        pass
                await record_list.delete(uid)
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
                    from flow_sdk.fs_store.indexer.functions.claude_sessions import (
                        claude_session_meta_dict,
                        get_claude_session,
                    )

                    project = rec.data.get("project", "") if rec.data else ""
                    session = get_claude_session(ref.id, project=project)
                    session_dict = claude_session_meta_dict(session) if session else None
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
        """Handle path-based source file CRUD: ``/fs-records/file?path=...&json_path=...``.

        Uses ``flow_sdk.fs_store.source_file_records`` to extract a flat list of
        typed records keyed by JSON Pointer. Each record carries ``type``,
        ``json_path``, ``source_file``, plus the JSON fragment's own fields.
        """
        from flow_sdk.fs_store.source_file_records import (  # noqa: PLC0415
            _delete_pointer,
            _set_pointer,
            extract_from_data,
            extract_records,
            is_allowed_source_path,
            known_filename,
            load_raw,
            write_raw,
        )

        qp = request_info.request.query_params
        source_path = qp.get("path", "")
        json_path = qp.get("json_path")

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

        expanded_path = str(Path(source_path).expanduser())
        if not known_filename(expanded_path):
            return ApiFailResponse(
                message=f"Unknown source file type: {Path(expanded_path).name}",
                status_code=400,
            )

        try:
            if method == "get":
                records = extract_records(expanded_path)
                if json_path is not None:
                    match = next(
                        (r for r in records if str(r.get("json_path", "")) == json_path),
                        None,
                    )
                    if match is None:
                        return ApiFailResponse(
                            message=f"No record at json_path '{json_path}'",
                            status_code=404,
                        )
                    return ApiSuccessResponse(data=match)
                return ApiSuccessResponse(data=records)

            if method == "put":
                if json_path is None:
                    return ApiFailResponse(
                        message="'json_path' query parameter is required for update",
                        status_code=400,
                    )
                body = await request_info.get_post_data()
                if not isinstance(body, dict):
                    return ApiFailResponse(
                        message="Invalid request body (expected JSON object)",
                    )
                data = load_raw(expanded_path)
                # Strip framework-only fields the TS layer round-trips back.
                payload = {k: v for k, v in body.items() if k not in ("type", "json_path", "source_file")}
                if json_path in ("", "/"):
                    # Root replace
                    for k, v in payload.items():
                        data[k] = v
                else:
                    _set_pointer(data, json_path, payload)
                write_raw(expanded_path, data)
                # Re-derive records from the in-hand dict — avoids a redundant
                # re-read + re-parse of the file we just wrote.
                records = extract_from_data(data, expanded_path)
                updated = next(
                    (r for r in records if str(r.get("json_path", "")) == json_path),
                    None,
                )
                if updated is None:
                    return ApiFailResponse(
                        message=f"Update wrote but couldn't re-resolve json_path '{json_path}'",
                        status_code=500,
                    )
                await self._broadcast_fs_record_op(
                    "update",
                    str(updated.get("type", "")),
                    str(updated.get("id", "")),
                    updated,
                    source_file=expanded_path,
                )
                return ApiSuccessResponse(data=updated)

            if method == "delete":
                if json_path is None:
                    return ApiFailResponse(
                        message="'json_path' query parameter is required for delete",
                        status_code=400,
                    )
                data = load_raw(expanded_path)
                removed = _delete_pointer(data, json_path)
                if not removed:
                    return ApiFailResponse(
                        message=f"No record at json_path '{json_path}'",
                        status_code=404,
                    )
                write_raw(expanded_path, data)
                await self._broadcast_fs_record_op(
                    "delete",
                    "",
                    "",
                    source_file=expanded_path,
                )
                return ApiSuccessResponse(data={"deleted": json_path})

            return ApiFailResponse(message=f"Unsupported method: {method}")
        except Exception as e:
            logging.exception(f"fs-records path-based error: {e}")
            return ApiFailResponse(message=str(e))

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


async def discover_record_by_path(
    record_type: str,
    path: str,
    *,
    notify: bool = False,
    proposed_id: str | None = None,
    scope: str | None = None,
    project_id: str | None = None,
    strict_owner: bool = False,
):
    """Find-or-recover ONE record by absolute path — the interactive fast path.

    If the source exists, parse JUST this file/folder via the type's
    ``from_disk_fn`` and ``sync_to_db`` and return the parsed record directly.
    Only fall back to the type's ``RecordList`` lookup when parsing cannot
    produce a match or the source is missing. No tree walks — the scoped
    re-index fallback stays in the ``/fs-records/{type}/discover`` route, which
    owns the heavy recovery.

    Shared by that route and ``AgenticProcess.show`` (a `flow show file` on a
    just-created skill/agent must resolve the entity so the bespoke editor
    renders). Returns the matched record or ``None``.

    ``notify`` (default False keeps the interactive callers silent): when True,
    the fresh-parse ``sync_to_db`` broadcasts the entity op — this is the
    force-reindex path used by ``reindex_paths`` so a changed file re-parses AND
    pushes a ``data_op_msg`` (bumped ``updated_date``) to watching clients.

    ``proposed_id`` (reindex only): the id of the entity ALREADY resolved for
    this path via ``get_by_asset_ref``. A portable asset (e.g. markdown) carries
    its id in an in-file identity capsule; a full-content overwrite (a real agent
    replacing a doc) wipes that capsule, so a bare re-parse would ``mint_id`` a
    FRESH v4 and fork a NEW entity, leaving the original's ``updated_date``
    frozen. Threading the known id makes ``mint_id`` re-stamp the capsule with the
    ORIGINAL id so the SAME entity updates in place. Consulted only on a capsule
    MISS — a still-present valid carrier id always wins, and folder types are
    unaffected (their capsule lives outside the edited file).
    """
    import asyncio as _asyncio  # noqa: PLC0415
    from datetime import datetime as _datetime  # noqa: PLC0415
    from datetime import timezone as _timezone  # noqa: PLC0415

    import flow_sdk.fs_store.indexer.registrations  # noqa: F401, PLC0415 — trigger auto-registration
    from flow_sdk.fs_store.fs_ref import FSRef as _FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.roots import classify_path  # noqa: PLC0415
    from flow_sdk.fs_store.fs_record import carrier_writes_are_suppressed  # noqa: PLC0415
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType as _RT  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry as _SR  # noqa: PLC0415

    if _SR.get(record_type) is None:
        return None
    expanded = str(Path(path).expanduser())
    target_norm = _normalize_asset_path(expanded)

    def _find() -> object | None:
        for rec in RecordList(type_name=record_type):
            ref = getattr(rec, "asset_ref", None) or getattr(rec, "_asset_ref", None)
            ref_path = getattr(ref, "path", None) if ref is not None else None
            if ref_path is None:
                ref_path = str(ref) if ref else ""
            if _normalize_asset_path(ref_path) == target_norm:
                return rec
        return None

    if Path(expanded).exists():
        _info = _SR.get(record_type)
        _from_disk = getattr(_info, "from_disk_fn", None)
        if _from_disk is not None:
            try:
                one_ref = _FSRef(
                    expanded,
                    record_type=_RT(record_type),
                    scope=scope or classify_path(expanded),
                    project_id=project_id,
                )
                # ``proposed_id`` (reindex): a portable asset carries its id in an
                # in-file capsule; a full-content overwrite wipes it, so a bare
                # re-parse would mint a FRESH v4 and fork a NEW entity, freezing
                # the original's updated_date. On a capsule MISS, re-stamp the
                # known id so the SAME entity updates. A still-present valid
                # carrier id always wins; folder types are unaffected.
                # Owner-first: when the caller didn't already resolve the row
                # (``proposed_id``), ask who owns this path before minting — a
                # capsule wiped by a full-content rewrite must recover its id,
                # not fork a new entity. ``live_ids=None`` (single path, no
                # per-type id set) means a VALID carrier always wins here; only
                # the full walk may conclude a carrier names no entity.
                _owner_id = proposed_id or await owner_id_for(
                    record_type, expanded, strict=strict_owner
                )
                # When the operation forbids touching the source bytes, resolve
                # READ-ONLY: `derive=False` answers only from evidence already
                # present and `overwrite=False` commits nothing.
                #
                # Read from the operation's context rather than taken as an
                # argument. The same policy as a parameter would have to be
                # threaded correctly by every caller, and a caller that forgot
                # would stamp a capsule into bytes that are not ours — a git
                # working tree, where it is then committed and pushed to
                # everyone who pulls.
                #
                # A suppressed resolve has no carrier to fall back on, so a
                # genuinely new asset is given a fresh id here. Identity for
                # such a source converges through an `origin_id` lookup, not
                # through anything derived from the bytes.
                _suppressed = carrier_writes_are_suppressed()
                resolved_id = _info.mint_entity_id(
                    one_ref,
                    owner_id=_owner_id,
                    proposed_id=proposed_id,
                    derive=not _suppressed,
                    overwrite=not _suppressed,
                )
                if _suppressed and not resolved_id:
                    resolved_id = str(mint_uuid())

                # Match the full indexer's deterministic primary ranking. A
                # non-primary path remains observable but is neither parsed nor
                # rewritten.
                from flow_sdk.db import get_db_driver  # noqa: PLC0415
                from flow_sdk.fs_store.asset_occurrences import (  # noqa: PLC0415
                    resolve_asset_collisions,
                    stored_asset_occurrences,
                )
                from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
                from flow_sdk.utils.git import git_asset_introduction  # noqa: PLC0415

                _driver = get_db_driver()
                _stored = {}
                if hasattr(_driver, "list_entity_sources_by_type"):
                    _sources = await _driver.list_entity_sources_by_type(record_type)
                    _target_sources = {
                        entity_id: source
                        for entity_id, source in _sources.items()
                        if str(entity_id) == str(resolved_id)
                    }
                    _stored = stored_asset_occurrences(record_type, _target_sources)

                def _resolve_target():
                    def _identity(candidate):
                        if not isinstance(candidate, str):
                            return record_type, resolved_id, canonical_posix_path(expanded)
                        candidate_ref = _FSRef(
                            candidate,
                            record_type=_RT(record_type),
                            scope=classify_path(candidate),
                        )
                        candidate_id = _info.mint_entity_id(candidate_ref)
                        if not candidate_id:
                            return None
                        return record_type, candidate_id, canonical_posix_path(candidate)

                    return resolve_asset_collisions(
                        [(record_type, resolved_id, expanded)],
                        _stored,
                        _identity,
                        git_asset_introduction,
                        _datetime.now(_timezone.utc),
                    )

                _decisions = await _asyncio.to_thread(_resolve_target)
                _decision = next(
                    (item for item in _decisions if item.type_name == record_type and item.entity_id == resolved_id),
                    None,
                )

                async def _reflect_collision() -> None:
                    if _decision is None or not _decision.changed:
                        return
                    _entity = await _driver.get_by_id(resolved_id, record_type)
                    if _entity is not None and hasattr(_entity, "reflect_asset_occurrences"):
                        await _entity.reflect_asset_occurrences(
                            _decision.occurrences,
                            notify=notify,
                        )

                if _decision is not None and _decision.duplicate_paths:
                    logging.warning(
                        "[asset-id] duplicate asset id; type=%s id=%s kept=%s skipped=%s",
                        record_type,
                        resolved_id,
                        _decision.primary_path,
                        ",".join(_decision.duplicate_paths),
                    )
                if _decision is not None and canonical_posix_path(expanded) != _decision.primary_path:
                    await _reflect_collision()
                    return None

                recs = _from_disk(one_ref, resolved_id)
                if _asyncio.iscoroutine(recs):
                    recs = await recs
                # Association rule (deepest project wins) — same stamp the
                # bulk-walk loop applies. Without it a discover-materialized
                # record lands project-less (the lone FSRef has no parent
                # chain) until the next full walk.
                from flow_sdk.fs_store.indexer.roots import (  # noqa: PLC0415
                    deepest_project_id_for_path,
                    load_project_mounts,
                )

                try:
                    owner_pid = deepest_project_id_for_path(canonical_posix_path(expanded), await load_project_mounts())
                except OSError:
                    owner_pid = None
                for rec in recs or []:
                    if project_id:
                        object.__setattr__(rec, "project_id", project_id)
                    elif owner_pid:
                        object.__setattr__(rec, "project_id", owner_pid)
                    ref = getattr(rec, "asset_ref", None) or getattr(rec, "_asset_ref", None)
                    ref_path = getattr(ref, "path", None) if ref is not None else None
                    if ref_path is None:
                        ref_path = str(ref) if ref else ""
                    synced = False
                    try:
                        await rec.sync_to_db(notify=notify)
                        synced = True
                    except Exception as _se:
                        logging.debug(f"[fs-records] targeted sync skipped for {record_type}: {_se}")
                    if synced and _normalize_asset_path(ref_path) == target_norm:
                        await _reflect_collision()
                        return rec
            except Exception as e:
                logging.debug(f"[fs-records] targeted parse failed for {record_type} @ {expanded}: {e}")
    return _find()
