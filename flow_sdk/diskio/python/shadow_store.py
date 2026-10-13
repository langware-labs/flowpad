"""ShadowStore — spec §7, enumeration of ``<records_root>/<type>/<id>/``.

The same walk ``FSRecord.iter_discovered`` / ``count`` and the indexer's
``_discover_records_dir_ids`` do — ``is_record_dir`` decides what a record is —
with the records root passed in and each record answered as a ``ShadowRecord``
instead of an ``FSRecord``. Sequential: ``threads`` is a cap this backend ignores.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator, Sequence

from flow_sdk.diskio.contract import FingerprintRule, ItemError, ShadowRecord, StreamEnd
from flow_sdk.diskio.python._stream import unreadable, with_end
from flow_sdk.diskio.python.prober import fingerprint, index_required, sentinel_parts
from flow_sdk.fs_store.record_paths import _METADATA_JSON, is_record_dir


def _type_dirs(root: Path, types: Sequence[str] | None) -> Iterator[Path]:
    if types is not None:
        yield from (root / name for name in types)
        return
    try:
        yield from sorted(child for child in root.iterdir() if child.is_dir())
    except OSError:
        return


def _record_dirs(type_dir: Path) -> Iterator[Path]:
    try:
        if not type_dir.is_dir():
            return
        for child in type_dir.iterdir():
            if is_record_dir(child):
                yield child
    except OSError:
        return


def _payload(data: dict) -> dict:
    """``FSRecord.from_dict``'s unwrap: the legacy shape nests the record under ``data``."""
    if "type" not in data and isinstance(data.get("data"), dict):
        return data["data"]
    return data


def _load(record_dir: Path) -> tuple[dict | None, ItemError | None]:
    meta_path = record_dir / _METADATA_JSON
    try:
        data: Any = json.loads(meta_path.read_text(encoding="utf-8"))
    except OSError as exc:
        return None, unreadable(str(meta_path), exc)
    except ValueError as exc:
        return None, ItemError(path=str(meta_path), kind="parse", detail=str(exc))
    if not isinstance(data, dict):
        return None, ItemError(path=str(meta_path), kind="parse", detail="metadata.json is not a JSON object")
    return data, None


def _sentinel_dir(root: Path, payload: dict) -> Path | None:
    """Where ``FSRecord`` looks for the sentinel: ``(metadata type, metadata id)``,
    never the enumerated folder. None when the metadata names no type or no id."""
    meta_type, meta_id = payload.get("type") or "", payload.get("id")
    if not meta_type or meta_id is None:
        return None
    return root / str(meta_type) / str(meta_id)


def _record(root: Path, type_name: str, record_dir: Path, *, load_meta: bool) -> ShadowRecord:
    data, error = _load(record_dir)
    if data is None:
        return ShadowRecord(type_name=type_name, dir_id=record_dir.name, meta_id=None, asset_ref=None,
                            fields=None, indexed_epoch=None, indexed_hash=None,
                            indexed_path_digest=None, error=error)
    payload = _payload(data)
    meta_id, asset_ref = payload.get("id"), payload.get("asset_ref")
    shadow = _sentinel_dir(root, payload)
    parts = sentinel_parts(shadow) if shadow is not None else None
    epoch: int | None = None
    if parts:
        try:
            epoch = int(parts[0])
        except ValueError:
            epoch = None
    return ShadowRecord(
        type_name=type_name,
        dir_id=record_dir.name,
        meta_id=None if meta_id is None else str(meta_id),
        asset_ref=asset_ref if isinstance(asset_ref, str) else None,
        fields=data if load_meta else None,
        indexed_epoch=epoch,
        indexed_hash=parts[1] if parts and len(parts) >= 2 else None,
        indexed_path_digest=parts[2] if parts and len(parts) >= 3 else None,
        error=None,
    )


class PyShadowStore:
    def ids(self, records_root: str, types: Sequence[str] | None) -> dict[str, tuple[str, ...]]:
        out: dict[str, tuple[str, ...]] = {}
        for type_dir in _type_dirs(Path(records_root), types):
            names = tuple(sorted(child.name for child in _record_dirs(type_dir)))
            if names:
                out[type_dir.name] = names
        return out

    def records(
        self, records_root: str, types: Sequence[str] | None, *, load_meta: bool, threads: int = 1,
    ) -> Iterator[ShadowRecord | StreamEnd]:
        return with_end(self._records(Path(records_root), types, load_meta=load_meta))

    @staticmethod
    def _records(root: Path, types: Sequence[str] | None, *, load_meta: bool) -> Iterator[ShadowRecord]:
        for type_dir in _type_dirs(root, types):
            for record_dir in _record_dirs(type_dir):
                yield _record(root, type_dir.name, record_dir, load_meta=load_meta)

    def pending(
        self, records_root: str, rules: dict[str, FingerprintRule], *, threads: int = 1,
    ) -> dict[str, bool]:
        root = Path(records_root)
        return {type_name: self._type_pending(root, type_name, rule) for type_name, rule in rules.items()}

    @staticmethod
    def _type_pending(root: Path, type_name: str, rule: FingerprintRule) -> bool:
        """True at the FIRST record of the type that needs re-indexing. A record
        with no ``asset_ref`` is never pending and is never probed."""
        for record_dir in _record_dirs(root / type_name):
            data, _error = _load(record_dir)
            if data is None:
                continue
            payload = _payload(data)
            asset_ref = payload.get("asset_ref")
            shadow = _sentinel_dir(root, payload)
            if not asset_ref or not isinstance(asset_ref, str) or shadow is None:
                continue
            asset_path = str(Path(asset_ref).resolve())
            fp, _failure = fingerprint(rule, asset_path)
            if index_required(fp, asset_path, shadow):
                return True
        return False
