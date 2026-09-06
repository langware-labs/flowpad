"""FSRecord — the lean filesystem manifest for an Entity's on-disk shadow.

Replaces ``Record``. Construct as ``FSRecord(type, id)``; the shadow
lives at ``<records_root>/<type>/<id>/metadata.json``. Holds the
asset_ref (FSRef to the user-facing source file) and a free-form
collection of meta fields as direct instance attributes (default).
Per-type typed metadata models are opt-in via ``TypeInfo.meta_model``.

All per-type behavior lives in free functions registered on
``TypeInfo`` (from_disk_fn, identity backend, asset_hash_fn, post_sync_fn,
main_subdir, main_layout). FSRecord itself knows nothing about types.

The class deliberately omits the following — every one of them was
removed because callers no longer need it AND it produced more bugs
than savings:

  - state.json / RecordState / PropertyRecord lazy-cache machinery
    (per-type extractors precompute derived fields into meta)
  - raw_json field + dict-like __getitem__/__setitem__ shims
  - fs_sync auto-save on attribute mutation
  - parent_ref / children_refs / origin_ref (Entity owns parent/child
    edges via the DB)
  - discover() / get(uid) static helpers (use Entity API instead)
  - polymorphic load fallbacks for legacy on-disk formats
  - the four-path tangle (source_file / path / record_folder_ref /
    metadata_ref). One canonical location per (type, id).
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Generic, Iterator, TypeVar
from weakref import WeakValueDictionary

from pydantic import BaseModel

from flow_sdk.fs_store.fs_ref import FSRef

if TYPE_CHECKING:
    from flow_sdk.fs_store.schema_registry import TypeInfo


M = TypeVar("M")  # meta model — dict view by default; Pydantic models opt-in via TypeInfo.meta_model


# Type-scoped shadow store: a record lives at ``records_root/<type>/<id>/`` — a
# BARE id under a ``<type>/`` parent (the parent dir already scopes the type, so
# the name carries no redundant prefix and no uname ``@``). The self-describing
# ``<type>-<id>`` stem (``record_stem``, re-exported below) is only for flat /
# portable namespaces (bundles, staging, VFS).
_METADATA_JSON = "metadata.json"
# The single per-record index sentinel. Two on-disk shapes:
#   legacy  ``<int_epoch>_<contenthash>.hash``
#   current ``<int_epoch>_<contenthash>_<pathdigest>.hash``
# The trailing ``<pathdigest>`` makes freshness location-aware so a relocated
# source (same bytes, new path) re-indexes and re-anchors its ``asset_ref``.
_HASH_GLOB = "*.hash"

# Instance attribute names that don't belong in serialized meta (system state).
_SYSTEM_ATTRS: frozenset[str] = frozenset({"type", "id", "_asset_ref"})

# Entity.save is DB -> disk while FSRecord.sync_to_db is disk -> DB.  They must
# not observe the same record between those two stores.  Locks are loop-scoped
# (asyncio locks cannot cross pytest/server event loops) and weakly held so a
# long-lived server does not retain one lock for every record it ever touched.
_RECORD_SYNC_LOCKS: "WeakValueDictionary[tuple[object, str, str], asyncio.Lock]" = (
    WeakValueDictionary()
)
#: "Do not write into the source bytes during this operation."
#:
#: Some sources own their bytes and some only READ them. A git working tree is
#: the clear second case: stamping an identity capsule into a tracked file
#: dirties the tree, is committed, and propagates our metadata to everyone who
#: pulls. Such a source resolves identity by an `origin_id` lookup instead, so
#: the carrier write is not merely unwanted — it is redundant.
#:
#: A ContextVar rather than a parameter because the write happens four layers
#: below the decision (`reflect` → `Entity.save` → `_store` → `upsert_main_ref`),
#: and threading a flag through all four would put a "may I write" argument on
#: methods that have no business asking. Same mechanism as the sync guard above.
_SUPPRESS_CARRIER_WRITE: "ContextVar[bool]" = ContextVar(
    "_SUPPRESS_CARRIER_WRITE", default=False
)


def carrier_writes_are_suppressed() -> bool:
    """Whether this operation must leave the source bytes alone.

    Public so the resolvers can ASK rather than be TOLD. A policy threaded as a
    parameter has to be passed correctly by every caller; one read from the
    operation's own context cannot be forgotten.
    """
    return _SUPPRESS_CARRIER_WRITE.get()


@contextmanager
def carrier_writes_suppressed():
    """Resolve identity without stamping it into the asset."""
    token = _SUPPRESS_CARRIER_WRITE.set(True)
    try:
        yield
    finally:
        _SUPPRESS_CARRIER_WRITE.reset(token)


_HELD_RECORD_SYNC_KEYS: "ContextVar[frozenset[tuple[object, str, str]]]" = ContextVar(
    "_held_record_sync_keys", default=frozenset()
)

# Fresh file-backed entities are keyed by their carrier path, not their random
# entity id.  Serializing that path closes the create race where two requests
# compute the same slug, both observe a missing file, and the later store
# overwrites the first.  Loop-scoped locks match ``record_sync_guard`` and are
# weakly held so the server does not retain every path it has ever created.
_CREATE_TARGET_LOCKS: "WeakValueDictionary[tuple[object, str], asyncio.Lock]" = (
    WeakValueDictionary()
)


class AssetPathCollisionError(ValueError):
    """A fresh owned asset would overwrite another entity's carrier."""


def _carrier_identity_matches(info: "TypeInfo", asset_ref: FSRef, entity_id: str) -> bool:
    """True when the carrier already on disk declares ``entity_id`` as its own.

    Reads through ``TypeInfo.extract_id`` — the one adoption gate — so identity
    here means exactly what it means everywhere else. A malformed or unreadable
    capsule is never a match: it falls through to the ordinary path check and
    the caller refuses, which is the safe direction.
    """
    try:
        return info.read_id(asset_ref) == entity_id
    except Exception:
        return False


def assert_create_target_available(
    info: "TypeInfo",
    asset_ref: FSRef,
    *,
    entity_type: str,
    name: str,
    entity_id: str | None = None,
) -> None:
    """Reject a fresh owned-asset target that already carries user data.

    ``asset_ref`` is not always the writable file: folder-backed types point at
    their directory and declare an inner ``main_file``.  TypeInfo owns that
    convention, so collision detection resolves the same carrier as the writer.
    An empty folder is adoptable; any non-empty folder or existing carrier is
    somebody else's bundle and must remain byte-identical.

    "Somebody else's" is decided by IDENTITY, not by the path being occupied.
    A carrier whose identity capsule already holds ``entity_id`` is *this*
    entity's own carrier — re-materializing it (the receive path re-creating a
    row it no longer holds, a re-scan after a local delete, or two instances
    sharing one machine's ``user_home``) must adopt it rather than refuse. The
    capsule is the authority, so an unidentified or foreign carrier still
    collides exactly as before.
    """
    carrier = info.body_path_for(asset_ref._path)
    collision = carrier.exists() or carrier.is_symlink()

    if not collision and info.main_layout == "folder":
        target_folder = info.storage_root_for(asset_ref._path)
        if target_folder.is_symlink():
            collision = True
        elif target_folder.exists():
            if not target_folder.is_dir():
                collision = True
            else:
                try:
                    collision = next(target_folder.iterdir(), None) is not None
                except OSError:
                    # An unreadable pre-existing folder is never safe to adopt.
                    collision = True

    if collision:
        # Only now is the identity worth a read: an occupied path that already
        # declares THIS entity is its own carrier, so adopt instead of refusing.
        if entity_id and _carrier_identity_matches(info, asset_ref, entity_id):
            return
        raise AssetPathCollisionError(
            f"An {entity_type} named '{name}' already exists in this scope"
        )


@asynccontextmanager
async def create_target_guard(info: "TypeInfo", asset_ref: FSRef):
    """Serialize the collision check and first carrier write for one path."""
    loop = asyncio.get_running_loop()
    carrier = info.body_path_for(asset_ref._path)
    try:
        path_key = str(carrier.resolve(strict=False))
    except OSError:
        path_key = str(carrier.absolute())
    lock_key = (loop, path_key)
    lock = _CREATE_TARGET_LOCKS.get(lock_key)
    if lock is None:
        lock = asyncio.Lock()
        _CREATE_TARGET_LOCKS[lock_key] = lock
    async with lock:
        yield


@asynccontextmanager
async def record_sync_guard(record_type: str, record_id: str):
    """Serialize opposite-direction DB/disk syncs for one record.

    Reentrant only in the same asyncio Task.  A child task inherits contextvars,
    so task identity is part of the held key; it must still wait for its parent
    rather than accidentally bypassing the lock.
    """
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    held_key = (task, str(record_type), str(record_id))
    held = _HELD_RECORD_SYNC_KEYS.get()
    if held_key in held:
        yield
        return

    lock_key = (loop, str(record_type), str(record_id))
    lock = _RECORD_SYNC_LOCKS.get(lock_key)
    if lock is None:
        lock = asyncio.Lock()
        _RECORD_SYNC_LOCKS[lock_key] = lock

    async with lock:
        token = _HELD_RECORD_SYNC_KEYS.set(held | {held_key})
        try:
            yield
        finally:
            _HELD_RECORD_SYNC_KEYS.reset(token)


# Single source of truth lives in record_paths; re-exported here for the callers
# that import the stem / path helpers from this module.
from flow_sdk.fs_store.record_paths import (  # noqa: E402
    data_dir_for as data_dir_for,
    is_record_dir as is_record_dir,
    parse_record_stem as parse_record_stem,
    record_stem as record_stem,
    shadow_dir_for as shadow_dir_for,
)


def write_text_if_changed(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` unless the file already holds exactly that
    content. Record freshness fingerprints are mtime+size, so a byte-identical
    rewrite would still read as "source changed" and re-arm index refreshes
    (e.g. the GET-time ``check_and_refresh_record``)."""
    try:
        if path.exists() and path.read_text(encoding="utf-8") == text:
            return
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _get_default_records_root() -> Path:
    """Lazy lookup so tests can monkeypatch FS_RECORD_PATH between sessions."""
    from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415
    return get_default_records_root()


def _digest(raw: str) -> str:
    """The one freshness-token digester — a short, filename-safe hex digest.

    Used by ``FSRecord.get_hash`` to turn any raw freshness token (an
    ``FSRef.fingerprint`` or a per-type ``asset_hash_fn`` value) into the
    bounded ``<hexdigest>`` half of the ``.hash`` sentinel filename.
    """
    import hashlib
    return hashlib.blake2b(raw.encode(), digest_size=8).hexdigest()


#: Bumped whenever a record of a type is written or removed. A corpus cache
#: (e.g. the project cwd index) keys its validity on this, so it can never serve
#: a record whose fields were rewritten in place — rewriting an EXISTING record
#: touches only its own metadata.json, which does not move the type directory's
#: mtime.
_RECORD_WRITE_GENERATION: dict[str, int] = {}


def record_write_generation(record_type: str) -> int:
    """Monotonic counter of in-process writes to ``record_type``'s corpus."""
    return _RECORD_WRITE_GENERATION.get(str(record_type), 0)


def _bump_record_write_generation(record_type: str) -> None:
    key = str(record_type)
    _RECORD_WRITE_GENERATION[key] = _RECORD_WRITE_GENERATION.get(key, 0) + 1


def _json_default(obj: Any) -> Any:
    """Encode a value ``json.dumps`` cannot handle on its own.

    A Pydantic model is dumped, not stringified. Without this a model-valued
    metadata field (a model written via ``save_metadata``) would fall to the ``str``
    fallback and be written as its **repr** — ``"kind='array' fields=None …"`` —
    which re-reads as a string and fails validation on the next load. Silent
    corruption, no exception to notice it by.

    ``mode="json"`` so nested datetimes/enums/paths inside the model encode the
    same way the DB writer encodes them, and nulls are KEPT: the top-level
    ``None`` skip in ``save_metadata`` exists to protect a partial merge, and
    there is no partial merge inside a value that is replaced wholesale.

    Everything else keeps the historical ``str`` coercion — narrowing that is a
    separate change with its own blast radius.
    """
    if isinstance(obj, BaseModel):
        return obj.model_dump(mode="json")
    return str(obj)


class FSRecord(Generic[M]):
    """Lean filesystem manifest. See module docstring."""

    # Type fallback attr read by Entity.from_record / record_error when a
    # record carries no explicit ``type``. FSRecord is the single concrete
    # record class now (no subclasses), so there is no __init_subclass__
    # auto-registration — type metadata is owned by SchemaRegistry.
    _record_type: ClassVar[str] = ""

    # ── Construction ───────────────────────────────────────────────────────

    def __init__(self, type: str = "", id: str | None = None, **fields: Any) -> None:
        # All meta lives on __dict__ as direct attrs. System state uses
        # underscore prefix or the reserved names (type, id).
        # Fall back to subclass ClassVar _record_type when explicit type missing.
        if not type:
            type = getattr(self.__class__, "_record_type", "") or ""
        self.__dict__["type"] = str(type) if type else ""
        self.__dict__["id"] = str(id) if id is not None else None
        self.__dict__["_asset_ref"] = None
        for k, v in fields.items():
            if k in ("type", "id"):
                # Skip — already set above. Caller passed them as kwargs.
                continue
            if k == "asset_ref":
                self.asset_ref = v
                continue
            self.__dict__[k] = v

    # ── Meta access ────────────────────────────────────────────────────────

    @property
    def meta(self) -> dict:
        """Read-only view of meta fields. Excludes system attrs (type, id, _asset_ref).

        If ``TypeInfo.meta_model`` is registered for this type, returns an
        instance of that Pydantic model instead of a dict.
        """
        d = {k: v for k, v in self.__dict__.items()
             if k not in _SYSTEM_ATTRS and not k.startswith("_")}
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        info = SchemaRegistry.get(self.type)
        model_cls = getattr(info, "effective_meta_model", None) if info else None
        if model_cls is not None:
            try:
                return model_cls(**d)
            except Exception:
                return d
        return d

    def meta_dict(self) -> dict:
        """Flat dict for serialization + Entity DB row construction.

        Includes type, id, asset_ref (path string), and every non-system
        instance attribute. None values omitted. _-prefixed attrs excluded.
        """
        out: dict = {"type": self.type}
        if self.id is not None:
            out["id"] = self.id
        for k, v in self.__dict__.items():
            if k in _SYSTEM_ATTRS or k.startswith("_"):
                continue
            if v is None:
                continue
            out[k] = v
        ar = self._asset_ref
        if ar is not None:
            out["asset_ref"] = ar.path
        return out

    def to_dict(self) -> dict:
        """Alias for meta_dict — kept for backward-compat with Record callers."""
        return self.meta_dict()

    @property
    def data(self) -> dict:
        """Read-only shim: return meta_dict(). Backward-compat with Record callers."""
        return self.meta_dict()

    @classmethod
    def from_dict(cls, data: dict) -> "FSRecord":
        # Legacy on-disk shape from the deleted Record class wraps the record
        # payload under a top-level ``data`` key (alongside ``meta``).
        # Unwrap so subsequent code sees a flat dict.
        if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
            payload = dict(data["data"])
        else:
            payload = data
        d = {k: v for k, v in payload.items() if v is not None}
        type_name = d.pop("type", "")
        id_val = d.pop("id", None)
        asset_ref = d.pop("asset_ref", None)
        rec = cls(type_name, id_val, **d)
        if asset_ref:
            rec._asset_ref = FSRef(asset_ref)
        return rec

    # ── Identity ──────────────────────────────────────────────────────────

    @property
    def content_fingerprint(self) -> str:
        """Deterministic uuid5 over ``(type, asset_ref or name)``.

        NOT an entity id, despite having been assigned as one until 0.2.121.
        It is a fifth identity formula that never agreed with any of the others
        — ``Entity.allocate_id`` keys ``type:rid`` under NAMESPACE_DNS, while
        this keys ``type:path`` under NAMESPACE_URL — and it can fall back to
        ``name``, so two records with the same name at unrelated paths collide.
        Entity identity comes from ``TypeInfo.mint_entity_id`` and nowhere else.
        """
        key = self._asset_ref.path if self._asset_ref else (self.__dict__.get("name") or "")
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.type}:{key}"))

    # ── FSRefs ────────────────────────────────────────────────────────────

    @property
    def shadow_dir(self) -> Path:
        """records_root/<type>/<id>/"""
        if not self.type or self.id is None:
            raise ValueError(f"FSRecord(type={self.type!r}, id={self.id!r}) has no shadow_dir")
        return shadow_dir_for(self.type, self.id)

    @property
    def record_folder_ref(self) -> FSRef:
        return FSRef(self.shadow_dir)

    @property
    def metadata_ref(self) -> FSRef:
        return FSRef(self.shadow_dir / _METADATA_JSON)

    @property
    def asset_ref(self) -> FSRef | None:
        return self.__dict__.get("_asset_ref")

    @property
    def asset_path(self) -> str:
        """The path behind ``asset_ref``; ``""`` when the record has none."""
        ref = self.asset_ref
        return ref.path if ref is not None else ""

    @asset_ref.setter
    def asset_ref(self, value: Any) -> None:
        if value is None:
            self.__dict__["_asset_ref"] = None
        elif isinstance(value, str):
            self.__dict__["_asset_ref"] = FSRef(value)
        else:
            self.__dict__["_asset_ref"] = value

    @property
    def main_ref(self) -> FSRef | None:
        """Primary content ref, including an inner file for folder assets."""
        asset_ref = self.asset_ref
        if asset_ref is None:
            return None
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        info = SchemaRegistry.get(self.type) if self.type else None
        if info is None:
            return asset_ref
        body_path = info.body_path_for(asset_ref._path)
        return asset_ref if body_path == asset_ref._path else FSRef(body_path, parent=asset_ref)

    def ensure_asset_ref(self) -> "FSRecord":
        """Bind ``asset_ref`` from the record's own mount metadata
        (``fs_storage_mount_path``/``cwd``) when not already set, so the
        index-state properties resolve for records loaded from disk. Returns
        self for chaining."""
        if self.asset_ref is None:
            mount = self.__dict__.get("fs_storage_mount_path") or self.__dict__.get("cwd")
            if mount:
                self.asset_ref = FSRef(str(mount))
        return self

    def _meta_path_for_write(self, caller: str) -> Path:
        """Shadow ``metadata.json`` path, refusing a record that has no id.

        An id-less record reaching disk used to silently mint a FIFTH identity
        formula (``content_fingerprint``), invisible to every identity guard.
        Identity comes from ``TypeInfo.mint_entity_id`` before save — the
        fallback was logged for one release and is now a hard error.
        """
        if self.id is None:
            raise ValueError(
                f"FSRecord({self.type}) reached {caller} with no id; "
                "mint through TypeInfo.mint_entity_id first"
            )
        folder = self.shadow_dir
        folder.mkdir(parents=True, exist_ok=True)
        return folder / _METADATA_JSON

    # ── Save / Load ───────────────────────────────────────────────────────

    def save(self) -> Path:
        """Write metadata.json into the shadow folder. Raises if the record has no id."""
        meta_path = self._meta_path_for_write("save()")
        meta_path.write_text(
            json.dumps(self.to_dict(), indent=2, ensure_ascii=False, default=_json_default),
            encoding="utf-8",
        )
        _bump_record_write_generation(self.type)
        return meta_path

    def current_meta_keys(self) -> set[str]:
        """Keys currently present in the on-disk metadata.json (empty if none)."""
        meta_path = self.shadow_dir / _METADATA_JSON
        if not meta_path.exists():
            return set()
        try:
            return set(json.loads(meta_path.read_text(encoding="utf-8")).keys())
        except (OSError, ValueError):
            return set()

    def save_metadata(self, patch: dict) -> Path:
        """Partial-merge ``patch`` into metadata.json — the single DB→disk writer.

        Reads the existing on-disk metadata (if any), overlays ``patch``, and
        writes once. ``None`` values in ``patch`` are skipped, so a stale field
        never clobbers a fresh on-disk one. Unmentioned keys are preserved.
        ``type``/``id`` are always anchored from the record's identity.
        """
        meta_path = self._meta_path_for_write("save_metadata()")
        merged: dict = {}
        if meta_path.exists():
            try:
                merged = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                merged = {}
        merged["type"] = self.type
        merged["id"] = self.id
        for k, v in patch.items():
            if v is None or k in _SYSTEM_ATTRS or k.startswith("_"):
                continue
            merged[k] = v
            self.__dict__[k] = v  # keep the in-memory view consistent
        meta_path.write_text(
            json.dumps(merged, indent=2, ensure_ascii=False, default=_json_default),
            encoding="utf-8",
        )
        _bump_record_write_generation(self.type)
        return meta_path

    def save_metadata_field(self, key: str, val) -> Path:
        """Write a single metadata field (partial-merge convenience)."""
        return self.save_metadata({key: val})

    def remove_metadata_keys(self, *keys: str) -> Path | None:
        """Delete keys from metadata.json (the merge-writer can't remove).

        ``save_metadata`` partial-merges — an obsolete key (e.g. a stored
        field promoted to a computed one) would otherwise live on disk
        forever and re-hydrate on every adopt. Returns the metadata path, or
        None when there is no metadata file / nothing to remove.
        """
        meta_path = self.shadow_dir / _METADATA_JSON
        if not meta_path.exists():
            return None
        try:
            merged = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        removed = False
        for k in keys:
            if k in merged:
                merged.pop(k)
                self.__dict__.pop(k, None)  # keep the in-memory view consistent
                removed = True
        if not removed:
            return None
        meta_path.write_text(
            json.dumps(merged, indent=2, ensure_ascii=False, default=_json_default),
            encoding="utf-8",
        )
        return meta_path

    @classmethod
    def load(cls, type: str, id: str) -> "FSRecord":
        """Load by identity. Reads <records_root>/<type>/<id>/metadata.json"""
        return cls.load_record(shadow_dir_for(type, id))

    @classmethod
    def load_or_none(cls, type: str, id: str) -> "FSRecord | None":
        """Like ``load`` but returns ``None`` instead of raising on a missing shadow."""
        try:
            return cls.load(type, id)
        except FileNotFoundError:
            return None

    @classmethod
    def find_by_id(cls, id: str) -> "FSRecord | None":
        """Find a record by ``id`` alone, scanning every type under records_root.

        Unlike ``load``/``load_or_none`` this needs no ``type``: it checks the
        deterministic shadow path ``<records_root>/<type>/<id>/`` for each
        type folder. Returns the single match, ``None`` when no type owns ``id``,
        and raises ``ValueError`` when more than one type has a record with this
        ``id`` (ids are unique within a type but can collide across types).
        """
        root = _get_default_records_root()
        if not root.is_dir():
            return None
        matches: list[Path] = []
        for type_dir in root.iterdir():
            if not type_dir.is_dir():
                continue
            folder = type_dir / str(id)
            if is_record_dir(folder):
                matches.append(folder)
        if not matches:
            return None
        if len(matches) > 1:
            types = ", ".join(sorted(m.parent.name for m in matches))
            raise ValueError(
                f"Ambiguous FSRecord id {id!r}: found under multiple types ({types})"
            )
        return cls.load_record(matches[0])

    @classmethod
    def load_record(cls, path: str | Path) -> "FSRecord":
        """Load from a shadow folder OR a direct metadata.json path."""
        p = Path(path)
        meta_path = p / _METADATA_JSON if p.is_dir() else p
        if not meta_path.exists():
            raise FileNotFoundError(meta_path)
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        return cls.from_dict(data)

    @classmethod
    def discover(cls, type: str) -> list["FSRecord"]:
        """Enumerate every FSRecord shadow on disk for the given type.

        Walks ``<records_root>/<type>/`` and loads each child shadow folder
        directly via ``load_record``. Missing root or malformed entries are
        skipped silently.
        """
        return list(cls.iter_discovered(type))

    @classmethod
    def iter_discovered(cls, type: str) -> "Iterator[FSRecord]":
        """Lazy :meth:`discover` — same walk, same skips, one record at a time.

        Split out so callers that only need the FIRST match (e.g.
        ``type_has_pending_changes``) don't pay to load every shadow of the
        type, without re-implementing the ``is_record_dir`` filter or the
        malformed-entry handling.
        """
        root = _get_default_records_root() / type
        if not root.is_dir():
            return
        for child in root.iterdir():
            if not is_record_dir(child):
                continue
            try:
                yield cls.load_record(child)
            except (FileNotFoundError, OSError, ValueError):
                continue

    @classmethod
    def count(cls, type: str) -> int:
        """Count shadow folders for ``type`` without reading/parsing any
        ``metadata.json`` — just enumerates matching directory names."""
        root = _get_default_records_root() / type
        if not root.is_dir():
            return 0
        return sum(1 for child in root.iterdir() if is_record_dir(child))

    # ── Index state (self-contained, on-disk, zero DB) ───────────────────
    #
    # The freshness oracle lives beside the record (its shadow_dir), never in
    # the DB — so the index layer never reads the store it produces. A single
    # ``<int_epoch>_<hexdigest>.hash`` sentinel encodes both the last-indexed
    # time and the source hash at that index. Skip-fresh is the pure equality
    # ``record_hash != indexed_hash``. Index state is for asset-backed records.

    def get_hash(self) -> str:
        """Digest of the source's current freshness token. Reuses the existing
        per-type ``TypeInfo.asset_hash_fn`` (folder types combine inner-file
        mtimes) when present; the default token is the asset ref's own
        ``fingerprint`` (mtime+size). Empty string when there is no asset."""
        if self._asset_ref is None:
            return ""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(self.type)
        fn = getattr(info, "asset_hash_fn", None) if info else None
        try:
            raw = str(fn(self._asset_ref)) if fn is not None else self._asset_ref.fingerprint
        except Exception:
            raw = self._asset_ref.fingerprint
        return _digest(raw)

    @property
    def record_hash(self) -> str:
        """Live source hash of this record's asset."""
        return self.get_hash()

    def _hash_file(self) -> Path | None:
        """The single ``*.hash`` sentinel in the shadow dir, or None."""
        if not self.type or self.id is None:
            return None
        try:
            return next(iter(self.shadow_dir.glob(_HASH_GLOB)), None)
        except OSError:
            return None

    def _indexed_parts(self) -> list[str] | None:
        """Underscore-split stem of the ``.hash`` sentinel — ``[epoch,
        contenthash, pathdigest?]`` — or None if never indexed. One glob,
        shared by the index-state properties and the hot-path
        ``index_required`` so a single probe never globs the shadow dir twice.
        The digests are underscore-free blake2b hex, so the split is unambiguous
        across the legacy 2-part and current 3-part sentinel shapes."""
        f = self._hash_file()
        return f.stem.split("_") if f is not None else None

    @property
    def indexed_hash(self) -> str | None:
        """Source content hash captured at the last index, or None if never
        indexed."""
        parts = self._indexed_parts()
        return parts[1] if parts and len(parts) >= 2 else None

    @property
    def indexed_path_digest(self) -> str | None:
        """Digest of the asset path captured at the last index (3rd sentinel
        segment), or None for a legacy 2-part sentinel (path not recorded)."""
        parts = self._indexed_parts()
        return parts[2] if parts and len(parts) >= 3 else None

    @property
    def indexed_at(self) -> str | None:
        """ISO-8601 UTC time of the last index (from the sentinel filename),
        or None if never indexed."""
        from datetime import datetime as _dt  # noqa: PLC0415
        from datetime import timezone as _tz

        f = self._hash_file()
        if f is None:
            return None
        try:
            ts = int(f.stem.split("_", 1)[0])
        except (ValueError, IndexError):
            return None
        return _dt.fromtimestamp(ts, tz=_tz.utc).isoformat()

    def _path_digest(self) -> str:
        """Digest of the current asset path (the 3rd sentinel segment). Empty
        when the record has no asset."""
        ar = self._asset_ref
        return _digest(ar.path) if ar is not None else ""

    def _persisted_asset_path(self) -> str | None:
        """The asset path recorded in this record's on-disk metadata.json, or
        None when absent/unreadable. Used only to reconcile legacy (2-part)
        sentinels that predate path-aware freshness — a one-time read per
        relocated record, not on the steady-state hot path."""
        try:
            meta_path = self.shadow_dir / _METADATA_JSON
            if not meta_path.exists():
                return None
            ar = json.loads(meta_path.read_text(encoding="utf-8")).get("asset_ref")
            return ar if isinstance(ar, str) and ar else None
        except (OSError, ValueError):
            return None

    @property
    def index_required(self) -> bool:
        """True when the source changed since the last index (or never indexed),
        OR when the source relocated (same bytes, different path).

        The freshness token (``record_hash``) is mtime+size — deliberately
        path-blind. Many relocations (wheel install, ``cp -p``, archive extract)
        preserve mtime+size, so location drift must be caught separately or a
        moved record keeps a stale ``asset_ref`` forever. The non-fresh path
        re-parses → ``sync_to_db`` → ``Entity.from_record`` re-anchors it."""
        # One glob, both fields — skip-fresh runs this per record.
        parts = self._indexed_parts()
        indexed_hash = parts[1] if parts and len(parts) >= 2 else ""
        if self.record_hash != indexed_hash:
            return True  # content changed, or never indexed
        # Content is fresh — also re-anchor on location drift.
        idx_pd = parts[2] if parts and len(parts) >= 3 else None
        if idx_pd is not None:
            return self._path_digest() != idx_pd  # cheap 3-part compare
        # Legacy 2-part sentinel: no recorded path. Reconcile against the
        # persisted metadata.json so ONLY genuinely-moved records re-index
        # (no mass reindex of unmoved records on first upgrade). The next
        # write_hash upgrades this record's sentinel to the 3-part form.
        persisted = self._persisted_asset_path()
        if persisted is None:
            return False  # can't tell — treat as fresh, no spurious reindex
        return persisted != (self._asset_ref.path if self._asset_ref else "")

    @property
    def orphan(self) -> bool:
        """True when the record's source asset is genuinely GONE from disk.

        Absence alone is not enough: an unmounted volume or a disconnected share
        makes every file under it stat as missing. ``source_unreachable`` keeps
        those out — see its docstring for the parent-directory rule.
        """
        ar = self._asset_ref
        if ar is None or ar.exists():
            return False
        from flow_sdk.fs_store.path_utils import source_unreachable  # noqa: PLC0415

        return not source_unreachable(ar.path)

    def write_hash(self) -> None:
        """Stamp the current source hash + now as the index sentinel, replacing
        any prior one. No-op for asset-less records."""
        if self._asset_ref is None or not self.type or self.id is None:
            return
        import time  # noqa: PLC0415

        folder = self.shadow_dir
        folder.mkdir(parents=True, exist_ok=True)
        self.clear_hash()
        # 3-part sentinel: ``<epoch>_<contenthash>_<pathdigest>`` so freshness
        # is location-aware (see ``index_required``).
        (folder / f"{int(time.time())}_{self.record_hash}_{self._path_digest()}.hash").touch()

    def clear_hash(self) -> None:
        """Remove the index sentinel so the record reads as never-indexed."""
        if not self.type or self.id is None:
            return
        try:
            for f in self.shadow_dir.glob(_HASH_GLOB):
                f.unlink(missing_ok=True)
        except OSError:
            pass

    @classmethod
    def type_has_pending_changes(cls, type_name: str) -> bool:
        """True if ANY record of ``type_name`` needs re-indexing.

        The per-type answer to the same question ``index_required`` answers per
        record, and the primitive the unscoped index-status path was missing:
        it reported a hardcoded ``stale=False`` for every type while the
        indexer was re-parsing thousands of records. Short-circuits on the
        first pending record, so a stale type costs one shadow read.
        """
        return any(rec.index_required for rec in cls.iter_discovered(type_name))

    @classmethod
    def clear_hashes_for_type(cls, type_name: str) -> None:
        """Drop every record's index sentinel for ``type_name`` so cleared
        records read as never-indexed. Bulk counterpart to ``clear_hash``;
        keeps the sentinel-glob knowledge in one place."""
        root = _get_default_records_root() / type_name
        if not root.is_dir():
            return
        for hf in root.glob(f"*/{_HASH_GLOB}"):
            hf.unlink(missing_ok=True)

    # ── Search (FTS) — default readers over instance attrs. Type-specific
    # extractors populate these fields directly during parser_fn. ─────────

    @property
    def search_title(self) -> str:
        return self.__dict__.get("title") or self.__dict__.get("name") or ""

    @property
    def search_content(self) -> str:
        return self.__dict__.get("content") or self.__dict__.get("body") or ""

    @property
    def search_description(self) -> str:
        return self.__dict__.get("description") or ""

    def wiki_body(self) -> str | None:
        """Body for wiki-link extraction. Default: body or content field."""
        return self.__dict__.get("body") or self.__dict__.get("content")

    # ── Asset placement (read from TypeInfo) ──────────────────────────────

    def compute_asset_ref(
        self, scope_root: str | Path, entity, *, default_worker: str = "claude"
    ) -> FSRef | None:
        """Resolve the user-facing asset location under scope_root.

        The family subdir comes from ``placement`` (``asset_class`` / ``harness``
        / ``family`` via ``_resolved_layout``), so the harness prefix
        (``.claude`` / ``.agents`` / …) is chosen by ``default_worker`` instead of
        being welded into the type. ``main_layout`` / ``main_file`` / ``main_ext``
        still own the file-vs-folder tail. Returns None for types without a
        configured asset layout. ``default_worker`` defaults to ``claude`` so
        callers that pass a bare ``scope_root`` keep today's ``.claude/*`` layout.
        """
        from flow_sdk.fs_store.placement import family_subdir  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(self.type)
        if info is None:
            return None
        subdir = family_subdir(*info._resolved_layout, default_worker=default_worker)
        if subdir is None:
            return None
        safe = self._safe_name(entity)
        base = Path(scope_root) / subdir
        if info.main_layout == "folder":
            target = base / safe
        else:
            target = base / f"{safe}{info.main_ext}"
        resolved_root = Path(scope_root).resolve()
        resolved_target = target.resolve()
        if not resolved_target.is_relative_to(resolved_root):
            raise ValueError(f"Derived {self.type} asset path escapes its scope root")
        return FSRef(resolved_target)

    @staticmethod
    def _safe_name(entity) -> str:
        # Fall back to ``title`` for types that display via title rather than
        # name (e.g. Spec) so their owned main_ref folder isn't "untitled".
        raw = (getattr(entity, "name", None) or getattr(entity, "title", None) or "").strip().lower()
        out = "".join(c if (c.isalnum() or c in "_-") else "_" for c in raw)
        return out or "untitled"

    # ── DB integration ────────────────────────────────────────────────────

    async def sync_to_db(self, fts_batch: list | None = None, notify: bool = True) -> None:
        """Persist this FSRecord into the Entity DB + FTS + wiki.

        The whole opposite-direction transition shares the same per-record
        guard as ``Entity.save``.  ``Entity.from_record`` eventually re-enters
        the guard in this same task, which is deliberately supported.
        """
        async with record_sync_guard(self.type, str(self.id)):
            await self._sync_to_db_unlocked(fts_batch=fts_batch, notify=notify)

    async def _sync_to_db_unlocked(
        self, fts_batch: list | None = None, notify: bool = True
    ) -> None:
        """Implementation of :meth:`sync_to_db`; caller owns its record guard.

        Pipeline (single shared session for cache coherence):
          1. Entity row via ``Entity.from_record(self)``
          2. mirror DB state back to metadata.json via ``sync_from_entity``
          3. FTS upsert (batched or immediate)
          4. wiki edge re-extraction
          5. type-specific ``post_sync_fn`` from ``TypeInfo``
        """
        from flow_sdk import wiki  # noqa: PLC0415
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.db import get_db_driver
        from flow_sdk.db import session as _db_session  # noqa: PLC0415
        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry  # noqa: PLC0415
        from flow_sdk.fs_store.operations.record_error import (
            from_exception as _record_error_from_exception,  # noqa: PLC0415
        )
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        try:
            async with _db_session():
                entity = await Entity.from_record(self, notify=notify)

                # Mirror entity state back to disk metadata.json (id, scope, project_id, etc.).
                import asyncio  # noqa: PLC0415
                await asyncio.to_thread(self.sync_from_entity, entity)

                # FTS — read directly from instance attrs, no per-record parse.
                entry = FtsEntry.from_record(
                    entity.id, entity.type, self.__dict__.get("name"), self
                )
                if fts_batch is not None:
                    fts_batch.append(entry)
                else:
                    driver = get_db_driver()
                    if hasattr(driver, "fts_upsert"):
                        await driver.fts_upsert(entry)

                # Wiki edges.
                try:
                    await wiki.index(self.type, self.id, self.wiki_body())
                except Exception as wiki_exc:
                    import logging  # noqa: PLC0415
                    logging.getLogger(__name__).warning(
                        "wiki.index failed for %s:%s — %s", self.type, self.id, wiki_exc,
                    )

                # Type-specific post-sync hook.
                info = SchemaRegistry.get(self.type)
                # Each callback is isolated: one observer raising must not stop the next from
                # running, any more than it stops the sync that already committed.
                for callback in info.post_sync_callbacks if info is not None else ():
                    try:
                        await callback(self)
                    except Exception as post_exc:
                        import logging  # noqa: PLC0415
                        logging.getLogger(__name__).warning(
                            "post_sync_fn %s failed for %s:%s — %s",
                            getattr(callback, "__name__", callback), self.type, self.id, post_exc,
                        )
        except Exception as exc:
            _record_error_from_exception(self, exc, trigger="sync_to_db").save()
            raise

    def sync_from_entity(self, entity) -> bool:
        """Pull canonical state (id, scope, project_id, asset_ref, updated_date)
        from DB back into instance attrs. Returns True if any field changed.
        """
        changed = False
        ent_id = getattr(entity, "id", None)
        if ent_id and self.id != str(ent_id):
            self.__dict__["id"] = str(ent_id)
            changed = True
        for field in ("scope", "project_id", "updated_date"):
            v = getattr(entity, field, None)
            if v not in (None, "") and self.__dict__.get(field) != v:
                self.__dict__[field] = v
                changed = True
        ar_str = getattr(entity, "asset_ref", None)
        if ar_str and (self._asset_ref is None or self._asset_ref.path != ar_str):
            self.__dict__["_asset_ref"] = FSRef(ar_str)
            changed = True
        # Persist the mirrored state so on-disk metadata.json reflects entity truth.
        if changed and self.type and self.id is not None:
            try:
                self.save()
            except Exception:
                logging.getLogger(__name__).warning(
                    "[record-sync] FSRecord(%s/%s) could not persist the entity mirror; "
                    "metadata.json is stale until the next sync",
                    self.type,
                    self.id,
                    exc_info=True,
                )
        return changed

    async def get_links(self) -> list:
        """Outgoing wiki links from this record."""
        from flow_sdk import wiki  # noqa: PLC0415
        return await wiki.outgoing(self.type, self.id)

    async def get_backlinks(self) -> list:
        """Inbound wiki links pointing at this record."""
        from flow_sdk import wiki  # noqa: PLC0415
        return await wiki.backlinks(self.type, self.id)

    async def unindex(self) -> None:
        """Remove the Entity row, FTS entry, and wiki edges for this record."""
        from flow_sdk import wiki  # noqa: PLC0415
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        try:
            await wiki.delete_for_id(self.type, str(self.id))
        except Exception as wiki_exc:
            import logging  # noqa: PLC0415
            logging.getLogger(__name__).warning(
                "wiki.delete_for_id failed for %s:%s — %s",
                self.type, self.id, wiki_exc,
            )

        # Query through the registered typed class — a base-``Entity`` query
        # doesn't match typed rows, which silently skipped the row delete
        # (destroy() left the entity behind).
        entity_cls = SchemaRegistry.get_entity_cls(self.type) or Entity
        entity = await entity_cls.get_one(QueryFilter.parse({"id": self.id}))
        if entity is not None:
            driver = get_db_driver()
            if hasattr(driver, "fts_delete"):
                await driver.fts_delete(entity.id)
            await entity.delete()

    async def destroy(self) -> None:
        """Erase the record's entire existence: unindex (entity row, FTS, wiki
        edges) AND remove the shadow folder on disk (metadata.json, body bundle,
        .hash sentinel — everything under ``shadow_dir``)."""
        await self.unindex()
        import shutil  # noqa: PLC0415
        try:
            shutil.rmtree(self.shadow_dir)
        except (FileNotFoundError, OSError, ValueError):
            pass

    async def delete(self) -> None:
        """Alias for :meth:`destroy` — full purge (entity row + FTS + wiki edges
        + on-disk shadow folder). Kept so existing callers don't diverge."""
        await self.destroy()
