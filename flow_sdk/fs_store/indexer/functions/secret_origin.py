"""Walker + extractor + id mint for SECRET_ORIGIN references.

A secret reference is a **value-free** json at ``<project>/assets/sodot/<name>.json``
(see ``docs/secret_share.md``). It is indexed like any other asset so it travels
with a git-shared project. This module mirrors the SPREADSHEET flat-file pattern
(``spreadsheet.py``) but scopes discovery to the ``assets/sodot`` folder and — the
load-bearing difference — mints the **convergent** id (``SecretOrigin.key()``),
NOT a path-derived one, so a file-indexed row and a DB-minted row collide on one
id across machines. The extractor refuses any file that isn't value-free.

Type metadata lives in ``flow_sdk/schema/type_info/secret_origin_type_info.py``.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)

_EXT = ".json"


def _is_sodot_folder(path: Path) -> bool:
    """True for ``.../assets/sodot`` — the only place secret refs are indexed."""
    return path.name == "sodot" and path.parent.name == "assets"


def _load_doc(path: Path) -> dict | None:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    data = obj.get("data")
    return data if isinstance(data, dict) else None


def _convergent_id(data: dict) -> str | None:
    """The reference's convergent id: the adopted in-file ``id`` when valid, else
    recompute ``SecretOrigin.key()`` from the locator. Never path-derived."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

    raw = str(data.get("id") or "").strip()
    if raw and is_valid_entity_id(raw):
        return raw
    locator = data.get("locator")
    if isinstance(locator, dict):
        try:
            return SECRET_ORIGIN_ADAPTER.validate_python(locator).key()
        except Exception:  # noqa: BLE001
            return None
    return None


# ── walker ────────────────────────────────────────────────────────────────────

def secret_origin_in_folder_fn(nodes: list[FSRef], opts: IndexerOptions) -> list[FSRef]:
    """For each walked ``assets/sodot`` FOLDER, emit its direct ``*.json`` children."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        if not _is_sodot_folder(folder_path):
            continue
        try:
            entries = sorted(p for p in folder_path.iterdir() if p.suffix.lower() == _EXT)
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith("._"):
                continue
            try:
                if not entry.is_file():
                    continue
            except OSError:
                continue
            key = str(entry.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(entry, record_type=RecordType.SECRET_ORIGIN, parent=node))
    return out


# ── id mint ───────────────────────────────────────────────────────────────────

def secret_origin_gen_id(ref: FSRef) -> str | None:
    """The convergent id read from the file (never path-derived)."""
    data = _load_doc(ref._path)
    return _convergent_id(data) if data is not None else None


# ── extractor ─────────────────────────────────────────────────────────────────

def extract_secret_origin(ref: FSRef) -> list[FSRecord]:
    """Parse a value-free secret reference json into one FSRecord.

    Single-path index bypasses the walker's scoping, so gate on the ``.json`` ext
    AND the ``assets/sodot`` location here. Refuses any file that isn't value-free."""
    from flow_sdk.builtin.secret_origin import assert_value_free  # noqa: PLC0415

    path = ref._path
    if path.suffix.lower() != _EXT or not _is_sodot_folder(path.parent):
        return []
    try:
        if not path.is_file():
            return []
    except OSError:
        return []
    data = _load_doc(path)
    if data is None:
        return []
    try:
        assert_value_free(data, where=f"secret reference {path.name}")
    except ValueError as e:
        logger.warning("[secret-origin] refusing non-value-free reference %s: %s", path, e)
        return []
    sid = _convergent_id(data)
    if not sid:
        logger.warning("[secret-origin] %s has no adoptable id and no resolvable locator", path)
        return []

    rec = FSRecord(
        type=RecordType.SECRET_ORIGIN,
        id=sid,
        name=str(data.get("name") or path.stem),
        status="active",
        content=str(data.get("name") or path.stem),
        metadata={
            "env_var": data.get("env_var") or "",
            "locator": data.get("locator") or {},
            "sod_store": data.get("sod_store") or "",
        },
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]

# Freshness uses the default ``_asset_ref.fingerprint`` (mtime + size) — no custom
# asset_hash_fn needed for a flat json file.
