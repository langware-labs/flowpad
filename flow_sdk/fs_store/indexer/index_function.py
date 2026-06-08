"""FSIndexer — DFS walker with type-registered handlers.

Uses the existing FSRef primitive (flow_sdk/fs_store/fs_ref/base.py) tagged
with a RecordType discriminator. See tests/unit/test_fs_store/test_basic_indexer.py
for the contract.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.indexer.progress_table import (
    IndexProgressTable,
    TypeProgressRow,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.server.search_filters import ScopeFilter


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

# Per chunk node budget for FSIndexer.scan(): amortizes asyncio.to_thread
# dispatch cost across many node visits while still yielding the event loop
# frequently enough that progress emits + other requests stay responsive.
_SCAN_CHUNK_NODES = 256

# Per chunk ref budget for FSIndexer.index()'s skip-fresh probe. The probe
# (gen_id_fn frontmatter read/write-back + on-disk hash equality) is pure
# sync file I/O; batching it through one asyncio.to_thread call per chunk
# keeps that I/O off the event loop — previously thousands of fresh-skip
# iterations ran it inline with no real suspension point (the throttled
# emit() returns without yielding), parking the loop for the whole stretch.
_PROBE_CHUNK_REFS = 256


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
    # Orphan detection is automatic — happens after the main index loop by
    # walking the record homes on disk (no DB query).
    orphan_action: OrphanAction = OrphanAction.INDEX
    # When set, the orphan candidate set is intersected with this filter
    # before reporting and acting. Orphan-ness is still determined globally
    # (a record is orphan iff its Layer 1 source is missing); the filter
    # only narrows which orphans the caller cares about — same semantics as
    # `flow_sdk.server.search_filters.apply_scope_filter`. None = no narrowing.
    # For the filter to make sense on a scoped run, the walk should still be
    # global so `seen_ids` reflects all references; callers wiring scope-aware
    # cleanup pass `roots=None` together with this filter.
    scope_filter: ScopeFilter | None = None


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
    # Walkers are typically sync — pure file I/O, no async resources — and
    # FSIndexer.scan() runs them via ``asyncio.to_thread`` so the gitignore-
    # aware DFS doesn't park the event loop for an entire indexer pass.
    # A walker that genuinely needs async (DB lookups, real HTTP) may instead
    # expose ``async def __call__``; scan() detects and awaits it directly.
    def __call__(
        self, nodes: list[FSRef], opts: IndexerOptions
    ) -> list[FSRef]: ...


def _has_dispatch(info) -> bool:
    """True when *info* declares a ``from_disk_fn`` parser slot."""
    return info.from_disk_fn is not None


def _is_async_walker(fn: Any) -> bool:
    """True when ``fn`` is a coroutine function or a class instance whose
    ``__call__`` is. Used by scan() to choose between direct-await and
    thread-pool dispatch.
    """
    if inspect.iscoroutinefunction(fn):
        return True
    call = getattr(fn, "__call__", None)
    return call is not None and inspect.iscoroutinefunction(call)


# Sentinel returned by ``_read_disk_record_scope`` when metadata.json is
# missing / unreadable / non-dict. Distinct from genuinely-unscoped
# (``("", "")``) so the predicate can default to "do NOT match a narrowing
# scope filter" rather than letting unknown-provenance records sneak through
# every filter and become destructive-action targets.
_SCOPE_UNREADABLE: tuple[None, None] = (None, None)


def _read_disk_record_scope(
    type_name: str, eid: str,
) -> tuple[str, str] | tuple[None, None]:
    """Return ``(scope, project_id)`` from a records-dir orphan's metadata.json.

    The record home (shadow dir) is the source of truth for an orphan's
    provenance. Returns ``(None, None)`` when the file is missing / unreadable
    / non-dict — caller treats that as "unknown provenance" and refuses to
    match a narrowing filter (safer for DELETE: corrupt metadata can't bleed
    cross-scope).
    """
    import json  # noqa: PLC0415
    from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
        get_default_records_root,
        record_stem,
    )
    _META_JSON = "metadata.json"

    path = get_default_records_root() / type_name / record_stem(type_name, eid) / _META_JSON
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return _SCOPE_UNREADABLE
    try:
        blob = json.loads(raw)
    except json.JSONDecodeError:
        return _SCOPE_UNREADABLE
    if not isinstance(blob, dict):
        return _SCOPE_UNREADABLE
    data = blob.get("data", blob) if isinstance(blob.get("data"), dict) else blob
    return (str(data.get("scope") or ""), str(data.get("project_id") or ""))


def _scope_filter_keeps(
    sf: ScopeFilter,
    type_name: str,
    eid: str,
) -> bool:
    """Predicate: should this orphan id survive the scope filter?

    Mirrors ``flow_sdk.server.search_filters.apply_scope_filter`` for known
    records — user-scope iff ``sf.user``, project-scope iff ``project_id in
    sf.projects``, genuinely-unscoped always kept. For records whose
    metadata.json is missing / unreadable / corrupt we return False (do NOT
    keep) so a narrowing DELETE can't bleed across scopes via corrupt records
    of unknown provenance.
    """
    scope, pid = _read_disk_record_scope(type_name, eid)
    if scope is None:
        # Metadata unreadable → unknown provenance → don't match the filter.
        return False
    if scope == "user":
        return sf.user
    if scope == "project":
        record_projects = tuple(getattr(sf, "record_projects", ()) or ())
        return pid in set((*sf.projects, *record_projects))
    return True


def _db_missing_orphans(
    db_rows: dict[str, tuple], seen: set[str], disk_ids: set[str],
) -> set[str]:
    """DB-row orphan candidates among ``db_rows``.

    Obeys the strict orphan definition (``FSRecord.orphan``): a DECLARED
    source (asset_ref) that no longer exists. Rows without an asset_ref
    aren't file-backed → never orphan. Rows whose asset_ref still exists are
    alive even when the walk derived a different id for that file (e.g. an
    API-minted v4 row beside a path-minted v5 twin) — id-set arithmetic alone
    would misclassify those as orphan. Stat-per-row — callers run this
    off-loop via ``asyncio.to_thread``.
    """
    return {
        eid
        for eid, (aref, _scope, _pid) in db_rows.items()
        if eid not in seen
        and eid not in disk_ids
        and aref
        and not Path(str(aref)).exists()
    }


def _scope_filtered_orphans(
    sf: ScopeFilter,
    type_name: str,
    missing: list[str],
    disk_ids: set[str],
    db_rows: dict[str, tuple],
) -> list[str]:
    """Narrow orphan candidates to those matching the ScopeFilter.

    Disk orphans resolve provenance from their shadow metadata.json
    (``_scope_filter_keeps`` — file I/O, so callers run this off-loop via
    ``asyncio.to_thread``); DB-only orphans resolve it from the row itself
    (no shadow metadata.json exists for them) with the same predicate shape.
    """
    sf_projects = set((*sf.projects, *(getattr(sf, "record_projects", ()) or ())))

    def _db_row_keeps(eid: str) -> bool:
        _aref, scope, pid = db_rows[eid]
        if scope == "user":
            return sf.user
        if scope == "project":
            return str(pid or "") in sf_projects
        return True

    return [
        eid for eid in missing
        if (
            _scope_filter_keeps(sf, type_name, eid)
            if eid in disk_ids
            else _db_row_keeps(eid)
        )
    ]


class FSIndexer:
    def __init__(
        self,
        roots: list[FSRef] | None = None,
    ) -> None:
        self._roots: list[FSRef] = list(roots) if roots is not None else []
        # Each entry: (fn, output_type | None). ``output_type`` is the
        # ``RecordType`` the function emits; ``None`` means "unknown / multiple
        # types" and the dispatcher must always run it (legacy fallback).
        self._functions: dict[RecordType, list[tuple[IndexerFunc, RecordType | None]]] = {}

    def add_function(
        self,
        record_type: RecordType,
        fn: IndexerFunc,
        output_type: RecordType | None = None,
    ) -> None:
        """Register ``fn`` on input ``record_type``.

        ``output_type`` declares the ``RecordType`` ``fn`` emits — used by
        ``scan()`` to skip the function when ``opts.types`` is set and the
        function's output can't reach any requested type. ``None`` means
        "unknown" and disables the skip (the function always runs).
        """
        self._functions.setdefault(record_type, []).append((fn, output_type))

    def add_root(self, node: FSRef) -> None:
        self._roots.append(node)

    def _compute_needed_output_types(
        self, requested: tuple[RecordType, ...]
    ) -> set[RecordType] | None:
        """Reverse-reachability over the registration graph.

        Returns the set of output ``RecordType``s whose walk transitively
        produces a record in ``requested``. ``None`` means "no annotation —
        run every function" (legacy callers that didn't pass output_type).

        The graph: an edge ``T_in -> T_out`` exists for each
        ``add_function(T_in, fn, output_type=T_out)``. Walking backward from
        ``requested`` (BFS over reversed edges) yields the closure of useful
        types — any function whose ``output_type`` isn't in this closure can
        be skipped without losing records.
        """
        # Reverse adjacency: T_out -> {T_in such that an edge T_in -> T_out exists}.
        reverse: dict[RecordType, set[RecordType]] = {}
        any_unannotated = False
        for t_in, fns in self._functions.items():
            for _fn, t_out in fns:
                if t_out is None:
                    any_unannotated = True
                    continue
                reverse.setdefault(t_out, set()).add(t_in)
        if any_unannotated:
            # Mixed registration: be safe and don't skip anything.
            return None
        needed: set[RecordType] = set(requested)
        frontier: list[RecordType] = list(requested)
        while frontier:
            t = frontier.pop()
            for parent in reverse.get(t, ()):
                if parent not in needed:
                    needed.add(parent)
                    frontier.append(parent)
        return needed

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
            force=opts.force,
            scope_filter=opts.scope_filter,
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

        # Skip-fresh is entirely on-disk: it reads each record's own ``.hash``
        # sentinel (``index_required``). The per-record index loop makes ZERO
        # DB reads — it never queries the store it produces. Orphan detection
        # (post-loop) unions the record homes on disk
        # (``_discover_records_dir_ids``) with the type's DB row ids (one lean
        # SELECT per type) so rows without a shadow dir are still sweepable.

        # Pre-flight dispatchable set + per-type totals: known up front because
        # scan() materialized everything before we entered the per-record loop.
        # Only includes types the per-record loop will actually index (skips
        # scaffold types like USER_HOME_FOLDER / FOLDER that have no record_cls
        # or from_fsref). The (ref, info) pairing feeds the probe chunks below.
        dispatchable: list[tuple[FSRef, Any]] = []
        per_type_totals: dict[RecordType, int] = {}
        for ref in targets:
            if ref.record_type is None:
                continue
            info = SchemaRegistry.get(str(ref.record_type))
            if info is None:
                continue
            if not _has_dispatch(info):
                continue
            dispatchable.append((ref, info))
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
        # Per-type set of entity ids touched this run (parsed or skipped-fresh).
        # A record home (disk id) not in seen_ids is an orphan: its source is
        # gone. Populated before the skip/index decision so a fresh-skip counts.
        seen_ids: dict[RecordType, set[str]] = {}
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
        #
        # Within that session we COMMIT IN BOUNDED BATCHES (every
        # _INDEX_COMMIT_BATCH records). The engine issues BEGIN IMMEDIATE on
        # every transaction, so a single session spanning the whole scan would
        # hold the SQLite writer lock for seconds/minutes, starving concurrent
        # requests (os-status-batch, entity loads) until they time out as
        # "database is locked". Committing per batch releases the lock so those
        # requests interleave; the next write re-acquires a fresh transaction.
        # Safe because: (1) the session factory uses expire_on_commit=False, so
        # loop-held state survives a commit; (2) indexing is idempotent, so
        # per-batch durability (vs one all-or-nothing transaction) loses
        # nothing on a mid-run crash. This is a contention fix, NOT a
        # busy_timeout/retry change.
        _INDEX_COMMIT_BATCH = 50
        _since_commit = 0
        driver = get_db_driver()

        async def _flush_fts() -> None:
            """Flush the accumulated FTS batch (if any) and reset it."""
            if not fts_batch:
                return
            if hasattr(driver, "fts_upsert"):
                await driver.fts_upsert(fts_batch)
            fts_batch.clear()

        # Probe worker — runs in a thread, one call per _PROBE_CHUNK_REFS
        # chunk. Everything here is sync file I/O: gen_id_fn reads (and on
        # first encounter rewrites) frontmatter; index_required compares the
        # source's current hash against the on-disk ``.hash`` sentinel.
        # genId is the mint-on-first-encounter variant: idempotent if the
        # file already carries an id in frontmatter, else writes the
        # currently derived id back so future scans and lookups are
        # rename-stable. Types without a custom gen_id_fn get the default
        # mint: stable uuid5 of the path, via the single minter
        # (policy-conforming).
        from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415

        def _probe_chunk(
            items: list[tuple[FSRef, Any]],
        ) -> list[tuple[FSRef, Any, str, FSRecord, bool]]:
            out: list[tuple[FSRef, Any, str, FSRecord, bool]] = []
            for ref, info in items:
                # Per-ref tolerance: one unreadable source (e.g. a non-UTF-8
                # file blowing up a frontmatter read) must not abort the whole
                # index run. Fall back to the path-derived id and mark the ref
                # stale — the parse path's own try/except then counts it in
                # the per-type ``errors`` accounting instead of raising out.
                try:
                    if info.gen_id_fn is not None:
                        ref_id = info.gen_id_fn(ref)
                    else:
                        ref_id = mint_uuid(str(ref._path))
                    probe = FSRecord(type=str(ref.record_type), id=ref_id, asset_ref=ref)
                    # Skip-fresh: pure on-disk equality, no parse, no DB. The
                    # probe record reads its own `.hash` sentinel (shadow home)
                    # and the source's current hash via `get_hash`. Fresh when
                    # unchanged. `opts.force` (Full mode) bypasses it.
                    fresh = bool(ref_id) and not opts.force and not probe.index_required
                except Exception as e:
                    logging.warning(
                        "[FSIndexer] probe failed for %s (%s): %r — falling through to parse",
                        ref._path, ref.record_type, e,
                    )
                    ref_id = mint_uuid(str(ref._path))
                    probe = FSRecord(type=str(ref.record_type), id=ref_id, asset_ref=ref)
                    fresh = False
                out.append((ref, info, ref_id, probe, fresh))
            return out

        async with _db_session() as _idx_session:
            for chunk_start in range(0, len(dispatchable), _PROBE_CHUNK_REFS):
                chunk = dispatchable[chunk_start:chunk_start + _PROBE_CHUNK_REFS]
                probed = await asyncio.to_thread(_probe_chunk, chunk)
                for ref, info, ref_id, probe, fresh in probed:
                    current_rt = ref.record_type
                    acc = per_type_counts[ref.record_type]

                    # Per-type cap: once we've processed `limit_per_type` records of
                    # this type (parsed or skip-fresh), skip further refs of the same
                    # type. ``done`` in the progress table is ``indexed + skipped``,
                    # so the cap must include both to keep ``done <= limit_per_type``.
                    # (The probe already ran for capped refs — harmless: gen_id is
                    # idempotent and the hash check has no side effects.)
                    if opts.limit_per_type is not None and (acc["indexed"] + acc["skipped"]) >= opts.limit_per_type:
                        continue

                    # Track this id as "seen" before any skip/index decision so the
                    # orphan check post-loop won't false-positive a fresh-skip as
                    # missing.
                    if ref_id:
                        seen_ids.setdefault(ref.record_type, set()).add(ref_id)

                    if fresh:
                        acc["skipped"] += 1
                        # seen_ids already holds ref_id (added above), so a fresh
                        # skip is not misclassified as orphan.
                        await emit()
                        continue

                    t_start = time.perf_counter()
                    try:
                        # Loop is gated by _has_dispatch → from_disk_fn is set.
                        from_disk = info.from_disk_fn
                        if asyncio.iscoroutinefunction(from_disk):
                            records = await from_disk(ref)
                        else:
                            records = await asyncio.to_thread(from_disk, ref)
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
                        # Stamp the index sentinel only on a successful parse+sync,
                        # so a failed parse stays index_required and is retried.
                        probe.write_hash()
                    except Exception:
                        acc["errors"] += 1
                    acc["duration_ms"] += (time.perf_counter() - t_start) * 1000

                    await emit()

                    # Bounded-batch commit: flush this batch's FTS then commit the
                    # session, releasing the writer lock so concurrent requests
                    # aren't starved (see batch rationale above the loop).
                    _since_commit += 1
                    if _since_commit >= _INDEX_COMMIT_BATCH:
                        await _flush_fts()
                        await _idx_session.commit()
                        _since_commit = 0

            # Flush the trailing partial batch (records since the last
            # bounded-batch commit), still inside the shared session.
            await _flush_fts()

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
            # ``opts.scope_filter`` is applied on top: orphan-ness is determined
            # globally (so a cross-scope reference still rescues a record), but
            # only orphans whose (scope, project_id) match the filter are
            # reported and acted on. The callers wiring this on top must use a
            # global walk (roots=None) so ``seen_ids`` is global; otherwise
            # records referenced from outside the walked subtree would falsely
            # appear orphan.
            #
            # SAFETY GUARD: a destructive orphan_action with a narrowed walk
            # (custom roots) and no scope_filter would silently wipe records
            # referenced from outside the walked subtree. Refuse — fall back
            # to INDEX (non-destructive) and emit a warning. The caller's
            # ScopeFilter-aware wrapper is responsible for either widening the
            # walk to global or supplying a scope_filter.
            effective_orphan_action = opts.orphan_action
            if (
                effective_orphan_action != OrphanAction.INDEX
                and opts.roots is not None
                and opts.scope_filter is None
            ):
                logging.warning(
                    "Refusing destructive orphan_action=%s on narrowed walk without a scope_filter: "
                    "cross-scope references would be misclassified as orphan. Falling back to INDEX.",
                    effective_orphan_action,
                )
                effective_orphan_action = OrphanAction.INDEX
            orphan_records: dict[RecordType, list[str]] = {}
            orphan_sources: dict[RecordType, dict[str, dict[str, bool]]] = {}
            # Disk walks (records-root iterdir, per-type dir enumeration) run
            # in the thread pool — same off-loop discipline as the probe chunks.
            orphan_filter_types = await asyncio.to_thread(
                self._resolve_orphan_filter_types, opts.types,
            )
            # Both materializations feed the candidate set (per the DEFINITION
            # above): record homes on disk, plus DB rows — a row whose shadow
            # dir was never created (or already removed) would otherwise be
            # invisible to the sweep forever. One lean SELECT per type.
            disk_ids_per_type = await asyncio.to_thread(
                self._discover_records_dir_ids, orphan_filter_types,
            )
            db_rows_known = hasattr(driver, "list_entity_sources_by_type")
            db_rows_per_type: dict[str, dict[str, tuple]] = {}
            if db_rows_known:
                for type_name in orphan_filter_types:
                    db_rows_per_type[type_name] = await driver.list_entity_sources_by_type(type_name)

            for type_name in orphan_filter_types:
                try:
                    rt = RecordType(type_name)
                except ValueError:
                    continue

                disk_ids = disk_ids_per_type.get(type_name, set())
                db_rows = db_rows_per_type.get(type_name, {})
                seen = seen_ids.get(rt, set())
                # DB-only candidates per ``_db_missing_orphans`` (strict orphan
                # definition). Stat-per-row work — off the loop with the other
                # disk probes.
                db_missing = await asyncio.to_thread(
                    _db_missing_orphans, db_rows, seen, disk_ids,
                )
                missing = sorted((disk_ids - seen) | db_missing)
                if not missing:
                    continue

                if opts.scope_filter is not None:
                    # Reads each disk orphan's metadata.json — file I/O, keep
                    # it off the loop.
                    missing = await asyncio.to_thread(
                        _scope_filtered_orphans,
                        opts.scope_filter, type_name, missing, disk_ids, db_rows,
                    )
                    if not missing:
                        continue

                orphan_records[rt] = missing
                if db_rows_known:
                    orphan_sources[rt] = {
                        eid: {"in_db": eid in db_rows, "on_disk": eid in disk_ids}
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
                # Orphan-ness is the dynamic ``FSRecord.orphan`` (source gone) —
                # nothing to persist. Only an explicit IGNORE/DELETE sweep acts.
                db_removed = 0
                disk_removed = 0
                if effective_orphan_action != OrphanAction.INDEX:
                    db_removed, disk_removed = await self._apply_orphan_action(
                        rt, ids, effective_orphan_action,
                        id_sources=orphan_sources.get(rt),
                    )

                acc["orphans_db_removed"] = db_removed
                acc["orphans_disk_removed"] = disk_removed

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
        types: list[RecordType] | None,
    ) -> set[str]:
        """Decide which type names to check for orphans on this run.

        - If the caller passed ``types``, restrict to those.
        - Otherwise check every type that has a records dir on disk (the record
          homes are the authoritative set) — caller didn't filter so we sweep
          everything we can see.
        """
        # Constrain orphan detection to types the indexer actually walks.
        # Without this guard, runtime-only types like ``conversation``,
        # ``flow_message``, ``annotation``, ``compute_node``, ``invitation``
        # — all of which have DB rows but NO FSIndexer walker function —
        # would be flagged as orphan en masse (since ``seen_ids`` for them
        # is always empty). A subsequent IGNORE/DELETE sweep would wipe
        # them. This is data loss: those rows have no Layer 1 source, so
        # "source missing" doesn't apply.
        from flow_sdk.fs_store.indexer.builtin import INDEXABLE_TYPES  # noqa: PLC0415
        indexable = {str(t) for t in INDEXABLE_TYPES}

        if types:
            requested = {str(t) for t in types}
            # Intersect with INDEXABLE_TYPES so an explicit caller can't
            # accidentally enable orphan detection on a non-indexable type.
            return requested & indexable

        # Union of "types with DB rows" and "types with a records dir on disk"
        # so we never miss a records-dir orphan just because no DB row exists.
        # Then intersect with INDEXABLE_TYPES — see comment above.
        from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415

        result: set[str] = set()
        records_root = get_default_records_root()
        try:
            for child in records_root.iterdir():
                if child.is_dir():
                    result.add(child.name)
        except (FileNotFoundError, OSError):
            pass
        return result & indexable

    @staticmethod
    def _discover_records_dir_ids(type_names: set[str]) -> dict[str, set[str]]:
        """Walk ``<records_root>/<type>/`` for each type and return ``{type → {id}}``.

        IDs come from parsing the directory stem (``<type>-@<id>``). Folders
        that don't match the stem pattern are skipped — they aren't records.
        """
        from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
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
        from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
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
                # Type-scoped driver delete only. We deliberately do NOT go
                # through ``Entity.get_one(...).delete()`` here because that
                # path triggers relationship-cascade cleanup that can
                # unintentionally affect bootstrap-required rows (e.g.
                # deleting a "project" orphan via the typed-entity path can
                # ripple through membership relationships and unbind the
                # ``@local`` compute_node). Orphan sweeps want minimal,
                # type-scoped row removal — anything beyond FTS belongs in
                # the regular API delete path.
                try:
                    if hasattr(driver, "fts_delete"):
                        try:
                            await driver.fts_delete(eid)
                        except Exception:
                            pass
                    if await driver.delete_by_id(eid, type_name):
                        db_removed += 1
                except Exception as e:
                    import logging  # noqa: PLC0415
                    logging.debug(f"[FSIndexer] driver.delete_by_id for {type_name}:{eid}: {e}")

            if action == OrphanAction.DELETE and on_disk:
                try:
                    rec_dir = (
                        get_default_records_root() / type_name / record_stem(type_name, eid)
                    )
                    if rec_dir.exists():
                        import shutil  # noqa: PLC0415
                        # Recursive dir removal is file I/O — keep it off the loop.
                        await asyncio.to_thread(shutil.rmtree, rec_dir, ignore_errors=True)
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
        seen: set[tuple[str, RecordType | None, str | None]] = set()
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

        # Chunked DFS: process up to _SCAN_CHUNK_NODES sync-walker visits per
        # thread-pool roundtrip so per-call to_thread overhead doesn't pile up
        # over thousands of nodes. The event loop still runs between chunks
        # (~5x/s at typical walk speed) — that's where ``emit()`` lives.
        # Async walkers (rare; e.g. tests that register TranscriptIndexer)
        # are accumulated inside the chunk and awaited on the main loop after
        # the chunk returns.
        functions = self._functions

        # Type-gate the dispatcher: when opts.types is set, build the closure
        # of output types whose walk transitively produces a requested type
        # (reverse-BFS over the registration graph). A function whose
        # ``output_type`` isn't in that closure can be skipped without losing
        # records — e.g. ``project_folder_walker_fn`` (FOLDER) is skippable
        # when the caller only asked for CLAUDE_SESSION, since no chain leads
        # from FOLDER to CLAUDE_SESSION. Functions registered without an
        # ``output_type`` annotation disable the skip (legacy safe default).
        needed_output_types: set[RecordType] | None = None
        if opts.types is not None:
            needed_output_types = self._compute_needed_output_types(tuple(opts.types))

        def _process_chunk(
            max_nodes: int,
        ) -> tuple[list[tuple[FSRef, Any]], bool]:
            """One sync DFS chunk. Mutates ``stack``/``visited``/``seen``/
            ``per_type_counts`` in place. Returns (pending_async_calls,
            hit_limit) — the caller awaits each pending async walker on the
            main loop, then extends the stack from its children.
            """
            nonlocal current_rt
            pending: list[tuple[FSRef, Any]] = []
            processed = 0
            hit_limit = False
            while stack and processed < max_nodes:
                node = stack.pop()
                # Include json_path so multiple fragment records sharing one
                # source file (CLAUDE_HOOK / MCP_SERVER / PLUGIN — each a distinct
                # RFC-6901 pointer) are NOT collapsed. None for whole-file records,
                # so non-fragment dedup behaviour is unchanged.
                key = (node.path, node.record_type, node.json_path)
                if key in seen:
                    continue
                seen.add(key)
                visited.append(node)
                if opts.verbose:
                    print(f"[indexer] visit type={node.record_type} path={node.path}")
                if node.record_type is not None:
                    per_type_counts[node.record_type] = per_type_counts.get(node.record_type, 0) + 1
                    current_rt = node.record_type
                fns = functions.get(node.record_type, []) if node.record_type is not None else []
                for fn, out_type in fns:
                    if (
                        needed_output_types is not None
                        and out_type is not None
                        and out_type not in needed_output_types
                    ):
                        continue
                    if _is_async_walker(fn):
                        pending.append((node, fn))
                    else:
                        children = fn([node], opts)
                        stack.extend(reversed(children))
                if opts.limit is not None and len(visited) >= opts.limit:
                    hit_limit = True
                    break
                processed += 1
            return pending, hit_limit

        while stack:
            pending, hit_limit = await asyncio.to_thread(
                _process_chunk, _SCAN_CHUNK_NODES,
            )
            # Drain any async walkers seen inside the chunk on the main loop.
            for node, fn in pending:
                children = await fn([node], opts)
                stack.extend(reversed(children))
            await emit()
            if hit_limit:
                break

        current_rt = None
        if on_progress is not None:
            await on_progress(make_table(text="complete"))

        return visited



# reload-trigger 1778603346.7940538
