"""Pure identity readers and canonical writers for filesystem assets.

Type-specific modules supply only legacy carrier lookup and stable-key policy.
Validation and minting belong to :class:`TypeInfo`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flow_sdk.capsules import CapsuleSpec
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.identity_backend import (
    CapsuleIdentityBackend,
    DerivedIdentityBackend,
    NativeJsonIdentityBackend,
)
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load


def _path(ref: Any) -> Path:
    return Path(getattr(ref, "_path", ref))


def no_id(ref: Any) -> None:
    """Reader for carrier-less deterministic assets."""
    return None


def frontmatter_id(ref: Any) -> object | None:
    """Return a valid frontmatter ID, or the first invalid candidate.

    Keeping the invalid candidate distinguishable from absence lets TypeInfo
    apply the mandatory stable-v5 fallback instead of minting a random v4.
    """
    try:
        text = _path(ref).read_text(encoding="utf-8")
    except OSError:
        return None
    frontmatter = _extract_frontmatter(text)
    if frontmatter is None:
        return None
    fields = _yaml_load(frontmatter) or {}
    candidates = [fields.get("id"), fields.get("asset_id")]
    for candidate in candidates:
        if is_valid_entity_id(candidate):
            return str(candidate)
    return next((candidate for candidate in candidates if candidate is not None), None)


def folder_capsule_id(ref: Any) -> object | None:
    try:
        return (_path(ref) / ".flow" / "id").read_text(encoding="utf-8").strip()
    except OSError:
        return None


def json_id(ref: Any) -> object | None:
    try:
        data = json.loads(_path(ref).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data.get("id") if isinstance(data, dict) else None


def resolved_path_key(ref: Any) -> str:
    return str(_path(ref).resolve())


IDENTITY_CAPSULE = CapsuleSpec("identity", 1)
NATIVE_JSON_IDENTITY = NativeJsonIdentityBackend()


def capsule_identity(*legacy_readers: Any) -> CapsuleIdentityBackend:
    return CapsuleIdentityBackend(legacy_readers=tuple(legacy_readers))


def derived_identity(reader: Any = None) -> DerivedIdentityBackend:
    return DerivedIdentityBackend(reader=reader)
