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
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

from flow_sdk.fs_store.asset_occurrences import (
    StoredOccurrenceMap,
    resolve_asset_collisions,
    stored_asset_occurrences,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.progress_table import (
    PROGRESS_TEXT_COMPLETE,
    IndexProgressTable,
    TypeProgressRow,
)
from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd
from flow_sdk.fs_store.path_owners import PathOwnerIndex
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.server.search_filters import SCOPED_RECORD_TYPES, ScopeFilter

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
# (TypeInfo identity resolution + on-disk hash equality) is synchronous file
# I/O; batching it through one asyncio.to_thread call per chunk
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
    # Backward-compatible switch for same-path DB reconciliation. Duplicate
    # source assets are never rewritten: a live incumbent wins and every other
    # path with the same type+id is warned and skipped regardless of this flag.
    dedup_on_adopt: bool = True
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
    # Stale same-path duplicates removed (see the dupe sweep in index()):
    # pre-existing rows anchored to a walked file that resolved to a
    # different id this run and were claimed by nothing else.
    dupes_removed: int = 0
    duplicate_groups: int = 0
    duplicate_occurrences: int = 0


@dataclass(slots=True)
class IndexResult:
    per_type: dict[RecordType, PerTypeIndexResult] = field(default_factory=dict)
    total_indexed: int = 0
    total_errors: int = 0
    duration_ms: float = 0.0
    total_orphans_found: int = 0
    total_orphans_db_removed: int = 0
    total_orphans_disk_removed: int = 0
    total_dupes_removed: int = 0
    total_duplicate_groups: int = 0
    total_duplicate_occurrences: int = 0


class IndexerFunc(Protocol):
    # Walkers are typically sync — pure file I/O, no async resources — and
    # FSIndexer.scan() runs them via ``asyncio.to_thread`` so the gitignore-
    # aware DFS doesn't park the event loop for an entire indexer pass.
    # A walker that genuinely needs async (DB lookups, real HTTP) may instead
    # expose ``async def __call__``; scan() detects and awaits it directly.
    def __call__(self, nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]: ...


def _normalize_output_types(
    output_type: RecordType | Collection[RecordType] | None,
) -> frozenset[RecordType] | None:
    """Normalize public single/multi-output registration metadata."""
    if output_type is None:
        return None
    if isinstance(output_type, RecordType):
        return frozenset({output_type})
    return frozenset(output_type)


def _has_dispatch(info) -> bool:
    """True when *info* declares a ``from_disk_fn`` parser slot."""
    return info.from_disk_fn is not None


def ref_typeid(ref, owners: "PathOwnerIndex | None" = None) -> str | None:
    """Resolve a repo-asset FSRef to its ``<type>-<id>`` via the type's
    identity API. None when the ref is absent, isn't a repo asset, or has no id
    resolver. The single ref→typeid primitive shared by the enclosure-parent
    derivation (below) and the bundle's descendant collector.

    ``owners`` matters here: this resolves the PARENT folder asset, so minting
    would stamp a fresh capsule into a skill/task folder and fork it on the
    next walk. Callers with a preloaded owner map should pass it."""
    if ref is None or ref.record_type is None:
        return None
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    rtype = str(ref.record_type)
    if rtype not in SchemaRegistry.get_repo_types():
        return None
    info = SchemaRegistry.get(rtype)
    if info is None:
        return None
    try:
        rid = info.mint_entity_id(
            ref,
            owner_id=owners.owner_for(rtype, str(ref._path)) if owners is not None else None,
            derive=True,
            overwrite=True,
        )
    except Exception:
        return None
    return f"{rtype}-{rid}" if rid else None


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
    type_name: str,
    eid: str,
) -> tuple[str, str] | tuple[None, None]:
    """Return ``(scope, project_id)`` from a records-dir orphan's metadata.json.

    The record home (shadow dir) is the source of truth for an orphan's
    provenance. Returns ``(None, None)`` when the file is missing / unreadable
    / non-dict — caller treats that as "unknown provenance" and refuses to
    match a narrowing filter (safer for DELETE: corrupt metadata can't bleed
    cross-scope).
    """
    import json  # noqa: PLC0415

    from flow_sdk.fs_store.record_paths import shadow_dir_for  # noqa: PLC0415

    _META_JSON = "metadata.json"

    path = shadow_dir_for(type_name, eid) / _META_JSON
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


def _empty_scope_keeps(type_name: str) -> bool:
    """Whether an empty/None-scope row of ``type_name`` survives a scope filter.

    Single source of truth shared by the disk- and DB-orphan predicates, mirroring
    the search scope clause (``sqlite_driver._scope_sql_clause``): an empty-scope
    row of a SCOPED record type can never be surfaced under a user/project filter,
    so a narrowing DELETE must NOT reap it either — otherwise an unscoped orphan
    bleeds across into a project-scoped sweep. Non-scoped record types keep the
    always-match behaviour.
    """
    return type_name not in SCOPED_RECORD_TYPES


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
    # Genuinely-empty scope (scope == "" or other falsy).
    return _empty_scope_keeps(type_name)


def _same_path_dupe_groups(
    existing_db_paths: dict[str, dict[str, str]],
) -> dict[str, dict[str, set[str]]]:
    """``{type: {canonical_path: {id, ...}}}`` for paths claimed by ≥2 DB rows.

    Input is the skip-fresh preload (``{type: {id: asset_ref}}``). Grouping is
    on the RAW stored path first, so ``canonical_posix_path`` (a per-path
    ``resolve()`` syscall chain) runs only for the rare already-duplicated
    groups — never per row.
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    out: dict[str, dict[str, set[str]]] = {}
    for tname, by_id in existing_db_paths.items():
        groups: dict[str, set[str]] = {}
        for rid, src in by_id.items():
            groups.setdefault(src, set()).add(rid)
        for src, rids in groups.items():
            if len(rids) < 2:
                continue
            try:
                key = canonical_posix_path(src)
            except (OSError, ValueError):
                continue
            out.setdefault(tname, {}).setdefault(key, set()).update(rids)
    return out


def _db_missing_orphans(
    db_rows: dict[str, tuple],
    seen: set[str],
    disk_ids: set[str],
) -> set[str]:
    """DB-row orphan candidates among ``db_rows``.

    Obeys the strict orphan definition (``FSRecord.orphan``): a DECLARED
    source (asset_ref) that no longer exists. Rows without an asset_ref
    aren't file-backed → never orphan. Rows under an UNREACHABLE root (an
    unmounted volume) are excluded too — absence there is not deletion. Rows
    whose asset_ref still exists are
    alive even when the walk derived a different id for that file (e.g. an
    API-minted v4 row beside a path-minted v5 twin) — id-set arithmetic alone
    would misclassify those as orphan. Stat-per-row — callers run this
    off-loop via ``asyncio.to_thread``.
    """
    from flow_sdk.fs_store.path_utils import source_unreachable  # noqa: PLC0415

    return {
        eid
        for eid, source in db_rows.items()
        if (aref := source[0] if source else None)
        and eid not in seen
        and eid not in disk_ids
        and not Path(str(aref)).exists()
        # An unreachable root is not a deletion — see ``source_unreachable``.
        and not source_unreachable(str(aref))
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
        # Index, never unpack: the row carries more columns than the three read
        # here (asset_ref, scope, project_id — occurrences/created_date follow),
        # and a fixed-arity unpack breaks the whole index run when it grows.
        row = db_rows[eid]
        scope, pid = row[1], row[2]
        if scope == "user":
            return sf.user
        if scope == "project":
            return str(pid or "") in sf_projects
        # Empty/None scope.
        return _empty_scope_keeps(type_name)

    return [
        eid for eid in missing if (_scope_filter_keeps(sf, type_name, eid) if eid in disk_ids else _db_row_keeps(eid))
    ]


class FSIndexer:
    def __init__(
        self,
        roots: list[FSRef] | None = None,
    ) -> None:
        self._roots: list[FSRef] = list(roots) if roots is not None else []
        # Each entry: (fn, output_types | None). ``None`` means the outputs are
        # unknown and disables pruning globally (legacy conservative fallback).
        self._functions: dict[
            RecordType,
            list[tuple[IndexerFunc, frozenset[RecordType] | None]],
        ] = {}

    def add_function(
        self,
        record_type: RecordType,
        fn: IndexerFunc,
        output_type: RecordType | Collection[RecordType] | None = None,
    ) -> None:
        """Register ``fn`` on input ``record_type``.

        ``output_type`` accepts one or many emitted ``RecordType`` values.
        ``None`` means "unknown" and conservatively disables pruning.
        """
        self._functions.setdefault(record_type, []).append(
            (fn, _normalize_output_types(output_type))
        )

    def add_root(self, node: FSRef) -> None:
        self._roots.append(node)

    def _compute_needed_output_types(self, requested: tuple[RecordType, ...]) -> set[RecordType] | None:
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
            for _fn, output_types in fns:
                if output_types is None:
                    any_unannotated = True
                    continue
                for t_out in output_types:
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

    async def index(self, opts: IndexerOptions | None = None) -> IndexResult:
        """Discover -> parse -> persist pipeline.

        Always runs a full scan; when `opts.types` is set, only FSRefs of
        those types get parsed via `Record.from_fsref` and written to DB.

        Progress is reported as ``IndexProgressTable`` snapshots: first the
        inner scan's discovery snapshots forwarded as-is (``job_name="scan"``,
        totals unknown), then an initial index snapshot with totals known and
        ``done=0``, throttled updates at ~5/s as records are processed, and a
        terminal snapshot with ``text=PROGRESS_TEXT_COMPLETE`` and
        ``current=None`` — the run's only completion signal.
        """
        opts = opts if opts is not None else IndexerOptions()
        t0 = time.perf_counter()
        on_progress = opts.on_progress

        # Discovery drives the SAME activity: forward the scan's per-type
        # snapshots (counts ticking up, totals unknown) so the UI renders the
        # by-type table immediately instead of staring at a frozen pill for the
        # whole walk. Drop scan's terminal "complete" event — the activity is
        # only done after the per-record index loop below, not after discovery —
        # otherwise InProcessActivity.is_complete would latch on scan's
        # text="complete" and the run would look finished before it indexed a
        # single record.
        async def _forward_scan(table: IndexProgressTable) -> None:
            if table.text == PROGRESS_TEXT_COMPLETE:
                return
            await on_progress(table)

        scan_opts = IndexerOptions(
            verbose=opts.verbose,
            limit=opts.limit,
            limit_per_type=opts.limit_per_type,
            include_temp=opts.include_temp,
            types=opts.types,
            # None when nobody listens — lets scan skip building tables at all.
            on_progress=_forward_scan if on_progress is not None else None,
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
        from flow_sdk.db import get_db_driver
        from flow_sdk.db import session as _db_session
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

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
                "indexed": 0,
                "errors": 0,
                "duration_ms": 0.0,
                "skipped": 0,
                "orphans_found": 0,
                "orphans_db_removed": 0,
                "orphans_disk_removed": 0,
                "orphan_ids": [],
                "dupes_removed": 0,
                "duplicate_groups": 0,
                "duplicate_occurrences": 0,
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
                rows.append(
                    TypeProgressRow(
                        type_name=str(rt),
                        done=done,
                        total=total,
                        errors=int(acc["errors"]),
                        skipped=int(acc["skipped"]),
                    )
                )
            rows.sort(key=lambda r: -r.total)
            current_name = (
                str(current_rt) if current_rt is not None and current_rt not in _PROGRESS_HIDDEN_TYPES else None
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
        # Sentinels to stamp once the current batch COMMITS. write_hash() is a
        # non-transactional fs write — stamping it before the deferred commit
        # strands a fresh sentinel over an uncommitted row on a mid-batch crash,
        # and skip-fresh then trusts it forever. Queue here, stamp post-commit.
        _pending_hashes: list[FSRecord] = []
        driver = get_db_driver()

        # Skip-fresh must require the DB row to exist — not just a matching
        # on-disk ``.hash`` sentinel. A sentinel outlives its row (a DB
        # clear/rebuild drops rows but leaves the shadow store), so trusting
        # the sentinel alone makes the indexer skip re-creating a missing row
        # forever ("only 3 of 589 markdowns show"). Pre-load the set of
        # existing entity ids per dispatchable type — one lean SELECT each —
        # and gate freshness on membership. An empty ``existing_db_ids`` means
        # "couldn't enumerate" → fall back to sentinel-only (prior behaviour).
        existing_db_ids: dict[str, set[str]] = {}
        # ``{type: {id: asset_ref}}`` — the incumbent path an id already lives at.
        # Powers dedup-on-adopt (move vs copy). Same lean SELECT as the id set.
        existing_db_paths: dict[str, dict[str, str]] = {}
        stored_occurrences = StoredOccurrenceMap()
        if hasattr(driver, "list_entity_sources_by_type"):
            try:
                for rt in per_type_totals:
                    rows = await driver.list_entity_sources_by_type(str(rt))
                    existing_db_ids[str(rt)] = set(rows.keys())
                    existing_db_paths[str(rt)] = {rid: src[0] for rid, src in rows.items() if src and src[0]}
                    type_occurrences = stored_asset_occurrences(str(rt), rows)
                    stored_occurrences.update(type_occurrences)
                    stored_occurrences.synthetic_keys.update(getattr(type_occurrences, "synthetic_keys", ()))
            except Exception:
                logging.warning(
                    "[FSIndexer] could not preload DB ids for skip-fresh row check; "
                    "falling back to sentinel-only freshness",
                    exc_info=True,
                )
                existing_db_ids.clear()
                existing_db_paths.clear()
                stored_occurrences.clear()

        # Same-path reconciliation (the inverse of dedup-on-adopt, which handles
        # one id at two paths): paths already claimed by MORE THAN ONE row.
        # Classic cause: a wheel reinstall restores an invalid frontmatter id,
        # so each subsequent index mints a fresh id and inserts a new row — one
        # duplicate per install, and the orphan sweep never fires because the
        # source file still exists. When a walked file is parsed this run,
        # every other id anchored to its exact path becomes a removal
        # candidate; anything the walk claims elsewhere (``seen_ids``, e.g. a
        # MOVE's incumbent or a sibling fragment) is rescued before the sweep
        # below acts. Armed by ``opts.dedup_on_adopt`` — both sides of the same
        # id⇄path reconciliation policy.
        dupe_ids_by_path = _same_path_dupe_groups(existing_db_paths) if opts.dedup_on_adopt else {}
        stale_dupe_candidates: dict[RecordType, set[str]] = {}

        # Who already owns each walked path. Built from the SAME preload as the
        # freshness/dedup maps above — no extra query — and empty when the
        # preload failed, in which case identity degrades to the historic
        # carrier-or-mint behaviour rather than silently adopting a wrong row.
        path_owners = PathOwnerIndex.from_preload(existing_db_paths)
        # Only a preload that HELD rows yet yielded no owners is a problem — a
        # first index legitimately has type keys with no rows behind them.
        if any(existing_db_paths.values()) and not path_owners:
            logging.warning(
                "[FSIndexer] preloaded %d row(s) but resolved no path owners; "
                "a source whose identity carrier was wiped will mint a NEW id and fork its entity",
                sum(len(v) for v in existing_db_paths.values()),
            )

        # Deepest-project-wins association: snapshot (canonical_mount, id) for
        # every project once per run. With NESTED project mounts (an umbrella
        # workspace folder that is itself a Project), the outer root's walk
        # reaches the inner project's files too — chain-inherited project_id
        # would stamp them with the umbrella. The snapshot lets the stamp site
        # re-associate each record to the innermost mount containing its path.
        from flow_sdk.fs_store.indexer.roots import (  # noqa: PLC0415
            deepest_project_id_for_path,
            has_nested_project_mounts,
            load_project_mounts,
        )
        from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

        project_mounts = await load_project_mounts()
        # No nesting anywhere → every walk root's own project is already the
        # deepest containing mount, so drop the snapshot and let the stamp
        # site stay a straight chain-inherit (no per-record realpath).
        if not has_nested_project_mounts(project_mounts):
            project_mounts = ()

        async def _flush_fts() -> None:
            """Flush the accumulated FTS batch (if any) and reset it."""
            if not fts_batch:
                return
            if hasattr(driver, "fts_upsert"):
                await driver.fts_upsert(fts_batch)
            fts_batch.clear()

        async def _commit_batch() -> None:
            """Flush FTS, commit, THEN stamp the batch's ``.hash`` sentinels.

            Single home for the write-ahead invariant: a sentinel is written
            only after its row is durably committed, so a crash before commit
            leaves no sentinel (skip-fresh re-indexes next run). Every commit
            site must go through here — never stamp ``_pending_hashes`` ad hoc.
            """
            await _flush_fts()
            await _idx_session.commit()
            for pr in _pending_hashes:
                pr.write_hash()
            _pending_hashes.clear()

        def _probe_chunk(
            items: list[tuple[FSRef, Any]],
        ) -> list[tuple[FSRef, Any, str | None, FSRecord | None, bool, str]]:
            """Resolve one authoritative ID and freshness-probe each asset.

            Identity failures are returned with ``ref_id=None`` and handled as
            index errors by the async loop. No fallback ID may bypass TypeInfo.
            """
            out: list[tuple[FSRef, Any, str | None, FSRecord | None, bool, str]] = []
            for ref, info in items:
                canon_path = canonical_posix_path(str(ref._path))
                try:
                    # Owner-first identity: a source whose capsule was wiped by a
                    # full-content rewrite is NOT a new asset. Minting here forks
                    # the entity and the same-path sweep below then reaps the row
                    # every reference points at. ``path_owners`` comes from the
                    # preload above, so this costs no extra query.
                    ref_id = info.mint_entity_id(
                        ref,
                        owner_id=path_owners.owner_for(str(ref.record_type), str(ref._path), canon_path),
                        live_ids=existing_db_ids.get(str(ref.record_type)),
                        derive=True,
                        overwrite=True,
                    )
                    probe = FSRecord(type=str(ref.record_type), id=ref_id, asset_ref=ref)
                    # Skip-fresh: on-disk ``.hash`` equality AND a live DB row.
                    # The probe reads its own sentinel (shadow home) and the
                    # source's current hash via `get_hash`; ``row_present`` adds
                    # the requirement that the entity row still exists, so a
                    # stale sentinel left by a DB clear/rebuild can't mask a
                    # missing row. `opts.force` (Full mode) bypasses all of it.
                    # ``existing_db_ids`` is the pre-loaded id set per type;
                    # empty means it couldn't be enumerated → sentinel-only.
                    row_present = not existing_db_ids or ref_id in existing_db_ids.get(str(ref.record_type), ())
                    fresh = bool(ref_id) and not opts.force and not probe.index_required and row_present
                except Exception as e:
                    logging.warning(
                        "[FSIndexer] identity probe failed for %s (%s): %r",
                        ref._path,
                        ref.record_type,
                        e,
                    )
                    ref_id = None
                    probe = None
                    fresh = False
                out.append((ref, info, ref_id, probe, fresh, canon_path))
            return out

        # Probe the complete candidate set before parsing so a no-incumbent
        # duplicate has a deterministic winner independent of DFS/chunk order.
        all_probed: list[tuple[FSRef, Any, str | None, FSRecord | None, bool, str]] = []
        for chunk_start in range(0, len(dispatchable), _PROBE_CHUNK_REFS):
            chunk = dispatchable[chunk_start : chunk_start + _PROBE_CHUNK_REFS]
            all_probed.extend(await asyncio.to_thread(_probe_chunk, chunk))

        def _resolve_occurrences():
            from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
            from flow_sdk.utils.git import git_asset_introduction  # noqa: PLC0415

            stored_identities: dict[str, tuple[str, str, str]] = {}
            for (type_name, entity_id), occurrences in stored_occurrences.items():
                info = SchemaRegistry.get(type_name)
                if info is None:
                    continue
                for occurrence in occurrences:
                    try:
                        path = occurrence.path
                        if not Path(path).exists():
                            continue
                        rid = info.mint_entity_id(FSRef(path, record_type=RecordType(type_name)))
                        if rid == entity_id:
                            stored_identities[path] = (type_name, entity_id, path)
                    except Exception:
                        continue

            def identity(candidate):
                if isinstance(candidate, str):
                    return stored_identities.get(canonical_posix_path(candidate))
                ref, _info, ref_id, _probe, _fresh, canon_path = candidate
                if ref_id is None:
                    return None
                return (str(ref.record_type), ref_id, canon_path)

            return resolve_asset_collisions(
                all_probed,
                stored_occurrences,
                identity,
                git_asset_introduction,
                datetime.now(timezone.utc),
            )

        collision_decisions = await asyncio.to_thread(_resolve_occurrences)
        collision_by_key = {(item.type_name, item.entity_id): item for item in collision_decisions}
        duplicate_paths = {
            (item.type_name, item.entity_id, path) for item in collision_decisions for path in item.duplicate_paths
        }
        primary_swaps = {
            (item.type_name, item.entity_id, item.primary_path)
            for item in collision_decisions
            if item.primary_path is not None
            and stored_occurrences.get((item.type_name, item.entity_id))
            and stored_occurrences[(item.type_name, item.entity_id)][0].path != item.primary_path
        }
        for item in collision_decisions:
            if not item.duplicate_paths:
                continue
            rt = RecordType(item.type_name)
            acc = per_type_counts[rt]
            acc["duplicate_groups"] += 1
            acc["duplicate_occurrences"] += len(item.duplicate_paths)
            logging.warning(
                "[asset-id] duplicate asset id; type=%s id=%s kept=%s skipped=%s",
                item.type_name,
                item.entity_id,
                item.primary_path,
                ",".join(item.duplicate_paths),
            )

        async with _db_session() as _idx_session:
            for ref, info, ref_id, probe, fresh, canon_path in all_probed:
                current_rt = ref.record_type
                acc = per_type_counts[ref.record_type]
                # Start the per-type clock at the TOP of the ref, not after the
                # skip branches. `t_start` used to be set only on the parse
                # path, so a type whose refs were all fresh-skipped reported
                # duration_ms=0.0 even though enumerating and hash-checking
                # them cost real time — measured on a live backend: 25 of 30
                # type rows at 0.0, and the 5 non-zero rows summed to 11.4s of
                # a 19.6s request. Every exit below accumulates.
                t_ref = time.perf_counter()

                # Per-type cap: once we've processed `limit_per_type` records of
                # this type (parsed or skip-fresh), skip further refs of the same
                # type. ``done`` in the progress table is ``indexed + skipped``,
                # so the cap must include both to keep ``done <= limit_per_type``.
                # (The probe already ran for capped refs; identity resolution
                # is idempotent and the hash check has no side effects.)
                if opts.limit_per_type is not None and (acc["indexed"] + acc["skipped"]) >= opts.limit_per_type:
                    continue

                if ref_id is None or probe is None:
                    acc["errors"] += 1
                    acc["duration_ms"] += (time.perf_counter() - t_ref) * 1000
                    await emit()
                    continue

                # Track this id as "seen" before any skip/index decision so the
                # orphan check post-loop won't false-positive a fresh-skip as
                # missing.
                if ref_id:
                    seen_ids.setdefault(ref.record_type, set()).add(ref_id)

                if (str(ref.record_type), ref_id, canon_path) in duplicate_paths:
                    acc["skipped"] += 1
                    acc["duration_ms"] += (time.perf_counter() - t_ref) * 1000
                    await emit()
                    continue

                if fresh and (str(ref.record_type), ref_id, canon_path) not in primary_swaps:
                    acc["skipped"] += 1
                    acc["duration_ms"] += (time.perf_counter() - t_ref) * 1000
                    # seen_ids already holds ref_id (added above), so a fresh
                    # skip is not misclassified as orphan.
                    await emit()
                    continue

                t_start = t_ref
                try:
                    # Loop is gated by _has_dispatch → from_disk_fn is set.
                    from_disk = info.from_disk_fn
                    if asyncio.iscoroutinefunction(from_disk):
                        records = await from_disk(ref, ref_id)
                    else:
                        records = await asyncio.to_thread(from_disk, ref, ref_id)
                    # Walk-time scope/project_id from the FSRef parent-chain.
                    # Loop-invariant — read once, stamp on each record.
                    ref_scope = ref.scope
                    ref_pid = ref.project_id
                    if ref_pid is not None and project_mounts:
                        # Association rule: deepest project wins. The walk
                        # root's project may be an umbrella containing a
                        # nested project — re-associate to the innermost
                        # mount that contains this record's path.
                        try:
                            ref_pid = deepest_project_id_for_path(
                                canonical_posix_path(str(ref._path)),
                                project_mounts,
                                default=ref_pid,
                            )
                        except OSError:
                            pass
                    # Enclosure-derived parenthood: a repo asset physically
                    # nested inside another repo asset's folder inherits it as
                    # its parent, so a child re-indexed purely from disk (e.g.
                    # received without an ``entities.json`` envelope) is still
                    # parented. Loop-invariant — derive once from the FSRef
                    # parent chain. Only when the enclosing ref is itself a
                    # repo asset (not the walk root).
                    parent_typeid = ref_typeid(getattr(ref, "_parent", None), path_owners)
                    for rec in records:
                        if ref_scope is not None:
                            object.__setattr__(rec, "scope", ref_scope)
                        if parent_typeid and not getattr(rec, "parent_type_id", None):
                            object.__setattr__(rec, "parent_type_id", parent_typeid)
                        if ref_pid is not None:
                            object.__setattr__(rec, "project_id", ref_pid)
                        elif not getattr(rec, "project_id", None) and (
                            # No project-scoped ancestor in the FSRef chain
                            # (e.g. codex/copilot sessions expanded under
                            # USER_HOME_FOLDER, received transcripts). If the
                            # record names a cwd, resolve its owning project
                            # so it scopes + yields a project tab like a
                            # locally-indexed claude session does.
                            cwd_pid := resolve_project_id_for_cwd(getattr(rec, "cwd", None))
                        ):
                            object.__setattr__(rec, "project_id", cwd_pid)
                        await rec.sync_to_db(fts_batch=fts_batch, notify=False)
                    acc["indexed"] += len(records)
                    # Same-path reconciliation: a successful parse enumerates
                    # the file's COMPLETE record set (all landed in seen_ids
                    # just above), so any other pre-existing id anchored to
                    # this exact path is a stale-duplicate candidate. Only
                    # parsed refs nominate — a fresh-skip or per-type-cap
                    # skip doesn't prove the file's full id set.
                    if canon_path is not None and (
                        prior := dupe_ids_by_path.get(str(ref.record_type), {}).get(canon_path)
                    ):
                        stale_dupe_candidates.setdefault(ref.record_type, set()).update(prior)
                    # Stamp the sentinel only on a successful parse+sync (a
                    # failed parse stays index_required and is retried) AND
                    # only after the row commits — defer to the post-commit
                    # stamp below so a crash before commit leaves no sentinel.
                    _pending_hashes.append(probe)
                except Exception:
                    acc["errors"] += 1
                    # Make failures observable, but cap the full traceback to
                    # the first few per type so a pathological tree (thousands
                    # of unparseable files) can't flood the log; the one-line
                    # warning still counts every failure.
                    logging.warning(
                        "indexer: failed to index %s (%s)",
                        getattr(ref, "path", ref),
                        ref.record_type,
                        exc_info=acc["errors"] <= 5,
                    )
                acc["duration_ms"] += (time.perf_counter() - t_start) * 1000

                await emit()

                # Bounded-batch commit: flush this batch's FTS then commit the
                # session, releasing the writer lock so concurrent requests
                # aren't starved (see batch rationale above the loop).
                _since_commit += 1
                if _since_commit >= _INDEX_COMMIT_BATCH:
                    await _commit_batch()
                    _since_commit = 0

            # Commit + stamp the trailing partial batch (records since the last
            # bounded-batch commit). The commit was implicit on session exit
            # before; _commit_batch makes it explicit so the trailing batch's
            # sentinels are stamped under the same write-ahead ordering.
            await _commit_batch()

            # Reflect the complete collision view only after all primaries have
            # been parsed/skipped, so a newly-created row is available too.
            for (type_name, entity_id), decision in collision_by_key.items():
                if not decision.changed:
                    continue
                entity = await driver.get_by_id(entity_id, type_name)
                if entity is not None and hasattr(entity, "reflect_asset_occurrences"):
                    await entity.reflect_asset_occurrences(
                        decision.occurrences,
                        notify=True,
                    )

        # The writer session ends above, before the potentially long orphan
        # discovery below. Discovery is read-only and may walk every record
        # home/type even for an empty project; keeping BEGIN IMMEDIATE open
        # across it starves unrelated control-plane writes (tab close, process
        # create) until the whole index finishes. Duplicate/orphan removals
        # still open their own short writer sessions through the driver.
        #
        # Phase marker before the (potentially long) orphan sweep: without
        # it the last loop snapshot (done==total, no text) is what watchers
        # and refresh-time activity-status replay see for the whole sweep —
        # a stalled-looking 100% bar. Any non-complete text works; the
        # activity stays alive until the terminal emit below.
        await emit(text="sweeping", force=True)

        # ----- Same-path duplicate sweep -----
        # Positive-evidence cleanup, independent of ``orphan_action``: each
        # candidate's path was walked AND parsed this run and resolved to a
        # different id, so a candidate that nothing else claimed
        # (``seen_ids`` is global for the run) is an unreachable duplicate
        # row. Remove row + FTS + records dir via the same machinery as an
        # orphan DELETE. The source file is never touched — it belongs to
        # the surviving id.
        for rt, cands in stale_dupe_candidates.items():
            stale = sorted(cands - seen_ids.get(rt, set()))
            if not stale:
                continue
            db_removed, _ = await self._apply_orphan_action(
                rt,
                stale,
                OrphanAction.DELETE,
            )
            # rt was necessarily indexed via per_type_counts[rt] when the
            # parse loop nominated its candidates — always present.
            per_type_counts[rt]["dupes_removed"] += db_removed
            logging.info(
                "[FSIndexer] removed %d stale same-path duplicate row(s) for %s: %s",
                db_removed,
                rt,
                stale,
            )

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
        # reported and acted on. The callers wiring this on top MUST walk
        # every source — the all-projects root set (USER_HOME + one
        # REAL_PROJECT_CWD per project), NOT default_roots() — so
        # ``seen_ids`` is global; otherwise records under a project tree
        # that wasn't walked would falsely appear orphan. (See the
        # ``orphan_action != INDEX`` branch in fs_records_actions.index.)
        #
        # SAFETY GUARD: a destructive orphan_action with a narrowed walk
        # (custom roots) and no scope_filter would silently wipe records
        # referenced from outside the walked subtree. Refuse — fall back
        # to INDEX (non-destructive) and emit a warning. The caller's
        # ScopeFilter-aware wrapper is responsible for either widening the
        # walk to global or supplying a scope_filter.
        effective_orphan_action = opts.orphan_action
        if effective_orphan_action != OrphanAction.INDEX and opts.roots is not None and opts.scope_filter is None:
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
            self._resolve_orphan_filter_types,
            opts.types,
        )
        # Both materializations feed the candidate set (per the DEFINITION
        # above): record homes on disk, plus DB rows — a row whose shadow
        # dir was never created (or already removed) would otherwise be
        # invisible to the sweep forever. One lean SELECT per type.
        disk_ids_per_type = await asyncio.to_thread(
            self._discover_records_dir_ids,
            orphan_filter_types,
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
                _db_missing_orphans,
                db_rows,
                seen,
                disk_ids,
            )
            missing = sorted((disk_ids - seen) | db_missing)
            if not missing:
                continue

            if opts.scope_filter is not None:
                # Reads each disk orphan's metadata.json — file I/O, keep
                # it off the loop.
                missing = await asyncio.to_thread(
                    _scope_filtered_orphans,
                    opts.scope_filter,
                    type_name,
                    missing,
                    disk_ids,
                    db_rows,
                )
                if not missing:
                    continue

            orphan_records[rt] = missing
            if db_rows_known:
                orphan_sources[rt] = {eid: {"in_db": eid in db_rows, "on_disk": eid in disk_ids} for eid in missing}

        for rt, ids in orphan_records.items():
            acc = per_type_counts.setdefault(
                rt,
                {
                    "indexed": 0,
                    "errors": 0,
                    "duration_ms": 0.0,
                    "skipped": 0,
                    "orphans_found": 0,
                    "orphans_db_removed": 0,
                    "orphans_disk_removed": 0,
                    "orphan_ids": [],
                    "dupes_removed": 0,
                    "duplicate_groups": 0,
                    "duplicate_occurrences": 0,
                },
            )
            acc["orphans_found"] = len(ids)
            acc["orphan_ids"] = list(ids)
            # Orphan-ness is the dynamic ``FSRecord.orphan`` (source gone) —
            # nothing to persist. Only an explicit IGNORE/DELETE sweep acts.
            db_removed = 0
            disk_removed = 0
            if effective_orphan_action != OrphanAction.INDEX:
                db_removed, disk_removed = await self._apply_orphan_action(
                    rt,
                    ids,
                    effective_orphan_action,
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
                dupes_removed=int(acc.get("dupes_removed", 0)),
                duplicate_groups=int(acc.get("duplicate_groups", 0)),
                duplicate_occurrences=int(acc.get("duplicate_occurrences", 0)),
            )

        duration = (time.perf_counter() - t0) * 1000

        # Terminal snapshot — current=None, text=PROGRESS_TEXT_COMPLETE. The
        # authoritative (and only) completion signal; consumers clear UI state
        # and InProcessActivity.is_complete latches on it.
        current_rt = None
        if on_progress is not None:
            await on_progress(make_table(text=PROGRESS_TEXT_COMPLETE))

        return IndexResult(
            per_type=per_type,
            total_indexed=sum(p.indexed for p in per_type.values()),
            total_errors=sum(p.errors for p in per_type.values()),
            duration_ms=duration,
            total_orphans_found=sum(p.orphans_found for p in per_type.values()),
            total_orphans_db_removed=sum(p.orphans_db_removed for p in per_type.values()),
            total_orphans_disk_removed=sum(p.orphans_disk_removed for p in per_type.values()),
            total_dupes_removed=sum(p.dupes_removed for p in per_type.values()),
            total_duplicate_groups=sum(p.duplicate_groups for p in per_type.values()),
            total_duplicate_occurrences=sum(p.duplicate_occurrences for p in per_type.values()),
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

        The id is the bare directory name under ``records_root/<type>/``; a folder
        is a record iff it holds a ``metadata.json``. Other folders are skipped.
        """
        from flow_sdk.fs_store.record_paths import (  # noqa: PLC0415
            get_default_records_root,
            is_record_dir,
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
                    if is_record_dir(entry):
                        ids.add(entry.name)
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
        from flow_sdk.fs_store.record_paths import shadow_dir_for  # noqa: PLC0415

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
                    rec_dir = shadow_dir_for(type_name, eid)
                    if rec_dir.exists():
                        import shutil  # noqa: PLC0415

                        # Recursive dir removal is file I/O — keep it off the loop.
                        await asyncio.to_thread(shutil.rmtree, rec_dir, ignore_errors=True)
                        disk_removed += 1
                except Exception:
                    pass

        return db_removed, disk_removed

    async def scan(self, opts: IndexerOptions | None = None) -> list[FSRef]:
        """DFS over registered FSRef nodes.

        Progress is reported as ``IndexProgressTable`` snapshots with
        ``total=0`` (unknown — discovery IS the count). Each visited
        node increments its type's row; the table is re-broadcast at most
        every 200 ms. Final snapshot has ``current=None`` and
        ``text=PROGRESS_TEXT_COMPLETE``.
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
                # total=0: during discovery the per-type total is unknown — the
                # running count IS the total-so-far — so the UI shows a growing
                # count with no percentage, consistent with the table-level
                # total=0 below. Locked-in totals (done/total + %) arrive once
                # index() enters its per-record loop.
                TypeProgressRow(type_name=str(rt), done=count, total=0)
                for rt, count in per_type_counts.items()
                if rt not in _PROGRESS_HIDDEN_TYPES
            ]
            rows.sort(key=lambda r: -r.done)
            current_name = (
                str(current_rt) if current_rt is not None and current_rt not in _PROGRESS_HIDDEN_TYPES else None
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
                    logging.debug("[indexer] visit type=%s path=%s", node.record_type, node.path)
                if node.record_type is not None:
                    per_type_counts[node.record_type] = per_type_counts.get(node.record_type, 0) + 1
                    current_rt = node.record_type
                fns = functions.get(node.record_type, []) if node.record_type is not None else []
                for fn, output_types in fns:
                    if (
                        needed_output_types is not None
                        and output_types is not None
                        and not output_types.intersection(needed_output_types)
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
                _process_chunk,
                _SCAN_CHUNK_NODES,
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
            await on_progress(make_table(text=PROGRESS_TEXT_COMPLETE))

        return visited


# reload-trigger 1778603346.7940538
