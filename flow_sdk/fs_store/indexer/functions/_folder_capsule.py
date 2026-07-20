"""The ``.flow/id`` folder-entity id capsule.

A folder-backed entity stores its id in ``<folder>/.flow/id`` — a single-line
UTF-8 file holding the canonical v4/v5 UUID. This is the portable, move-safe
capsule: the id travels with the folder on share/copy and survives a rename (it
lives in the bytes, not the path), and it is the only place a main-doc-less
folder (e.g. a project) can carry its id. ``.flow/id`` is CONTENT, not ignorable
— it must travel; do not gitignore it (downstream repos that blanket-ignore
``.flow/`` must add ``!.flow/id``).

Mirrors the file/frontmatter carrier: read and write are separate pure/mutating
operations; ``TypeInfo`` alone decides whether an ID must be minted.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _asset_path(ref: Any) -> Path:
    return Path(getattr(ref, "_path", ref))


def _capsule_path(folder: Any) -> Path:
    return _asset_path(folder) / ".flow" / "id"


def read_folder_capsule_id(folder: Any) -> str | None:
    """Adopt the folder's ``.flow/id`` capsule id (validated v4/v5), else ``None``.

    Routes through ``adopt_entity_id`` so a foreign/garbage capsule id (a v7, a
    hand-typed token) is rejected → ``None`` and the caller mints a fresh v4.
    """
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    try:
        raw = _capsule_path(folder).read_text(encoding="utf-8")
    except OSError:
        return None
    return adopt_entity_id(raw)


def write_folder_capsule_id(folder: Any, entity_id: str) -> bool:
    """Write ``entity_id`` into ``<folder>/.flow/id`` — returns whether it persisted.

    Uses ``write_text_if_changed`` so an unchanged id never churns mtime/index
    hash. Swallows ``OSError`` (read-only mounts) — a capsule write must never
    abort an index run — and returns ``False`` in that case so callers can fall
    back without a confirming re-read.
    """
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    from flow_sdk.fs_store.indexer._frontmatter import _atomic_write_text  # noqa: PLC0415

    adopted = adopt_entity_id(entity_id)
    if adopted is None:
        return False

    try:
        _atomic_write_text(_capsule_path(folder), adopted + "\n")
        return True
    except OSError:
        return False
