"""FSIndexer — DFS walker with type-registered handlers.

Uses the existing FSRef primitive (flow_sdk/fs_store/fs_ref/base.py) tagged
with a RecordType discriminator. See tests/unit/test_fs_store/test_basic_indexer.py
for the contract.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    """Lifecycle signal emitted by scan() / index()."""
    stage: str                   # "scan_start" | "type_complete" | "scan_end"
                                 # | "index_start" | "index_end"
                                 # | "type_start" | "type_progress"
    record_type: RecordType | None = None
    count: int = 0
    total_bytes: int = 0
    indexed: int = 0
    errors: int = 0
    duration_ms: float = 0.0
    sub_done: int = 0
    sub_total: int = 0


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


@dataclass(frozen=True, slots=True)
class PerTypeIndexResult:
    type: RecordType
    indexed: int
    errors: int
    duration_ms: float
    skipped: int = 0
    skipped: int = 0


@dataclass(slots=True)
class IndexResult:
    per_type: dict[RecordType, PerTypeIndexResult] = field(default_factory=dict)
    total_indexed: int = 0
    total_errors: int = 0
    duration_ms: float = 0.0


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

    async with await driver._get_session() as session:
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
        state_dir: Path,
        roots: list[FSRef] | None = None,
    ) -> None:
        self._state_dir: Path = state_dir
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
        from flow_sdk.db import get_db_driver

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

            # Skip-fresh: in-memory dict lookup, one stat(), no parse.
            # Bypassed when `opts.force` is set (hard refresh).
            rt_name = str(ref.record_type)
            last_ts = valid_map.get(rt_name, {}).get(info.record_cls.getId(ref))
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
                for rec in records:
                    await rec.sync_to_db(fts_batch=fts_batch, notify=False)
                acc["indexed"] += len(records)
            except Exception:
                acc["errors"] += 1
            acc["duration_ms"] += (time.perf_counter() - t_start) * 1000

            # Throttled sub_progress during a type.
            now = time.perf_counter()
            if now - seen_progress_at.get(ref.record_type, 0.0) >= _PROGRESS_THROTTLE_S:
                seen_progress_at[ref.record_type] = now
                await _emit_sub_progress(ref.record_type)

        # Emit one type_complete per unique type at the end (DFS interleaves
        # mean we can't know a type is "done" mid-loop without a second pass).
        for rt in per_type_counts.keys():
            await _emit_type_complete(rt)

        # Batch FTS commit
        if fts_batch:
            driver = get_db_driver()
            if hasattr(driver, "fts_upsert"):
                await driver.fts_upsert(fts_batch)

        # Build per-type result (events already emitted inline above).
        per_type: dict[RecordType, PerTypeIndexResult] = {}
        for rt, acc in per_type_counts.items():
            per_type[rt] = PerTypeIndexResult(
                type=rt,
                indexed=int(acc["indexed"]),
                errors=int(acc["errors"]),
                duration_ms=round(acc["duration_ms"], 2),
                skipped=int(acc.get("skipped", 0)),
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
        )

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
