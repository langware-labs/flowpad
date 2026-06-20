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

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.view_mode import ViewMode, visible_in, view_mode_rank

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
    orphan_count: int = 0


@dataclass
class IndexStatus:
    never_indexed: bool
    last_indexed_at: str | None
    stale: bool
    default_types: list[str]
    per_type: list[TypeIndexStatus]
    total_orphans: int = 0


@dataclass
class AssetStats:
    """Live per-type asset counts for a ScopeFilter — counts only. Freshness
    and orphans deliberately live in ``IndexStatus`` / ``get_index_status``;
    this is the single source the UI counter surfaces render from."""

    per_type: dict[str, int]
    total: int


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
    # Minimum view mode at which this type is browseable (None ⇒ never). See
    # flow_sdk/schema/view_mode.py — visibility is cumulative.
    browseable_by: ViewMode | None = None
    creatable: bool = False
    api_visible: bool = False
    icon: str | None = None
    parent_type: str | None = None
    locations: list[str] = field(default_factory=list)

    # --- Runtime refs (NOT in hash, NOT persisted) ---
    entity_cls: type | None = field(default=None, compare=False, repr=False)
    # Optional post-sync hook: async Callable[[FSRecord], None] — runs after
    # FSRecord.sync_to_db completes its entity/FTS/wiki writes. Used by
    # types that reconcile cross-record relationships (e.g. markdown folder-doc
    # parent/child edges) that the base sync doesn't know about.
    post_sync_fn: Any = field(default=None, compare=False, repr=False)
    # Per-type indexer dispatch callables, registered next to their definitions
    # in ``fs_store/indexer/functions/<type>.py``. The indexer reads these
    # instead of duck-typing classmethods on the entity:
    #   from_disk_fn:  Callable[[FSRef], list[FSRecord]] — parse (cold path)
    #   gen_id_fn:     Callable[[FSRef], str]           — mint/read id (hot path)
    #   asset_hash_fn: Callable[[FSRef], float]         — cheap freshness stat
    from_disk_fn: Any = field(default=None, compare=False, repr=False)
    gen_id_fn: Any = field(default=None, compare=False, repr=False)
    asset_hash_fn: Any = field(default=None, compare=False, repr=False)
    # Per-type default-body writer: Callable[[entity], str]. Read by
    # FSRecord.default_body / upsert_main_ref to materialize the backing file on
    # create. None ⇒ no auto-created body.
    default_body_fn: Any = field(default=None, compare=False, repr=False)
    # True ⇒ entity saves re-render the backing file from default_body_fn on
    # EVERY store() (entity is the file's sole editor), not just on create.
    owns_main_ref: bool = field(default=False, compare=False, repr=False)
    # True ⇒ sharing an entity of this type also shares its parent
    # (``parent_type_id``); the receive path materializes the parent first via
    # ``Entity.materialize_share_parent``. Runtime-only; not part of the
    # schema hash. Only safe when the parent type is deterministic/field-frozen.
    parent_share_on_default: bool = field(default=False, compare=False, repr=False)
    # The declarative TypeMetadata (possibly a per-type subclass) this TypeInfo
    # was built from — home for type-specific extras beyond the flat fields.
    # Runtime-only; the flat fields above remain the serialized surface.
    metadata: Any = field(default=None, compare=False, repr=False)
    # Per-type pydantic metadata model: the FS↔DB schema. Its field set defines
    # which entity fields with ``persist=DEFAULT`` are mirrored to metadata.json,
    # and ``FSRecord.meta_dict`` returns a typed instance when it is set.
    # Runtime-only; not part of the schema hash.
    meta_model: Any = field(default=None, compare=False, repr=False)
    # Asset layout: scope-relative subdir for the primary asset
    # (e.g. ".claude/skills") and whether the asset is a single file or
    # a folder. Used by FSRecord to resolve where an entity's asset goes
    # on save.
    main_subdir: str | None = None
    main_layout: str = "file"
    # For ``main_layout == "folder"`` owned types: the fixed inner filename of
    # the primary asset (e.g. ``spec.md`` under ``specs/<name>/``). When set,
    # ``compute_asset_ref`` targets ``<subdir>/<name>/<main_file>`` instead of
    # the bare folder, so ``owns_main_ref`` folder types can write/round-trip
    # the body file. Runtime-only; not part of the schema hash.
    main_file: str | None = None
    # Folder-layout types: True ⇒ asset_ref IS ``<subdir>/<name>/<main_file>``
    # (spec); False ⇒ asset_ref is the bare folder and the default body is
    # materialized into ``<folder>/<main_file>`` (skill). Runtime-only.
    main_file_is_asset_ref: bool = False

    def asset_ref_for(self, folder: Path) -> Path:
        """Where a folder-layout type's asset_ref points, given its folder.

        Spec-style (``main_file_is_asset_ref``) anchors asset_ref on the inner
        ``<folder>/<main_file>``; skill-style keeps it on the bare folder. The
        inverse of ``body_path_for`` — both live here so the folder↔body
        convention is stated once. Callers gate on ``main_layout == "folder"``.
        """
        if self.main_file and self.main_file_is_asset_ref:
            return folder / self.main_file
        return folder

    def body_path_for(self, asset_path: Path) -> Path:
        """Map an asset_ref path to the writable main-body file.

        Folder-layout types whose asset_ref is the bare folder (skill-style,
        ``main_file_is_asset_ref=False``) keep the body at ``<folder>/<main_file>``;
        every other shape's asset_ref already IS the body target.
        """
        if self.main_layout == "folder" and self.main_file and not self.main_file_is_asset_ref:
            return asset_path / self.main_file
        return asset_path

    @property
    def folder_backed(self) -> bool:
        """True when ``asset_ref`` points at a browsable folder — a folder-layout
        type whose asset_ref is the bare folder (skill-style,
        ``main_file_is_asset_ref=False``), not the inner ``main_file``
        (spec-style). The Assets sidebar expands these rows into their on-disk
        file tree. Derived from the existing folder-layout fields so no type
        carries a redundant flag."""
        return self.main_layout == "folder" and not self.main_file_is_asset_ref

    @property
    def browseable_by_str(self) -> str | None:
        """``browseable_by`` as its serialized string value (or None) — the one
        wire form used by both ``schema_hash`` and ``to_dict``."""
        return self.browseable_by.value if self.browseable_by else None

    @property
    def schema_hash(self) -> str:
        """MD5 of structural fields as canonical JSON. Stable across runs."""
        payload = {
            "type_name": self.type_name,
            "uid_field": self.uid_field,
            "index_fields": sorted(self.index_fields),
            "defaults": self.defaults,
            "indexed_by_default": self.indexed_by_default,
            "browseable_by": self.browseable_by_str,
            "creatable": self.creatable,
            "api_visible": self.api_visible,
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
            "browseable_by": self.browseable_by_str,
            "creatable": self.creatable,
            "api_visible": self.api_visible,
            "icon": self.icon,
            "parent_type": self.parent_type,
            "locations": self.locations,
            "main_subdir": self.main_subdir,
            "main_layout": self.main_layout,
            "folder_backed": self.folder_backed,
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
            browseable_by=ViewMode(data["browseable_by"]) if data.get("browseable_by") else None,
            creatable=data.get("creatable", False),
            api_visible=data.get("api_visible", False),
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
    # Whether the declarative type-info registrations have run in this process.
    _loaded: ClassVar[bool] = False

    # Backward compat: direct class attribute access for default_index_types
    default_index_types: ClassVar[list[str]] = _BUILTIN_DEFAULT_TYPES

    # ---------------------------------------------------------------------------
    # Lazy initialization
    # ---------------------------------------------------------------------------

    @classmethod
    def _ensure_loaded(cls) -> None:
        """Populate the registry on first read.

        Entity types self-register on import (``__init_subclass__``), but the
        declarative *metadata* types only register when ``register_all()`` runs.
        Rather than require every process (CLI, SDK script, indexer, backend) to
        remember to call it, run it lazily the first time the registry is read —
        once per process. ``register_all()`` is idempotent, so a later explicit
        call (e.g. at server startup) is harmless.
        """
        if cls._loaded:
            return
        # Set the flag BEFORE running register_all: it calls register() many
        # times, which must not re-enter this loader.
        cls._loaded = True
        try:
            from flow_sdk.schema.type_info import register_all  # lazy: avoid import cycle

            register_all()
        except Exception:
            cls._loaded = False  # let the next access retry rather than wedge
            raise

    # ---------------------------------------------------------------------------
    # Registration
    # ---------------------------------------------------------------------------

    @classmethod
    def register_crud_type(cls, type_name: str, *, icon: str | None = None) -> None:
        """Register a CRUD-only type that has no indexer walker.

        Such types (e.g. ``claude_error``, ``claude_debug_log``) are produced
        on demand and exist only so the fs-records routes accept them
        (GET returns an empty list instead of 400). They are never auto-indexed,
        browseable, or creatable.
        """
        cls.register(TypeInfo(
            type_name=type_name,
            icon=icon,
            indexed_by_default=False,
            browseable_by=None,
            creatable=False,
        ))

    @classmethod
    def register(cls, info: TypeInfo) -> None:
        """Register or enrich a TypeInfo. O(1). Idempotent — merges on re-register."""
        existing = cls._types.get(info.type_name)
        if existing is not None:
            for loc in info.locations:
                if loc not in existing.locations:
                    existing.locations.append(loc)
            if info.main_subdir is not None:
                existing.main_subdir = info.main_subdir
            if info.main_layout != "file":
                existing.main_layout = info.main_layout
            if info.main_file is not None:
                existing.main_file = info.main_file
            if info.main_file_is_asset_ref:
                existing.main_file_is_asset_ref = True
            if info.post_sync_fn is not None:
                existing.post_sync_fn = info.post_sync_fn
            if info.from_disk_fn is not None:
                existing.from_disk_fn = info.from_disk_fn
            if info.gen_id_fn is not None:
                existing.gen_id_fn = info.gen_id_fn
            if info.asset_hash_fn is not None:
                existing.asset_hash_fn = info.asset_hash_fn
            if info.default_body_fn is not None:
                existing.default_body_fn = info.default_body_fn
            if info.owns_main_ref:
                existing.owns_main_ref = True
            if info.parent_share_on_default:
                existing.parent_share_on_default = True
            if info.metadata is not None:
                existing.metadata = info.metadata
            if info.meta_model is not None:
                existing.meta_model = info.meta_model
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
            if info.browseable_by is not None and (
                existing.browseable_by is None
                or view_mode_rank(info.browseable_by) < view_mode_rank(existing.browseable_by)
            ):
                # Keep the more permissive (lower-ordered) non-null level.
                existing.browseable_by = info.browseable_by
            if info.indexed_by_default and not existing.indexed_by_default:
                existing.indexed_by_default = True
            if info.api_visible and not existing.api_visible:
                existing.api_visible = True
            if info.index_fields:
                existing.index_fields = list(info.index_fields)
            if info.defaults:
                existing.defaults = {**existing.defaults, **info.defaults}
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
        cls._ensure_loaded()
        if not isinstance(type_name, str):
            type_name = type_name.type  # TypeId duck-type: .type is the type string
        return cls._types.get(type_name)

    @classmethod
    def get_subtypes(cls, type_name: str) -> list[TypeInfo]:
        cls._ensure_loaded()
        names = cls._subtypes.get(type_name, [])
        return [cls._types[n] for n in names if n in cls._types]

    @classmethod
    def get_all_types(cls) -> list[str]:
        cls._ensure_loaded()
        return list(cls._types.keys())

    @classmethod
    def get_entity_cls(cls, type_name: str) -> type | None:
        info = cls.get(type_name)
        return info.entity_cls if info else None

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
        return bool(info and info.entity_cls is not None and info.api_visible)

    @classmethod
    def get_all_entity_types(cls) -> list[str]:
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None]

    @classmethod
    def get_all_entity_classes(cls) -> list[type]:
        cls._ensure_loaded()
        return [v.entity_cls for v in cls._types.values() if v.entity_cls is not None]

    @classmethod
    def get_public_entity_types(cls) -> list[str]:
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None and v.api_visible]

    # --- Presentation read-through getters (registry is the single source) ---

    @classmethod
    def is_api_visible(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.api_visible)

    @classmethod
    def get_icon(cls, type_name: str) -> str | None:
        info = cls.get(type_name)
        return info.icon if info else None

    @classmethod
    def browseable_by(cls, type_name: str) -> ViewMode | None:
        """Minimum view mode at which ``type_name`` is browseable (None ⇒ never)."""
        info = cls.get(type_name)
        return info.browseable_by if info else None

    @classmethod
    def is_browseable_in(cls, type_name: str, mode: ViewMode) -> bool:
        """True iff ``type_name`` is browseable in the given view ``mode`` (cumulative)."""
        return visible_in(cls.browseable_by(type_name), mode)

    @classmethod
    def is_creatable(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.creatable)

    @classmethod
    def is_indexed_by_default(cls, type_name: str) -> bool:
        info = cls.get(type_name)
        return bool(info and info.indexed_by_default)

    @classmethod
    def get_all_record_types(cls) -> list[str]:
        cls._ensure_loaded()
        return [k for k, v in cls._types.items() if v.entity_cls is not None]

    @classmethod
    def get_default_index_types(cls) -> list[str]:
        """Return authoritative list of default-indexed type names."""
        cls._ensure_loaded()
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
        from flow_sdk.fs_store.operations.record_error import clear_all, clear_for_type  # noqa: PLC0415

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
            await clear_all()
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
                await clear_for_type(type_name)
        return ClearResult(
            fts_cleared=fts_cleared,
            entities_cleared=entities_cleared,
            types_cleared=types_cleared,
        )

    # New name alias
    clear = clear_index

    @classmethod
    async def get_index_status(
        cls,
        types: list[str] | None = None,
        scope: "object | None" = None,
    ) -> IndexStatus:
        """Snapshot of index state. DB-free for freshness.

        * **Project scope** (``scope.projects == [one id]``) — the project IS a
          record, so its three states come from the project record's own
          on-disk ``.hash`` sentinel: ``never_indexed`` = no sentinel,
          ``last_indexed_at`` = the sentinel time, ``stale`` = ``index_required``
          ("changes pending"). No child aggregation.
        * **Unscoped / type list** — footer/scanner view. ``last_indexed_at``
          per type from the JSONL run-history (audit); ``entity_count`` from
          ``count_entities_by_type`` (the live searchable count).

        ``stale`` now means "changes pending next index", not a 24h timer.
        Orphan counts come from a scan, not from here.
        """
        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        driver = get_db_driver()
        per_type: list[TypeIndexStatus] = []
        latest_iso: str | None = None
        for type_name in types or cls.get_default_index_types():
            type_last = cls.get_last_index_at(type_name)  # JSONL run-history (audit)
            if type_last and (latest_iso is None or type_last > latest_iso):
                latest_iso = type_last
            count = await cls._safe_count(driver, type_name, scope)
            per_type.append(
                TypeIndexStatus(
                    type_name=type_name,
                    last_indexed_at=type_last,
                    entity_count=count,
                    stale=False,
                    orphan_count=0,
                )
            )

        # Project-scoped freshness from the project record's own sentinel.
        project_id = cls._single_project_id(scope)
        if project_id is not None:
            prec = cls._project_record_for_status(project_id)
            indexed_at = prec.indexed_at if prec is not None else None
            return IndexStatus(
                never_indexed=indexed_at is None,
                last_indexed_at=indexed_at,
                stale=bool(prec.index_required) if prec is not None else False,
                default_types=cls.get_default_index_types(),
                per_type=per_type,
                total_orphans=0,
            )

        return IndexStatus(
            never_indexed=all(t.last_indexed_at is None for t in per_type),
            last_indexed_at=latest_iso,
            stale=False,
            default_types=cls.get_default_index_types(),
            per_type=per_type,
            total_orphans=0,
        )

    @staticmethod
    async def _safe_count(driver, type_name: str, scope: "object | None") -> int:
        """Per-type live count, tolerant of a driver whose
        ``count_entities_by_type`` predates the ``scope`` kwarg. Shared by
        ``get_index_status`` and ``get_asset_stats`` so there is one counting
        path, not two."""
        try:
            return await driver.count_entities_by_type(type_name, scope=scope)
        except TypeError:
            return await driver.count_entities_by_type(type_name)
        except Exception:
            return 0

    @classmethod
    async def get_asset_stats(cls, scope: "object | None" = None) -> AssetStats:
        """Live per-type asset counts for a ScopeFilter, over the registry's
        default index types (P5 — derived, not hardcoded). Counts only; reuses
        the same per-type count path as ``get_index_status``."""
        from flow_sdk.db import get_db_driver  # noqa: PLC0415

        driver = get_db_driver()
        per_type = {
            str(type_name): await cls._safe_count(driver, type_name, scope)
            for type_name in cls.get_default_index_types()
        }
        return AssetStats(per_type=per_type, total=sum(per_type.values()))

    @staticmethod
    def _single_project_id(scope: "object | None") -> str | None:
        """The lone project id when ``scope`` targets exactly one project, else None."""
        projects = list(getattr(scope, "projects", None) or []) if scope is not None else []
        return projects[0] if len(projects) == 1 else None

    @staticmethod
    def _project_record_for_status(project_id: str) -> "object | None":
        """Load the project record with its asset_ref bound to the project
        folder, so ``indexed_at`` / ``index_required`` resolve. None if the
        record (or its mount path) is unknown."""
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

        prec = FSRecord.load_or_none("project", project_id)
        return prec.ensure_asset_ref() if prec is not None else None

    # New name alias
    get_status = get_index_status


    @classmethod
    def get_errors(cls, type_name: "str | TypeId | None" = None) -> list:
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        results = FSRecord.discover(RecordType.RECORD_ERROR)
        if type_name is not None:
            if not isinstance(type_name, str):
                type_name = type_name.type
            results = [
                e for e in results
                if e.__dict__.get("source_record_type") == type_name or getattr(e, "type", None) == type_name
            ]
        return results
