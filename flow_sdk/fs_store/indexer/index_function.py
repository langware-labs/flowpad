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
    record_type: RecordType | None = None
    count: int = 0
    total_bytes: int = 0
    indexed: int = 0
    errors: int = 0
    duration_ms: float = 0.0


ProgressCallback = Callable[[ProgressEvent], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class IndexerOptions:
    verbose: bool = True
    limit: int | None = None
    include_temp: bool = False  # walk temp-path projects (/tmp, /var/folders, …)
    types: list[RecordType] | None = None  # index() filter; None = all types
    on_progress: ProgressCallback | None = None


@dataclass(frozen=True, slots=True)
class PerTypeIndexResult:
    type: RecordType
    indexed: int
    errors: int
    duration_ms: float


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

        if opts.on_progress is not None:
            await opts.on_progress(ProgressEvent(stage="index_start"))

        refs = await self.scan(opts)

        if opts.types is None:
            targets = refs
        else:
            target_set = set(opts.types)
            targets = [r for r in refs if r.record_type in target_set]

        # Imports localized to break cycles
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        from flow_sdk.db import get_db_driver

        per_type_counts: dict[RecordType, dict[str, float]] = {}
        seen_types: set[RecordType] = set()
        fts_batch: list = []
        for ref in targets:
            if ref.record_type is None:
                continue
            # Emit type_complete once we transition past a type boundary.
            # (Not strictly per-type-ordered since DFS interleaves, but a
            # reasonable approximation — most types are contiguous in scan
            # order due to how claude_projects_fn emits PROJECT nodes first.)
            info = SchemaRegistry.get(str(ref.record_type))
            if info is None or info.record_cls is None:
                continue
            if not hasattr(info.record_cls, "from_fsref"):
                continue

            acc = per_type_counts.setdefault(
                ref.record_type, {"indexed": 0, "errors": 0, "duration_ms": 0.0}
            )
            t_start = time.perf_counter()
            try:
                records = await info.record_cls.from_fsref(ref)
                for rec in records:
                    await rec.sync_to_db(fts_batch=fts_batch, notify=False)
                acc["indexed"] += len(records)
            except Exception:
                acc["errors"] += 1
            acc["duration_ms"] += (time.perf_counter() - t_start) * 1000

        # Batch FTS commit
        if fts_batch:
            driver = get_db_driver()
            if hasattr(driver, "fts_upsert"):
                await driver.fts_upsert(fts_batch)

        # Build per-type result + emit type_complete per type
        per_type: dict[RecordType, PerTypeIndexResult] = {}
        for rt, acc in per_type_counts.items():
            pt = PerTypeIndexResult(
                type=rt,
                indexed=int(acc["indexed"]),
                errors=int(acc["errors"]),
                duration_ms=round(acc["duration_ms"], 2),
            )
            per_type[rt] = pt
            if opts.on_progress is not None:
                await opts.on_progress(ProgressEvent(
                    stage="type_complete",
                    record_type=rt,
                    indexed=pt.indexed,
                    errors=pt.errors,
                    duration_ms=pt.duration_ms,
                ))

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

        stack: list[FSRef] = list(reversed(self._roots))
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
