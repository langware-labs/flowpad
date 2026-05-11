"""FSIndexer — DFS walker with type-registered handlers.

Uses the existing FSRef primitive (flow_sdk/fs_store/fs_ref/base.py) tagged
with a RecordType discriminator. See tests/unit/test_fs_store/test_basic_indexer.py
for the contract.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable, Protocol

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


class OrphanAction(str, Enum):
    """How index() should handle orphan rows (DB rows whose source is gone).

    INDEX  — keep the DB row + keep the on-disk fs_record. Status quo / safest.
    IGNORE — remove the DB row, keep the on-disk fs_record (acts as tombstone).
    DELETE — remove both the DB row AND the on-disk fs_record dir.

    All three modes count orphans in the report. INDEX is a no-op effect-wise
    but still surfaces the count so callers can see drift.
    """

    INDEX = "index"
    IGNORE = "ignore"
    DELETE = "delete"


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    """Lifecycle signal emitted by scan() / index()."""
    stage: str                   # "scan_start" | "type_complete" | "scan_end"
                                 # | "index_start" | "index_end"
                                 # | "type_start" | "type_progress"
                                 # | "type_orphans"
    record_type: RecordType | None = None
    count: int = 0
    total_bytes: int = 0
    indexed: int = 0
    errors: int = 0
    duration_ms: float = 0.0
    sub_done: int = 0
    sub_total: int = 0
    # Orphan stats — only populated on stage="type_orphans".
    orphans_found: int = 0
    orphans_db_removed: int = 0
    orphans_disk_removed: int = 0


ProgressCallback = Callable[[ProgressEvent], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class IndexerOptions:
    verbose: bool = True
    limit: int | None = None
    limit_per_type: int | None = None  # per-type cap on parsed records in index()
    include_temp: bool = False  # walk temp-path projects (/tmp, /var/folders, …)
    types: list[RecordType] | None = None  # index() filter; None = all types
    on_progress: ProgressCallback | None = None
    # Per-call root override; when set, scan() walks only these instead of
    # FSIndexer._roots. Used by project-scoped fastScan to limit traversal
    # to a single project subtree without mutating the shared indexer state.
    roots: tuple[FSRef, ...] | None = None
    # When True, skip-fresh is bypassed: every ref gets re-parsed and re-upserted
    # regardless of mtime. Used by "hard refresh" within a project scope.
    force: bool = False
    # Honor .gitignore + _WALK_IGNORED in project-scope walkers (FOLDER fan-out).
    # No-op outside REAL_PROJECT_CWD / CWD_ROOT scopes.
    gitignore: bool = True
    # When set, every record produced by this indexer run carries this
    # project_id. Stamped onto the root FSRef by the handler; reflected onto
    # records via `from_fsref` reading `ref.project_id`.
    project_id: str | None = None
    # Orphan handling: what to do with DB rows that no longer have a source on
    # disk. Default INDEX is the historical behavior (do nothing, just count).
    # IGNORE removes the DB row only; DELETE removes both DB row + fs_record dir.
    # Orphan detection is automatic — happens after the main index loop using
    # the freshness-check `valid_map` we already preload (no extra DB query).
    orphan_action: OrphanAction = OrphanAction.INDEX


@dataclass(frozen=True, slots=True)
class PerTypeIndexResult:
    type: RecordType
    indexed: int
    errors: int
    duration_ms: float
    skipped: int = 0
    # Orphan stats. orphans_found is detected regardless of action; the
    # *_removed fields are non-zero only for IGNORE (db) / DELETE (both).
    orphans_found: int = 0
    orphans_db_removed: int = 0
    orphans_disk_removed: int = 0
    orphan_ids: tuple[str, ...] = ()


@dataclass(slots=True)
class IndexResult:
    per_type: dict[RecordType, PerTypeIndexResult] = field(default_factory=dict)
    total_indexed: int = 0
    total_errors: int = 0
    duration_ms: float = 0.0
    total_orphans_found: int = 0
    total_orphans_db_removed: int = 0
    total_orphans_disk_removed: int = 0


class IndexerFunc(Protocol):
    async def __call__(
        self, nodes: list[FSRef], opts: IndexerOptions
    ) -> list[FSRef]: ...


async def _load_updated_map(driver: Any, type_name: str) -> dict[str, float]:
    """Return `{id: updated_date_ts}` for every entity row of `type_name`.

    Single-query bulk preload used by `FSIndexer.index()` for the skip-fresh
    check. Rows with `updated_date is None` are dropped (they'd always fail
    the freshness comparison anyway).

    SQLite stores `updated_date` as an ISO-like string ("YYYY-MM-DD HH:MM:SS[.µs]")
    written by the ORM from `datetime.now(UTC)`, so we parse as UTC to match
    file mtime semantics (epoch seconds).
    """
    from datetime import datetime, timezone

    from sqlalchemy import text

    async with driver._session_ctx() as session:
        result = await session.execute(
            text("SELECT id, updated_date FROM entities WHERE type = :t"),
            {"t": type_name},
        )
        rows = result.fetchall()
    out: dict[str, float] = {}
    for r in rows:
        ud = r[1]
        if ud is None:
            continue
        if hasattr(ud, "timestamp"):
            # datetime object — honor its tzinfo, default to UTC if naive
            dt = ud if ud.tzinfo is not None else ud.replace(tzinfo=timezone.utc)
            out[r[0]] = dt.timestamp()
            continue
        if isinstance(ud, str):
            try:
                dt = datetime.fromisoformat(ud.replace(" ", "T"))
            except ValueError:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            out[r[0]] = dt.timestamp()
            continue
        try:
            out[r[0]] = float(ud)
        except (TypeError, ValueError):
            continue
    return out


class FSIndexer:
    def __init__(
        self,
        roots: list[FSRef] | None = None,
    ) -> None:
        self._roots: list[FSRef] = list(roots) if roots is not None else []
        self._functions: dict[RecordType, list[IndexerFunc]] = {}

    def add_function(
        self, record_type: RecordType, fn: IndexerFunc
    ) -> None:
        self._functions.setdefault(record_type, []).append(fn)

    def add_root(self, node: FSRef) -> None:
        self._roots.append(node)

    async def index(
        self, opts: IndexerOptions | None = None
    ) -> IndexResult:
        """Discover -> parse -> persist pipeline.

        Always runs a full scan; when `opts.types` is set, only FSRefs of
        those types get parsed via `Record.from_fsref` and written to DB.
        """
        opts = opts if opts is not None else IndexerOptions()
        t0 = time.perf_counter()

        on_progress = opts.on_progress
        if on_progress is not None:
            await on_progress(ProgressEvent(stage="index_start"))

        # Inner scan emits its own type_complete burst — suppress so it
        # doesn't flood the outer index activity with "done" ticks before
        # real indexing work begins.
        scan_opts = IndexerOptions(
            verbose=opts.verbose,
            limit=opts.limit,
            limit_per_type=opts.limit_per_type,
            include_temp=opts.include_temp,
            types=opts.types,
            on_progress=None,
            roots=opts.roots,
            gitignore=opts.gitignore,
            project_id=opts.project_id,
        )
        refs = await self.scan(scan_opts)

        if opts.types is None:
            targets = refs
        else:
            target_set = set(opts.types)
            targets = [r for r in refs if r.record_type in target_set]

        # Imports localized to break cycles
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        from flow_sdk.db import get_db_driver, session as _db_session

        # Bulk-preload {id: updated_date_ts} per type — one DB query each.
        # Used for the skip-fresh check: if an asset's mtime is <= the DB
        # row's updated_date, no re-parse needed.
        driver = get_db_driver()
        type_names = {str(r.record_type) for r in targets if r.record_type is not None}
        valid_map: dict[str, dict[str, float]] = {}
        for tn in type_names:
            valid_map[tn] = await _load_updated_map(driver, tn)

        # Per-type totals (so sub_total is known up front for the UI).
        per_type_totals: dict[RecordType, int] = {}
        for ref in targets:
            if ref.record_type is None:
                continue
            per_type_totals[ref.record_type] = per_type_totals.get(ref.record_type, 0) + 1

        per_type_counts: dict[RecordType, dict[str, float]] = {}
        # Per-type set of entity ids we touched in this run (parsed or skipped-fresh).
        # Anything in valid_map[type] - seen_ids[type] is an orphan: a DB row whose
        # source no longer exists on disk.
        seen_ids: dict[RecordType, set[str]] = {}
        fts_batch: list = []
        current_rt: RecordType | None = None
        seen_progress_at: dict[RecordType, float] = {}
        _PROGRESS_THROTTLE_S = 0.2

        async def _emit_type_complete(rt: RecordType) -> None:
            if on_progress is None:
                return
            acc = per_type_counts.get(rt, {"indexed": 0, "errors": 0, "duration_ms": 0.0, "skipped": 0})
            await on_progress(ProgressEvent(
                stage="type_complete",
                record_type=rt,
                indexed=int(acc["indexed"]),
                errors=int(acc["errors"]),
                duration_ms=round(float(acc["duration_ms"]), 2),
                sub_done=int(acc["indexed"]) + int(acc.get("skipped", 0)),
                sub_total=per_type_totals.get(rt, 0),
            ))

        async def _emit_sub_progress(rt: RecordType) -> None:
            if on_progress is None:
                return
            acc = per_type_counts[rt]
            await on_progress(ProgressEvent(
                stage="type_progress",
                record_type=rt,
                indexed=int(acc["indexed"]),
                errors=int(acc["errors"]),
                sub_done=int(acc["indexed"]) + int(acc.get("skipped", 0)),
                sub_total=per_type_totals.get(rt, 0),
            ))

        # Hoist a single DB session over the entire per-record loop + FTS
        # flush. The driver's `_session_ctx` contextvar handshake makes
        # every nested call (sync_to_db → Entity.from_record → driver.save,
        # wiki.index → AsyncLinkStore, fts_upsert) reuse this one session,
        # so we pay connection setup ONCE for the whole batch instead of
        # per record. Critical for paths that touch hundreds of records
        # (e.g. ~/.claude/skills/ scan).
        async with _db_session():
            for ref in targets:
                if ref.record_type is None:
                    continue
                info = SchemaRegistry.get(str(ref.record_type))
                if info is None or info.record_cls is None:
                    continue
                if not hasattr(info.record_cls, "from_fsref"):
                    continue

                # On type-boundary transitions emit ``type_progress`` (NOT type_complete) —
                # DFS interleaves types, so the same type can re-appear later. Final
                # type_complete events fire post-loop, once per unique type.
                if ref.record_type != current_rt:
                    current_rt = ref.record_type
                    if on_progress is not None and current_rt not in seen_progress_at:
                        await on_progress(ProgressEvent(
                            stage="type_start",
                            record_type=current_rt,
                            sub_done=0,
                            sub_total=per_type_totals.get(current_rt, 0),
                        ))

                acc = per_type_counts.setdefault(
                    ref.record_type, {"indexed": 0, "errors": 0, "duration_ms": 0.0, "skipped": 0}
                )

                # Per-type cap: once we've indexed `limit_per_type` records of this
                # type, skip further refs of the same type.
                if opts.limit_per_type is not None and acc["indexed"] >= opts.limit_per_type:
                    continue

                # Track this id as "seen" before any skip/index decision so the
                # orphan check post-loop won't false-positive a fresh-skip as missing.
                ref_id = info.record_cls.getId(ref)
                if ref_id:
                    seen_ids.setdefault(ref.record_type, set()).add(ref_id)

                # Skip-fresh: in-memory dict lookup, one stat(), no parse.
                # Bypassed when `opts.force` is set (hard refresh).
                rt_name = str(ref.record_type)
                last_ts = valid_map.get(rt_name, {}).get(ref_id)
                if not opts.force and last_ts is not None:
                    asset_ts = info.record_cls.asset_hash_for_ref(ref)
                    if asset_ts and asset_ts <= last_ts:
                        acc["skipped"] += 1
                        # Throttled sub_progress even for skips.
                        now = time.perf_counter()
                        if now - seen_progress_at.get(ref.record_type, 0.0) >= _PROGRESS_THROTTLE_S:
                            seen_progress_at[ref.record_type] = now
                            await _emit_sub_progress(ref.record_type)
                        continue

                t_start = time.perf_counter()
                try:
                    records = await info.record_cls.from_fsref(ref)
                    # Walk-time scope/project_id from the FSRef parent-chain.
                    # Loop-invariant — read once, stamp on each record.
                    ref_scope = ref.scope
                    ref_pid = ref.project_id
                    for rec in records:
                        if ref_scope is not None:
                            object.__setattr__(rec, "scope", ref_scope)
                        if ref_pid is not None:
                            object.__setattr__(rec, "project_id", ref_pid)
                        await rec.sync_to_db(fts_batch=fts_batch, notify=False)
                        # Reflect any actually-saved id back into seen_ids in case
                        # from_fsref returns multiple records (rare) or a different id.
                        rec_id = getattr(rec, "id", None)
                        if rec_id:
                            seen_ids.setdefault(ref.record_type, set()).add(str(rec_id))
                    acc["indexed"] += len(records)
                except Exception:
                    acc["errors"] += 1
                acc["duration_ms"] += (time.perf_counter() - t_start) * 1000

                # Throttled sub_progress during a type.
                now = time.perf_counter()
                if now - seen_progress_at.get(ref.record_type, 0.0) >= _PROGRESS_THROTTLE_S:
                    seen_progress_at[ref.record_type] = now
                    await _emit_sub_progress(ref.record_type)

            # Batch FTS commit — still inside the shared session.
            if fts_batch:
                driver = get_db_driver()
                if hasattr(driver, "fts_upsert"):
                    await driver.fts_upsert(fts_batch)

            # ----- Orphan handling -----
            # DEFINITION: a record is orphan iff its source (Layer 1, e.g.
            # ~/.claude/skills/<name>/SKILL.md) does not exist. The orphan
            # condition is independent of which materializations remain — DB
            # row only, fs_record dir only, or both. We detect by looking at
            # BOTH known materializations and asking the same question for each:
            # was this id seen during the scan (meaning Layer 1 still exists)?
            #
            #   orphan_ids = (records_dir_ids | db_row_ids) - seen_ids
            #
            # Project-scoped runs (opts.project_id != None) are skipped because
            # both valid_map and the records-dir walk are global, but seen_ids
            # only covers refs from the project subtree.
            orphan_records: dict[RecordType, list[str]] = {}
            orphan_id_sources: dict[RecordType, dict[str, dict[str, bool]]] = {}
            if opts.project_id is None:
                orphan_filter_types = self._resolve_orphan_filter_types(
                    opts.types, valid_map
                )
                # Map type → set of ids found by walking the records dir on disk.
                disk_ids_per_type = self._discover_records_dir_ids(orphan_filter_types)

                for type_name in orphan_filter_types:
                    try:
                        rt = RecordType(type_name)
                    except ValueError:
                        continue

                    db_ids = set(valid_map.get(type_name, {}).keys())
                    disk_ids = disk_ids_per_type.get(type_name, set())
                    all_ids = db_ids | disk_ids

                    seen = seen_ids.get(rt, set())
                    missing = sorted(all_ids - seen)
                    if not missing:
                        continue

                    orphan_records[rt] = missing
                    orphan_id_sources[rt] = {
                        eid: {
                            "in_db": eid in db_ids,
                            "on_disk": eid in disk_ids,
                        }
                        for eid in missing
                    }

            for rt, ids in orphan_records.items():
                acc = per_type_counts.setdefault(
                    rt, {"indexed": 0, "errors": 0, "duration_ms": 0.0, "skipped": 0}
                )
                acc["orphans_found"] = len(ids)
                acc["orphan_ids"] = list(ids)
                db_removed = 0
                disk_removed = 0

                if opts.orphan_action != OrphanAction.INDEX:
                    db_removed, disk_removed = await self._apply_orphan_action(
                        rt, ids, opts.orphan_action,
                        id_sources=orphan_id_sources.get(rt, {}),
                    )

                acc["orphans_db_removed"] = db_removed
                acc["orphans_disk_removed"] = disk_removed

                if on_progress is not None:
                    await on_progress(ProgressEvent(
                        stage="type_orphans",
                        record_type=rt,
                        orphans_found=len(ids),
                        orphans_db_removed=db_removed,
                        orphans_disk_removed=disk_removed,
                    ))

        # Emit one type_complete per unique type at the end (DFS interleaves
        # mean we can't know a type is "done" mid-loop without a second pass).
        for rt in per_type_counts.keys():
            await _emit_type_complete(rt)

        # Build per-type result (events already emitted inline above).
        per_type: dict[RecordType, PerTypeIndexResult] = {}
        for rt, acc in per_type_counts.items():
            per_type[rt] = PerTypeIndexResult(
                type=rt,
                indexed=int(acc["indexed"]),
                errors=int(acc["errors"]),
                duration_ms=round(acc["duration_ms"], 2),
                skipped=int(acc.get("skipped", 0)),
                orphans_found=int(acc.get("orphans_found", 0)),
                orphans_db_removed=int(acc.get("orphans_db_removed", 0)),
                orphans_disk_removed=int(acc.get("orphans_disk_removed", 0)),
                orphan_ids=tuple(acc.get("orphan_ids", []) or []),
            )

        duration = (time.perf_counter() - t0) * 1000

        if opts.on_progress is not None:
            await opts.on_progress(ProgressEvent(
                stage="index_end",
                indexed=sum(p.indexed for p in per_type.values()),
                errors=sum(p.errors for p in per_type.values()),
                duration_ms=duration,
            ))

        return IndexResult(
            per_type=per_type,
            total_indexed=sum(p.indexed for p in per_type.values()),
            total_errors=sum(p.errors for p in per_type.values()),
            duration_ms=duration,
            total_orphans_found=sum(p.orphans_found for p in per_type.values()),
            total_orphans_db_removed=sum(p.orphans_db_removed for p in per_type.values()),
            total_orphans_disk_removed=sum(p.orphans_disk_removed for p in per_type.values()),
        )

    @staticmethod
    def _resolve_orphan_filter_types(
        types: list[RecordType] | None, valid_map: dict[str, dict[str, float]],
    ) -> set[str]:
        """Decide which type names to check for orphans on this run.

        - If the caller passed ``types``, restrict to those.
        - Otherwise check every type that either has DB rows OR has a records
          dir on disk — caller didn't filter so we sweep everything we can see.
        """
        if types:
            return {str(t) for t in types}

        # Union of "types with DB rows" and "types with a records dir on disk"
        # so we never miss a records-dir orphan just because no DB row exists.
        from flow_sdk.fs_store.record import get_default_records_root  # noqa: PLC0415

        result: set[str] = set(valid_map.keys())
        records_root = get_default_records_root()
        try:
            for child in records_root.iterdir():
                if child.is_dir():
                    result.add(child.name)
        except (FileNotFoundError, OSError):
            pass
        return result

    @staticmethod
    def _discover_records_dir_ids(type_names: set[str]) -> dict[str, set[str]]:
        """Walk ``<records_root>/<type>/`` for each type and return ``{type → {id}}``.

        IDs come from parsing the directory stem (``<type>-@<id>``). Folders
        that don't match the stem pattern are skipped — they aren't records.
        """
        from flow_sdk.fs_store.record import (  # noqa: PLC0415
            get_default_records_root,
            parse_record_stem,
        )

        out: dict[str, set[str]] = {}
        records_root = get_default_records_root()
        for type_name in type_names:
            type_dir = records_root / type_name
            if not type_dir.is_dir():
                continue
            ids: set[str] = set()
            try:
                for entry in type_dir.iterdir():
                    if not entry.is_dir():
                        continue
                    try:
                        parsed_type, parsed_id = parse_record_stem(entry.name)
                    except ValueError:
                        continue
                    if parsed_type != type_name:
                        continue
                    ids.add(parsed_id)
            except (FileNotFoundError, OSError):
                continue
            if ids:
                out[type_name] = ids
        return out

    async def _apply_orphan_action(
        self,
        rt: RecordType,
        ids: list[str],
        action: OrphanAction,
        *,
        id_sources: dict[str, dict[str, bool]] | None = None,
    ) -> tuple[int, int]:
        """Apply IGNORE / DELETE to a list of orphan ids of a single type.

        Returns ``(db_removed, disk_removed)``. INDEX never reaches this method.

        Action semantics (orphan = source missing, layers may be partial):

        - IGNORE: remove the DB row + FTS entry if present. Disk dir untouched.
        - DELETE: remove DB row + FTS entry if present, AND rmtree the records
          dir at ``records_root/<type>/<stem>/`` if present.

        Cleanup chain for a DB-side orphan goes through ``Entity.delete()`` so
        the orphan removal benefits from the same downstream invalidation a
        normal API delete would: entity cache, auth cache, uname cache, wiki
        edges. Without this, ~1000 orphan ids would leave their wiki backlinks
        and cache references in place until the next natural eviction.

        For records-dir-only orphans (no DB row), we still issue a best-effort
        ``wiki.delete_for_id`` because wiki edges can outlive an entity row
        that was deleted previously without proper cleanup.

        ``id_sources`` (optional) maps each id to ``{"in_db": bool, "on_disk":
        bool}``. When omitted we attempt every removal — driver returns False
        harmlessly for missing rows.

        Failures are tolerated per-id so a single bad row doesn't abort the sweep.
        """
        if not ids:
            return 0, 0

        # Lazy imports keep this module a leaf in import topology.
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.record import (  # noqa: PLC0415
            get_default_records_root,
            record_stem,
        )

        driver = get_db_driver()
        type_name = str(rt)
        db_removed = 0
        disk_removed = 0

        for eid in ids:
            sources = (id_sources or {}).get(eid, {"in_db": True, "on_disk": True})
            in_db = sources.get("in_db", True)
            on_disk = sources.get("on_disk", True)

            # Best-effort wiki edge cleanup — idempotent, runs for every orphan
            # regardless of whether the DB row currently exists. Stale edges
            # pointing at a previously-deleted id would otherwise persist.
            try:
                from flow_sdk import wiki  # noqa: PLC0415
                await wiki.delete_for_id(type_name, eid)
            except Exception:
                pass

            if in_db:
                cleaned = False
                # Preferred path: load the Entity, call entity.delete(). This
                # cascades through the standard caches the same way an API
                # delete would.
                try:
                    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
                    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

                    entity = await Entity.get_one(QueryFilter.parse({"id": eid}))
                    if entity is not None:
                        if hasattr(driver, "fts_delete"):
                            try:
                                await driver.fts_delete(eid)
                            except Exception:
                                pass
                        await entity.delete()
                        db_removed += 1
                        cleaned = True
                except Exception:
                    pass

                # Fallback: row didn't load (already gone, or no Entity class
                # registered for this type). Fall through to a raw driver delete
                # so the bulk sweep still makes progress.
                if not cleaned:
                    try:
                        if hasattr(driver, "fts_delete"):
                            try:
                                await driver.fts_delete(eid)
                            except Exception:
                                pass
                        if await driver.delete_by_id(eid, type_name):
                            db_removed += 1
                    except Exception:
                        pass

            if action == OrphanAction.DELETE and on_disk:
                try:
                    rec_dir = (
                        get_default_records_root() / type_name / record_stem(type_name, eid)
                    )
                    if rec_dir.exists():
                        import shutil  # noqa: PLC0415
                        shutil.rmtree(rec_dir, ignore_errors=True)
                        disk_removed += 1
                except Exception:
                    pass

        return db_removed, disk_removed

    async def scan(
        self, opts: IndexerOptions | None = None
    ) -> list[FSRef]:
        opts = opts if opts is not None else IndexerOptions()
        t0 = time.perf_counter()

        if opts.on_progress is not None:
            await opts.on_progress(ProgressEvent(stage="scan_start"))

        roots_for_walk = list(opts.roots) if opts.roots is not None else self._roots
        stack: list[FSRef] = list(reversed(roots_for_walk))
        visited: list[FSRef] = []
        seen: set[tuple[str, RecordType | None]] = set()
        while stack:
            node = stack.pop()
            key = (node.path, node.record_type)
            if key in seen:
                continue
            seen.add(key)
            visited.append(node)
            if opts.verbose:
                print(f"[indexer] visit type={node.record_type} path={node.path}")
            fns = self._functions.get(node.record_type, []) if node.record_type is not None else []
            for fn in fns:
                children = await fn([node], opts)
                stack.extend(reversed(children))
            if opts.limit is not None and len(visited) >= opts.limit:
                break

        # Emit per-type completion events (aggregate by record_type)
        if opts.on_progress is not None:
            by_type: dict[RecordType, dict[str, int]] = {}
            for n in visited:
                if n.record_type is None:
                    continue
                b = by_type.setdefault(n.record_type, {"count": 0, "total_bytes": 0})
                b["count"] += 1
                try:
                    b["total_bytes"] += n._path.stat().st_size
                except OSError:
                    pass
            for rt, b in by_type.items():
                await opts.on_progress(ProgressEvent(
                    stage="type_complete",
                    record_type=rt,
                    count=b["count"],
                    total_bytes=b["total_bytes"],
                ))
            duration = (time.perf_counter() - t0) * 1000
            await opts.on_progress(ProgressEvent(
                stage="scan_end",
                count=len(visited),
                duration_ms=duration,
            ))

        return visited
