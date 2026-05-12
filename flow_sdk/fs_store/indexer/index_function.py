"""FSIndexer — DFS walker with type-registered handlers.

Uses the existing FSRef primitive (flow_sdk/fs_store/fs_ref/base.py) tagged
with a RecordType discriminator. See tests/unit/test_fs_store/test_basic_indexer.py
for the contract.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Protocol

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.progress_table import (
    IndexProgressTable,
    TypeProgressRow,
)
from flow_sdk.fs_store.record_types import RecordType


# DFS waypoints the walker visits to reach leaf record types. Either they
# don't materialize records at all (USER_HOME_FOLDER, SYSTEM_ROOT, FOLDER,
# CWD_ROOT) or they're expansion nodes used to reach indexable children
# (PROJECT, REAL_PROJECT_CWD). Filtered out of progress tables so the user
# sees only types they recognize. Per-type accumulators in IndexResult still
# include them — this filter is presentation-only.
_PROGRESS_HIDDEN_TYPES: set[RecordType] = {
    RecordType.USER_HOME_FOLDER,
    RecordType.SYSTEM_ROOT,
    RecordType.REAL_PROJECT_CWD,
    RecordType.CWD_ROOT,
    RecordType.PROJECT,
    RecordType.FOLDER,
}

_PROGRESS_THROTTLE_S = 0.2


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


ProgressCallback = Callable[[IndexProgressTable], Awaitable[None]]


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


async def _load_entity_state_map(
    driver: Any, type_name: str
) -> dict[str, tuple[float, str, str]]:
    """Return `{id: (updated_date_ts, scope, project_id)}` for every entity row of `type_name`.

    Single-query bulk preload used by `FSIndexer.index()` for the skip-fresh
    check. Rows with `updated_date is None` are dropped (they'd always fail
    the freshness comparison anyway). `scope` and `project_id` are returned as
    empty strings when NULL/missing in the DB so callers can do simple equality.

    SQLite stores `updated_date` as an ISO-like string ("YYYY-MM-DD HH:MM:SS[.µs]")
    written by the ORM from `datetime.now(UTC)`, so we parse as UTC to match
    file mtime semantics (epoch seconds).
    """
    from datetime import datetime, timezone

    from sqlalchemy import text

    # `scope` and `project_id` live inside the JSON `data` blob, not as their
    # own columns — extract them server-side so we get the same per-row triple
    # in one round trip. SQLite has json_extract built in; other drivers using
    # this code path will need an equivalent.
    async with driver._session_ctx() as session:
        result = await session.execute(
            text(
                "SELECT id, updated_date, "
                "json_extract(data, '$.scope'), "
                "json_extract(data, '$.project_id') "
                "FROM entities WHERE type = :t"
            ),
            {"t": type_name},
        )
        rows = result.fetchall()
    out: dict[str, tuple[float, str, str]] = {}
    for r in rows:
        ud = r[1]
        scope = r[2] or ""
        pid = r[3] or ""
        ts: float | None = None
        if ud is None:
            continue
        if hasattr(ud, "timestamp"):
            dt = ud if ud.tzinfo is not None else ud.replace(tzinfo=timezone.utc)
            ts = dt.timestamp()
        elif isinstance(ud, str):
            try:
                dt = datetime.fromisoformat(ud.replace(" ", "T"))
            except ValueError:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            ts = dt.timestamp()
        else:
            try:
                ts = float(ud)
            except (TypeError, ValueError):
                continue
        if ts is None:
            continue
        out[r[0]] = (ts, scope, pid)
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

        Progress is reported as ``IndexProgressTable`` snapshots: an initial
        snapshot with totals known and ``done=0``, throttled updates at
        ~5/s as records are processed, and a terminal snapshot with
        ``text="complete"`` and ``current=None``.
        """
        opts = opts if opts is not None else IndexerOptions()
        t0 = time.perf_counter()
        on_progress = opts.on_progress

        # Inner scan suppresses its own progress emission — we drive the
        # whole index activity from this method's snapshot loop.
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

        # Bulk-preload {id: (updated_date_ts, scope, project_id)} per type — one
        # DB query each. Used for the skip-fresh check: if an asset's mtime is
        # <= the DB row's updated_date AND the row's scope/project_id already
        # match the FSRef walk, no re-parse needed.
        driver = get_db_driver()
        type_names = {str(r.record_type) for r in targets if r.record_type is not None}
        valid_map: dict[str, dict[str, tuple[float, str, str]]] = {}
        for tn in type_names:
            valid_map[tn] = await _load_entity_state_map(driver, tn)

        # Pre-flight per-type totals: known up front because scan() materialized
        # everything before we entered the per-record loop. Only counts types
        # the per-record loop will actually index (skips scaffold types like
        # USER_HOME_FOLDER / FOLDER that have no record_cls or from_fsref).
        per_type_totals: dict[RecordType, int] = {}
        for ref in targets:
            if ref.record_type is None:
                continue
            info = SchemaRegistry.get(str(ref.record_type))
            if info is None or info.record_cls is None:
                continue
            if not hasattr(info.record_cls, "from_fsref"):
                continue
            per_type_totals[ref.record_type] = per_type_totals.get(ref.record_type, 0) + 1

        # Per-type accumulators. Mutated in place during the loop; the table
        # snapshot reads from these dicts on every emit.
        per_type_counts: dict[RecordType, dict[str, Any]] = {
            rt: {
                "indexed": 0, "errors": 0, "duration_ms": 0.0, "skipped": 0,
                "orphans_found": 0, "orphans_db_removed": 0, "orphans_disk_removed": 0,
                "orphan_ids": [],
            }
            for rt in per_type_totals
        }
        # Per-type set of entity ids we touched in this run (parsed or skipped-fresh).
        # Anything in valid_map[type] - seen_ids[type] is an orphan: a DB row whose
        # source no longer exists on disk.
        seen_ids: dict[RecordType, set[str]] = {}
        # Per-type list of entity ids that were successfully parsed+synced this run.
        # Used post-loop to clear orphan=False on rows whose source reappeared.
        seen_alive_ids: dict[RecordType, list[str]] = {}
        fts_batch: list = []
        current_rt: RecordType | None = None
        last_emit_at = 0.0

        def make_table(text: str | None = None) -> IndexProgressTable:
            rows: list[TypeProgressRow] = []
            for rt, total in per_type_totals.items():
                if rt in _PROGRESS_HIDDEN_TYPES:
                    continue
                acc = per_type_counts[rt]
                done = int(acc["indexed"]) + int(acc["skipped"])
                rows.append(TypeProgressRow(
                    type_name=str(rt),
                    done=done,
                    total=total,
                    errors=int(acc["errors"]),
                    skipped=int(acc["skipped"]),
                ))
            rows.sort(key=lambda r: -r.total)
            current_name = (
                str(current_rt) if current_rt is not None
                and current_rt not in _PROGRESS_HIDDEN_TYPES
                else None
            )
            return IndexProgressTable(
                job_name="index",
                rows=tuple(rows),
                current=current_name,
                done=sum(r.done for r in rows),
                total=sum(r.total for r in rows),
                text=text,
                ts=datetime.now(timezone.utc).isoformat(),
            )

        async def emit(text: str | None = None, force: bool = False) -> None:
            nonlocal last_emit_at
            if on_progress is None:
                return
            now = time.perf_counter()
            if not force and now - last_emit_at < _PROGRESS_THROTTLE_S:
                return
            last_emit_at = now
            await on_progress(make_table(text=text))

        # Initial snapshot — totals known, all done=0. Lets the UI render the
        # full table immediately instead of waiting for the first record.
        await emit(force=True)

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

                current_rt = ref.record_type
                acc = per_type_counts[ref.record_type]

                # Per-type cap: once we've processed `limit_per_type` records of
                # this type (parsed or skip-fresh), skip further refs of the same
                # type. ``done`` in the progress table is ``indexed + skipped``,
                # so the cap must include both to keep ``done <= limit_per_type``.
                if opts.limit_per_type is not None and (acc["indexed"] + acc["skipped"]) >= opts.limit_per_type:
                    continue

                # Track this id as "seen" before any skip/index decision so the
                # orphan check post-loop won't false-positive a fresh-skip as missing.
                ref_id = info.record_cls.getId(ref)
                if ref_id:
                    seen_ids.setdefault(ref.record_type, set()).add(ref_id)

                # Skip-fresh: in-memory dict lookup, one stat(), no parse.
                # Bypassed when `opts.force` is set (hard refresh) OR when the
                # DB row is missing the scope/project_id that the FSRef walk
                # now provides — those are stamped from the parent chain at
                # walk time, so a row with stale scope must be re-synced.
                rt_name = str(ref.record_type)
                state = valid_map.get(rt_name, {}).get(ref_id)
                if not opts.force and state is not None:
                    last_ts, db_scope, db_pid = state
                    asset_ts = info.record_cls.asset_hash_for_ref(ref)
                    fresh = bool(asset_ts) and asset_ts <= last_ts
                    walk_scope = ref.scope or ""
                    walk_pid = ref.project_id or ""
                    scope_matches = (walk_scope == "" or db_scope == walk_scope)
                    pid_matches = (walk_pid == "" or db_pid == walk_pid)
                    if fresh and scope_matches and pid_matches:
                        acc["skipped"] += 1
                        # Even when skipping the parse, the file is alive on
                        # disk this pass. Add to seen_alive_ids so a previous
                        # orphan flag gets cleared. Without this, restoring a
                        # file would only clear orphan if its mtime forced a
                        # re-parse — i.e. flaky.
                        if ref_id:
                            seen_alive_ids.setdefault(ref.record_type, []).append(str(ref_id))
                        await emit()
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
                            # After each successful target sync, ensure orphan flag is cleared.
                            # Cheap to call: _mark_orphans_in_db skips rows already orphan=False.
                            seen_alive_ids.setdefault(ref.record_type, []).append(str(rec_id))
                    acc["indexed"] += len(records)
                except Exception:
                    acc["errors"] += 1
                acc["duration_ms"] += (time.perf_counter() - t_start) * 1000

                await emit()

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
                    rt, {
                        "indexed": 0, "errors": 0, "duration_ms": 0.0, "skipped": 0,
                        "orphans_found": 0, "orphans_db_removed": 0, "orphans_disk_removed": 0,
                        "orphan_ids": [],
                    }
                )
                acc["orphans_found"] = len(ids)
                acc["orphan_ids"] = list(ids)
                # Non-destructive: always mark orphan=True so callers can see stale rows.
                # Idempotent — _mark_orphans_in_db only updates rows that need to change.
                await self._mark_orphans_in_db(rt, list(ids), orphaned=True)
                db_removed = 0
                disk_removed = 0

                if opts.orphan_action != OrphanAction.INDEX:
                    db_removed, disk_removed = await self._apply_orphan_action(
                        rt, ids, opts.orphan_action,
                        id_sources=orphan_id_sources.get(rt, {}),
                    )

                acc["orphans_db_removed"] = db_removed
                acc["orphans_disk_removed"] = disk_removed

            # Clear orphan=False on any record that was successfully resynced this pass
            # (covers the "file reappeared" case).
            for rt, ids in seen_alive_ids.items():
                await self._mark_orphans_in_db(rt, ids, orphaned=False)

        # Build per-type result for the IndexResult return value.
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

        # Terminal snapshot — current=None, text="complete". Authoritative
        # signal; consumers can clear UI state on this.
        current_rt = None
        if on_progress is not None:
            await on_progress(make_table(text="complete"))

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

    async def _mark_orphans_in_db(
        self,
        rt: "RecordType",
        ids: list[str],
        orphaned: bool,
    ) -> int:
        """Set ``orphan`` (and ``orphan_since``) on a list of entity ids.

        Non-destructive companion to ``_apply_orphan_action``: instead of
        deleting the row, mark it stale (or clear the mark when the source
        has returned). Idempotent — skips rows already in the requested state.

        Returns the count of rows that actually changed.
        """
        if not ids:
            return 0

        from datetime import datetime, timezone  # noqa: PLC0415
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        type_name = str(rt)
        changed = 0
        now = datetime.now(timezone.utc)

        # Resolve the entity class so get_one filters by id+type (a base
        # Entity.get_one would scope to type='entity' and miss the row).
        entity_cls = SchemaRegistry.get_entity_cls(type_name) or Entity

        for eid in ids:
            try:
                entity = await entity_cls.get_by_id(eid)
                if entity is None:
                    continue
                current = bool(getattr(entity, "orphan", False))
                if current == orphaned:
                    continue  # already in desired state — nothing to do
                entity.orphan = orphaned
                if orphaned:
                    # Preserve the original orphan_since on repeated False→True (shouldn't happen
                    # because of the early-return above, but defensive).
                    if getattr(entity, "orphan_since", None) is None:
                        entity.orphan_since = now
                else:
                    entity.orphan_since = None
                # Persist via the driver directly — entity.save() would re-run
                # _store(), which calls record.upsert_main_ref and would re-create
                # the source file we just decided is missing.
                from flow_sdk.db.db_entity import DBEntity  # noqa: PLC0415
                await DBEntity.save(entity, None)
                changed += 1
            except Exception as e:
                import logging  # noqa: PLC0415
                logging.debug(f"[FSIndexer] _mark_orphans_in_db skipped {type_name}:{eid}: {e}")
                continue

        return changed

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

                    entity = await Entity.get_one(QueryFilter.parse({"id": eid}, type_name))
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
        """DFS over registered FSRef nodes.

        Progress is reported as ``IndexProgressTable`` snapshots with
        ``total=0`` (unknown — discovery IS the count). Each visited
        node increments its type's row; the table is re-broadcast at most
        every 200 ms. Final snapshot has ``current=None, text="complete"``.
        """
        opts = opts if opts is not None else IndexerOptions()
        on_progress = opts.on_progress

        roots_for_walk = list(opts.roots) if opts.roots is not None else self._roots
        stack: list[FSRef] = list(reversed(roots_for_walk))
        visited: list[FSRef] = []
        seen: set[tuple[str, RecordType | None]] = set()
        per_type_counts: dict[RecordType, int] = {}
        current_rt: RecordType | None = None
        last_emit_at = 0.0

        def make_table(text: str | None = None) -> IndexProgressTable:
            rows = [
                TypeProgressRow(type_name=str(rt), done=count, total=count)
                for rt, count in per_type_counts.items()
                if rt not in _PROGRESS_HIDDEN_TYPES
            ]
            rows.sort(key=lambda r: -r.done)
            current_name = (
                str(current_rt) if current_rt is not None
                and current_rt not in _PROGRESS_HIDDEN_TYPES
                else None
            )
            return IndexProgressTable(
                job_name="scan",
                rows=tuple(rows),
                current=current_name,
                done=sum(r.done for r in rows),
                total=0,  # 0 = unknown for scan; UI hides percentage
                text=text,
                ts=datetime.now(timezone.utc).isoformat(),
            )

        async def emit(text: str | None = None, force: bool = False) -> None:
            nonlocal last_emit_at
            if on_progress is None:
                return
            now = time.perf_counter()
            if not force and now - last_emit_at < _PROGRESS_THROTTLE_S:
                return
            last_emit_at = now
            await on_progress(make_table(text=text))

        await emit(force=True)

        while stack:
            node = stack.pop()
            key = (node.path, node.record_type)
            if key in seen:
                continue
            seen.add(key)
            visited.append(node)
            if opts.verbose:
                print(f"[indexer] visit type={node.record_type} path={node.path}")
            if node.record_type is not None:
                per_type_counts[node.record_type] = per_type_counts.get(node.record_type, 0) + 1
                current_rt = node.record_type
            fns = self._functions.get(node.record_type, []) if node.record_type is not None else []
            for fn in fns:
                children = await fn([node], opts)
                stack.extend(reversed(children))
            if opts.limit is not None and len(visited) >= opts.limit:
                break
            await emit()

        current_rt = None
        if on_progress is not None:
            await on_progress(make_table(text="complete"))

        return visited

