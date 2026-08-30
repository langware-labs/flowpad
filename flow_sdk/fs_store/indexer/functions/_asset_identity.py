"""Identity carrier factories + the legacy readers types hand them.

A type declares ``identity_carrier=`` with one of these. Validation and
minting belong to ``TypeInfo.mint_entity_id``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.capsules import CapsuleSpec
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.identity_carrier import (
    DerivedCarrier,
    FolderJsonCarrier,
    FolderMdCarrier,
    FrontmatterCarrier,
    NativeJsonCarrier,
    capsule_id,
    folder_capsule_json_id,
)
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load


def _path(ref: Any) -> Path:
    return Path(getattr(ref, "_path", ref))


def frontmatter_asset_id(ref: Any) -> object | None:
    """Legacy reader: the pre-capsule ``asset_id:`` frontmatter key — a valid
    id, else the invalid candidate (distinguishable from absence)."""
    try:
        text = _path(ref).read_text(encoding="utf-8")
    except OSError:
        return None
    frontmatter = _extract_frontmatter(text)
    if frontmatter is None:
        return None
    candidate = (_yaml_load(frontmatter) or {}).get("asset_id")
    return str(candidate) if is_valid_entity_id(candidate) else candidate


def folder_capsule_id(ref: Any) -> object | None:
    """Legacy reader: a folder's pre-capsule ``.flow/id`` file."""
    try:
        return (_path(ref) / ".flow" / "id").read_text(encoding="utf-8").strip()
    except OSError:
        return None


def resolved_path_key(ref: Any) -> str:
    return str(_path(ref).resolve())


IDENTITY_CAPSULE = CapsuleSpec("identity", 1)
NATIVE_JSON_IDENTITY = NativeJsonCarrier()


def frontmatter_identity(*legacy: Any) -> FrontmatterCarrier:
    """The carrier for a type whose main document is markdown: ``id:`` in its
    frontmatter. The markdown capsule and ``asset_id:`` are always read as
    legacy (the capsule is converted in place); ``legacy`` adds the type's own."""
    return FrontmatterCarrier(legacy=(capsule_id, frontmatter_asset_id, *legacy))


def folder_md_identity(*legacy: Any) -> FolderMdCarrier:
    """A folder type whose main document is markdown (``SKILL.md``, ``task.md``):
    the id moves from the folder's ``.flow/capsules/identity.json`` into that
    document's frontmatter; the json and ``.flow/id`` stay readable."""
    return FolderMdCarrier(
        legacy=(capsule_id, folder_capsule_json_id, *(_in_folder(reader) for reader in (folder_capsule_id, *legacy)))
    )


def _in_folder(reader: Any) -> Any:
    """Adapt a folder-keyed legacy reader to the carrier path (the main doc)."""

    def read(path: Path) -> object | None:
        return reader(path.parent if path.is_file() else path)

    read.__name__ = getattr(reader, "__name__", "legacy")
    return read


def folder_json_identity(*legacy: Any) -> FolderJsonCarrier:
    return FolderJsonCarrier(legacy=tuple(legacy))


def derived_identity(reader: Any = None) -> DerivedCarrier:
    return DerivedCarrier(reader=reader)
