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

# Instance attribute names that don't belong in serialized meta (system state).
_SYSTEM_ATTRS: frozenset[str] = frozenset({"type", "id", "_asset_ref"})


def record_stem(record_type: str, uid: str) -> str:
    return f"{record_type}{_NAME_SEP}{uid}"


def parse_record_stem(stem: str) -> tuple[str, str]:
    if _NAME_SEP not in stem:
        raise ValueError(f"Invalid record stem: {stem!r}")
    rt, uid = stem.split(_NAME_SEP, 1)
    return rt, uid


def _get_default_records_root() -> Path:
    """Lazy lookup so tests can monkeypatch FS_RECORD_PATH between sessions."""
    from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415
    return get_default_records_root()


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

    # ── Asset freshness (indexer skip-fresh) ─────────────────────────────

    @classmethod
    def asset_hash_for_ref(cls, ref: FSRef | None) -> float:
        """Default file mtime. Per-type override via Entity.asset_hash classmethod."""
        if ref is None:
            return 0.0
        try:
            return ref._path.stat().st_mtime
        except OSError:
            return 0.0

    @property
    def asset_hash(self) -> float:
        """Max ``st_mtime`` of the user-facing asset. 0.0 when no asset.

        Per-type override via ``TypeInfo.asset_hash_fn`` (e.g. folder-based
        types that walk inner files like SKILL.md + skill.yaml).
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(self.type)
        asset_hash_fn = getattr(info, "asset_hash_fn", None) if info else None
        if asset_hash_fn is not None and self._asset_ref is not None:
            try:
                return float(asset_hash_fn(self._asset_ref))
            except Exception:
                return 0.0
        return self.asset_hash_for_ref(self._asset_ref)

    def is_valid(self) -> bool:
        """True when the on-disk shadow is current relative to the asset.

        Compares ``asset_hash`` to ``updated_date`` (mirrored into meta via
        ``sync_from_entity``). Returns False when either is missing or the
        asset is newer — meaning the indexer needs to re-parse.

        Records without an asset_ref (synthetic / in-memory) trivially
        validate iff type+id are populated.
        """
        from datetime import datetime as _dt, timezone as _tz  # noqa: PLC0415

        if self._asset_ref is None:
            return bool(self.type) and self.id is not None
        ah = self.asset_hash
        if ah <= 0:
            return False
        ud = self.__dict__.get("updated_date")
        if ud is None:
            return False
        if hasattr(ud, "timestamp"):
            dt = ud if getattr(ud, "tzinfo", None) is not None else ud.replace(tzinfo=_tz.utc)
            stored_ts = dt.timestamp()
        elif isinstance(ud, str):
            try:
                dt = _dt.fromisoformat(ud.replace(" ", "T"))
            except ValueError:
                return False
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=_tz.utc)
            stored_ts = dt.timestamp()
        else:
            try:
                stored_ts = float(ud)
            except (TypeError, ValueError):
                return False
        return ah <= stored_ts

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
        target = base / safe if info.main_layout == "folder" else base / f"{safe}.md"
        return FSRef(target)

    @staticmethod
    def _safe_name(entity) -> str:
        raw = (getattr(entity, "name", None) or "").strip().lower()
        out = "".join(c if (c.isalnum() or c in "_-") else "_" for c in raw)
        return out or "untitled"

    def default_body(self, entity) -> str | None:
        """Per-type default body. Looks up ``TypeInfo.default_body_fn``."""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(self.type)
        body_fn = getattr(info, "default_body_fn", None) if info else None
        if body_fn is None:
            return None
        return body_fn(entity)

    def upsert_main_ref(self, entity) -> None:
        """Write default_body into asset_ref iff the file doesn't yet exist.

        No-op if the record has no asset_ref OR no default_body for the type.
        Asset_ref must be under the user's scope_root — never under records_root.
        """
        ar = self._asset_ref
        if ar is None:
            return
        path = ar._path
        if path.exists():
            return
        body = self.default_body(entity)
        if body is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

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
        from flow_sdk import wiki  # noqa: PLC0415

        try:
            await wiki.delete_for_id(self.type, str(self.id))
        except Exception as wiki_exc:
            import logging  # noqa: PLC0415
            logging.getLogger(__name__).warning(
                "wiki.delete_for_id failed for %s:%s — %s",
                self.type, self.id, wiki_exc,
            )

        entity = await Entity.get_one(QueryFilter.parse({"id": self.id}))
        if entity is not None:
            driver = get_db_driver()
            if hasattr(driver, "fts_delete"):
                await driver.fts_delete(entity.id)
            await entity.delete()

    async def delete(self) -> None:
        """Unindex (entity row, FTS, wiki edges) AND remove the shadow folder on disk."""
        await self.unindex()
        import shutil  # noqa: PLC0415
        try:
            shutil.rmtree(self.shadow_dir)
        except (FileNotFoundError, OSError, ValueError):
            pass
