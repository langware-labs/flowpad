"""Extractor + id mint for SECRET_ORIGIN references.

A secret reference is a **value-free** json at ``<project>/assets/sodot/<name>.json``
(see ``docs/secret_share.md``). It is indexed like any other asset so it travels
with a git-shared project. Discovery is the type's declared ``walk``
(``secret_origin_type_info.py``): the ``assets/sodot`` placement mount under any
walked project folder. The load-bearing difference from a plain flat file is the
id: the **convergent** ``SecretOrigin.key()``, NOT a path-derived one, so a
file-indexed row and a DB-minted row collide on one id across machines. The
extractor refuses any file that isn't value-free.

Type metadata lives in ``flow_sdk/schema/type_info/secret_origin_type_info.py``.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
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


# ── id mint ───────────────────────────────────────────────────────────────────

def secret_origin_id_from_file(ref: FSRef | Path) -> str | None:
    """Read only the embedded entity id; locator derivation is the mint seam."""
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    data = _load_doc(Path(getattr(ref, "_path", ref)))
    return adopt_entity_id(data.get("id")) if data is not None else None


def secret_origin_identity_key(ref: FSRef | Path) -> str | None:
    """The stable key behind the id — ``(project_id, env_var)``.

    Delegates to ``secret_origin_identity.stable_key`` rather than restating the
    recipe. The previous version hardcoded a second copy of the per-kind locator
    field table, which is precisely the kind of duplicate that drifts.
    """
    from flow_sdk.builtin.secret_origin_identity import stable_key  # noqa: PLC0415

    data = _load_doc(Path(getattr(ref, "_path", ref)))
    if not data:
        return None
    project_id = str(data.get("project_id") or "").strip()
    env_var = str(data.get("env_var") or "").strip()
    if not project_id or not env_var:
        return None
    return stable_key(project_id, env_var)


# ── extractor ─────────────────────────────────────────────────────────────────

def extract_secret_origin(ref: FSRef, resolved_id: str) -> list[FSRecord]:
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
    if not str(data.get("project_id") or "").strip() or not str(data.get("env_var") or "").strip():
        # A pre-re-key reference. Left on disk, never mutated, simply not indexed
        # — identity now requires both halves and we do not guess either.
        logger.info("[secret-origin] skipping reference without project_id/env_var: %s", path)
        return []
    try:
        assert_value_free(data, where=f"secret reference {path.name}")
    except ValueError as e:
        logger.warning("[secret-origin] refusing non-value-free reference %s: %s", path, e)
        return []
    rec = FSRecord(
        type=RecordType.SECRET_ORIGIN,
        id=resolved_id,
        name=str(data.get("name") or path.stem),
        status="active",
        content=str(data.get("name") or path.stem),
        metadata={
            "project_id": data.get("project_id") or "",
            "env_var": data.get("env_var") or "",
            "locator": data.get("locator") or {},
            "sod_store": data.get("sod_store") or "",
            "description": data.get("description") or "",
        },
    )
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]

# Freshness uses the default ``_asset_ref.fingerprint`` (mtime + size) — no custom
# asset_hash_fn needed for a flat json file.
