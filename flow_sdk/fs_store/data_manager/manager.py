"""DataManager — explicit split-phase indexing pipeline.

Phases:
  1. scan()         — filesystem discovery → list[Record], no DB writes
  2. index_meta()   — write Entity rows to DB + hash sentinel files
  3. index_search() — write FTS entries to DB
  4. index_all()    — convenience wrapper: scan → index_meta → index_search

All SDK imports are lazy (inside methods) to avoid circular-import chains.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import time
from typing import TYPE_CHECKING

from .options import IndexAllOptions, IndexMetaOptions, IndexSearchOptions, ScanOptions
from .results import DiscoveryResult, IndexAllResult, IndexMetaResult, IndexSearchResult

if TYPE_CHECKING:
    pass  # type-only imports go here if needed

_DISCOVERY_WORKERS = 16
_BULK_THRESHOLD = 5


def _has_parallel_discovery(record_cls) -> bool:
    """Return True if record_cls provides parallel-discovery support."""
    from flow_sdk.fs_store.record import Record as _BaseRecord  # noqa: PLC0415
    has_custom_iter = (
        "discover_iter" in record_cls.__dict__
        or any(
            "discover_iter" in base.__dict__
            for base in record_cls.__mro__[1:]
            if base is not _BaseRecord and base is not object
            and "discover_iter" in base.__dict__
        )
    )
    return has_custom_iter and hasattr(record_cls, "discover_paths_iter")


def _discover_records_sync(record_cls, limit: int | None) -> list:
    """Blocking discovery — runs inside asyncio.to_thread()."""
    from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415
    from flow_sdk.fs_store.record import Record as _BaseRecord  # noqa: PLC0415

    has_custom_iter = (
        "discover_iter" in record_cls.__dict__
        or any(
            "discover_iter" in base.__dict__
            for base in record_cls.__mro__[1:]
            if base is not _BaseRecord and base is not object
            and "discover_iter" in base.__dict__
        )
    )

    if has_custom_iter:
        return list(record_cls.discover_iter(limit=limit))
    # Fallback: RecordList (no limit support)
    return list(RecordList(record_class=record_cls))


def _discover_parallel(record_cls, limit: int | None) -> list:
    """Parallel discovery via discover_paths_iter + ThreadPoolExecutor."""
    paths = list(record_cls.discover_paths_iter(limit=limit))
    if not paths:
        return []
    load_fn = getattr(record_cls, "from_jsonl", None)
    if load_fn is None:
        # No from_jsonl — fall back to sequential
        return list(record_cls.discover_iter(limit=limit))
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=_DISCOVERY_WORKERS) as pool:
        futures = [pool.submit(load_fn, p) for p in paths]
        for fut in concurrent.futures.as_completed(futures):
            try:
                records.append(fut.result())
            except Exception:
                pass
    return records


def _write_sentinel(rec) -> None:
    """Write hash sentinel for a record, bypassing read_only check."""
    try:
        rec.write_hash_file(rec.content_fingerprint)
    except Exception:
        pass


def _write_sentinels(entity_map: dict) -> None:
    """Write hash sentinel files for indexed records (sync, called via to_thread)."""
    for rec, _entity in entity_map.items():
        _write_sentinel(rec)


class DataManager:
    """Orchestrates filesystem discovery and DB indexing as explicit independent phases.

    Usage::

        dm = DataManager()
        result = await dm.scan(ScanOptions(types=["claude_session"], limit=100))
        await dm.index_meta(result.records)
        await dm.index_search(result.records)
        hits = await Entity.search("v0.2.3")
    """

    # -------------------------------------------------------------------------
    # Phase 1: Discovery
    # -------------------------------------------------------------------------

    async def scan(self, opts: ScanOptions | None = None) -> DiscoveryResult:
        """Discover records for the given types from the filesystem.

        No DB writes. Returns live Record instances — FTS fields may not be
        populated yet (call index_search() which will call load_fts_content()).
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        opts = opts or ScanOptions()
        resolved_types = opts.types if opts.types is not None else SchemaRegistry.get_default_index_types()

        records: list = []
        by_type: dict[str, list] = {}
        t0 = time.perf_counter()

        for type_name in resolved_types:
            record_cls = SchemaRegistry.get_record_cls(type_name)
            if record_cls is None:
                continue

            if _has_parallel_discovery(record_cls):
                type_records = await asyncio.to_thread(_discover_parallel, record_cls, opts.limit)
            else:
                type_records = await asyncio.to_thread(_discover_records_sync, record_cls, opts.limit)

            by_type[type_name] = type_records
            records.extend(type_records)

        duration_ms = round((time.perf_counter() - t0) * 1000, 1)
        return DiscoveryResult(
            records=records,
            by_type=by_type,
            total=len(records),
            duration_ms=duration_ms,
        )

    # -------------------------------------------------------------------------
    # Phase 2: Metadata index
    # -------------------------------------------------------------------------

    async def index_meta(
        self,
        records: list,
        opts: IndexMetaOptions | None = None,
    ) -> IndexMetaResult:
        """Write Entity rows to the DB for pre-discovered records.

        Also writes hash sentinel files (so index_required returns False on
        subsequent runs when skip_fresh=True).
        """
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        opts = opts or IndexMetaOptions()
        driver = get_db_driver()

        indexed = 0
        skipped = 0
        errors = 0
        t0 = time.perf_counter()

        # Separate records to process vs skip (fresh check)
        to_index: list = []
        for rec in records:
            if opts.skip_fresh and not rec.index_required:
                skipped += 1
            else:
                to_index.append(rec)

        if not to_index:
            duration_ms = round((time.perf_counter() - t0) * 1000, 1)
            return IndexMetaResult(indexed=0, skipped=skipped, errors=0, duration_ms=duration_ms)

        # Group by type for entity-class resolution
        by_type: dict[str, list] = {}
        for rec in to_index:
            type_name = getattr(rec, "_record_type", None) or getattr(rec, "type", "") or ""
            by_type.setdefault(type_name, []).append(rec)

        for type_name, type_records in by_type.items():
            entity_cls = SchemaRegistry.get_entity_cls(type_name) or Entity

            if len(type_records) > _BULK_THRESHOLD and hasattr(driver, "bulk_save"):
                # Bulk path: build entities list, one transaction
                entities: list = []
                entity_map: dict = {}
                for rec in type_records:
                    try:
                        data = rec.meta_dict()
                        entity_id = entity_cls.allocate_id(data)
                        create_kwargs = {"id": entity_id, "type": type_name}
                        create_kwargs.update({k: v for k, v in data.items() if k not in ("id", "type")})
                        try:
                            entity = entity_cls(**create_kwargs)
                        except Exception:
                            entity = Entity(type=type_name, **create_kwargs)
                        entities.append(entity)
                        entity_map[rec] = entity
                    except Exception:
                        errors += 1

                if entities:
                    await driver.bulk_save(entities)
                    await asyncio.to_thread(_write_sentinels, entity_map)
                    indexed += len(entities)
            else:
                # Per-record path
                for rec in type_records:
                    try:
                        await Entity.from_record(rec)
                        await asyncio.to_thread(_write_sentinel, rec)
                        indexed += 1
                    except Exception:
                        errors += 1

        duration_ms = round((time.perf_counter() - t0) * 1000, 1)
        return IndexMetaResult(indexed=indexed, skipped=skipped, errors=errors, duration_ms=duration_ms)

    # -------------------------------------------------------------------------
    # Phase 3: Search index
    # -------------------------------------------------------------------------

    async def index_search(
        self,
        records: list,
        opts: IndexSearchOptions | None = None,
    ) -> IndexSearchResult:
        """Write FTS entries to the DB for pre-discovered records.

        Calls rec.load_fts_content() on every record before reading FTS fields.
        This is the explicit seam that triggers the full JSONL parse for
        ClaudeSessionRecord (and any other record type with lazy FTS content).

        Entity rows must already exist in the DB (call index_meta first).
        """
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

        opts = opts or IndexSearchOptions()
        driver = get_db_driver()

        indexed = 0
        errors = 0
        t0 = time.perf_counter()

        fts_entries: list = []

        # Group by type for entity-class resolution
        by_type: dict[str, list] = {}
        for rec in records:
            type_name = getattr(rec, "_record_type", None) or getattr(rec, "type", "") or ""
            by_type.setdefault(type_name, []).append(rec)

        for type_name, type_records in by_type.items():
            entity_cls = SchemaRegistry.get_entity_cls(type_name) or Entity

            for rec in type_records:
                try:
                    # Re-derive entity_id deterministically (same as index_meta)
                    data = rec.meta_dict()
                    entity_id = entity_cls.allocate_id(data)

                    fts_entries.append(FtsEntry(
                        entity_id=entity_id,
                        entity_type=type_name,
                        name=rec.name or None,
                        title=getattr(rec, "search_title", None),
                        description=getattr(rec, "search_description", None),
                        content=getattr(rec, "search_content", None),
                    ))
                    indexed += 1
                except Exception:
                    errors += 1

        if fts_entries and hasattr(driver, "fts_upsert"):
            await driver.fts_upsert(fts_entries)

        duration_ms = round((time.perf_counter() - t0) * 1000, 1)
        return IndexSearchResult(indexed=indexed, errors=errors, duration_ms=duration_ms)

    # -------------------------------------------------------------------------
    # Convenience: full pipeline
    # -------------------------------------------------------------------------

    async def index_all(self, opts: IndexAllOptions | None = None) -> IndexAllResult:
        """Full pipeline: scan → index_meta → index_search.

        Logs scan and index operations to the SchemaRegistry audit log.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        opts = opts or IndexAllOptions()
        t0 = time.perf_counter()

        scan_opts = ScanOptions(types=opts.types, limit=opts.limit)
        discovery = await self.scan(scan_opts)

        meta_opts = IndexMetaOptions(types=opts.types, limit=opts.limit, skip_fresh=opts.skip_fresh)
        meta = await self.index_meta(discovery.records, meta_opts)

        search_opts = IndexSearchOptions(types=opts.types, limit=opts.limit)
        search = await self.index_search(discovery.records, search_opts)

        # Log to schema registry audit files
        resolved_types = opts.types if opts.types is not None else SchemaRegistry.get_default_index_types()
        SchemaRegistry.append_scan(
            trigger="data_manager",
            duration_ms=discovery.duration_ms,
            total_records=discovery.total,
            total_bytes=0,
            types=[{"type": t, "count": len(discovery.by_type.get(t, []))} for t in resolved_types],
        )
        SchemaRegistry.append_index(
            trigger="data_manager",
            duration_ms=meta.duration_ms + search.duration_ms,
            total_indexed=meta.indexed,
            types=[{"type": t, "indexed": len(discovery.by_type.get(t, []))} for t in resolved_types],
        )

        duration_ms = round((time.perf_counter() - t0) * 1000, 1)
        return IndexAllResult(
            discovery=discovery,
            meta=meta,
            search=search,
            duration_ms=duration_ms,
        )
