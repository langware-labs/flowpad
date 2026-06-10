"""FSRecord — the lean filesystem manifest for an Entity's on-disk shadow.

Replaces ``Record``. Construct as ``FSRecord(type, id)``; the shadow
lives at ``<records_root>/<type>/<type>-@<id>/metadata.json``. Holds the
asset_ref (FSRef to the user-facing source file) and a free-form
collection of meta fields as direct instance attributes (default).
Per-type typed metadata models are opt-in via ``TypeInfo.meta_model``.

All per-type behavior lives in free functions registered on
``TypeInfo`` (from_disk_fn, gen_id_fn, asset_hash_fn, post_sync_fn,
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

import json
import uuid
from pathlib import Path
from typing import Any, ClassVar, Generic, TypeVar

from flow_sdk.fs_store.fs_ref import FSRef


M = TypeVar("M")  # meta model — dict view by default; Pydantic models opt-in via TypeInfo.meta_model


# Canonical naming. <type>-@<uid> as folder name under records_root/<type>/.
_NAME_SEP = "-@"
_METADATA_JSON = "metadata.json"
# The single per-record index sentinel. Two on-disk shapes:
#   legacy  ``<int_epoch>_<contenthash>.hash``
#   current ``<int_epoch>_<contenthash>_<pathdigest>.hash``
# The trailing ``<pathdigest>`` makes freshness location-aware so a relocated
# source (same bytes, new path) re-indexes and re-anchors its ``asset_ref``.
_HASH_GLOB = "*.hash"

# Instance attribute names that don't belong in serialized meta (system state).
_SYSTEM_ATTRS: frozenset[str] = frozenset({"type", "id", "_asset_ref"})


def record_stem(record_type: str, uid: str) -> str:
    return f"{record_type}{_NAME_SEP}{uid}"


def parse_record_stem(stem: str) -> tuple[str, str]:
    if _NAME_SEP not in stem:
        raise ValueError(f"Invalid record stem: {stem!r}")
    rt, uid = stem.split(_NAME_SEP, 1)
    return rt, uid


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
        model_cls = getattr(info, "meta_model", None) if info else None
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
    def fingerprint(self) -> str:
        """Deterministic uuid5 for (type, asset_ref). Matches Entity.allocate_id."""
        key = self._asset_ref.path if self._asset_ref else (self.__dict__.get("name") or "")
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.type}:{key}"))

    # ── FSRefs ────────────────────────────────────────────────────────────

    @property
    def shadow_dir(self) -> Path:
        """records_root/<type>/<type>-@<id>/"""
        if not self.type or self.id is None:
            raise ValueError(f"FSRecord(type={self.type!r}, id={self.id!r}) has no shadow_dir")
        return _get_default_records_root() / self.type / record_stem(self.type, self.id)

    @property
    def record_folder_ref(self) -> FSRef:
        return FSRef(self.shadow_dir)

    @property
    def metadata_ref(self) -> FSRef:
        return FSRef(self.shadow_dir / _METADATA_JSON)

    @property
    def asset_ref(self) -> FSRef | None:
        return self.__dict__.get("_asset_ref")

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
        """Alias — the 'main' file is the asset_ref."""
        return self.asset_ref

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

    # ── Save / Load ───────────────────────────────────────────────────────

    def save(self) -> Path:
        """Write metadata.json into the shadow folder. Mints id if absent."""
        if self.id is None:
            self.__dict__["id"] = self.fingerprint
        folder = self.shadow_dir
        folder.mkdir(parents=True, exist_ok=True)
        meta_path = folder / _METADATA_JSON
        meta_path.write_text(
            json.dumps(self.to_dict(), indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
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
        if self.id is None:
            self.__dict__["id"] = self.fingerprint
        folder = self.shadow_dir
        folder.mkdir(parents=True, exist_ok=True)
        meta_path = folder / _METADATA_JSON
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
            json.dumps(merged, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        return meta_path

    def save_metadata_field(self, key: str, val) -> Path:
        """Write a single metadata field (partial-merge convenience)."""
        return self.save_metadata({key: val})

    @classmethod
    def load(cls, type: str, id: str) -> "FSRecord":
        """Load by identity. Reads <records_root>/<type>/<type>-@<id>/metadata.json"""
        folder = _get_default_records_root() / type / record_stem(type, id)
        return cls.load_record(folder)

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
        deterministic shadow path ``<records_root>/<type>/<type>-@<id>/`` for each
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
            folder = type_dir / record_stem(type_dir.name, id)
            if (folder / _METADATA_JSON).exists():
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
        root = _get_default_records_root() / type
        if not root.is_dir():
            return []
        out: list[FSRecord] = []
        for child in root.iterdir():
            if not child.is_dir() or _NAME_SEP not in child.name:
                continue
            try:
                out.append(cls.load_record(child))
            except (FileNotFoundError, OSError, ValueError):
                continue
        return out

    @classmethod
    def count(cls, type: str) -> int:
        """Count shadow folders for ``type`` without reading/parsing any
        ``metadata.json`` — just enumerates matching directory names."""
        root = _get_default_records_root() / type
        if not root.is_dir():
            return 0
        return sum(
            1 for child in root.iterdir()
            if child.is_dir() and _NAME_SEP in child.name
        )

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
        from datetime import datetime as _dt, timezone as _tz  # noqa: PLC0415

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
        """True when the record's source asset no longer exists on disk."""
        ar = self._asset_ref
        return ar is not None and not ar.exists()

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

    def compute_asset_ref(self, scope_root: str | Path, entity) -> FSRef | None:
        """Resolve the user-facing asset location under scope_root.

        Reads ``main_subdir`` / ``main_layout`` from the registered TypeInfo.
        Returns None for types without a configured asset layout.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(self.type)
        if info is None or info.main_subdir is None:
            return None
        safe = self._safe_name(entity)
        base = Path(scope_root) / info.main_subdir
        if info.main_layout == "folder":
            # Spec-style folder types (main_file_is_asset_ref) point asset_ref at
            # the inner body file (specs/<name>/spec.md); skill/whiteboard-style
            # folder types keep asset_ref on the folder and resolve the inner
            # main_file themselves (the indexer emits the folder, not the file).
            if info.main_file and info.main_file_is_asset_ref:
                target = base / safe / info.main_file
            else:
                target = base / safe
        else:
            target = base / f"{safe}.md"
        return FSRef(target)

    @staticmethod
    def _safe_name(entity) -> str:
        # Fall back to ``title`` for types that display via title rather than
        # name (e.g. Spec) so their owned main_ref folder isn't "untitled".
        raw = (getattr(entity, "name", None) or getattr(entity, "title", None) or "").strip().lower()
        out = "".join(c if (c.isalnum() or c in "_-") else "_" for c in raw)
        return out or "untitled"

    def default_body(self, entity) -> str | None:
        """Per-type default body. Looks up ``TypeInfo.default_body_fn``."""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(self.type)
        body_fn = info.default_body_fn if info else None
        if body_fn is None:
            return None
        return body_fn(entity)

    def upsert_main_ref(self, entity) -> None:
        """Write default_body into asset_ref iff the file doesn't yet exist —
        or on EVERY save for ``owns_main_ref`` types (the entity is the file's
        sole editor, so entity-side edits must reach the on-disk source of
        truth; otherwise the next rescan would revert them).

        No-op if the record has no asset_ref OR no default_body for the type.
        Asset_ref must be under the user's scope_root — never under records_root.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        ar = self._asset_ref
        if ar is None:
            return
        info = SchemaRegistry.get(self.type)
        # For folder types whose asset_ref is the folder (skill/whiteboard), the
        # body lives at <folder>/<main_file>. Resolve the real file before the
        # existence check — the folder itself always exists, which would
        # otherwise short-circuit the first-create write.
        path = info.body_path_for(ar._path) if info else ar._path
        owns = bool(info and info.owns_main_ref)
        if path.exists() and not owns:
            return
        body = self.default_body(entity)
        if body is None:
            return
        write_text_if_changed(path, body)  # mkdirs; unchanged → don't touch mtime/index hash

    # ── DB integration ────────────────────────────────────────────────────

    async def sync_to_db(self, fts_batch: list | None = None, notify: bool = True) -> None:
        """Persist this FSRecord into the Entity DB + FTS + wiki.

        Pipeline (single shared session for cache coherence):
          1. Entity row via ``Entity.from_record(self)``
          2. mirror DB state back to metadata.json via ``sync_from_entity``
          3. FTS upsert (batched or immediate)
          4. wiki edge re-extraction
          5. type-specific ``post_sync_fn`` from ``TypeInfo``
        """
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.db import session as _db_session, get_db_driver  # noqa: PLC0415
        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.fs_store.operations.record_error import from_exception as _record_error_from_exception  # noqa: PLC0415
        from flow_sdk import wiki  # noqa: PLC0415

        try:
            async with _db_session():
                entity = await Entity.from_record(self, notify=notify)

                # Mirror entity state back to disk metadata.json (id, scope, project_id, etc.).
                import asyncio  # noqa: PLC0415
                await asyncio.to_thread(self.sync_from_entity, entity)

                # FTS — read directly from instance attrs, no per-record parse.
                entry = FtsEntry(
                    entity_id=entity.id,
                    entity_type=entity.type,
                    name=self.__dict__.get("name") or None,
                    title=self.search_title,
                    description=self.search_description,
                    content=self.search_content,
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
                if info is not None and info.post_sync_fn is not None:
                    try:
                        await info.post_sync_fn(self)
                    except Exception as post_exc:
                        import logging  # noqa: PLC0415
                        logging.getLogger(__name__).warning(
                            "post_sync_fn failed for %s:%s — %s",
                            self.type, self.id, post_exc,
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
                pass
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
        from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
        from flow_sdk.db import get_db_driver  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk import wiki  # noqa: PLC0415

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
