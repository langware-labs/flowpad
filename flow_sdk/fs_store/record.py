"""Unified Record class — domain-data-only model.

Single base class with:
- Direct instance attributes for all fields (no _data dict)
- Dirty tracking via _dirty_keys: set[str] (private)
- Single on-disk file per record folder:
    - metadata.json  — ALL fields (no meta/domain split)
    - data/<key>.json — named FSRef children (_domain_fsref_keys)
- Unified save() with single entry point
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import platform
import shutil
import subprocess
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, ClassVar, TypeVar

from .record_field import MISSING as _RF_MISSING
from .record_field import RecordField
from .record_ref import RecordRef
from .scope import Scope

T = TypeVar("T", bound="Record")

_META_JSON = "metadata.json"
_DATA_JSON = "data.json"  # backward-compat: used by resource_record_list

_FLOWPAD_HOME: Path = Path.home() / ".flow"
_DEFAULT_RECORDS_ROOT: Path = _FLOWPAD_HOME / "records"
_DEFAULT_RECORDS_DATA_ROOT: Path = _FLOWPAD_HOME / "records_data"

ENV_FS_RECORD_PATH = "FS_RECORD_PATH"


def get_flowpad_home() -> Path:
    """Return the flowpad home directory (~/.flow by default)."""
    return _FLOWPAD_HOME


def get_default_records_root() -> Path:
    """Return the default root for record metadata storage.

    Resolution order:
    1. ``FS_RECORD_PATH`` env var (allows tests and explicit overrides)
    2. ``_DEFAULT_RECORDS_ROOT`` (set by ``set_default_records_root()`` or config)
    """
    env_path = os.environ.get(ENV_FS_RECORD_PATH)
    if env_path:
        return Path(env_path)
    return _DEFAULT_RECORDS_ROOT


def get_default_records_data_root() -> Path:
    """Return the default root for record data/blob storage (~/.flow/records_data)."""
    return _DEFAULT_RECORDS_DATA_ROOT


def set_default_records_root(path: Path) -> None:
    """Override the default records root (primarily for testing)."""
    global _DEFAULT_RECORDS_ROOT
    _DEFAULT_RECORDS_ROOT = path
    # Sync the env var so get_default_records_root() — which checks it first — stays consistent.
    os.environ[ENV_FS_RECORD_PATH] = str(path)


def set_default_records_data_root(path: Path) -> None:
    """Override the default records data root (primarily for testing)."""
    global _DEFAULT_RECORDS_DATA_ROOT
    _DEFAULT_RECORDS_DATA_ROOT = path


class RecordStatus(str, Enum):
    """Status of a record."""
    CREATING = "creating"
    NEW = "new"
    ACTIVE = "active"
    ORPHAN = "orphan"


# Naming convention: <type>-@<uid>
_NAME_SEP = "-@"


def record_stem(record_type: str, uid: str) -> str:
    """Build the canonical stem used for file / folder names."""
    return f"{record_type}{_NAME_SEP}{uid}"


def parse_record_stem(stem: str) -> tuple[str, str]:
    """Parse a ``<type>-@<uid>`` stem into (type, uid)."""
    if _NAME_SEP not in stem:
        raise ValueError(f"Invalid record stem: {stem!r}")
    record_type, uid = stem.split(_NAME_SEP, 1)
    return record_type, uid


# Fields excluded from to_dict() and from_dict() output
_SKIP_SERIALIZE: frozenset[str] = frozenset({
    "source_file", "path",
    "json_path",
    "fs_sync", "storage_layout",
    "raw_json",
})

_FS_SYNC_SKIP = frozenset({"fs_sync", "storage_layout", "source_file", "path"})

# Old meta fields that should NOT be carried into the new data.json domain data.
_OLD_META_FIELDS = frozenset({
    "created_at", "modified_at", "created_by", "updated_by",
    "scope", "entity_id", "json_path",
})


def _migrate_old_format(folder: Path) -> dict | None:
    """Migrate old ``.flow_record/record.json`` or ``data.json`` to ``metadata.json``.

    Returns the domain data dict, or ``None`` if no old format found.
    """
    old_dir = folder / ".flow_record"
    old_file = old_dir / "record.json"

    # Try .flow_record/record.json first
    if old_file.is_file():
        try:
            raw = json.loads(old_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(raw, dict):
            return None
        domain = {k: v for k, v in raw.items() if k not in _OLD_META_FIELDS}
        meta_file = folder / _META_JSON
        meta_file.write_text(
            json.dumps({"data": domain}, indent=2, default=str),
            encoding="utf-8",
        )
        try:
            shutil.rmtree(old_dir)
        except OSError:
            pass
        return domain

    # Try old data.json
    data_file_path = folder / "data.json"
    if data_file_path.is_file():
        try:
            raw = json.loads(data_file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(raw, dict):
            return None
        data = raw.get("data", raw)
        meta_file = folder / _META_JSON
        meta_file.write_text(
            json.dumps({"data": data}, indent=2, default=str),
            encoding="utf-8",
        )
        try:
            data_file_path.unlink()
        except OSError:
            pass
        return data

    return None


class Record:
    """Unified base class for all records.

    NOT a dataclass. Uses direct instance attributes for all fields.
    Persisted to ``metadata.json`` in the record folder.

    Subclasses define domain properties as plain attrs or properties.

    ID:
      id    — always a UUID (v4 random, or v5 derived via identity_key/fingerprint)
              used for filesystem stem and discover_one()
    """

    # Subclasses set this to auto-register in the type registry.
    _record_type: ClassVar[str] = ""
    def _is_read_only(self) -> bool:
        """Return True if this record instance is read-only.

        Enforcement is FSRef-level only: the instance is read-only when its
        asset_ref or record_folder_ref carries read_only=True.  No ClassVar participates
        — all write protection lives on FSRef instances.
        """
        try:
            _asset_ref = object.__getattribute__(self, "_asset_ref")
            if _asset_ref is not None and _asset_ref.read_only:
                return True
        except AttributeError:
            pass
        try:
            _record_folder_ref = object.__getattribute__(self, "_record_folder_ref")
            if _record_folder_ref is not None and _record_folder_ref.read_only:
                return True
        except AttributeError:
            pass
        return False

    # Subclasses set this to True to be included in the default index.

    _indexed_by_default: ClassVar[bool] = False
    # Subclasses set this to True to mark the type as user-facing (shown in asset browser).
    _user_asset: ClassVar[bool] = False
    # Subclasses set this to cap how many records are scanned by default (None = no limit).
    _scan_limit: ClassVar[int | None] = None
    # Extra field names concatenated into the embedding text.
    index_fields: ClassVar[list[str]] = []
    # Map of property key → RecordField (computed mode). Defined by subclasses.
    _property_types: ClassVar[dict[str, type["Any"]]] = {}
    # Map of field name → RecordField (stored mode). Populated by RecordField.__set_name__.
    _field_defs: ClassVar[dict[str, "Any"]] = {}
    # Names of keys managed via named FSRef children in the data/ subfolder.
    _domain_fsref_keys: ClassVar[list[str]] = []

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        rt = cls.__dict__.get("_record_type")
        if rt:
            # Find parent type in MRO
            parent_type = None
            for base in cls.__mro__[1:]:
                bt = base.__dict__.get("_record_type")
                if bt:
                    parent_type = bt
                    break

            try:
                # Collect RecordField(index=True) from this class's own _field_defs
                # and merge into index_fields.
                own_field_defs = cls.__dict__.get("_field_defs", {})
                field_index_names = [
                    n for n, fd in own_field_defs.items()
                    if isinstance(fd, RecordField) and fd._index and fd._is_stored
                ]
                if field_index_names:
                    own_index = list(cls.__dict__.get("index_fields", []))
                    inherited_index = list(getattr(cls, "index_fields", []))
                    cls.index_fields = list(dict.fromkeys(own_index + inherited_index + field_index_names))

                # Merge RecordField scalar defaults into _DATA_DEFAULTS.
                # Explicit _DATA_DEFAULTS wins (existing takes priority).
                field_defaults = {
                    n: fd._default for n, fd in own_field_defs.items()
                    if isinstance(fd, RecordField) and fd._is_stored and fd._default is not _RF_MISSING
                }
                if field_defaults:
                    existing_defaults = dict(getattr(cls, "_DATA_DEFAULTS", {}))
                    cls._DATA_DEFAULTS = {**field_defaults, **existing_defaults}

                from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo  # noqa: PLC0415
                SchemaRegistry.register(TypeInfo(
                    type_name=rt,
                    uid_field="id",
                    index_fields=list(getattr(cls, "index_fields", [])),
                    defaults=dict(getattr(cls, "_DATA_DEFAULTS", {})),
                    indexed_by_default=bool(getattr(cls, "_indexed_by_default", False)),
                    user_asset=bool(getattr(cls, "_user_asset", False)),
                    parent_type=parent_type,
                    locations=["record"],
                    record_cls=cls,
                ))
            except Exception:
                pass  # never break Record subclass definition

    def __init__(self, _data: dict | None = None, **kwargs: Any):
        """Initialize a Record.

        Can be called two ways:
        1. Record() — empty record with generated UUID
        2. Record(id="x", name="y", description="z") — all kwargs become direct attrs
        """
        object.__setattr__(self, "_dirty_keys", set())
        object.__setattr__(self, "_source_file", None)
        object.__setattr__(self, "_path", None)
        # fs_sync as plain instance attr
        object.__setattr__(self, "fs_sync", False)
        object.__setattr__(self, "_record_folder_ref", None)   # FSRef | None — record folder
        object.__setattr__(self, "_asset_ref", None)  # FSRef | None — external content
        object.__setattr__(self, "_asset_folder_ref", None)  # FSRef | None — folder asset was discovered from

        # Merge _data dict first (lowest priority)
        if _data is not None:
            for key, value in _data.items():
                object.__setattr__(self, key, value)

        if kwargs:
            for key, value in kwargs.items():
                _d = object.__getattribute__(self, "__dict__")
                if key == "raw_json" and isinstance(value, dict):
                    _d.update({k: v for k, v in value.items() if not k.startswith("_")})
                elif key == "fs_sync":
                    object.__setattr__(self, "fs_sync", value)
                elif key == "storage_layout":
                    pass  # StorageLayout removed; records are always folder-based
                elif key == "source_file":
                    object.__setattr__(self, "_source_file", value)
                elif key == "path":
                    object.__setattr__(self, "_path", value)
                elif key == "_meta":
                    # Backward compat: merge old _meta dict into attrs
                    if isinstance(value, dict):
                        _d.update({k: v for k, v in value.items() if not k.startswith("_")})
                elif key in ("parent_ref", "parent"):
                    _d["parent"] = self._serialize_ref(value)
                elif key in ("children_refs", "children"):
                    _d["children_list"] = [self._serialize_ref(c) for c in (value or [])]
                elif key in ("origin_ref", "origin"):
                    _d["origin"] = self._serialize_ref(value)
                elif key == "data_ref":
                    _d["data_ref"] = self._serialize_ref(value)
                elif key == "parent_id" and value is not None:
                    _d["parent"] = {"id": value, "type": ""}
                else:
                    _d[key] = value

        # Ensure id exists
        _d = object.__getattribute__(self, "__dict__")
        if not _d.get("id"):
            key = self.identity_key
            if key is not None:
                _d["id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{self._record_type}:{key}"))
            else:
                _d["id"] = str(uuid.uuid4())

        # Set type from _record_type ClassVar if not provided
        if not _d.get("type"):
            rt = getattr(type(self), "_record_type", "")
            if rt:
                _d["type"] = rt

        # Apply RecordField stored-mode defaults for fields not already set by kwargs/_data.
        _all_field_defs: dict = {}
        for _c in type(self).__mro__:
            for _n, _fd in _c.__dict__.get("_field_defs", {}).items():
                _all_field_defs.setdefault(_n, _fd)
        for _fname, _fdef in _all_field_defs.items():
            if _fname not in _d:
                if _fdef._default_factory is not None:
                    _d[_fname] = _fdef._default_factory()
                elif _fdef._default is not _RF_MISSING:
                    _d[_fname] = _fdef._default

    def __getattr__(self, name: str) -> Any:
        """Fallback attribute access — only called when normal lookup fails."""
        # Avoid recursion for internal attrs
        if name.startswith("_"):
            raise AttributeError(name)
        raise AttributeError(f"{self.__class__.__name__!r} has no attribute {name!r}")

    def __setattr__(self, name: str, value: Any) -> None:
        """Route attribute writes to the correct storage.

        - Internal/private attrs (_foo) → object.__setattr__
        - Property descriptors with setters → call the setter
        - fs_sync, storage_layout → object.__setattr__
        - Everything else → direct instance attr + dirty tracking + auto-sync
        """
        # Internal attrs
        if name.startswith("_"):
            object.__setattr__(self, name, value)
            return

        # Check if there's a property descriptor with a setter
        for cls in type(self).__mro__:
            if name in cls.__dict__:
                desc = cls.__dict__[name]
                if isinstance(desc, property) and desc.fset is not None:
                    desc.fset(self, value)
                    return
                elif isinstance(desc, property):
                    # Read-only property — fall through to direct storage
                    break
                break

        # Instance-level attrs (fs_sync, storage_layout)
        if name in ("fs_sync", "storage_layout"):
            object.__setattr__(self, name, value)
            return

        # Everything else goes to direct instance attr with dirty tracking
        object.__setattr__(self, name, value)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add(name)
        self._auto_sync(name)

    @staticmethod
    def _serialize_ref(value: Any) -> dict | None:
        """Convert a ref value to a dict for storage."""
        if value is None:
            return None
        if isinstance(value, dict):
            return value
        if isinstance(value, RecordRef):
            return value.to_dict()
        # Duck-type: FsRecordRef or similar
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return None

    @staticmethod
    def _deserialize_ref(value: Any) -> RecordRef | None:
        """Convert a stored dict back to a RecordRef."""
        if value is None:
            return None
        if isinstance(value, RecordRef):
            return value
        if isinstance(value, dict):
            return RecordRef.from_dict(value)
        return None

    # -- Identity properties --

    @property
    def id(self) -> str:
        return object.__getattribute__(self, "__dict__").get("id", "")

    @id.setter
    def id(self, value: str) -> None:
        object.__getattribute__(self, "__dict__")["id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("id")

    @property
    def type(self) -> str:
        return object.__getattribute__(self, "__dict__").get("type", "") or getattr(type(self), "_record_type", "")

    @type.setter
    def type(self, value: str) -> None:
        object.__getattribute__(self, "__dict__")["type"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("type")

    @property
    def name(self) -> str:
        return object.__getattribute__(self, "__dict__").get("name", "")

    @name.setter
    def name(self, value: str) -> None:
        object.__getattribute__(self, "__dict__")["name"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("name")
        self._auto_sync("name")

    @property
    def status(self) -> str | RecordStatus | None:
        return object.__getattribute__(self, "__dict__").get("status")

    @status.setter
    def status(self, value: str | RecordStatus | None) -> None:
        old_status = object.__getattribute__(self, "__dict__").get("status")
        object.__getattribute__(self, "__dict__")["status"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("status")
        if value != old_status:
            self.on_status_change(old_status, value)
        self._auto_sync("status")

    def on_status_change(self, old_status: Any, new_status: Any) -> None:
        """Called when ``status`` changes. Override in subclasses to react."""

    # -- Location (stored as instance attrs, not in _data) --

    @property
    def source_file(self) -> str | None:
        return self._source_file

    @source_file.setter
    def source_file(self, value: str | None) -> None:
        object.__setattr__(self, "_source_file", value)

    @property
    def path(self) -> str | None:
        return self._path

    @path.setter
    def path(self, value: str | None) -> None:
        object.__setattr__(self, "_path", value)

    @property
    def record_folder_ref(self) -> "Any":  # FSRef | None
        """FSRef pointing to this record's own metadata folder in records_root.

        Lazily resolves to FSRef(self.default_path) when not explicitly set.
        This is always under records_root — never an external source directory.
        All write operations (metadata.json, state.json, hash sentinels) target
        record_folder_ref._path so that external-backed records (skills, projects from
        ~/.claude/) never pollute their source directories.
        """
        ref = object.__getattribute__(self, "_record_folder_ref")
        if ref is None:
            dp = self.default_path
            if dp is not None:
                from flow_sdk.fs_store.fs_ref import FSRef as _FSRef
                ref = _FSRef(dp)
        return ref

    @record_folder_ref.setter
    def record_folder_ref(self, value: "Any") -> None:
        object.__setattr__(self, "_record_folder_ref", value)

    @property
    def metadata_ref(self) -> "Any":  # FSRef
        """Always resolves to the shadow records-root folder — never an external asset dir.

        This is the single authoritative write target for metadata.json and state.json.
        Uses default_path when available (guarantees records_root shadow).
        Falls back to record_folder_ref only when no type/id exist yet.
        """
        from .fs_ref import FSRef as _FSRef
        dp = self.default_path
        if dp is not None:
            return _FSRef(dp)
        rfr = self.record_folder_ref
        if rfr is not None:
            return rfr
        raise ValueError(
            f"Cannot determine metadata_ref for {self.__class__.__name__} (no type/id)"
        )

    @property
    def asset_ref(self) -> "Any":  # FSRef | None
        return object.__getattribute__(self, "_asset_ref")

    @asset_ref.setter
    def asset_ref(self, value: "Any") -> None:
        object.__setattr__(self, "_asset_ref", value)

    @property
    def asset_folder_ref(self) -> "Any":  # FSRef | None
        """FSRef pointing to the folder from which this asset was discovered."""
        return object.__getattribute__(self, "_asset_folder_ref")

    @asset_folder_ref.setter
    def asset_folder_ref(self, value: "Any") -> None:
        object.__setattr__(self, "_asset_folder_ref", value)

    @property
    def main_ref(self) -> "Any":  # FSRef | None
        """Primary content ref for this record. Default: metadata.json (JSONFsRef).

        Subclasses override to point at their primary content file (e.g. SKILL.md).
        """
        rd = self.record_dir
        if rd is None:
            return None
        from flow_sdk.fs_store.fs_ref import JSONFsRef
        return JSONFsRef(rd / _META_JSON)

    # -- Relationship refs --

    @property
    def parent_ref(self) -> RecordRef | None:
        return self._deserialize_ref(object.__getattribute__(self, "__dict__").get("parent"))

    @parent_ref.setter
    def parent_ref(self, value: RecordRef | None) -> None:
        object.__getattribute__(self, "__dict__")["parent"] = self._serialize_ref(value)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("parent")

    @property
    def children_refs(self) -> list[RecordRef]:
        raw = object.__getattribute__(self, "__dict__").get("children_list", [])
        return [self._deserialize_ref(c) for c in raw if c is not None]

    @children_refs.setter
    def children_refs(self, value: list[RecordRef]) -> None:
        object.__setattr__(self, "children_list", [self._serialize_ref(c) for c in value])
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("children")

    def link_to_parent_record(self) -> None:
        """Register self as a child in the parent record's children_refs.

        Uses self.parent_ref to locate the parent on disk, loads it, and
        delegates to add_child(self) — which deduplicates and auto-saves.
        Safe to call when the parent record doesn't exist (no-op with warning).

        This establishes the bidirectional record-layer composition:
          child.parent_ref     →  parent record  (set by caller)
          parent.children_refs →  child record   (set here)

        Works for any parent/child record type pair.
        """
        import logging as _logging

        parent = self.parent_ref
        if not parent or not parent.id or not parent.type:
            return

        parent_folder = (
            get_default_records_root() / parent.type / record_stem(parent.type, parent.id)
        )
        parent_meta = parent_folder / "metadata.json"
        if not parent_meta.exists():
            return

        try:
            parent_rec = Record.load(parent_meta)
            parent_rec.add_child(self)
        except Exception as exc:
            _logging.getLogger(__name__).warning(
                f"Record.link_to_parent_record: could not update parent record "
                f"({parent.type}/{parent.id}): {exc}"
            )

    @property
    def origin_ref(self) -> RecordRef | None:
        return self._deserialize_ref(object.__getattribute__(self, "__dict__").get("origin"))

    @origin_ref.setter
    def origin_ref(self, value: RecordRef | None) -> None:
        object.__setattr__(self, "origin", self._serialize_ref(value))
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("origin")

    # -- Data access --

    @property
    def data(self) -> dict:
        """Read-only shim: return to_dict() for backward compat."""
        return self.to_dict()

    # -- Raw JSON (backward compat with ResourceRecord.raw_json) --

    @property
    def raw_json(self) -> dict:
        """Backward compat: return to_dict()."""
        return self.to_dict()

    @raw_json.setter
    def raw_json(self, value: dict) -> None:
        for k, v in value.items():
            setattr(self, k, v)

    # -- Naming helpers --

    @property
    def stem(self) -> str:
        """Canonical ``<type>-@<uid>`` stem for this record."""
        return record_stem(self.type, self.id)

    # -- Filesystem properties --

    @property
    def fs_modified_at(self) -> datetime | None:
        """Return modified_at from the filesystem (mtime of source path)."""
        target = None
        if self.path:
            target = Path(self.path)
        elif self.source_file:
            target = Path(self.source_file)
        if target is not None:
            try:
                mtime = target.stat().st_mtime
                return datetime.fromtimestamp(mtime, tz=timezone.utc)
            except OSError:
                pass
        return None

    @property
    def record_dir(self) -> Path | None:
        """The directory containing this record on disk."""
        if self.path:
            return Path(self.path)
        if self.source_file:
            sf = Path(self.source_file)
            return sf.parent
        return None

    @property
    def record_data_dir(self) -> Path | None:
        """Path to the record folder. None if record has no folder on disk.

        Named FSRef children live directly in this folder (e.g. ``config.json``).
        Does NOT create the directory — use ``data_dir`` for auto-creating access.
        """
        return self.record_dir

    @property
    def data_dir(self) -> Path | None:
        """The record folder for domain files. Creates it if needed."""
        rd = self.record_dir
        if rd is None:
            return None
        rd.mkdir(parents=True, exist_ok=True)
        return rd

    def read_file(self, filename: str) -> str | None:
        """Read a companion text file from data_dir, falling back to record_dir."""
        dd = self.data_dir
        if dd is not None:
            p = dd / filename
            if p.exists():
                return p.read_text(encoding="utf-8")
        # Fall back to record_dir for migration
        rd = self.record_dir
        if rd is None:
            return None
        p = rd / filename
        if not p.exists():
            return None
        return p.read_text(encoding="utf-8")

    def write_file(self, filename: str, content: str) -> Path:
        """Write a companion text file to data_dir. Creates dirs if needed."""
        dd = self.data_dir
        if dd is None:
            raise ValueError("No record_dir -- set path or source_file first")
        p = dd / filename
        p.write_text(content, encoding="utf-8")
        return p

    @property
    def output_dir(self) -> Path:
        """The output subdirectory for this record. Creates it if needed."""
        d = self.data_dir
        if d is None:
            raise ValueError("No path or source_file set")
        out = d / "output"
        out.mkdir(parents=True, exist_ok=True)
        return out

    @property
    def input_dir(self) -> Path:
        """The input subdirectory for this record. Creates it if needed."""
        d = self.data_dir
        if d is None:
            raise ValueError("No path or source_file set")
        inp = d / "input"
        inp.mkdir(parents=True, exist_ok=True)
        return inp

    def compute_record_hash(self) -> str:
        """SHA256 of record content files (16 hex chars)."""
        rd = self.record_dir
        if rd is None:
            return "0" * 16
        h = hashlib.sha256()
        # Primary: metadata.json (contains all fields)
        p = rd / "metadata.json"
        if p.exists():
            h.update(p.read_bytes())
        # Named FSRef children (live directly in record folder)
        for key in sorted(getattr(type(self), "_domain_fsref_keys", [])):
            named_p = rd / f"{key}.json"
            if named_p.exists():
                h.update(named_p.read_bytes())
        return h.hexdigest()[:16]

    def _fingerprint_paths(self) -> list[Path]:
        """Return paths to stat for fingerprint computation."""
        rd = self.record_dir
        if rd is None:
            return []
        paths = []
        # Primary: metadata.json (contains all fields)
        p = rd / "metadata.json"
        if p.exists():
            paths.append(p)
        # Named FSRef children (live directly in record folder)
        for key in sorted(getattr(type(self), "_domain_fsref_keys", [])):
            named_p = rd / f"{key}.json"
            if named_p.exists():
                paths.append(named_p)
        return paths

    @property
    def content_fingerprint(self) -> str:
        """Lightweight content fingerprint based on file mtime + size.

        O(1) filesystem stat calls — no file reads. Returns 16 hex chars.
        For FOLDER layout: combines stats of metadata.json + data/_obj_data.json.
        For FILE layout: stat of source_file.
        Returns '0' * 16 if no files exist.
        """
        rd = self.record_dir
        if rd is None:
            return "0" * 16
        h = hashlib.md5()
        for p in self._fingerprint_paths():
            try:
                st = p.stat()
                h.update(f"{st.st_mtime}:{st.st_size}".encode())
            except OSError:
                pass
        digest = h.hexdigest()[:16]
        return digest if digest != hashlib.md5(b"").hexdigest()[:16] else "0" * 16

    @property
    def fingerprint(self) -> str:
        """Backward-compatible alias for content_fingerprint."""
        return self.content_fingerprint

    @property
    def identity_key(self) -> str | None:
        """Overridable hook for deterministic id derivation.

        Return a stable string that uniquely identifies this record within its type.
        When non-None and no explicit id is passed to __init__, the id is derived as:
            uuid5(NAMESPACE_DNS, f"{self._record_type}:{identity_key}")
        Returns None by default → uuid4() is used (existing behavior).
        Must only access instance attrs (already populated from kwargs at __init__ time).
        """
        return None

    @property
    def index_state_dir(self) -> Path | None:
        """Directory where flow-internal index state files (hash sentinels) are stored.

        Always resolves through ``record_folder_ref`` which is always under
        records_root — never an external source directory (skill folders, etc.).
        Returns None when the record has no type/id to form a default path.
        """
        rfr = self.record_folder_ref
        if rfr is None:
            return None
        return Path(rfr._path)

    def write_hash_file(self, fingerprint: str) -> None:
        """Write <fingerprint>.<timestamp>.hash in index_state_dir. Removes old markers."""
        rd = self.index_state_dir
        if rd is None:
            return
        rd.mkdir(parents=True, exist_ok=True)
        for old in rd.glob("*.hash"):
            old.unlink(missing_ok=True)
        timestamp = int(time.time())
        (rd / f"{fingerprint}.{timestamp}.hash").touch()

    def read_hash_file(self) -> tuple[str, float] | None:
        """Return (fingerprint, timestamp) from hash sentinel file, or None."""
        rd = self.index_state_dir
        if rd is None or not rd.is_dir():
            return None
        for f in rd.glob("*.hash"):
            parts = f.stem.split(".")
            if len(parts) == 2:
                try:
                    return parts[0], float(parts[1])
                except ValueError:
                    pass
        return None

    def record_update_required(self, ttl: float = 30.0) -> bool:
        """True if hash sentinel missing, TTL expired, or fingerprint mismatch."""
        result = self.read_hash_file()
        if result is None:
            return True
        stored_fingerprint, timestamp = result
        if time.time() - timestamp > ttl:
            return True
        return self.content_fingerprint != stored_fingerprint

    @property
    def index_required(self) -> bool:
        """True if this record needs (re-)indexing.

        Returns True when the hash sentinel file is absent. Does not check fingerprint
        match or TTL — those are for live-refresh decisions.
        """
        rd = self.index_state_dir
        if rd is None:
            return False
        sentinel_files = list(rd.glob("*.hash"))
        return len(sentinel_files) == 0

    @property
    def default_path(self) -> Path | None:
        """The default storage path for this record based on type and id."""
        if not self.type:
            return None
        return get_default_records_root() / self.type / record_stem(self.type, self.id)

    # -- Key-value access (backward compat with ResourceRecord) --

    def __getitem__(self, key: str) -> Any:
        d = object.__getattribute__(self, "__dict__")
        if key in d and not key.startswith("_"):
            return d[key]
        raise KeyError(key)

    def __setitem__(self, key: str, value: Any) -> None:
        setattr(self, key, value)

    def __delitem__(self, key: str) -> None:
        d = object.__getattribute__(self, "__dict__")
        if key in d and not key.startswith("_"):
            object.__delattr__(self, key)
            dirty = object.__getattribute__(self, "_dirty_keys")
            dirty.add(key)
            return
        raise KeyError(key)

    def __contains__(self, key: str) -> bool:
        d = object.__getattribute__(self, "__dict__")
        return key in d and not key.startswith("_") and key not in _SKIP_SERIALIZE

    def keys(self) -> list[str]:
        """All data keys."""
        d = object.__getattribute__(self, "__dict__")
        return [k for k in d if not k.startswith("_") and k not in _SKIP_SERIALIZE]

    # -- Serialization --

    def to_dict(self) -> dict:
        """Serialize to a flat dict. Fields in _SKIP_SERIALIZE and private attrs excluded."""
        def _convert(obj: Any) -> Any:
            if isinstance(obj, datetime):
                return obj.isoformat()
            if isinstance(obj, Enum):
                return obj.value
            if isinstance(obj, RecordRef):
                return obj.to_dict()
            if isinstance(obj, list):
                return [_convert(item) for item in obj]
            return obj

        result: dict = {}
        d = object.__getattribute__(self, "__dict__")
        for key, value in d.items():
            if key.startswith("_"):
                continue
            if key in _SKIP_SERIALIZE:
                continue
            if key == "fs_sync":
                continue
            if key == "children_list":
                # Serialize as "children" key
                result["children"] = _convert(value)
                continue
            result[key] = _convert(value)

        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Record":
        """Deserialize from a flat dict — all keys become direct attrs."""
        rec = cls.__new__(cls)
        object.__setattr__(rec, "_dirty_keys", set())
        object.__setattr__(rec, "_source_file", data.get("source_file"))
        object.__setattr__(rec, "_path", data.get("path"))
        object.__setattr__(rec, "fs_sync", False)
        object.__setattr__(rec, "_record_folder_ref", None)
        object.__setattr__(rec, "_asset_ref", None)

        for key, value in data.items():
            if key in _SKIP_SERIALIZE:
                continue
            if key in ("children", "children_refs"):
                raw = value if isinstance(value, list) else []
                object.__setattr__(rec, "children_list", [
                    c if isinstance(c, dict) else {"id": str(c), "type": ""}
                    for c in raw
                ])
            elif key in ("parent", "parent_ref"):
                if isinstance(value, dict):
                    object.__getattribute__(rec, "__dict__")["parent"] = value
            elif key == "parent_id" and value is not None:
                if "parent" not in object.__getattribute__(rec, "__dict__"):
                    object.__getattribute__(rec, "__dict__")["parent"] = {"id": value, "type": ""}
            elif key in ("origin", "origin_ref"):
                if isinstance(value, dict):
                    object.__getattribute__(rec, "__dict__")["origin"] = value
            elif key == "raw_json" and isinstance(value, dict):
                _rd2 = object.__getattribute__(rec, "__dict__")
                _rd2.update({k: v for k, v in value.items() if not k.startswith("_")})
            else:
                object.__getattribute__(rec, "__dict__")[key] = value

        # Coerce scope
        scope_val = object.__getattribute__(rec, "__dict__").get("scope")
        if isinstance(scope_val, str):
            try:
                object.__getattribute__(rec, "__dict__")["scope"] = Scope(scope_val)
            except ValueError:
                pass

        # Coerce status
        _rd = object.__getattribute__(rec, "__dict__")
        status_val = _rd.get("status")
        if isinstance(status_val, str):
            try:
                _rd["status"] = RecordStatus(status_val)
            except ValueError:
                pass  # keep as raw string (subclasses may use custom status enums)

        # Ensure id
        if not _rd.get("id"):
            key = rec.identity_key
            if key is not None:
                _rd["id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{rec._record_type}:{key}"))
            else:
                _rd["id"] = str(uuid.uuid4())

        # Ensure type from _record_type ClassVar
        if not _rd.get("type"):
            rt = getattr(cls, "_record_type", "")
            if rt:
                _rd["type"] = rt

        # Apply RecordField stored-mode defaults for fields absent in the serialised data.
        _all_field_defs: dict = {}
        for _c in type(rec).__mro__:
            for _n, _fd in _c.__dict__.get("_field_defs", {}).items():
                _all_field_defs.setdefault(_n, _fd)
        for _fname, _fdef in _all_field_defs.items():
            if _fname not in _rd:
                if _fdef._default_factory is not None:
                    _rd[_fname] = _fdef._default_factory()
                elif _fdef._default is not _RF_MISSING:
                    _rd[_fname] = _fdef._default

        return rec

    # -- Key management --

    @classmethod
    def _get_record_key(cls, record_data: dict) -> str:
        """Default: fast md5 hash of canonical JSON (first 12 chars).

        Subclasses override for meaningful keys.
        """
        canonical = json.dumps(record_data, sort_keys=True, separators=(",", ":"))
        return hashlib.md5(canonical.encode()).hexdigest()[:12]

    # -- Load / Read --

    @classmethod
    def _init_record(
        cls: type[T],
        data: dict[str, Any],
        path: str | Path,
        indent: int = 2,
    ) -> T:
        """Materialize entity data as metadata.json at path (DB→disk sync).

        Args:
            data:  entity.db_json() — the dict to persist as metadata.json.
            path:  target folder (or .json file whose stem becomes the folder).
        """
        p = Path(path)
        folder = p.parent / p.stem if p.suffix == ".json" else p
        rec = cls.from_dict(data)
        rec.path = str(folder)
        meta_file = rec._save_split_format(folder, indent=indent)
        rec.source_file = str(meta_file)
        return rec

    @classmethod
    def load_record(cls: type[T], path: str | Path) -> T:
        """Load a record from a disk path or directory."""
        p = Path(path)
        if p.is_dir():
            folder = p
            meta_file = folder / _META_JSON
            if meta_file.exists():
                rec = cls()
                rec._load_split_format(folder)
                rec.source_file = str(meta_file)
                rec.path = str(folder)
                return rec
            migrated = _migrate_old_format(folder)
            if migrated is None:
                rec = cls()
                rec.path = str(folder)
                return rec
            meta_file = folder / _META_JSON
            if meta_file.exists():
                rec = cls()
                rec._load_split_format(folder)
                rec.source_file = str(meta_file)
                rec.path = str(folder)
                return rec
            rec = cls()
            rec.path = str(folder)
            return rec
        # File path
        rec = cls()
        if p.exists():
            rec.read_record(p)
        rec.source_file = str(p)
        return rec

    @classmethod
    def init(
        cls: type[T],
        data: dict[str, Any],
        path: str | Path,
        indent: int = 2,
    ) -> T:
        """Backward-compatible alias for ``_init_record(data, path)``."""
        return cls._init_record(data, path, indent=indent)

    @classmethod
    def load(cls, path: str | Path) -> Record:
        """Polymorphic loader -- reads JSON, checks type, returns correct subclass."""
        from .factory.type_registry import type_registry

        p = Path(path)
        folder = p if p.is_dir() else p.parent

        if p.is_dir():
            # Try metadata.json first
            meta_file = folder / _META_JSON
            if meta_file.exists():
                rec = cls.__new__(cls)
                object.__setattr__(rec, "_dirty_keys", set())
                object.__setattr__(rec, "_source_file", None)
                object.__setattr__(rec, "_path", str(folder))
                object.__setattr__(rec, "fs_sync", False)
                object.__setattr__(rec, "_record_folder_ref", None)
                object.__setattr__(rec, "_asset_ref", None)
                rec._load_split_format(folder)
                # Re-resolve to typed class
                record_type = object.__getattribute__(rec, "__dict__").get("type", "")
                target_cls = type_registry.get(record_type) or Record
                if target_cls is not cls:
                    typed_rec = target_cls.__new__(target_cls)
                    object.__setattr__(typed_rec, "_dirty_keys", set())
                    object.__setattr__(typed_rec, "_source_file", str(meta_file))
                    object.__setattr__(typed_rec, "_path", str(folder))
                    object.__setattr__(typed_rec, "fs_sync", False)
                    object.__setattr__(typed_rec, "_record_folder_ref", None)
                    object.__setattr__(typed_rec, "_asset_ref", None)
                    # Copy all public attrs from rec
                    rec_d = object.__getattribute__(rec, "__dict__")
                    for k, v in rec_d.items():
                        if not k.startswith("_") and k not in ("fs_sync",):
                            object.__setattr__(typed_rec, k, v)
                    return typed_rec
                rec.source_file = str(meta_file)
                return rec

            # Fall back: try migrating from old format
            data_file = folder / "data.json"
        else:
            data_file = p

        # Backward compat: migrate old .flow_record/record.json if data.json missing
        if not data_file.exists():
            migrated = _migrate_old_format(folder)
            if migrated is not None:
                meta_file = folder / _META_JSON
                if meta_file.exists():
                    return cls.load(folder)
            raise FileNotFoundError(f"Record not found: {data_file}")

        raw = json.loads(data_file.read_text(encoding="utf-8"))
        # Support wrapped format {"data": {...}}
        data = raw.get("data", raw) if isinstance(raw, dict) else raw
        record_type = data.get("type", "")
        target_cls = type_registry.get(record_type) or Record
        rec = target_cls.from_dict(data)
        rec.source_file = str(data_file)
        return rec

    # -- Discovery (overridable by subclasses) --

    # -- External-source hooks (override in subclasses for multi-source discovery) --

    @classmethod
    def _external_source_iter(cls: type[T], limit: int | None = None) -> Any:
        """Yield records from sources other than records_root.

        Override alongside ``_external_source_count`` and ``_external_source_find_one``
        to add a second discovery source (e.g. ``~/.claude/projects/``).
        The base implementation yields nothing.
        """
        return iter([])

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        """Count records from the external source.

        Override when ``_external_source_iter`` is overridden so that
        ``discovery_items_count()`` — and therefore progress-bar totals — stay accurate.
        """
        return 0

    @classmethod
    def _external_source_find_one(cls: type[T], uid: str) -> T | None:
        """O(1) lookup in the external source by uid.

        Override alongside ``_external_source_iter`` so that ``discover_one()``
        can find records that live outside records_root without a full scan.
        """
        return None

    @classmethod
    def discover(cls: type[T], scope: Scope | None = None, **kwargs: Any) -> list[T]:
        """Find all records of this type on disk.

        Default implementation: directory-scan of ``records_root / <type> /``,
        then appends any records from ``_external_source_iter()`` (deduped by id).
        Source-file-backed records override this to parse their source file.

        Parameters:
            scope: optional scope filter (not used by default scan)
            **kwargs: passed to subclass overrides
        """
        return list(cls.discover_iter(scope=scope, **kwargs))

    @classmethod
    def discovery_items_count(cls, limit: int | None = None) -> int:
        """Return the number of discoverable items for this record type.

        Base implementation: counts subdirectories in ``records_root / _record_type /``
        plus any items reported by ``_external_source_count()``.
        Subclasses that fully override ``discover()`` should also override this method.

        Raises NotImplementedError if ``_record_type`` is empty and no override is
        provided — callers should treat that as "unknown" and fall back to a full scan.
        """
        record_type = str(getattr(cls, "_record_type", ""))
        if not record_type:
            raise NotImplementedError(
                f"{cls.__name__}.discovery_items_count() not implemented — "
                "override this method or set _record_type"
            )
        type_dir = get_default_records_root() / record_type
        count = sum(1 for e in type_dir.iterdir() if e.is_dir() and _NAME_SEP in e.name) if type_dir.is_dir() else 0
        count += cls._external_source_count()
        return min(count, limit) if limit is not None else count

    @classmethod
    def discover_iter(cls: type[T], limit: int | None = None, scope: Scope | None = None, **kwargs: Any):
        """Lazy generator — yields one Record at a time without building a full list.

        Phase 1: records_root directory scan (standard storage).
        Phase 2: ``_external_source_iter()`` with seen-id dedup (O(1) per record).

        Callers can emit progress events without waiting for all records to load.
        Subclasses that fully replace discovery should override this method directly.
        """
        record_type = str(getattr(cls, "_record_type", ""))
        if not record_type:
            # Fallback: wrap discover() lazily — no external source in this path
            count = 0
            for rec in cls._records_root_discover(scope=scope, **kwargs):
                yield rec
                count += 1
                if limit is not None and count >= limit:
                    return
            return

        seen_ids: set[str] = set()
        count = 0

        # Phase 1: records_root
        type_dir = get_default_records_root() / record_type
        if type_dir.is_dir():
            for entry in sorted(type_dir.iterdir()):
                if not entry.is_dir() or _NAME_SEP not in entry.name:
                    continue
                # Skip folders with no data file (no metadata.json and no migratable old format)
                meta_file = entry / _META_JSON
                if not meta_file.exists() and _migrate_old_format(entry) is None:
                    continue
                try:
                    rec = cls.load_record(entry)
                    seen_ids.add(rec.id)
                    yield rec
                    count += 1
                    if limit is not None and count >= limit:
                        return
                except (json.JSONDecodeError, OSError, ValueError):
                    continue

        # Phase 2: external source (deduped)
        remaining = None if limit is None else max(0, limit - count)
        for rec in cls._external_source_iter(limit=remaining):
            if rec.id not in seen_ids:
                seen_ids.add(rec.id)
                yield rec
                count += 1
                if limit is not None and count >= limit:
                    return

    @classmethod
    def _records_root_discover(cls: type[T], scope: Scope | None = None, **kwargs: Any):
        """Internal: yield records from records_root only (no external source).

        Used by the no-_record_type fallback path in discover_iter().
        """
        record_type = getattr(cls, "_record_type", "") or cls().type
        if not record_type:
            return

        records_root = get_default_records_root()
        type_dir = records_root / record_type
        if not type_dir.is_dir():
            return

        for entry in sorted(type_dir.iterdir()):
            if not entry.is_dir() or _NAME_SEP not in entry.name:
                continue
            meta_file = entry / _META_JSON
            if meta_file.exists():
                try:
                    yield cls.load_record(entry)
                except (json.JSONDecodeError, OSError, ValueError):
                    continue
                continue
            # Try migrating old format
            migrated = _migrate_old_format(entry)
            if migrated is None:
                continue
            try:
                rec = cls.load_record(entry)
                rec.path = str(entry)
                yield rec
            except (json.JSONDecodeError, OSError, ValueError):
                continue

    @classmethod
    def discover_one(cls: type[T], uid: str, scope: Scope | None = None, **kwargs: Any) -> T | None:
        """Find a single record by uid.

        Tries records_root first (O(1) path lookup), then ``_external_source_find_one()``.
        """
        record_type = getattr(cls, "_record_type", "") or cls().type
        if not record_type:
            return None

        # O(1) records_root lookup
        records_root = get_default_records_root()
        stem = record_stem(record_type, uid)
        folder = records_root / record_type / stem
        if folder.is_dir():
            meta_file = folder / _META_JSON
            if meta_file.exists():
                try:
                    return cls.load_record(folder)
                except (json.JSONDecodeError, OSError):
                    return None
            # Try migrating old format
            migrated = _migrate_old_format(folder)
            if migrated is not None:
                try:
                    return cls.load_record(folder)
                except (json.JSONDecodeError, OSError):
                    return None
            # fall through to external source

        # O(1) external source lookup
        return cls._external_source_find_one(uid)

    # ── State cache ───────────────────────────────────────────────────────

    def _get_state(self) -> "Any":
        """Lazy-load RecordState (reads state.json on first access)."""
        if not hasattr(self, "_state_cache") or self._state_cache is None:
            from .record_state import RecordState
            object.__setattr__(self, "_state_cache", RecordState(self))
            self._state_cache.load()
        return self._state_cache

    def _load_split_format(self, folder: Path) -> None:
        """Read metadata.json from *folder* into direct instance attrs.

        metadata.json holds ALL record fields (no meta/domain split).
        Uses the wrapped ``{"data": {...}}`` format.

        Named FSRef children (``data/<key>.json``) are merged last and always win.

        If metadata.json is corrupt, identity is recovered from the folder name
        (``<type>-@<uid>``) and a valid metadata.json is written back so that
        subsequent loads use the same stable id (heal-on-read).
        """
        meta_file = folder / _META_JSON
        # Legacy domain blob location (read-only migration — never written)
        domain_file = folder / "_obj_data.json"

        merged: dict = {}
        meta_failed = False

        # 1. Read legacy domain blob first (lowest priority)
        if domain_file.exists():
            try:
                raw = json.loads(domain_file.read_text(encoding="utf-8"))
                domain = raw.get("data", raw) if isinstance(raw, dict) else {}
                merged.update({k: v for k, v in domain.items() if k not in _FS_SYNC_SKIP})
            except (json.JSONDecodeError, OSError):
                pass

        # 2. Read metadata.json (wins over legacy domain blob)
        if meta_file.exists():
            try:
                from flow_sdk.fs_store.fs_ref import JSONFsRef as _JSONFsRef
                meta_ref = _JSONFsRef(meta_file)
                merged.update(meta_ref.as_dict())
            except (json.JSONDecodeError, OSError):
                meta_failed = True

        # 3. Rehydrate named FSRef children (highest priority — live in record folder)
        _fsref_keys = getattr(type(self), "_domain_fsref_keys", [])
        for key in _fsref_keys:
            named_p = folder / f"{key}.json"
            if named_p.exists():
                try:
                    raw = json.loads(named_p.read_text(encoding="utf-8"))
                    merged[key] = raw.get("data", raw) if isinstance(raw, dict) else raw
                except (ValueError, OSError):
                    pass

        # Heal: if metadata.json was corrupt, recover identity from folder name
        # and rewrite metadata.json so all future loads get the same stable id.
        if meta_failed:
            try:
                _, uid = parse_record_stem(folder.name)
                merged.setdefault("id", uid)
                merged.setdefault("type", getattr(type(self), "_record_type", "") or "")
                meta_file.write_text(
                    json.dumps({"data": merged}, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
            except (ValueError, OSError):
                pass  # folder name unparseable or disk error — id stays as auto-UUID

        if merged:
            # Extract asset_ref before constructing — not a data field
            _asset_ref_path = merged.pop("asset_ref", None)
            loaded = self.__class__.from_dict(merged)
            # Copy all instance attrs from loaded into self (except private ones)
            loaded_d = object.__getattribute__(loaded, "__dict__")
            self_d = object.__getattribute__(self, "__dict__")
            for k, v in loaded_d.items():
                if not k.startswith("_") and k not in ("fs_sync",):
                    self_d[k] = v
            object.__setattr__(self, "_dirty_keys", set())
            if _asset_ref_path:
                from .fs_ref import FSRef as _FSRef
                object.__setattr__(self, "_asset_ref", _FSRef(_asset_ref_path, read_only=self._is_read_only()))  # type: ignore[arg-type]

    def _reload_from_disk(self) -> None:
        """Re-read record data from disk into instance attrs. Called by discovery()."""
        # For FOLDER layout with path set, use split format
        if self.path:
            folder = Path(self.path)
            meta_file = folder / _META_JSON
            if meta_file.exists():
                self._load_split_format(folder)
                return
            # Fall back: try migrating from old data.json
            dj = folder / "data.json"
            if dj.exists():
                try:
                    raw = json.loads(dj.read_text(encoding="utf-8"))
                    domain = raw.get("data", raw)
                    for k in _OLD_META_FIELDS:
                        domain.pop(k, None)
                    for k, v in domain.items():
                        if k not in _FS_SYNC_SKIP:
                            object.__setattr__(self, k, v)
                except (json.JSONDecodeError, OSError):
                    pass
                return

        # FILE layout: read source_file
        target = Path(self.source_file) if self.source_file else None
        if target and target.exists():
            try:
                raw = json.loads(target.read_text(encoding="utf-8"))
                domain = raw.get("data", raw)
                for k in _OLD_META_FIELDS:
                    domain.pop(k, None)
                for k, v in domain.items():
                    if k not in _FS_SYNC_SKIP:
                        object.__setattr__(self, k, v)
            except (json.JSONDecodeError, OSError):
                pass

    def discovery(self, force: bool = False, recursive: bool = False) -> "Record":
        """Discover this record.

        force=False (default):
            - If already discovered (state.json exists): skip reloading data.json,
              but still check and refresh any expired property TTLs.
            - If not yet discovered: full scan (same as force=True).
        force=True:
            - Always re-read data.json from disk.
            - Re-run all registered PropertyRecord discoveries.
        recursive=True:
            - After discovering self, propagate to all children.

        Returns self for chaining.
        """
        index = self._get_state()
        already_discovered = index.is_discovered()

        # 1. Reload domain data only when needed
        if force or not already_discovered:
            if self.source_file or self.path:
                self._reload_from_disk()

        # 2. Collect _property_types from the MRO (own dicts only, no duplicates)
        prop_descriptors: dict[str, Any] = {}
        for cls in type(self).__mro__:  # type: ignore[misc]
            for k, v in cls.__dict__.get("_property_types", {}).items():
                prop_descriptors.setdefault(k, v)

        # 3. Run each descriptor — always on first discovery or when force=True;
        #    on subsequent calls, only re-run expired entries
        for key, descriptor in prop_descriptors.items():
            entry = index.get_property(key)
            should_run = force or entry is None or descriptor.is_expired(entry)
            if should_run:
                value = descriptor.run_discovery(self, force=force)
                index.set_property(key, descriptor.to_index_entry(value))

        # 4. Mark discovered and persist
        if not already_discovered or index._dirty:
            index.mark_discovered()
            index.save()

        # 5. Recurse into children if requested
        if recursive:
            for child in self.children:
                child.discovery(force=force, recursive=True)

        return self

    def get_prop(self, key: str) -> Any:
        """TTL-aware property getter.

        If a PropertyRecord descriptor is registered for *key*:
            - check TTL; if expired → auto-run discovery, persist, return new value.
        If no descriptor is registered:
            - fall back to getattr(self, key, None).
        """
        # Find descriptor in MRO
        descriptor = None
        for cls in type(self).__mro__:  # type: ignore[misc]
            pt = cls.__dict__.get("_property_types", {})
            if key in pt:
                descriptor = pt[key]
                break

        if descriptor is None:
            return getattr(self, key, None)

        index = self._get_state()
        entry = index.get_property(key)

        if entry is None or descriptor.is_expired(entry):
            value = descriptor.run_discovery(self, force=True)
            entry = descriptor.to_index_entry(value)
            index.set_property(key, entry)
            index.save()

        return descriptor.get_value(entry)

    def sync_from_entity(self, entity) -> bool:
        """Write Entity metadata back to this Record's _data.

        Uses db_json() — the same contract as SQLite storage — so only
        public, non-excluded, non-None fields are merged.  Private fields
        (prefixed with ``_``), db-excluded fields, and ``None``-valued
        fields are ignored.

        No-op for read-only records or FILE layout records (where source_file
        is a domain-format file like settings.json rather than metadata.json).

        Returns True if the record was saved, False otherwise.
        """
        if self._is_read_only():
            return False
        # Skip for source-file sub-records (those with a json_path).  Their
        # content is managed by a JsonFileRecordStore; calling save() here
        # would overwrite the entire source file with the wrapped {"data": ...}
        # format instead of patching only the sub-block.
        jp = object.__getattribute__(self, "__dict__").get("json_path")
        if jp is not None:
            return False
        # record_folder_ref always resolves to records_root shadow — never an
        # external directory. save() targets it directly, so no path hacks needed.
        metadata = entity.db_json()
        # Only write to disk when entity state actually adds or changes fields in
        # the record — avoids 3-4 file writes per record on bulk re-index runs
        # (sessions, skills, etc.) when nothing has changed.
        changed = {k: v for k, v in metadata.items() if getattr(self, k, None) != v}
        self.write_hash_file(self.content_fingerprint)
        if not changed:
            return False
        for k, v in changed.items():
            # Skip read-only class-level properties (no setter) — Python 3.13
            # raises AttributeError when object.__setattr__ is called on them.
            prop = next(
                (klass.__dict__.get(k) for klass in type(self).__mro__ if k in klass.__dict__),
                None,
            )
            if isinstance(prop, property) and prop.fset is None:
                continue
            object.__setattr__(self, k, v)
        self.save()
        return True

    def persist(self) -> None:
        """Save this record using the strategy appropriate for its type.

        For owned records: delegates to ``save()``.
        Subclasses (source-file records) may override to write back
        to their source file.
        """
        self.save()

    def read_record(self, path: Path) -> None:
        """Populate this record's fields from *path*.

        The default implementation reads JSON and calls from_dict.
        Subclasses may override (e.g. to parse YAML or JSONL).

        Raises ``ValueError`` if the file is empty or contains invalid JSON
        (can happen when concurrent writers haven't finished flushing).
        """
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            raise ValueError(f"Empty record file: {path}")
        raw = json.loads(text)
        # Support wrapped format {"data": {...}}
        data = raw.get("data", raw) if isinstance(raw, dict) else raw
        loaded = self.__class__.from_dict(data)
        # Copy all instance attrs from loaded into self (except private ones)
        loaded_d = object.__getattribute__(loaded, "__dict__")
        self_d = object.__getattribute__(self, "__dict__")
        for k, v in loaded_d.items():
            if not k.startswith("_") and k not in ("fs_sync",):
                self_d[k] = v
        object.__setattr__(self, "_dirty_keys", set())
        if loaded._source_file:
            object.__setattr__(self, "_source_file", loaded._source_file)
        if loaded._path:
            object.__setattr__(self, "_path", loaded._path)

    # -- Write / Save --

    def write_record(self, path: Path, indent: int = 2) -> None:
        """Write this record to *path*.

        Raises ReadOnlyRecordError if the record type is read-only.
        """
        from .exceptions import ReadOnlyRecordError
        if self._is_read_only():
            raise ReadOnlyRecordError(
                f"{self.__class__.__name__} is read-only and cannot be written"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), indent=indent, ensure_ascii=False),
            encoding="utf-8",
        )

    def save_record_json(self, path: str | Path | None = None, indent: int = 2) -> None:
        """Write this record to disk in wrapped ``{"data": {...}}`` format.

        If *path* points to a specific ``.json`` file, the record is written
        directly to that file (compat mode).  When *path* is a directory or
        ``metadata.json``, the full split-format save is used and
        ``source_file`` is updated to the resulting ``metadata.json`` path.
        """
        from .exceptions import ReadOnlyRecordError
        if self._is_read_only():
            raise ReadOnlyRecordError(
                f"{self.__class__.__name__} is read-only and cannot be written"
            )
        p = Path(path or self.source_file)
        if p.suffix == ".json" and p.name != _META_JSON:
            # Write directly to the given .json file (compat / simple file mode).
            p.parent.mkdir(parents=True, exist_ok=True)
            data = self.to_dict()
            from flow_sdk.fs_store.fs_ref import JSONFsRef as _JSONFsRef
            _JSONFsRef(p).write(
                __import__("json").dumps({"data": data}, indent=indent, ensure_ascii=False)
            )
            self.source_file = str(p)
        else:
            folder = p.parent if p.suffix == ".json" else p
            folder.mkdir(parents=True, exist_ok=True)
            meta_file = self._save_split_format(folder, indent=indent)
            self.source_file = str(meta_file)

    def _save_split_format(self, folder: Path, indent: int = 2) -> Path:
        """Write metadata.json into *folder* (all _data fields, no split).

        All record data goes into metadata.json — no meta/domain partitioning.
        Named FSRef children (_domain_fsref_keys) are additionally written to
        individual ``data/<key>.json`` files for O(1) access.

        Returns the metadata.json path.
        """
        folder.mkdir(parents=True, exist_ok=True)
        data = self.to_dict()

        # Persist asset_ref path in metadata so cold load restores it
        try:
            _asset_ref = object.__getattribute__(self, "_asset_ref")
        except AttributeError:
            _asset_ref = None
        if _asset_ref is not None:
            data["asset_ref"] = _asset_ref.path

        # Write named FSRef children directly in the record folder (excluded from metadata.json)
        _fsref_keys = set(getattr(type(self), "_domain_fsref_keys", []))
        for key in sorted(_fsref_keys):
            if key in data:
                named_path = folder / f"{key}.json"
                named_path.write_text(
                    json.dumps({"data": data.pop(key)}, indent=indent, ensure_ascii=False),
                    encoding="utf-8",
                )

        from flow_sdk.fs_store.fs_ref import JSONFsRef as _JSONFsRef
        meta_ref = _JSONFsRef(folder / _META_JSON)
        meta_ref.write(json.dumps({"data": data}, indent=indent, ensure_ascii=False))
        meta_file = Path(meta_ref.path)

        return meta_file

    def save(self) -> None:
        """Save to disk, auto-assigning a default path if needed.

        Write strategy (in priority order):
        1. If ``_record_folder_ref`` is explicitly set → write to that folder.
        2. If ``source_file`` is a specific ``.json`` file (not metadata.json)
           → write back to that file via ``save_record_json(source_file)`` and
           update ``_get_state()`` / manifest.
        3. If ``record_folder_ref`` auto-resolves via ``default_path`` → write
           to that folder (folder-layout, records_root shadow).
        4. No path available → raise ValueError.

        External-backed records (skills, ~/.claude/ projects) always have
        ``_record_folder_ref`` set explicitly to a records_root shadow folder,
        so they never fall through to the source_file branch.
        """
        from .exceptions import ReadOnlyRecordError
        if self._is_read_only():
            raise ReadOnlyRecordError(
                f"{self.__class__.__name__} is read-only and cannot be saved"
            )
        sf = self.source_file
        if sf:
            p = Path(sf)
            if p.suffix == ".json" and p.name != _META_JSON:
                # Simple file-mode: write directly to source_file
                first_save = not p.exists()
                self.save_record_json(p)
                # Determine folder for state/manifest
                folder = p.parent
                self._get_state().save(meta=self.to_dict())
                if self.path and folder == Path(self.path):
                    self._bump_manifest("add" if first_save else "update")
                return

        # All other cases: write to shadow folder via metadata_ref
        folder = Path(self.metadata_ref.path)
        first_save = not folder.exists()
        meta_file = self._save_split_format(folder)
        self.path = str(folder)
        self.source_file = str(meta_file)
        state_meta = self.to_dict()
        try:
            _asset_ref = object.__getattribute__(self, "_asset_ref")
        except AttributeError:
            _asset_ref = None
        if _asset_ref is not None:
            state_meta["asset_ref"] = _asset_ref.path
        self._get_state().save(meta=state_meta)
        self._bump_manifest("add" if first_save else "update")

    # -- Auto-sync (fs_sync behavior from FsRecord) --

    def _auto_sync(self, field_name: str) -> None:
        """If fs_sync is enabled and source_file is set, auto-save."""
        if (
            field_name not in _FS_SYNC_SKIP
            and not field_name.startswith("_")
            and getattr(self, "fs_sync", False)
            and self.source_file
        ):
            self.save()

    # -- Live relationship properties --

    @property
    def parent(self) -> Record | None:
        """Load the parent record from disk via parent_ref.path."""
        if self.parent_ref is None or not self.parent_ref.path:
            return None
        p = Path(self.parent_ref.path)
        if not p.exists():
            return None
        return Record.load_record(p)

    @property
    def children(self) -> list[Record]:
        """Load child records from disk via each ref's path."""
        result: list[Record] = []
        for ref in self.children_refs:
            if not ref.path:
                continue
            p = Path(ref.path)
            if not p.exists():
                continue
            result.append(Record.load_record(p))
        return result

    def get_children_by_type(self, type: str) -> list[Record]:
        """Load child records filtered by type."""
        from .factory.type_registry import type_registry

        result: list[Record] = []
        for ref in self.children_refs:
            if not ref.path:
                continue
            p = Path(ref.path)
            if not p.exists():
                continue
            target_cls = type_registry.get(type) or Record
            child = target_cls.load_record(p)
            if child.type == type:
                result.append(child)
        return result

    def add_child(self, child: "Record | RecordRef") -> RecordRef:
        """Append a child ref without creating/modifying child files."""
        ref = child if isinstance(child, RecordRef) else RecordRef.from_record(child)
        existing = list(object.__getattribute__(self, "__dict__").get("children_list", []))
        if not any(
            (isinstance(e, dict) and e.get("id") == ref.id and e.get("type") == ref.type)
            for e in existing
        ):
            existing.append(ref.to_dict())
            object.__setattr__(self, "children_list", existing)
            dirty = object.__getattribute__(self, "_dirty_keys")
            dirty.add("children")
            if self.source_file:
                self.save()
        return ref

    # -- Clone / Move / Delete --

    def clone(self, new_path: str | Path) -> Record:
        """Create a copy with a new id at new_path.

        For directory (FOLDER) targets, writes metadata.json + _obj_data.json.
        For explicit .json file targets, writes a single data.json.
        """
        from .exceptions import ReadOnlyRecordError

        if self._is_read_only():
            raise ReadOnlyRecordError(
                f"{self.__class__.__name__} is read-only and cannot be cloned"
            )
        cloned = copy.deepcopy(self)
        object.__setattr__(cloned, "id", str(uuid.uuid4()))
        cloned.origin_ref = RecordRef.from_record(self)
        p = Path(new_path)
        if p.is_dir() or not p.suffix:
            # FOLDER layout — write split format
            cloned.path = str(p)
            meta_file = cloned._save_split_format(p)
            cloned.source_file = str(meta_file)
        else:
            cloned.path = None
            cloned.save_record_json(p)
        return cloned

    def move(self, new_path: str | Path) -> None:
        """Relocate this record to new_path.

        For directory (FOLDER) targets, writes metadata.json + _obj_data.json.
        For explicit .json file targets, writes a single data.json.
        """
        from .exceptions import ReadOnlyRecordError

        if self._is_read_only():
            raise ReadOnlyRecordError(
                f"{self.__class__.__name__} is read-only and cannot be moved"
            )
        old_record_dir = self.record_dir
        p = Path(new_path)
        if p.is_dir() or not p.suffix:
            # FOLDER layout — write split format
            self.path = str(p)
            meta_file = self._save_split_format(p)
            self.source_file = str(meta_file)
        else:
            self.path = None
            self.save_record_json(p)
        if old_record_dir and old_record_dir.exists() and old_record_dir != p:
            shutil.rmtree(old_record_dir, ignore_errors=True)

    async def delete(self, delete_ref: bool = False) -> None:
        """Remove this record from disk, its Entity DB row, and FTS index entry.

        Args:
            delete_ref: If True, also delete the asset_ref folder (e.g. the live
                        skill directory at ~/.claude/skills/<name>/).
        """
        try:
            await self.unindex()
        except Exception:
            pass
        rd = self.record_dir
        if rd and rd.exists():
            shutil.rmtree(rd, ignore_errors=True)
        elif self.source_file:
            Path(self.source_file).unlink(missing_ok=True)
        if delete_ref:
            ar = self.asset_ref
            if ar is not None and ar._path.exists():
                shutil.rmtree(ar._path, ignore_errors=True)
        self._bump_manifest("remove")
        self.source_file = None
        self.path = None

    # -- Semantic search / indexing ------------------------------------------

    @property
    def search_content(self) -> str | None:
        """Text content to embed for semantic search.

        Returns ``None`` by default — subclasses override to opt into indexing.
        When ``None``, this record is never indexed.
        """
        return None

    @property
    def search_title(self) -> str | None:
        """Short title for FTS indexing. Overrides get higher BM25 weight than content."""
        return None

    @property
    def search_description(self) -> str | None:
        """One-line description for FTS indexing."""
        return None

    _META_FIELD_KEYS: ClassVar[frozenset[str]] = frozenset({
        "id", "type", "name", "status",
        "created_date", "updated_date", "scope",
    })

    def meta_dict(self) -> dict[str, Any]:
        """Return all public fields for serialization and Entity DB row construction.

        All non-None fields from to_dict() are included.  Internal fields
        (source_file, path, fs_sync, storage_layout) are excluded by to_dict().
        None-valued fields are omitted.
        """
        d = self.to_dict()
        return {k: v for k, v in d.items() if v is not None}

    def index_content(self) -> str | None:
        """Return searchable text for FTS indexing."""
        return self.search_content

    @classmethod
    def record_type(cls) -> str:
        """Return the canonical type string for this record class."""
        return cls._record_type or ""

    async def unindex(self) -> None:
        """Remove the corresponding Entity DB row + FTS entry."""
        from flow_sdk.core.entity.entity_model import Entity  # lazy import (circular)
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

        entity = await Entity.get_one(QueryFilter.parse({"id": self.id}))
        if entity is not None:
            from flow_sdk.db import get_db_driver
            driver = get_db_driver()
            if hasattr(driver, "fts_delete"):
                await driver.fts_delete(entity.id)
            await entity.delete()

    async def sync_to_db(self, fts_batch: "list | None" = None, notify: bool = True) -> None:
        """Create or update the corresponding Entity in SQLite.

        If ``fts_batch`` is provided the FtsEntry is appended to it instead of
        being written immediately — callers can flush a whole batch in one
        connection via ``driver.fts_upsert(fts_batch)``.

        On failure, saves a RecordError to disk and re-raises so callers can count/log.
        """
        from flow_sdk.core.entity.entity_model import Entity  # already lazy-imported

        try:
            # Step 1: Entity row (delegates to Entity.from_record)
            entity = await Entity.from_record(self, notify=notify)

            # Write entity's db_json() back to metadata.json so disk reflects entity state,
            # then write the hash sentinel (sync_from_entity handles both).
            import asyncio as _asyncio
            await _asyncio.to_thread(self.sync_from_entity, entity)

            # Step 2: FTS upsert — use record's search fields directly (already in memory)
            from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
            entry = FtsEntry(
                entity_id=entity.id,
                entity_type=entity.type,
                name=self.name or None,
                title=self.search_title,
                description=self.search_description,
                content=self.search_content,
            )
            if fts_batch is not None:
                fts_batch.append(entry)
            else:
                from flow_sdk.db import get_db_driver
                driver = get_db_driver()
                if hasattr(driver, "fts_upsert"):
                    await driver.fts_upsert(entry)
        except Exception as exc:
            from flow_sdk.fs_records.record_error import RecordError  # lazy (circular-safe)
            RecordError.from_exception(self, exc, trigger="sync_to_db").save()
            raise

    def _bump_manifest(self, op: str) -> None:
        """Update collection manifest if record is under default records root."""
        record_type = self.type
        if not record_type:
            return
        records_root = get_default_records_root()
        record_path = Path(self.path) if self.path else None
        if record_path is None:
            return
        try:
            record_path.relative_to(records_root / record_type)
        except ValueError:
            return  # Not under default root, skip manifest update
        from .manifest import CollectionManifest
        CollectionManifest(record_type).bump(op)

    def open(self) -> None:
        """Open this record's folder in the native OS file explorer."""
        folder = self.record_dir
        if folder is None:
            raise ValueError("No path or source_file set")
        system = platform.system()
        if system == "Darwin":
            subprocess.Popen(["open", str(folder)])
        elif system == "Windows":
            subprocess.Popen(["explorer", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(id={self.id!r}, type={self.type!r}, name={self.name!r})"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Record):
            return NotImplemented
        return self.id == other.id and self.type == other.type

    def __hash__(self) -> int:
        return hash((self.id, self.type))
