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

from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings

_MAX_LOG_ENTRIES: int = 100


def _schema_dir() -> Path:
    """Resolve the per-instance schema dir at call time.

    Lives on InstanceSettings — never cache the result, never construct
    `~/.flow/<...>/schema` directly. This getter is the single chokepoint.
    """
    return get_instance_settings().schema_dir


def _sanitize_type_name(type_name: str) -> str:
    """Make a type name safe for use as a directory/file name component."""
    return type_name.replace(":", "__").replace(" ", "_")


def _schema_dir_for(type_name: str) -> Path:
    return _schema_dir() / "types" / _sanitize_type_name(type_name)


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
    # Filesystem-scannable types (must overlap with INDEXABLE_TYPES in
    # flow_sdk/fs_store/indexer/builtin.py — the indexer can't walk types
    # not registered there). Runtime-only types like BOOKMARK, ANNOTATION,
    # AGENTIC_PROCESS, RECORD_ERROR, CLAUDE_ERROR are written to the DB by
    # Record.save and intentionally excluded from this list.
    RecordType.SKILL,
    RecordType.AGENT,
    RecordType.TASK,
    RecordType.MARKDOWN,
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_MEMORY,
    RecordType.CLAUDE_RULES,
    RecordType.CLAUDE_HOOK,
    RecordType.COMMAND,
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
    creatable: bool = False
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
            "creatable": self.creatable,
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

    def to_dict(self) -> dict:
        return {
            "type_name": self.type_name,
            "uid_field": self.uid_field,
            "index_fields": self.index_fields,
            "defaults": self.defaults,
            "indexed_by_default": self.indexed_by_default,
            "user_asset": self.user_asset,
            "creatable": self.creatable,
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
            creatable=data.get("creatable", False),
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
            if info.creatable and not existing.creatable:
                existing.creatable = True
            if info.user_asset and not existing.user_asset:
                existing.user_asset = True
            info = existing
        else:
            cls._types[info.type_name] = info

        if info.parent_type:
            cls._subtypes.setdefault(info.parent_type, [])
            if info.type_name not in cls._subtypes[info.parent_type]:
                cls._subtypes[info.parent_type].append(info.type_name)

        if info.indexed_by_default and info.type_name not in cls._default_index_types:
            cls._default_index_types.append(info.type_name)

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
            _append_jsonl(_schema_dir() / "types" / sanitized / "scan_log.jsonl", entry)
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
            _append_jsonl(_schema_dir() / "scan_log.jsonl", global_entry)
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
                _append_jsonl(_schema_dir() / "types" / sanitized / "scan_log.jsonl", t_entry)

        return now

    @staticmethod
    def append_index(
        trigger: str,
        duration_ms: float,
        total_indexed: int,
        types: list[dict[str, Any]],
        type_name: str | None = None,
    ) -> str:
        """Log an index operation. Returns the ISO timestamp written.

        Per-type log only — the "global" timestamp is derived in
        ``get_index_status`` as ``max(per_type[i].last_indexed_at)``. This
        means per-type indexing (e.g. UI's "Index Now" loop) automatically
        flips ``never_indexed`` to false without needing a separate global
        write call.
        """
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
            _append_jsonl(_schema_dir() / "types" / sanitized / "index_log.jsonl", entry)
        else:
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
                _append_jsonl(_schema_dir() / "types" / sanitized / "index_log.jsonl", t_entry)

        return now

    @staticmethod
    def get_last_scan_at(type_name: str) -> str | None:
        sanitized = _sanitize_type_name(type_name)
        entry = _read_last_entry(_schema_dir() / "types" / sanitized / "scan_log.jsonl")
        return (entry or {}).get("created_at")

    @staticmethod
    def get_last_index_at(type_name: str) -> str | None:
        sanitized = _sanitize_type_name(type_name)
        entry = _read_last_entry(_schema_dir() / "types" / sanitized / "index_log.jsonl")
        return (entry or {}).get("created_at")

    # ---------------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------------


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
            global_log = _schema_dir() / "index_log.jsonl"
            if global_log.exists():
                global_log.unlink()
            types_dir = _schema_dir() / "types"
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
                log_file = _schema_dir() / "types" / sanitized / "index_log.jsonl"
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
    async def get_index_status(cls, types: list[str] | None = None) -> IndexStatus:
        """Snapshot of per-instance index state. Async because it queries the DB
        for live entity counts.

        ``last_indexed_at`` and ``never_indexed`` are derived from per-type
        timestamps — there is no separate global JSONL. This means per-type
        indexing (UI's "Index Now" loop) automatically flips ``never_indexed``.
        ``entity_count`` comes from ``driver.count_entities_by_type`` so it
        reflects what's actually searchable, not a stale log entry.
        """
        from datetime import timedelta  # noqa: PLC0415
        from flow_sdk._compat import UTC
        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        driver = get_db_driver()
        per_type: list[TypeIndexStatus] = []
        latest_iso: str | None = None
        for type_name in types or cls.get_default_index_types():
            type_last = cls.get_last_index_at(type_name)
            type_stale = True
            if type_last:
                dt = datetime.fromisoformat(type_last)
                type_stale = (datetime.now(UTC) - dt) > timedelta(hours=24)
                if latest_iso is None or type_last > latest_iso:
                    latest_iso = type_last
            try:
                count = await driver.count_entities_by_type(type_name)
            except Exception:
                count = 0
            per_type.append(
                TypeIndexStatus(
                    type_name=type_name,
                    last_indexed_at=type_last,
                    entity_count=count,
                    stale=type_stale,
                )
            )
        never_indexed = all(t.last_indexed_at is None for t in per_type)
        global_stale = False
        if latest_iso:
            dt = datetime.fromisoformat(latest_iso)
            global_stale = (datetime.now(UTC) - dt) > timedelta(hours=24)
        return IndexStatus(
            never_indexed=never_indexed,
            last_indexed_at=latest_iso,
            stale=global_stale,
            default_types=cls.get_default_index_types(),
            per_type=per_type,
        )

    # New name alias
    get_status = get_index_status


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
