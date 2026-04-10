"""SchemaRegistry — unified type system for Record + Entity layers.

Files:
  ~/.flow/schema/scan_log.jsonl                          — global scan log
  ~/.flow/schema/index_log.jsonl                         — global index log
  ~/.flow/schema/types/<sanitized_type>/type_info.json   — per-type TypeInfo
  ~/.flow/schema/types/<sanitized_type>/scan_log.jsonl   — per-type scan log
  ~/.flow/schema/types/<sanitized_type>/index_log.jsonl  — per-type index log

Each log file keeps at most _MAX_LOG_ENTRIES entries (oldest trimmed on append).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.config import FLOW_HOME
from flow_sdk.fs_store.record_types import RecordType

_MAX_LOG_ENTRIES: int = 100

SCHEMA_DIR: Path = FLOW_HOME / "schema"


def _sanitize_type_name(type_name: str) -> str:
    """Make a type name safe for use as a directory/file name component."""
    return type_name.replace(":", "__").replace(" ", "_")


def _schema_dir_for(type_name: str) -> Path:
    return SCHEMA_DIR / "types" / _sanitize_type_name(type_name)


# ---------------------------------------------------------------------------
# JSONL helpers
# ---------------------------------------------------------------------------


def _append_jsonl(path: Path, entry: dict[str, Any]) -> None:
    """Append one JSON line to *path*, then trim to _MAX_LOG_ENTRIES lines."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, default=str) + "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line)
    _trim_jsonl(path)


def _trim_jsonl(path: Path) -> None:
    """If the file exceeds _MAX_LOG_ENTRIES lines, keep only the last N."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) <= _MAX_LOG_ENTRIES:
            return
        keep = lines[-_MAX_LOG_ENTRIES:]
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.writelines(keep)
        tmp.replace(path)
    except Exception:
        pass


def _read_last_entry(path: Path) -> dict[str, Any] | None:
    """Return the last JSON object from a JSONL file, or None."""
    try:
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as fh:
            lines = [ln for ln in fh if ln.strip()]
        if not lines:
            return None
        return json.loads(lines[-1])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# SDK result types
# ---------------------------------------------------------------------------


@dataclass
class ScanResult:
    """Result of scanning a single record type."""

    type_name: str
    count: int
    total_bytes: int
    scan_ms: float
    last_scan_at: str | None = None
    records: list[dict] | None = None
    avg_bytes: int = 0
    min_bytes: int = 0
    max_bytes: int = 0


@dataclass
class IndexResult:
    """Result of indexing a single record type."""

    type_name: str
    indexed: int
    skipped: int
    duration_ms: float
    last_index_at: str | None = None
    errors: int = 0
    fresh: int = 0


PROGRESS_EMIT_EVERY: int = 25  # emit one event per this many records


@dataclass
class ScanProgress:
    """Per-record progress event emitted during scan_type_progress()."""

    type_name: str
    done: int
    total: int
    id: str
    size_bytes: int = 0


@dataclass
class IndexProgress:
    """Per-record progress event emitted during index_type_progress()."""

    type_name: str
    done: int
    total: int
    id: str
    indexed: int
    skipped: int
    errors: int


@dataclass
class IndexRequest:
    """Declarative description of a scan+index operation."""

    types: list[str] | None = None
    actions: list[str] = field(default_factory=lambda: ["scan", "index"])
    start_time: datetime | None = None
    end_time: datetime | None = None
    trigger: str = "manual"
    limit_per_type: int | None = None


@dataclass
class ClearResult:
    fts_cleared: int
    entities_cleared: int
    types_cleared: list[str]


@dataclass
class TypeIndexStatus:
    type_name: str
    last_indexed_at: str | None
    last_scan_at: str | None
    entity_count: int
    stale: bool


@dataclass
class IndexStatus:
    never_indexed: bool
    last_indexed_at: str | None
    stale: bool
    default_types: list[str]
    per_type: list[TypeIndexStatus]


# ---------------------------------------------------------------------------
# Hardcoded fallback list so get_default_index_types() works before any
# Record subclass has registered itself as indexed_by_default.
# ---------------------------------------------------------------------------

_BUILTIN_DEFAULT_TYPES: list[str] = [
    RecordType.SKILL,
    RecordType.BOOKMARK,
    RecordType.AGENT,
    RecordType.TASK,
    RecordType.AGENTIC_PROCESS,
    RecordType.RECORD_ERROR,
    RecordType.CLAUDE_ERROR,
    RecordType.DOCS,
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_MEMORY,
    RecordType.CLAUDE_RULES,
    RecordType.CLAUDE_HOOK,
    RecordType.COMMAND,
    RecordType.ANNOTATION,
]


# ---------------------------------------------------------------------------
# TypeInfo
# ---------------------------------------------------------------------------


@dataclass
class TypeInfo:
    """Metadata for a single record/entity type."""

    # --- Structural fields (included in hash, persisted) ---
    type_name: str
    uid_field: str = "id"
    index_fields: list[str] = field(default_factory=list)
    defaults: dict[str, Any] = field(default_factory=dict)
    indexed_by_default: bool = False
    user_asset: bool = False
    icon: str | None = None
    parent_type: str | None = None
    locations: list[str] = field(default_factory=list)

    # --- Runtime refs (NOT in hash, NOT persisted) ---
    record_cls: type | None = field(default=None, compare=False, repr=False)
    entity_cls: type | None = field(default=None, compare=False, repr=False)

    @property
    def schema_hash(self) -> str:
        """MD5 of structural fields as canonical JSON. Stable across runs."""
        payload = {
            "type_name": self.type_name,
            "uid_field": self.uid_field,
            "index_fields": sorted(self.index_fields),
            "defaults": self.defaults,
            "indexed_by_default": self.indexed_by_default,
            "user_asset": self.user_asset,
            "icon": self.icon,
            "parent_type": self.parent_type,
            "locations": sorted(self.locations),
        }
        return hashlib.md5(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    @property
    def type_id(self) -> "TypeId":
        from flow_sdk.fs_store.type_id import TypeId  # lazy — avoids circular at module load

        return TypeId(type=self.type_name)

    @property
    def extends(self) -> "TypeInfo | None":
        if self.parent_type is None:
            return None
        return SchemaRegistry.get(self.parent_type)

    @property
    def subtypes(self) -> list["TypeInfo"]:
        return SchemaRegistry.get_subtypes(self.type_name)

    @property
    def scans(self) -> list[dict]:
        """Last N scan/index entries. Reads scan_log.jsonl on access."""
        return SchemaRegistry._read_scans(self.type_name)

    def to_dict(self) -> dict:
        return {
            "type_name": self.type_name,
            "uid_field": self.uid_field,
            "index_fields": self.index_fields,
            "defaults": self.defaults,
            "indexed_by_default": self.indexed_by_default,
            "user_asset": self.user_asset,
            "icon": self.icon,
            "parent_type": self.parent_type,
            "locations": self.locations,
            "schema_hash": self.schema_hash,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "TypeInfo":
        return cls(
            type_name=data["type_name"],
            uid_field=data.get("uid_field", "id"),
            index_fields=data.get("index_fields", []),
            defaults=data.get("defaults", {}),
            indexed_by_default=data.get("indexed_by_default", False),
            user_asset=data.get("user_asset", False),
            icon=data.get("icon"),
            parent_type=data.get("parent_type"),
            locations=data.get("locations", []),
        )


# ---------------------------------------------------------------------------
# SchemaRegistry
# ---------------------------------------------------------------------------


class SchemaRegistry:
    """Unified type registry + scan/index orchestration."""

    _types: ClassVar[dict[str, TypeInfo]] = {}
    _subtypes: ClassVar[dict[str, list[str]]] = {}
    _default_index_types: ClassVar[list[str]] = []
    _persisted_hashes: ClassVar[dict[str, str]] = {}

    # Backward compat: direct class attribute access for default_index_types
    default_index_types: ClassVar[list[str]] = _BUILTIN_DEFAULT_TYPES

    # ---------------------------------------------------------------------------
    # Registration
    # ---------------------------------------------------------------------------

    @classmethod
    def register(cls, info: TypeInfo) -> None:
        """Register or enrich a TypeInfo. O(1). Idempotent — merges on re-register."""
        existing = cls._types.get(info.type_name)
        if existing is not None:
            for loc in info.locations:
                if loc not in existing.locations:
                    existing.locations.append(loc)
            if info.record_cls is not None:
                existing.record_cls = info.record_cls
            if info.entity_cls is not None:
                if existing.entity_cls is None:
                    existing.entity_cls = info.entity_cls
                elif existing.entity_cls is not info.entity_cls:
                    existing_fqn = f"{existing.entity_cls.__module__}.{existing.entity_cls.__name__}"
                    new_fqn = f"{info.entity_cls.__module__}.{info.entity_cls.__name__}"
                    if existing_fqn != new_fqn:
                        raise ValueError(
                            f"Duplicate entity registration for type '{info.type_name}': "
                            f"'{existing_fqn}' vs '{new_fqn}'. "
                            f"Each entity type name must map to exactly one class."
                        )
            if info.icon is not None:
                existing.icon = info.icon
            info = existing
        else:
            cls._types[info.type_name] = info

        if info.parent_type:
            cls._subtypes.setdefault(info.parent_type, [])
            if info.type_name not in cls._subtypes[info.parent_type]:
                cls._subtypes[info.parent_type].append(info.type_name)

        if info.indexed_by_default and info.type_name not in cls._default_index_types:
            cls._default_index_types.append(info.type_name)

        cls._maybe_persist(info)

    @classmethod
    def get(cls, type_name: "str | TypeId") -> TypeInfo | None:
        if not isinstance(type_name, str):
            type_name = type_name.type  # TypeId duck-type: .type is the type string
        return cls._types.get(type_name)

    @classmethod
    def get_subtypes(cls, type_name: str) -> list[TypeInfo]:
        names = cls._subtypes.get(type_name, [])
        return [cls._types[n] for n in names if n in cls._types]

    @classmethod
    def get_all_types(cls) -> list[str]:
        return list(cls._types.keys())

    @classmethod
    def get_entity_cls(cls, type_name: str) -> type | None:
        info = cls.get(type_name)
        return info.entity_cls if info else None

    @classmethod
    def get_record_cls(cls, type_name: str) -> type | None:
        info = cls.get(type_name)
        return info.record_cls if info else None

    @classmethod
    def is_entity_type(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.entity_cls is not None)

    @classmethod
    def is_implemented(cls, type_name: str) -> bool:
        return cls.is_entity_type(type_name)

    @classmethod
    def is_public_entity(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        try:
            return bool(info and info.entity_cls and info.entity_cls.api_visible())
        except Exception:
            return False

    @classmethod
    def get_all_entity_types(cls) -> list[str]:
        return [k for k, v in cls._types.items() if v.entity_cls is not None]

    @classmethod
    def get_all_entity_classes(cls) -> list[type]:
        return [v.entity_cls for v in cls._types.values() if v.entity_cls is not None]

    @classmethod
    def get_public_entity_types(cls) -> list[str]:
        result = []
        for k, v in cls._types.items():
            if v.entity_cls is not None:
                try:
                    if v.entity_cls.api_visible():
                        result.append(k)
                except Exception:
                    pass
        return result

    @classmethod
    def get_all_record_types(cls) -> list[str]:
        return [k for k, v in cls._types.items() if v.record_cls is not None]

    @classmethod
    def get_default_index_types(cls) -> list[str]:
        """Return authoritative list of default-indexed type names."""
        if cls._default_index_types:
            return list(cls._default_index_types)
        return list(_BUILTIN_DEFAULT_TYPES)

    # ---------------------------------------------------------------------------
    # Persistence
    # ---------------------------------------------------------------------------

    @classmethod
    def _maybe_persist(cls, info: TypeInfo) -> None:
        h = info.schema_hash
        if cls._persisted_hashes.get(info.type_name) == h:
            return
        path = _schema_dir_for(info.type_name) / "type_info.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(info.to_dict(), indent=2), encoding="utf-8")
            cls._persisted_hashes[info.type_name] = h
        except OSError:
            pass

    @classmethod
    def _read_scans(cls, type_name: str, n: int = 20) -> list[dict]:
        path = _schema_dir_for(type_name) / "scan_log.jsonl"
        try:
            lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
            return [json.loads(ln) for ln in lines[-n:]]
        except (OSError, json.JSONDecodeError):
            return []

    @classmethod
    def load_persisted(cls) -> None:
        """Load all type_info.json files at startup. Best-effort, never raises."""
        types_dir = SCHEMA_DIR / "types"
        if not types_dir.is_dir():
            return
        for type_dir in types_dir.iterdir():
            f = type_dir / "type_info.json"
            if not f.exists():
                continue
            try:
                info = TypeInfo.from_dict(json.loads(f.read_text(encoding="utf-8")))
                if info.type_name not in cls._types:
                    cls._types[info.type_name] = info
                    cls._persisted_hashes[info.type_name] = info.schema_hash
                    if info.parent_type:
                        cls._subtypes.setdefault(info.parent_type, [])
                        if info.type_name not in cls._subtypes[info.parent_type]:
                            cls._subtypes[info.parent_type].append(info.type_name)
                    if info.indexed_by_default and info.type_name not in cls._default_index_types:
                        cls._default_index_types.append(info.type_name)
            except Exception:
                pass

    # ---------------------------------------------------------------------------
    # Logging methods
    # ---------------------------------------------------------------------------

    @staticmethod
    def append_scan(
        trigger: str,
        duration_ms: float,
        total_records: int,
        total_bytes: int,
        types: list[dict[str, Any]],
        type_name: str | None = None,
    ) -> str:
        """Log a scan operation. Returns the ISO timestamp written."""
        now = datetime.now(timezone.utc).isoformat()

        if type_name:
            entry = {
                "id": str(uuid.uuid4()),
                "type": "scan_log",
                "scan_trigger": trigger,
                "duration_ms": duration_ms,
                "total_records": total_records,
                "total_bytes": total_bytes,
                "type_name": type_name,
                "created_at": now,
            }
            sanitized = _sanitize_type_name(type_name)
            _append_jsonl(SCHEMA_DIR / "types" / sanitized / "scan_log.jsonl", entry)
        else:
            global_entry = {
                "id": str(uuid.uuid4()),
                "type": "scan_log",
                "scan_trigger": trigger,
                "duration_ms": duration_ms,
                "total_records": total_records,
                "total_bytes": total_bytes,
                "types": types,
                "created_at": now,
            }
            _append_jsonl(SCHEMA_DIR / "scan_log.jsonl", global_entry)
            for t in types:
                t_name = t.get("type", "")
                if not t_name:
                    continue
                t_entry = {
                    "id": str(uuid.uuid4()),
                    "type": "scan_log",
                    "scan_trigger": trigger,
                    "duration_ms": t.get("scan_ms", 0.0),
                    "total_records": t.get("count", 0),
                    "total_bytes": t.get("total_bytes", 0),
                    "type_name": t_name,
                    "created_at": now,
                }
                sanitized = _sanitize_type_name(t_name)
                _append_jsonl(SCHEMA_DIR / "types" / sanitized / "scan_log.jsonl", t_entry)

        return now

    @staticmethod
    def append_index(
        trigger: str,
        duration_ms: float,
        total_indexed: int,
        types: list[dict[str, Any]],
        type_name: str | None = None,
    ) -> str:
        """Log an index operation. Returns the ISO timestamp written."""
        now = datetime.now(timezone.utc).isoformat()

        if type_name:
            entry = {
                "id": str(uuid.uuid4()),
                "type": "index_log",
                "index_trigger": trigger,
                "duration_ms": duration_ms,
                "total_indexed": total_indexed,
                "type_name": type_name,
                "created_at": now,
            }
            sanitized = _sanitize_type_name(type_name)
            _append_jsonl(SCHEMA_DIR / "types" / sanitized / "index_log.jsonl", entry)
        else:
            global_entry = {
                "id": str(uuid.uuid4()),
                "type": "index_log",
                "index_trigger": trigger,
                "duration_ms": duration_ms,
                "total_indexed": total_indexed,
                "types": types,
                "created_at": now,
            }
            _append_jsonl(SCHEMA_DIR / "index_log.jsonl", global_entry)
            for t in types:
                t_name = t.get("type", "")
                if not t_name:
                    continue
                t_entry = {
                    "id": str(uuid.uuid4()),
                    "type": "index_log",
                    "index_trigger": trigger,
                    "duration_ms": 0.0,
                    "total_indexed": t.get("indexed", 0),
                    "type_name": t_name,
                    "created_at": now,
                }
                sanitized = _sanitize_type_name(t_name)
                _append_jsonl(SCHEMA_DIR / "types" / sanitized / "index_log.jsonl", t_entry)

        return now

    @staticmethod
    def get_last_scan_at(type_name: str) -> str | None:
        sanitized = _sanitize_type_name(type_name)
        entry = _read_last_entry(SCHEMA_DIR / "types" / sanitized / "scan_log.jsonl")
        return (entry or {}).get("created_at")

    @staticmethod
    def get_last_index_at(type_name: str) -> str | None:
        sanitized = _sanitize_type_name(type_name)
        entry = _read_last_entry(SCHEMA_DIR / "types" / sanitized / "index_log.jsonl")
        return (entry or {}).get("created_at")

    @staticmethod
    def get_last_global_index_at() -> str | None:
        entry = _read_last_entry(SCHEMA_DIR / "index_log.jsonl")
        return (entry or {}).get("created_at")

    # ---------------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------------

    @classmethod
    def _scan_type(
        cls,
        type_or_cls,
        include_records: bool = False,
        limit: int | None = None,
    ) -> ScanResult:
        """Scan a record type and return a ScanResult.

        Accepts either a type_name str or a record_cls (backward compat).
        """
        from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415

        if isinstance(type_or_cls, str):
            type_name = type_or_cls
            info = cls.get(type_name)
            record_cls = info.record_cls if info else None
        else:
            record_cls = type_or_cls
            type_name = getattr(record_cls, "_record_type", None) or ""

        if record_cls is None:
            return ScanResult(type_name=type_name, count=0, total_bytes=0, scan_ms=0.0)

        count = 0
        total_bytes = 0
        records_out: list[dict] = []
        t0 = time.perf_counter()
        for rec in RecordList(record_class=record_cls):
            if limit is not None and count >= limit:
                break
            count += 1
            size = 0
            try:
                if rec.source_file:
                    size = Path(rec.source_file).stat().st_size
            except Exception:
                pass
            total_bytes += size
            if include_records:
                entry = {
                    "id": rec.id,
                    "name": getattr(rec, "name", ""),
                    "size_bytes": size,
                    "modified_at": getattr(rec, "modified_at", None) or getattr(rec, "created_at", None),
                    "status": getattr(rec, "status", None),
                }
                mc = getattr(rec, "message_count", None)
                if mc is not None:
                    entry["message_count"] = mc
                records_out.append(entry)
        scan_ms = round((time.perf_counter() - t0) * 1000, 1)
        avg_bytes = total_bytes // count if count else 0
        min_bytes = min((r["size_bytes"] for r in records_out), default=0) if include_records else 0
        max_bytes = max((r["size_bytes"] for r in records_out), default=0) if include_records else 0
        return ScanResult(
            type_name=type_name,
            count=count,
            total_bytes=total_bytes,
            scan_ms=scan_ms,
            records=records_out if include_records else None,
            avg_bytes=avg_bytes,
            min_bytes=min_bytes,
            max_bytes=max_bytes,
        )

    @classmethod
    async def index_type(
        cls,
        type_or_cls,
        limit: int | None = None,
        clear_first: bool = False,
        skip_fresh: bool = False,
    ) -> IndexResult:
        """Index a record type and return an IndexResult.

        Accepts either a type_name str or a record_cls (backward compat).
        When skip_fresh=True, records whose sync marker matches their
        current fingerprint are skipped (counted as ``fresh``).
        """
        from flow_sdk.fs_store.record_list import RecordList  # noqa: PLC0415

        if isinstance(type_or_cls, str):
            type_name = type_or_cls
            info = cls.get(type_name)
            record_cls = info.record_cls if info else None
        else:
            record_cls = type_or_cls
            type_name = getattr(record_cls, "_record_type", None) or ""

        if record_cls is None:
            return IndexResult(type_name=type_name, indexed=0, skipped=0, duration_ms=0.0, errors=0)

        if clear_first:
            from flow_sdk.db import get_db_driver  # noqa: PLC0415

            driver = get_db_driver()
            if hasattr(driver, "delete_entities_by_type"):
                await driver.delete_entities_by_type(type_name)

        _CONCURRENT_INDEX_BATCH = 32

        indexed = 0
        skipped = 0
        fresh_count = 0
        errors_count = 0
        t0 = time.perf_counter()

        # Use discover_iter directly (with limit) when the record class provides
        # its own override — avoids discovering ALL records when only a subset is
        # needed (RecordList.discover() has no limit parameter).
        # Fall back to RecordList for classes that rely on the base Record.discover_iter
        # so that test mocks patching RecordList.__iter__ still work.
        from flow_sdk.fs_store.record import Record as _BaseRecord  # noqa: PLC0415
        _has_custom_iter = (
            "discover_iter" in record_cls.__dict__
            or any(
                "discover_iter" in base.__dict__
                for base in record_cls.__mro__[1:]
                if base is not _BaseRecord and base is not object
                and "discover_iter" in base.__dict__
            )
        )
        if _has_custom_iter and hasattr(record_cls, "discover_paths_iter"):
            # Parallel discovery: collect paths (fast, no I/O), then load records concurrently
            import concurrent.futures as _cf  # noqa: PLC0415
            _paths = list(record_cls.discover_paths_iter(limit=limit))
            _DISCOVERY_WORKERS = 16
            with _cf.ThreadPoolExecutor(max_workers=_DISCOVERY_WORKERS) as _pool:
                _load = getattr(record_cls, "from_jsonl", None) or record_cls
                if _load is not None and hasattr(record_cls, "from_jsonl"):
                    _futures = [_pool.submit(record_cls.from_jsonl, p) for p in _paths]
                    _raw_items = []
                    for _fut in _cf.as_completed(_futures):
                        try:
                            _raw_items.append(_fut.result())
                        except Exception:
                            pass
                else:
                    _raw_items = await asyncio.to_thread(
                        lambda: list(record_cls.discover_iter(limit=limit))
                    )
            _raw_iter = iter(_raw_items)
        elif _has_custom_iter:
            _raw_iter = iter(await asyncio.to_thread(
                lambda: list(record_cls.discover_iter(limit=limit))
            ))
        else:
            _raw_iter = iter(RecordList(record_class=record_cls))

        # collect all records up front
        all_records: list = []
        for rec in _raw_iter:
            if limit is not None and len(all_records) + skipped >= limit:
                break
            if skip_fresh and not rec.index_required:
                fresh_count += 1
                skipped += 1
                continue
            all_records.append(rec)

        # Use bulk path (single transaction) when driver supports it and there are enough records
        from flow_sdk.db import get_db_driver as _get_db_driver  # noqa: PLC0415
        _driver = _get_db_driver()
        if len(all_records) > 5 and hasattr(_driver, "bulk_save"):
            _indexed, _skipped, _errors = await cls.bulk_index_records(all_records, type_name)
            indexed += _indexed
            skipped += _skipped
            errors_count += _errors
        else:
            # process in concurrent batches (fallback for small sets or unsupported drivers)
            for batch_start in range(0, len(all_records), _CONCURRENT_INDEX_BATCH):
                batch = all_records[batch_start:batch_start + _CONCURRENT_INDEX_BATCH]
                batch_fts: list = []

                async def _index_one(rec, _fts=batch_fts):
                    await rec.sync_to_db(fts_batch=_fts, notify=False)

                results = await asyncio.gather(
                    *[_index_one(r) for r in batch],
                    return_exceptions=True,
                )
                for r in results:
                    if isinstance(r, Exception):
                        errors_count += 1
                        skipped += 1
                    else:
                        indexed += 1

                if batch_fts:
                    from flow_sdk.db import get_db_driver
                    driver = get_db_driver()
                    if hasattr(driver, "fts_upsert"):
                        await driver.fts_upsert(batch_fts)

                await asyncio.sleep(0)

        duration_ms = round((time.perf_counter() - t0) * 1000, 1)
        return IndexResult(
            type_name=type_name,
            indexed=indexed,
            skipped=skipped,
            duration_ms=duration_ms,
            errors=errors_count,
            fresh=fresh_count,
        )

    @classmethod
    async def bulk_index_records(
        cls,
        records: list,
        type_name: str,
    ) -> tuple[int, int, int]:
        """Index a pre-collected list of records in bulk (one DB transaction).

        Returns (indexed, skipped, errors).
        """
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry  # noqa: PLC0415

        entity_cls = cls.get_entity_cls(type_name) or Entity
        driver = get_db_driver()

        entities = []
        fts_entries = []
        errors = 0

        for rec in records:
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
                fts_entries.append(FtsEntry(
                    entity_id=entity_id,
                    entity_type=type_name,
                    name=rec.name or None,
                    title=getattr(rec, "search_title", None),
                    description=getattr(rec, "search_description", None),
                    content=getattr(rec, "search_content", None),
                ))
            except Exception:
                errors += 1

        if entities and hasattr(driver, "bulk_save"):
            await driver.bulk_save(entities)

        if fts_entries and hasattr(driver, "fts_upsert"):
            await driver.fts_upsert(fts_entries)

        return len(entities), 0, errors

    @classmethod
    async def scan_type_progress(
        cls,
        type_or_cls,
        limit: int | None = None,
        emit_every: int = PROGRESS_EMIT_EVERY,
    ):
        """Async generator: yield ScanProgress after every emit_every records.

        Accepts either a type_name str or a record_cls (backward compat).
        Uses lazy discovery (discover_iter) so the first event fires after the
        first file is opened rather than waiting for all files to load.
        """
        if isinstance(type_or_cls, str):
            type_name = type_or_cls
            info = cls.get(type_name)
            record_cls = info.record_cls if info else None
        else:
            record_cls = type_or_cls
            type_name = getattr(record_cls, "_record_type", None) or ""

        if record_cls is None:
            return

        # Apply per-type default scan limit from the record class if not overridden by caller.
        if limit is None:
            limit = getattr(record_cls, "_scan_limit", None)

        # Get a fast count first (no file reads for standard types).
        try:
            total = record_cls.discovery_items_count(limit=limit)
        except NotImplementedError:
            total = None  # unknown — emit on every emit_every boundary

        if total == 0:
            return

        batch_size = max(1, (total // 100)) if total else emit_every

        done = 0
        for rec in record_cls.discover_iter(limit=limit):
            done += 1
            size = 0
            try:
                if rec.source_file:
                    size = Path(rec.source_file).stat().st_size
            except Exception:
                pass
            emit_total = total if total is not None else done
            if done % batch_size == 0 or done == total:
                yield ScanProgress(
                    type_name=type_name,
                    done=done,
                    total=emit_total,
                    id=rec.id,
                    size_bytes=size,
                )
            if done % batch_size == 0:
                await asyncio.sleep(0)

    @classmethod
    async def index_type_progress(
        cls,
        type_or_cls,
        limit: int | None = None,
        skip_fresh: bool = False,
        emit_every: int = PROGRESS_EMIT_EVERY,
    ):
        """Async generator: yield IndexProgress after every emit_every records.

        Accepts either a type_name str or a record_cls (backward compat).
        Uses lazy discovery (discover_iter) so the first event fires after the
        first file is opened rather than waiting for all files to load.
        """
        if isinstance(type_or_cls, str):
            type_name = type_or_cls
            info = cls.get(type_name)
            record_cls = info.record_cls if info else None
        else:
            record_cls = type_or_cls
            type_name = getattr(record_cls, "_record_type", None) or ""

        if record_cls is None:
            return

        # Apply per-type default scan limit from the record class if not overridden by caller.
        if limit is None:
            limit = getattr(record_cls, "_scan_limit", None)

        # Get a fast count first (no file reads for standard types).
        try:
            total = record_cls.discovery_items_count(limit=limit)
        except NotImplementedError:
            total = None  # unknown — emit on every emit_every boundary

        if total == 0:
            return

        batch_size = max(1, (total // 100)) if total else emit_every

        indexed = 0
        skipped = 0
        errors = 0
        done = 0
        fts_batch: list = []
        for rec in record_cls.discover_iter(limit=limit):
            done += 1
            if skip_fresh and not rec.index_required:
                skipped += 1
            else:
                try:
                    await rec.sync_to_db(fts_batch=fts_batch, notify=False)
                    indexed += 1
                except Exception:
                    errors += 1
            emit_total = total if total is not None else done
            if done % batch_size == 0 or done == total:
                # Flush accumulated FTS entries before yielding progress.
                if fts_batch:
                    from flow_sdk.db import get_db_driver
                    driver = get_db_driver()
                    if hasattr(driver, "fts_upsert"):
                        await driver.fts_upsert(fts_batch)
                    fts_batch = []
                yield IndexProgress(
                    type_name=type_name,
                    done=done,
                    total=emit_total,
                    id=rec.id,
                    indexed=indexed,
                    skipped=skipped,
                    errors=errors,
                )
            if done % batch_size == 0:
                await asyncio.sleep(0)
        # Flush any remaining entries not covered by the last batch boundary.
        if fts_batch:
            from flow_sdk.db import get_db_driver
            driver = get_db_driver()
            if hasattr(driver, "fts_upsert"):
                await driver.fts_upsert(fts_batch)

    # ---------------------------------------------------------------------------
    # High-level orchestration
    # ---------------------------------------------------------------------------

    @classmethod
    async def discover(
        cls,
        types: list[str] | None = None,
        trigger: str = "manual",
        limit_per_type: int | None = None,
        actions: list[str] | None = None,
    ) -> tuple[list[ScanResult], list[IndexResult]]:
        """Full scan+index for given or default types."""
        if actions is None:
            actions = ["scan", "index"]

        resolved_types = types if types is not None else cls.get_default_index_types()
        scan_results: list[ScanResult] = []
        index_results: list[IndexResult] = []

        for type_name in resolved_types:
            record_cls = cls.get_record_cls(type_name)
            if record_cls is None:
                continue

            if "scan" in actions:
                sr = cls._scan_type(record_cls, limit=limit_per_type)
                last_scan_at = cls.append_scan(
                    trigger=trigger,
                    duration_ms=sr.scan_ms,
                    total_records=sr.count,
                    total_bytes=sr.total_bytes,
                    types=[],
                    type_name=type_name,
                )
                sr.last_scan_at = last_scan_at
                scan_results.append(sr)

            if "index" in actions:
                use_skip_fresh = trigger not in ("rebuild", "manual")
                ir = await cls.index_type(record_cls, limit=limit_per_type, skip_fresh=use_skip_fresh)
                last_index_at = cls.append_index(
                    trigger=trigger,
                    duration_ms=ir.duration_ms,
                    total_indexed=ir.indexed,
                    types=[],
                    type_name=type_name,
                )
                ir.last_index_at = last_index_at
                index_results.append(ir)

        if "scan" in actions and scan_results:
            cls.append_scan(
                trigger=trigger,
                duration_ms=sum(r.scan_ms for r in scan_results),
                total_records=sum(r.count for r in scan_results),
                total_bytes=sum(r.total_bytes for r in scan_results),
                types=[
                    {"type": r.type_name, "count": r.count, "total_bytes": r.total_bytes, "scan_ms": r.scan_ms}
                    for r in scan_results
                ],
            )

        if "index" in actions and index_results:
            cls.append_index(
                trigger=trigger,
                duration_ms=sum(r.duration_ms for r in index_results),
                total_indexed=sum(r.indexed for r in index_results),
                types=[{"type": r.type_name, "indexed": r.indexed} for r in index_results],
            )

        return scan_results, index_results

    # New name alias
    sync = discover

    @classmethod
    async def incremental(
        cls,
        request: IndexRequest,
    ) -> tuple[list[ScanResult], list[IndexResult]]:
        """Scan+index only types not indexed since request.start_time."""
        resolved_types = request.types if request.types is not None else cls.get_default_index_types()
        scan_results: list[ScanResult] = []
        index_results: list[IndexResult] = []

        for type_name in resolved_types:
            if request.start_time is not None:
                last_at = cls.get_last_index_at(type_name) or cls.get_last_scan_at(type_name)
                if last_at is not None and last_at >= request.start_time.isoformat():
                    continue

            record_cls = cls.get_record_cls(type_name)
            if record_cls is None:
                continue

            if "scan" in request.actions:
                sr = cls._scan_type(record_cls, limit=request.limit_per_type)
                last_scan_at = cls.append_scan(
                    trigger=request.trigger,
                    duration_ms=sr.scan_ms,
                    total_records=sr.count,
                    total_bytes=sr.total_bytes,
                    types=[],
                    type_name=type_name,
                )
                sr.last_scan_at = last_scan_at
                scan_results.append(sr)

            if "index" in request.actions:
                ir = await cls.index_type(record_cls, limit=request.limit_per_type, skip_fresh=True)
                last_index_at = cls.append_index(
                    trigger=request.trigger,
                    duration_ms=ir.duration_ms,
                    total_indexed=ir.indexed,
                    types=[],
                    type_name=type_name,
                )
                ir.last_index_at = last_index_at
                index_results.append(ir)

        if "scan" in request.actions and scan_results:
            cls.append_scan(
                trigger=request.trigger,
                duration_ms=sum(r.scan_ms for r in scan_results),
                total_records=sum(r.count for r in scan_results),
                total_bytes=sum(r.total_bytes for r in scan_results),
                types=[
                    {"type": r.type_name, "count": r.count, "total_bytes": r.total_bytes, "scan_ms": r.scan_ms}
                    for r in scan_results
                ],
            )

        if "index" in request.actions and index_results:
            cls.append_index(
                trigger=request.trigger,
                duration_ms=sum(r.duration_ms for r in index_results),
                total_indexed=sum(r.indexed for r in index_results),
                types=[{"type": r.type_name, "indexed": r.indexed} for r in index_results],
            )

        return scan_results, index_results

    # New name alias
    sync_incremental = incremental

    @classmethod
    async def clear_index(cls, types: list[str] | None = None) -> ClearResult:
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_records.record_error import RecordError  # noqa: PLC0415

        driver = get_db_driver()
        if types is None:
            fts_cleared = await driver.fts_clear() if hasattr(driver, "fts_clear") else 0
            entities_cleared = (
                await driver.delete_entities_by_type(None) if hasattr(driver, "delete_entities_by_type") else 0
            )
            global_log = SCHEMA_DIR / "index_log.jsonl"
            if global_log.exists():
                global_log.unlink()
            types_dir = SCHEMA_DIR / "types"
            if types_dir.is_dir():
                for per_type_log in types_dir.glob("*/index_log.jsonl"):
                    per_type_log.unlink()
            types_cleared = cls.get_all_record_types()
            await RecordError.clear_all()
        else:
            fts_cleared = 0
            entities_cleared = 0
            types_cleared = []
            for type_name in types:
                if hasattr(driver, "delete_entities_by_type"):
                    entities_cleared += await driver.delete_entities_by_type(type_name)
                sanitized = _sanitize_type_name(type_name)
                log_file = SCHEMA_DIR / "types" / sanitized / "index_log.jsonl"
                if log_file.exists():
                    log_file.unlink()
                types_cleared.append(type_name)
                await RecordError.clear_for_type(type_name)
        return ClearResult(
            fts_cleared=fts_cleared,
            entities_cleared=entities_cleared,
            types_cleared=types_cleared,
        )

    # New name alias
    clear = clear_index

    @classmethod
    def get_index_status(cls, types: list[str] | None = None) -> IndexStatus:
        from datetime import timedelta  # noqa: PLC0415
        from flow_sdk._compat import UTC

        last_indexed_at = cls.get_last_global_index_at()
        never_indexed = last_indexed_at is None
        stale = False
        if last_indexed_at:
            dt = datetime.fromisoformat(last_indexed_at)
            stale = (datetime.now(UTC) - dt) > timedelta(hours=24)
        per_type = []
        for type_name in types or cls.get_default_index_types():
            type_last = cls.get_last_index_at(type_name)
            type_stale = True
            if type_last:
                dt = datetime.fromisoformat(type_last)
                type_stale = (datetime.now(UTC) - dt) > timedelta(hours=24)
            per_type.append(
                TypeIndexStatus(
                    type_name=type_name,
                    last_indexed_at=type_last,
                    last_scan_at=cls.get_last_scan_at(type_name),
                    entity_count=0,
                    stale=type_stale,
                )
            )
        return IndexStatus(
            never_indexed=never_indexed,
            last_indexed_at=last_indexed_at,
            stale=stale,
            default_types=cls.get_default_index_types(),
            per_type=per_type,
        )

    # New name alias
    get_status = get_index_status

    @classmethod
    async def rebuild_index(
        cls,
        types: list[str] | None = None,
        trigger: str = "rebuild",
    ) -> tuple[ClearResult, list[IndexResult]]:
        clear_result = await cls.clear_index(types)
        index_results = []
        resolved_types = types or cls.get_default_index_types()
        for type_name in resolved_types:
            record_cls = cls.get_record_cls(type_name)
            if record_cls is None:
                continue
            ir = await cls.index_type(record_cls)
            cls.append_index(
                trigger=trigger,
                duration_ms=ir.duration_ms,
                total_indexed=ir.indexed,
                types=[],
                type_name=type_name,
            )
            index_results.append(ir)
        if index_results:
            cls.append_index(
                trigger=trigger,
                duration_ms=sum(r.duration_ms for r in index_results),
                total_indexed=sum(r.indexed for r in index_results),
                types=[{"type": r.type_name, "indexed": r.indexed} for r in index_results],
            )
        return clear_result, index_results

    # New name alias
    rebuild = rebuild_index

    @classmethod
    def get_errors(cls, type_name: "str | TypeId | None" = None) -> list:
        from flow_sdk.fs_records.record_error import RecordError  # noqa: PLC0415

        results = list(RecordError.discover())  # base type only
        for subtype_info in cls.get_subtypes("record_error"):
            subtype_cls = subtype_info.record_cls
            if subtype_cls is not None:
                results.extend(subtype_cls.discover())
        if type_name is not None:
            if not isinstance(type_name, str):
                type_name = type_name.type
            results = [e for e in results if getattr(e, "_record_type", None) == type_name]
        return results
