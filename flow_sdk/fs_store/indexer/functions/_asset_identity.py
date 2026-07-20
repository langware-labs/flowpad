"""Pure identity readers and canonical writers for filesystem assets.

Type-specific modules supply only legacy carrier lookup and stable-key policy.
Validation and minting belong to :class:`TypeInfo`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.indexer._frontmatter import (
    _atomic_write_text,
    read_frontmatter_id,
    write_frontmatter_id,
)
from flow_sdk.fs_store.indexer.functions._folder_capsule import (
    read_folder_capsule_id,
    write_folder_capsule_id,
)


def _path(ref: Any) -> Path:
    return Path(getattr(ref, "_path", ref))


def no_id(ref: Any) -> None:
    """Reader for carrier-less deterministic assets."""
    return None


def frontmatter_id(ref: Any) -> object | None:
    """Return canonical ``id``, then legacy ``asset_id``, without mutation."""
    return read_frontmatter_id(_path(ref))


def write_frontmatter(ref: Any, entity_id: str) -> bool:
    return write_frontmatter_id(_path(ref), entity_id)


def folder_capsule_id(ref: Any) -> object | None:
    return read_folder_capsule_id(_path(ref))


def write_folder_capsule(ref: Any, entity_id: str) -> bool:
    return write_folder_capsule_id(_path(ref), entity_id)


def json_id(ref: Any) -> object | None:
    try:
        data = json.loads(_path(ref).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data.get("id") if isinstance(data, dict) else None


def write_json_id(ref: Any, entity_id: str) -> bool:
    path = _path(ref)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return False
        data["id"] = entity_id
        _atomic_write_text(path, json.dumps(data, indent=2) + "\n")
        return True
    except (OSError, ValueError):
        return False


def resolved_path_key(ref: Any) -> str:
    return str(_path(ref).resolve())
